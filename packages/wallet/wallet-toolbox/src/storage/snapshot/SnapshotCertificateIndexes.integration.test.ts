import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { runInSeries } from '../../utility/runInSeries'
import { seedArchiveClosure } from '../../../test/utils/snapshotArchiveFixtures'
import { snapshotArchiveTables } from './archive/SnapshotArchive'
import { openKnexSnapshotArchiveSource, type SnapshotArchiveSource } from './archive/KnexSnapshotArchiveSource'
import type { WalletReadSnapshot, WalletSnapshotCursor } from './WalletReadSnapshot'
import {
  addSnapshotCertificateIndexes,
  removeSnapshotCertificateIndexes,
  SNAPSHOT_CERTIFICATE_INDEX_MIGRATION
} from '../schema/snapshotCertificateIndexMigration'

const identity = '02' + '11'.repeat(32)
const stores: StorageKnex[] = []
const writers: Knex[] = []
const directories: string[] = []
const dates = { created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-certificate-index-'))
  directories.push(directory)
  const options = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  }
  const k = knex(options)
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  stores.push(source)
  await k.raw('PRAGMA journal_mode=WAL')
  await source.migrate('certificate index fixture', 'synthetic-certificate-index')
  await source.makeAvailable()
  // Start with the immediately preceding schema on both old and new source.
  await removeSnapshotCertificateIndexes(k)
  await k('knex_migrations').where('name', SNAPSHOT_CERTIFICATE_INDEX_MIGRATION).delete()
  const { user } = await source.findOrInsertUser(identity)
  const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
  await seedArchiveClosure(source, user.userId, other.userId)
  const writer = knex(options)
  writers.push(writer)
  return { source, writer, k, userId: user.userId, otherId: other.userId }
}
async function journal(k: Knex): Promise<void> {
  await k('knex_migrations').insert({
    name: SNAPSHOT_CERTIFICATE_INDEX_MIGRATION,
    batch: 99,
    migration_time: new Date()
  })
}
async function pages(view: WalletReadSnapshot | SnapshotArchiveSource) {
  expect(Object.hasOwn(view, 'certificateIndexes')).toBe(false)
  if ('validateClosure' in view) await view.validateClosure()
  const result: Record<string, unknown[]> = {}
  await runInSeries(snapshotArchiveTables, async table => {
    let cursor: WalletSnapshotCursor | undefined
    const selected: unknown[] = []
    let complete = false
    for (let pageNumber = 0; pageNumber < 25 && !complete; pageNumber++) {
      const page = await view.readPage(table, cursor, { maxRows: 1, maxBytes: 131072 })
      selected.push({ rows: page.rows, after: page.cursor?.after, payloadBytes: page.payloadBytes, done: page.done })
      complete = page.done
      cursor = page.cursor
    }
    expect(complete).toBe(true)
    result[table] = selected
  })
  return result
}
afterEach(async () => {
  await runInSeries(writers.splice(0), k => k.destroy())
  await runInSeries(stores.splice(0), source => source.destroy())
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})

test('indexed ordinary/archive pages preserve all13tables and original source indexes/legacy offsets', async () => {
  const { source, k, userId } = await fixture()
  const legacy = async () => {
    const all: Record<string, Array<Array<number | string>>> = {}
    await runInSeries(
      [
        ['findTransactions', 'transactionId'],
        ['findOutputs', 'outputId'],
        ['findCertificates', 'certificateId'],
        ['findTxLabels', 'txLabelId'],
        ['findOutputBaskets', 'basketId'],
        ['findOutputTags', 'outputTagId'],
        ['findCommissions', 'commissionId'],
        ['findSyncStates', 'syncStateId']
      ] as const,
      async ([method, key]) => {
        all[method] = []
        await runInSeries([0, 1], async offset => {
          const rows = await source[method]({ partial: { userId }, paged: { limit: 1, offset } })
          all[method].push(rows.map(row => (row as unknown as Record<string, number>)[key]))
        })
      }
    )
    all.certificateFields = []
    await runInSeries([0, 1], async offset => {
      const rows = await source.findCertificateFields({ partial: { userId }, paged: { limit: 1, offset } })
      all.certificateFields.push(rows.flatMap(row => [row.fieldName, row.certificateId]))
    })
    return all
  }
  const standard = async () =>
    await k('sqlite_master')
      .whereIn('type', ['table', 'index'])
      .whereNotIn('tbl_name', ['snapshot_certificate_field_keys', 'snapshot_certificate_index_progress'])
      .select('type', 'name', 'tbl_name', 'sql')
      .orderBy('name')
  const originalIndexes = await standard()
  const originalOffsets = await legacy()
  const old = await source.openWalletReadSnapshot(identity)
  let baseline
  try {
    baseline = await pages(old)
  } finally {
    await old.close()
  }
  await addSnapshotCertificateIndexes(k)
  expect(await standard()).toEqual(originalIndexes)
  expect(await legacy()).toEqual(originalOffsets)
  const queries: Array<{ sql: string; bindings: Knex.RawBinding[] }> = []
  const listen = (query: { sql: string; bindings: Knex.RawBinding[] }): void => {
    if (
      query.sql.startsWith('select') &&
      query.sql.includes('cross join') &&
      query.sql.includes('snapshot_certificate_field_keys')
    )
      queries.push(query)
  }
  k.on('query', listen)
  try {
    const partial = await source.openWalletReadSnapshot(identity)
    try {
      expect(await pages(partial)).toEqual(baseline)
      expect(queries).toEqual([])
    } finally {
      await partial.close()
    }
    await journal(k)
    await runInSeries(
      [() => source.openWalletReadSnapshot(identity), () => openKnexSnapshotArchiveSource(source, identity)],
      async open => {
        const view = await open()
        try {
          expect(await pages(view)).toEqual(baseline)
        } finally {
          await view.close()
        }
      }
    )
    expect(queries.length).toBeGreaterThan(0)
  } finally {
    k.off('query', listen)
  }
  // Explain only page queries; closure may legitimately visit its certificateal parents.
  await runInSeries(
    queries.filter(query => query.sql.includes('__snapshotBytes') || query.sql.includes('.*')),
    async query => {
      const plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + query.sql, query.bindings)
      expect(plan.some(row => row.detail.includes('SEARCH snapshot_certificate_field_keys USING COVERING INDEX'))).toBe(
        true
      )
      expect(plan.some(row => /SCAN |TEMP B-TREE/.test(row.detail))).toBe(false)
    }
  )
})

test.each(['ordinary', 'archive'] as const)(
  '%s mode and all13table pages stay bound across independent journal/profile/progress writes',
  async kind => {
    const { source, k, writer, userId, otherId } = await fixture()
    await addSnapshotCertificateIndexes(k)
    const open = async () =>
      kind === 'ordinary'
        ? await source.openWalletReadSnapshot(identity)
        : await openKnexSnapshotArchiveSource(source, identity)
    const queries: string[] = []
    const listen = (query: { sql: string }): void => {
      if (
        query.sql.startsWith('select') &&
        query.sql.includes('cross join') &&
        query.sql.includes('snapshot_certificate_field_keys')
      )
        queries.push(query.sql)
    }
    k.on('query', listen)
    const old = await open()
    let baseline
    try {
      baseline = await pages(old)
      queries.length = 0
      await journal(writer)
      expect(await pages(old)).toEqual(baseline)
      expect(queries).toEqual([])
    } finally {
      await old.close()
    }
    const indexed = await open()
    try {
      await writer.transaction(async trx => {
        await trx('snapshot_certificate_index_progress').where('snapshotTableId', 0).update({ complete: 0 })
        await trx('certificates').where('certificateId', 3).update({ userId: otherId })
        await trx('certificate_fields').where('certificateId', 3).update({ userId: otherId })
        await trx('certificates').insert({
          ...dates,
          certificateId: 4,
          userId,
          serialNumber: 'new-after-view',
          type: 'type',
          certifier: identity,
          subject: identity,
          revocationOutpoint: 'a'.repeat(64) + '.0',
          signature: 'synthetic',
          isDeleted: false
        })
      })
      expect(await pages(indexed)).toEqual(baseline)
      expect(queries.length).toBeGreaterThan(0)
    } finally {
      await indexed.close()
      k.off('query', listen)
    }
    await expect(open()).rejects.toThrow('migration is incomplete')
    await writer('snapshot_certificate_index_progress').where('snapshotTableId', 0).update({ complete: 1 })
    const fresh = await open()
    try {
      expect((await fresh.readPage('certificates')).rows.map(row => row.certificateId)).toEqual([1, 4])
    } finally {
      await fresh.close()
    }
  }
)
