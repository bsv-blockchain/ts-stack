import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { retireGenerationPage } from '../schema/snapshotSqliteIndexRetirement'
import { fixture, value, tables } from '../../../test/utils/snapshotSqliteFixtures'
import { installGeneration, names, metadata } from '../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../schema/snapshotSqliteIndexBootstrap'
import { walletSnapshotSourceQuery } from './KnexWalletReadSnapshot'
import type { WalletSnapshotTable } from './WalletReadSnapshot'

const selections: Array<{
  table: WalletSnapshotTable
  keys: string[]
  after: (number | string)[]
}> = [
  { table: 'transactions', keys: ['snapshotRowId'], after: [4999] },
  { table: 'txLabelMaps', keys: ['snapshotLeftId', 'snapshotRightId'], after: [4999, 4999] },
  { table: 'outputTagMaps', keys: ['snapshotLeftId', 'snapshotRightId'], after: [4999, 4999] },
  {
    table: 'certificateFields',
    keys: ['snapshotFieldName', 'snapshotCertificateId'],
    after: ['field-4999', 4999]
  },
  { table: 'provenTxs', keys: ['rowId'], after: [4999] },
  { table: 'provenTxReqs', keys: ['rowId'], after: [4999] }
]

test('all generation page shapes use indexed profile/key ranges without a temporary sort', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await installGeneration(k)
    for (const selection of selections) {
      const query = walletSnapshotSourceQuery(k, selection.table, 1, 'v2', 'v2', 'v2', 'v2').select('*')
      if (selection.keys.length === 1) void query.where(selection.keys[0], '>', selection.after[0])
      else void query.whereRaw('(??,??)>(?,?)', [...selection.keys, ...selection.after])
      void query.orderBy(selection.keys).limit(32)
      const sql = query.toSQL()
      const plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + sql.sql, sql.bindings)
      expect(plan.some(step => step.detail.includes('SEARCH snapshot_') && step.detail.includes('_v2'))).toBe(true)
      expect(
        plan.filter(step => step.detail.includes('TEMP B-TREE') || step.detail.startsWith('SCAN snapshot_'))
      ).toEqual([])
    }
  } finally {
    await k.destroy()
  }
})

test('no-op and unrelated source updates do not amplify auxiliary writes', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.schema.alterTable('transactions', table => table.text('description').notNullable().defaultTo(''))
    const plan = await installGeneration(k)
    await k('transactions').insert(value('transactions', 1, 1, 1))
    for (let i = 0; i < 30; i++) if ((await copyGenerationPage(k, plan)).complete) break
    const total = async () => Number((await k.raw('SELECT total_changes() AS writes'))[0].writes)
    const before = await total()
    await k('transactions').where('transactionId', 1).update({ userId: 1, reference: 'r1', txid: 't1', provenTxId: 1 })
    expect((await total()) - before).toBe(1)
    const same = await total()
    await k('transactions').where('transactionId', 1).update({ description: 'updated payload' })
    expect((await total()) - same).toBe(1)
    expect(await k(names.profile)).toHaveLength(1)
    expect(await k(names.edges)).toHaveLength(1)
  } finally {
    await k.destroy()
  }
})

test.each(['transactions', 'tx_labels_map', 'certificate_fields'])(
  'invalid leading %s identity cannot be skipped by the initial cursor',
  async table => {
    const k = await fixture('BINARY', false, false)
    try {
      const plan = await installGeneration(k)
      const row =
        table === 'transactions'
          ? { ...value(table, 1, 1, 1), transactionId: -1 }
          : table === 'tx_labels_map'
            ? { txLabelId: -1, transactionId: 1 }
            : { userId: 1, certificateId: -1, fieldName: '', fieldValue: 'v' }
      await k(table).insert(row)
      let rejected = false
      for (let i = 0; i < 30; i++) {
        try {
          const result = await copyGenerationPage(k, plan)
          if (result.complete) break
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          rejected = true
          break
        }
      }
      expect(rejected).toBe(true)
      expect(await k(metadata).first('complete')).toEqual({ complete: 0 })
    } finally {
      await k.destroy()
    }
  }
)

test('populated WAL measurement records bounded rebuild, indexed late pages and reusable retired space', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-generation-measure-'))
  const filename = join(directory, 'fixture.sqlite')
  const k = await fixture('BINARY', false, false, filename)
  const started = performance.now()
  const footprint = async () => {
    const base = await stat(filename)
    const wal = await stat(filename + '-wal').catch(() => undefined)
    return {
      databaseBytes: base.size,
      walBytes: wal?.size ?? 0,
      pageCount: Number((await k.raw('PRAGMA page_count'))[0].page_count),
      freePages: Number((await k.raw('PRAGMA freelist_count'))[0].freelist_count)
    }
  }
  try {
    for (const table of tables)
      for (let start = 0; start < 1000; start += 100) {
        const rows = Array.from({ length: 100 }, (_, index) => {
          const id = start + index + 1
          return table === 'certificate_fields'
            ? { userId: (id % 2) + 1, fieldName: 'a', certificateId: id, fieldValue: 'v' }
            : value(table, id, id, (id % 2) + 1)
        })
        await k(table).insert(rows)
      }
    const before = await footprint()
    const copyStart = performance.now(),
      plan = await installGeneration(k)
    let peak = before.databaseBytes + before.walBytes,
      copyPages = 0,
      retirePages = 0,
      maximumRetired = 0
    for (; copyPages < 100; copyPages++) {
      const page = await copyGenerationPage(k, plan)
      const now = await footprint()
      peak = Math.max(peak, now.databaseBytes + now.walBytes)
      if (page.complete) {
        copyPages++
        break
      }
    }
    expect(copyPages).toBe(49)
    const copied = await footprint(),
      copyMilliseconds = performance.now() - copyStart
    const plans: Record<string, unknown> = {}
    for (const selected of selections) {
      const after = selected.table === 'certificateFields' ? ['a', 900] : selected.keys.map(() => 900)
      const query = walletSnapshotSourceQuery(k, selected.table, 1, 'v2', 'v2', 'v2', 'v2').select('*')
      if (selected.keys.length === 1) void query.where(selected.keys[0], '>', after[0])
      else void query.whereRaw('(??,??)>(?,?)', [...selected.keys, ...after])
      void query.orderBy(selected.keys).limit(8)
      const sql = query.toSQL(),
        rows = await query
      expect(rows).toHaveLength(8)
      const steps: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + sql.sql, sql.bindings)
      expect(steps.some(step => step.detail.includes('SEARCH snapshot_') && step.detail.includes('_v2'))).toBe(true)
      expect(
        steps.filter(step => step.detail.includes('TEMP B-TREE') || step.detail.startsWith('SCAN snapshot_'))
      ).toEqual([])
      plans[selected.table] = steps
    }
    const retireStart = performance.now()
    for (; retirePages < 200; retirePages++) {
      const page = await retireGenerationPage(k, plan)
      maximumRetired = Math.max(maximumRetired, page.removed)
      expect(page.removed).toBeLessThanOrEqual(256)
      const now = await footprint()
      peak = Math.max(peak, now.databaseBytes + now.walBytes)
      if (page.complete) {
        retirePages++
        break
      }
    }
    expect(retirePages).toBeLessThan(200)
    const retired = await footprint()
    expect(retired.freePages).toBeGreaterThan(copied.freePages)
    const receipt = {
      observedAt: new Date().toISOString(),
      fixture: '1000 small rows in each of thirteen minimal standard source tables; two profiles',
      production: false,
      sourceRows: 13000,
      sqliteVersion: (await k.raw('SELECT sqlite_version() AS version'))[0].version,
      before,
      copied,
      retired,
      peakObservedDatabaseAndWalBytes: peak,
      copyPages,
      retirePages,
      maximumRetired,
      copyMilliseconds,
      retireMilliseconds: performance.now() - retireStart,
      totalMilliseconds: performance.now() - started,
      plans,
      limitations: [
        'fixed minimal records, not a complete large-wallet performance or resource-budget acceptance',
        'SQL range plans and returned-row counts do not measure internal VM row visits',
        'freed SQLite pages are reusable; database/WAL file shrink is not promised'
      ]
    }
    console.log(JSON.stringify({ sqliteGenerationCost: receipt }))
  } finally {
    await k.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
