import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { SNAPSHOT_ARCHIVE_GUARD_MIGRATION } from '../../schema/KnexMigrations'
import { decodeSyncTransfer } from '../../remoting/SyncTransfer'
import * as Transfer from '../../remoting/SyncTransfer'
import * as ArchiveSource from './KnexSnapshotArchiveSource'
import { runInNewContext } from 'node:vm'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import { openKnexSnapshotArchiveSource } from './KnexSnapshotArchiveSource'
import { assertKnexSnapshotArchiveClosure } from './KnexSnapshotArchiveClosure'
import { captureKnexSnapshotArchive } from './captureKnexSnapshotArchive'
import { KnexSnapshotArchiveStore, snapshotArchiveTables } from './KnexSnapshotArchiveStore'
import { verifySnapshotArchiveDirectory, verifySnapshotArchivePage } from './SnapshotArchiveDirectory'

const identity = '02' + '11'.repeat(32)
const foreign = '03' + '22'.repeat(32)
const stores: StorageKnex[] = []
const directories: string[] = []

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-archive-capture-'))
  directories.push(directory)
  const open = () => {
    const storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
    stores.push(storage)
    return storage
  }
  const writer = open()
  await writer.knex.raw('PRAGMA journal_mode = WAL')
  await writer.migrate('original source', 'original-source')
  await writer.makeAvailable()
  const { user } = await writer.findOrInsertUser(identity)
  const { user: other } = await writer.findOrInsertUser(foreign)
  await seedArchiveClosure(writer, user.userId, other.userId)
  await writer.knex('outputs').where({ outputId: 1 }).update({ spentBy: 3 })
  const reader = open()
  await reader.makeAvailable()
  return { reader, writer, userId: user.userId, otherId: other.userId }
}

afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(storage => storage.destroy()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function changeReference(writer: StorageKnex, table: string, key: string, field: string, value: number) {
  if (table === 'commissions') await writer.knex('commissions').where({ transactionId: value }).delete()
  const query = writer.knex(table).where({ [key]: 1 })
  if (table.endsWith('_map')) void query.where({ [field]: 1 })
  if (table === 'certificate_fields') {
    await query.where({ certificateId: 1, fieldName: 'a' }).update({ [field]: value, fieldName: 'changed' })
  } else await query.update({ [field]: value })
}

test('captures all thirteen tables with original metadata, packed bytes and profile-bound relations', async () => {
  const { reader, writer, userId } = await fixture()
  const progress: Array<{ pages: number; rows: number; bytes: number }> = []
  const manifest = await captureKnexSnapshotArchive(reader, writer.knex, identity, 'test', {
    onProgress: p => progress.push(p)
  })
  expect(manifest.binding.sourceSchema).toBe(SNAPSHOT_ARCHIVE_GUARD_MIGRATION)
  expect(manifest.binding.sourceStorage.storageName).toBe('original source')
  expect(manifest.binding.sourceStorage.storageIdentityKey).toBe('original-source')
  expect(manifest.binding.user).toMatchObject({ userId, identityKey: identity })
  expect(manifest.pages).toBe(13)
  const store = new KnexSnapshotArchiveStore(writer.knex)
  const verified = verifySnapshotArchiveDirectory(await store.directory(identity, manifest.archiveId), {
    identityKey: identity,
    chain: 'test',
    sourceStorageIdentityKey: 'original-source',
    archiveId: manifest.archiveId,
    digest: manifest.digest,
    sourceSchema: SNAPSHOT_ARCHIVE_GUARD_MIGRATION
  })
  expect(verified.manifest).toEqual(manifest)
  const captured: Record<string, Array<Record<string, unknown>>> = {}
  for (const [sequence, table] of snapshotArchiveTables.entries()) {
    const page = await store.read(identity, manifest.archiveId, sequence)
    const frame = decodeSyncTransfer(verifySnapshotArchivePage(page, verified.receipts[sequence])) as {
      version: number
      table: string
      rows: Array<Record<string, unknown>>
    }
    expect(frame).toMatchObject({ version: 1, table })
    expect(frame.rows).toHaveLength(page.rows)
    expect(page.done).toBe(true)
    captured[table] = frame.rows
    for (const row of frame.rows) {
      if ('userId' in row) expect(row.userId).toBe(userId)
      expect(row.created_at).toBe('2026-01-01T00:00:00.000Z')
    }
  }
  expect(captured.provenTxs.map(row => row.provenTxId)).toEqual([1, 3])
  expect(captured.provenTxs[0].rawTx).toEqual(new Uint8Array([1, 1, 255]))
  expect(captured.provenTxReqs.map(row => row.provenTxReqId)).toEqual([1, 3])
  expect(captured.transactions.map(row => row.transactionId)).toEqual([1, 3])
  expect(captured.txLabelMaps.map(row => [row.txLabelId, row.transactionId])).toEqual([
    [1, 1],
    [1, 3],
    [3, 3]
  ])
  expect(captured.syncStates.map(row => [row.syncStateId, row.syncMap])).toEqual([
    [1, '{}'],
    [3, '{}']
  ])
  expect(captured.certificateFields).toHaveLength(8)
  expect(progress.at(-1)).toMatchObject({ pages: 13, rows: manifest.rows })
  expect(progress.at(-1)!.bytes).toBeGreaterThan(0)
  expect(progress[0].pages).toBe(1)
  const next = await reader.openReadSnapshot()
  await next.close()
  await store.close(identity, manifest.archiveId)
})

test('preserves nullable proof, basket and spending references in an incomplete wallet history', async () => {
  const { reader, writer } = await fixture()
  await writer.knex('transactions').where({ transactionId: 1 }).update({ provenTxId: null })
  await writer.knex('proven_tx_reqs').where({ provenTxReqId: 1 }).update({ provenTxId: null })
  await writer.knex('outputs').where({ outputId: 1 }).update({ basketId: null, spentBy: null })
  const manifest = await captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')
  const store = new KnexSnapshotArchiveStore(writer.knex)
  for (const [sequence, field] of [
    [1, 'provenTxId'],
    [3, 'provenTxId'],
    [5, 'basketId']
  ] as const) {
    const page = await store.read(identity, manifest.archiveId, sequence)
    const frame = decodeSyncTransfer(page.bytes) as { rows: Array<Record<string, unknown>> }
    expect(frame.rows[0][field]).toBeUndefined()
    if (sequence === 5) expect(frame.rows[0].spentBy).toBeUndefined()
  }
  await store.close(identity, manifest.archiveId)
})

test('source schema, primary history and closure stay pinned while an independent writer changes them', async () => {
  const { reader, writer } = await fixture()
  const source = await openKnexSnapshotArchiveSource(reader, identity)
  const originalPrimary = source.user.activeStorage
  await writer.knex('users').where({ identityKey: identity }).update({ activeStorage: 'replacement' })
  await writer.knex('knex_migrations').insert({ name: 'future-schema', batch: 99, migration_time: new Date() })
  await writer.knex('outputs').where({ outputId: 1 }).update({ basketId: 2 })
  expect(source.sourceSchema).toBe(SNAPSHOT_ARCHIVE_GUARD_MIGRATION)
  expect(source.user.activeStorage).toBe(originalPrimary)
  await expect(source.validateClosure()).resolves.toBeUndefined()
  expect((await source.readPage('outputs')).rows[0].basketId).toBe(1)
  await source.close()
  const changed = await openKnexSnapshotArchiveSource(reader, identity)
  expect(changed.sourceSchema).toBe('future-schema')
  expect(changed.user.activeStorage).toBe('replacement')
  await expect(changed.validateClosure()).rejects.toThrow('relation')
  await expect(changed.closed).rejects.toThrow('relation')
})

test.each([
  ['transactions', 'transactionId', 'provenTxId'],
  ['proven_tx_reqs', 'provenTxReqId', 'provenTxId'],
  ['commissions', 'commissionId', 'transactionId'],
  ['outputs', 'outputId', 'transactionId'],
  ['outputs', 'outputId', 'basketId'],
  ['outputs', 'outputId', 'spentBy'],
  ['tx_labels_map', 'txLabelId', 'transactionId'],
  ['tx_labels_map', 'transactionId', 'txLabelId'],
  ['output_tags_map', 'outputTagId', 'outputId'],
  ['output_tags_map', 'outputId', 'outputTagId'],
  ['certificate_fields', 'certificateId', 'userId'],
  ['certificate_fields', 'userId', 'certificateId']
])('refuses dangling %s.%s/%s without sealing or leaking a reservation', async (table, key, field) => {
  const { reader, writer } = await fixture()
  await writer.knex.raw('PRAGMA foreign_keys = OFF')
  await changeReference(writer, table, key, field, 999)
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')).rejects.toThrow('relation')
  expect(await writer.knex('snapshot_archives')).toHaveLength(0)
  expect(await writer.knex('snapshot_archive_pages')).toHaveLength(0)
  expect(await writer.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test.each([
  ['commissions', 'commissionId', 'transactionId'],
  ['outputs', 'outputId', 'transactionId'],
  ['outputs', 'outputId', 'basketId'],
  ['outputs', 'outputId', 'spentBy'],
  ['tx_labels_map', 'txLabelId', 'transactionId'],
  ['tx_labels_map', 'transactionId', 'txLabelId'],
  ['output_tags_map', 'outputTagId', 'outputId'],
  ['output_tags_map', 'outputId', 'outputTagId'],
  ['certificate_fields', 'certificateId', 'userId'],
  ['certificate_fields', 'userId', 'certificateId']
])('refuses existing foreign-profile targets in %s.%s/%s', async (table, key, field) => {
  const { reader, writer } = await fixture()
  await changeReference(writer, table, key, field, 2)
  const source = await openKnexSnapshotArchiveSource(reader, identity)
  await expect(source.validateClosure()).rejects.toThrow('relation')
  await expect(source.closed).rejects.toThrow('relation')
})

test('cancellation and progress callback failures discard committed staging and release the reader', async () => {
  const { reader, writer } = await fixture()
  const signal = new AbortController()
  await expect(
    captureKnexSnapshotArchive(reader, writer.knex, identity, 'test', {
      signal: signal.signal,
      onProgress: () => signal.abort()
    })
  ).rejects.toThrow('cancelled')
  expect(await writer.knex('snapshot_archive_pages')).toHaveLength(0)
  const failure = new Error('synthetic progress failure')
  await expect(
    captureKnexSnapshotArchive(reader, writer.knex, identity, 'test', {
      onProgress: () => {
        throw failure
      }
    })
  ).rejects.toBe(failure)
  expect(await writer.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  const next = await reader.openReadSnapshot()
  await next.close()
})

test('invalid binding, network, shared-pool and already-cancelled requests fail with no partial archive', async () => {
  const { reader, writer } = await fixture()
  await expect(captureKnexSnapshotArchive(reader, reader.knex, identity, 'test')).rejects.toThrow('separate')
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'mock')).rejects.toThrow('chain')
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'main')).rejects.toThrow('chain')
  await expect(captureKnexSnapshotArchive(reader, writer.knex, 'invalid', 'test')).rejects.toThrow('identityKey')
  await expect(captureKnexSnapshotArchive(reader, writer.knex, '02' + '33'.repeat(32), 'test')).rejects.toThrow(
    'existing wallet profile'
  )
  const signal = new AbortController()
  signal.abort()
  await expect(
    captureKnexSnapshotArchive(reader, writer.knex, identity, 'test', { signal: signal.signal })
  ).rejects.toThrow('cancelled')
  expect(await writer.knex('snapshot_archives')).toHaveLength(0)
  const queries: string[] = []
  writer.knex.on('query', query => queries.push(query.sql))
  for (const id of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(assertKnexSnapshotArchiveClosure(writer.knex, id)).rejects.toThrow('userId')
  expect(queries).toHaveLength(0)
})

test('malformed identities refuse the source before acquiring a database read view', async () => {
  const { reader } = await fixture()
  const queries: string[] = []
  reader.knex.on('query', query => queries.push(query.sql))
  for (const key of [null, 42, '', 'invalid', 'prefix' + identity, identity + 'suffix', '04' + '11'.repeat(32)]) {
    await expect(openKnexSnapshotArchiveSource(reader, key as string)).rejects.toThrow('compressed public identity key')
  }
  expect(queries).toHaveLength(0)
})

test('capture checks source identity independently and forwards cancellation to the retained view', async () => {
  const { reader, writer } = await fixture()
  const source = await openKnexSnapshotArchiveSource(reader, identity)
  jest.spyOn(ArchiveSource, 'openKnexSnapshotArchiveSource').mockResolvedValue({
    ...source,
    user: { ...source.user, identityKey: foreign }
  })
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')).rejects.toThrow('requested profile')
  expect(source.isOpen).toBe(false)
  expect(await writer.knex('snapshot_archives')).toHaveLength(0)
  jest.restoreAllMocks()
  const signal = new AbortController()
  const open = reader.openReadSnapshot.bind(reader)
  let captured: Awaited<ReturnType<typeof open>> | undefined
  jest.spyOn(reader, 'openReadSnapshot').mockImplementation(async options => {
    captured = await open(options)
    return captured
  })
  await expect(
    captureKnexSnapshotArchive(reader, writer.knex, identity, 'test', {
      signal: signal.signal,
      lifetimeMs: 60000,
      onProgress: () => {
        signal.abort()
        expect(captured?.isOpen).toBe(false)
      }
    })
  ).rejects.toThrow('cancelled')
  expect(await writer.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('missing or invalid migration metadata refuses opening and releases read capacity', async () => {
  const { reader, writer } = await fixture()
  const metadata = await writer.knex('knex_migrations').orderBy('id', 'desc').first()
  for (const name of ['', 'x'.repeat(257)]) {
    await writer.knex('knex_migrations').where({ id: metadata.id }).update({ name })
    await expect(openKnexSnapshotArchiveSource(reader, identity)).rejects.toThrow('schema version')
  }
  await writer.knex('knex_migrations').delete()
  await expect(openKnexSnapshotArchiveSource(reader, identity)).rejects.toThrow('schema version')
  const next = await reader.openReadSnapshot()
  await next.close()
})

test('supports a configured migration table/schema and preserves the longest accepted schema name', async () => {
  const { reader, writer } = await fixture()
  await writer.knex.schema.renameTable('knex_migrations', 'archive_migration_history')
  await writer
    .knex('archive_migration_history')
    .orderBy('id', 'desc')
    .limit(1)
    .update({ name: 'x'.repeat(256) })
  reader.knex.client.config.migrations = { tableName: 'archive_migration_history', schemaName: 'main' }
  const queries: string[] = []
  reader.knex.on('query', query => queries.push(query.sql))
  const source = await openKnexSnapshotArchiveSource(reader, identity)
  expect(queries.some(sql => sql.includes('`main`.`archive_migration_history`'))).toBe(true)
  expect(source.sourceSchema).toBe('x'.repeat(256))
  expect(source.isOpen).toBe(true)
  await source.close()
  await source.closed
  expect(source.isOpen).toBe(false)
  await writer.knex('archive_migration_history').update({ name: 'x' })
  const shortest = await openKnexSnapshotArchiveSource(reader, identity)
  expect(shortest.sourceSchema).toBe('x')
  await shortest.close()
})

test('a full page continues through its empty terminal page and preserves mainnet binding', async () => {
  const { reader, writer, userId } = await fixture()
  await writer.knex('settings').update({ chain: 'main' })
  await writer.knex('tx_labels_map').whereIn('txLabelId', [1, 3]).delete()
  await writer.knex('tx_labels').where({ userId }).delete()
  for (let index = 0; index < 256; index++) await writer.findOrInsertTxLabel(userId, `page-${index}`)
  const manifest = await captureKnexSnapshotArchive(reader, writer.knex, identity, 'main')
  expect(manifest.binding.sourceStorage.chain).toBe('main')
  expect(manifest.pages).toBe(15)
  const store = new KnexSnapshotArchiveStore(writer.knex)
  expect(await store.read(identity, manifest.archiveId, 8)).toMatchObject({ table: 'txLabels', rows: 128, done: false })
  expect(await store.read(identity, manifest.archiveId, 9)).toMatchObject({ table: 'txLabels', rows: 128, done: false })
  expect(await store.read(identity, manifest.archiveId, 10)).toMatchObject({ table: 'txLabels', rows: 0, done: true })
  await store.close(identity, manifest.archiveId)
})

test('oversized source rows and exhausted reservations fail closed', async () => {
  const { reader, writer } = await fixture()
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test', { maxBytes: 4100 })).rejects.toThrow(
    'metadata'
  )
  await writer
    .knex('proven_txs')
    .where({ provenTxId: 1 })
    .update({ rawTx: Buffer.alloc(200000) })
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')).rejects.toThrow('maxBytes')
  expect(await writer.knex('snapshot_archives')).toHaveLength(0)
  expect(await writer.knex('snapshot_archive_pages')).toHaveLength(0)
})

test('encoding refusal cleans the reservation without returning an oversized frame', async () => {
  const { reader, writer } = await fixture()
  jest.spyOn(Transfer, 'encodeSyncTransfer').mockReturnValue(new Uint8Array(1048577))
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')).rejects.toThrow('encoded page limit')
  expect(await writer.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('capture bounds page work even if a source never reports completion', async () => {
  const { reader, writer } = await fixture()
  const source = await openKnexSnapshotArchiveSource(reader, identity)
  const read = jest.fn(async () => ({ rows: [], payloadBytes: 0, done: false }))
  jest.spyOn(ArchiveSource, 'openKnexSnapshotArchiveSource').mockResolvedValue({ ...source, readPage: read })
  const append = jest.spyOn(KnexSnapshotArchiveStore.prototype, 'append').mockResolvedValue()
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')).rejects.toThrow('page limit')
  expect(read).toHaveBeenCalledTimes(4096)
  expect(append).toHaveBeenCalledTimes(4096)
  expect(source.isOpen).toBe(false)
  expect(await writer.knex('snapshot_archives')).toHaveLength(0)
})

test('normalizes cross-realm dates and rejects malformed dates before staging them', async () => {
  const { reader, writer } = await fixture()
  for (const value of [runInNewContext('new Date("2026-01-01T00:00:00.000Z")'), new Date(NaN)]) {
    const source = await openKnexSnapshotArchiveSource(reader, identity)
    const readPage = source.readPage
    jest.spyOn(ArchiveSource, 'openKnexSnapshotArchiveSource').mockResolvedValue({
      ...source,
      readPage: async (...args) => {
        const page = await readPage(...args)
        for (const row of page.rows) row.created_at = value
        return page
      }
    })
    const pending = captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')
    if (Number.isNaN(value.getTime())) await expect(pending).rejects.toThrow('invalid date')
    else {
      const manifest = await pending
      const store = new KnexSnapshotArchiveStore(writer.knex)
      const frame = decodeSyncTransfer((await store.read(identity, manifest.archiveId, 0)).bytes) as {
        rows: Array<{ created_at: string }>
      }
      expect(frame.rows[0].created_at).toBe('2026-01-01T00:00:00.000Z')
      await store.close(identity, manifest.archiveId)
    }
    jest.restoreAllMocks()
  }
})

test('failed source cleanup prevents sealing and interrupted staging cleanup keeps its reservation', async () => {
  const { reader, writer } = await fixture()
  const source = await openKnexSnapshotArchiveSource(reader, identity)
  const failure = new Error('synthetic source close failure')
  jest.spyOn(ArchiveSource, 'openKnexSnapshotArchiveSource').mockResolvedValue({
    ...source,
    close: async () => {
      await source.close()
      throw failure
    }
  })
  await expect(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')).rejects.toBe(failure)
  expect(await writer.knex('snapshot_archives')).toHaveLength(0)
  jest.restoreAllMocks()
  const callbackFailure = new Error('synthetic callback failure')
  jest.spyOn(KnexSnapshotArchiveStore.prototype, 'close').mockRejectedValue(new Error('synthetic cleanup failure'))
  await expect(
    captureKnexSnapshotArchive(reader, writer.knex, identity, 'test', {
      onProgress: () => {
        throw callbackFailure
      }
    })
  ).rejects.toBe(callbackFailure)
  expect(await writer.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 1 })
  expect((await writer.knex('snapshot_archives').first()).state).toBe('building')
  jest.restoreAllMocks()
  await writer.knex('snapshot_archives').update({ expiresAt: 0 })
  await new KnexSnapshotArchiveStore(writer.knex).reap()
  expect(await writer.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0 })
})
