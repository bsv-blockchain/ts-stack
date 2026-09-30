import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { KnexMigrations } from '../../schema/KnexMigrations'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex, type Knex } from 'knex'
import { addSnapshotArchiveTables, removeSnapshotArchiveTables } from '../../schema/snapshotArchiveMigration'
import { verifySnapshotArchiveDirectory, verifySnapshotArchivePage } from './SnapshotArchiveDirectory'
import {
  KnexSnapshotArchiveStore,
  snapshotArchiveTables,
  snapshotArchiveLimits,
  type SnapshotArchiveBinding,
  type SnapshotArchiveWriter
} from './KnexSnapshotArchiveStore'

const identity = '02' + '11'.repeat(32)
const other = '03' + '22'.repeat(32)
const date = new Date('2026-01-01T00:00:00.000Z')
const binding: SnapshotArchiveBinding = {
  version: 1,
  snapshotId: 'a'.repeat(64),
  sourceSchema: 'test-schema-v1',
  sourceStorage: {
    created_at: date,
    updated_at: date,
    storageIdentityKey: 'source',
    storageName: 'original source',
    chain: 'test',
    dbtype: 'SQLite',
    maxOutputScript: 1024
  },
  user: { userId: 7, identityKey: identity, activeStorage: 'historical primary', created_at: date, updated_at: date }
}
const bytes = new TextEncoder().encode('[]')
const databases: Knex[] = []
const directories: string[] = []

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-archive-'))
  directories.push(directory)
  const open = () => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'archive.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      acquireConnectionTimeout: 5000
    })
    databases.push(db)
    return db
  }
  const db = open()
  await db.raw('PRAGMA journal_mode = WAL')
  await addSnapshotArchiveTables(db)
  return { db, peer: open(), store: new KnexSnapshotArchiveStore(db) }
}

async function complete(store: KnexSnapshotArchiveStore, writer: SnapshotArchiveWriter) {
  for (const [sequence, table] of snapshotArchiveTables.entries()) {
    await store.append(writer, { sequence, table, rows: 0, done: true, bytes })
  }
  return await store.seal(writer)
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(db => db.destroy()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('completed staging is immutable and readable from an independent server connection', async () => {
  const { db, peer, store } = await fixture()
  const writer = await store.begin(binding)
  await expect(store.inspect(identity, writer.archiveId)).rejects.toThrow('unavailable')
  await expect(store.seal(writer)).rejects.toThrow('unavailable')
  await expect(new KnexSnapshotArchiveStore(peer).begin(binding)).rejects.toThrow('occupied')
  const manifest = await complete(store, writer)
  expect(manifest.pages).toBe(13)
  expect(manifest.rows).toBe(0)
  expect(manifest.binding).toEqual(binding)
  expect(manifest).not.toHaveProperty('writerToken')
  const secondServer = new KnexSnapshotArchiveStore(peer)
  expect(await secondServer.inspect(identity, writer.archiveId)).toEqual(manifest)
  expect(await secondServer.seal(writer)).toEqual(manifest)
  for (const [sequence, table] of snapshotArchiveTables.entries()) {
    const page = await secondServer.read(identity, writer.archiveId, sequence)
    expect(page).toMatchObject({ sequence, table, rows: 0, done: true, bytes })
    page.bytes.fill(0)
    expect((await store.read(identity, writer.archiveId, sequence)).bytes).toEqual(bytes)
  }
  await expect(secondServer.read(identity, writer.archiveId, 13)).rejects.toThrow('unavailable')
  await expect(
    secondServer.append(writer, { sequence: 13, table: 'syncStates', rows: 0, done: true, bytes })
  ).rejects.toThrow('unavailable')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({
    archives: 1,
    reservedBytes: snapshotArchiveLimits.archiveBytes
  })
  await secondServer.close(identity, writer.archiveId)
  await secondServer.close(identity, writer.archiveId)
  await expect(store.inspect(identity, writer.archiveId)).rejects.toThrow('unavailable')
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('mainnet source metadata survives sealing and cross-connection reads', async () => {
  const { peer, store } = await fixture()
  const mainnet: SnapshotArchiveBinding = {
    ...binding,
    sourceStorage: { ...binding.sourceStorage, chain: 'main' }
  }
  const writer = await store.begin(mainnet)
  const manifest = await complete(store, writer)
  const secondServer = new KnexSnapshotArchiveStore(peer)
  expect(manifest.binding).toEqual(mainnet)
  expect((await secondServer.inspect(identity, writer.archiveId)).binding).toEqual(mainnet)
  expect((await secondServer.read(identity, writer.archiveId, 12)).table).toBe('syncStates')
  await secondServer.close(identity, writer.archiveId)
  await expect(store.inspect(identity, writer.archiveId)).rejects.toThrow('unavailable')
})

test('a replacement server returns verified inclusion metadata without selecting payloads or writer credentials', async () => {
  const { db, peer, store } = await fixture()
  const writer = await store.begin(binding)
  await expect(store.directory(identity, writer.archiveId)).rejects.toThrow('unavailable')
  const manifest = await complete(store, writer)
  const second = new KnexSnapshotArchiveStore(peer)
  const queries: string[] = []
  const observe = (query: { sql: string }) => queries.push(query.sql)
  peer.on('query', observe)
  const directory = await second.directory(identity, writer.archiveId)
  peer.off('query', observe)
  const pageQueries = queries.filter(sql => sql.includes('snapshot_archive_pages'))
  expect(pageQueries).toHaveLength(1)
  expect(pageQueries[0]).not.toMatch(/payload|\*/)
  expect(pageQueries[0]).toContain('limit ?')
  expect(JSON.stringify(directory)).not.toContain(writer.writerToken)
  expect(directory.bindingJson).toBe((await db('snapshot_archives').first()).binding)
  const verified = verifySnapshotArchiveDirectory(directory, {
    identityKey: identity,
    chain: 'test',
    sourceStorageIdentityKey: 'source',
    archiveId: manifest.archiveId,
    digest: manifest.digest
  })
  expect(verified.manifest).toEqual(manifest)
  expect(verified.tables.syncStates).toEqual({ first: 12, pages: 1, rows: 0 })
  const last = await second.read(identity, writer.archiveId, verified.tables.syncStates.first)
  expect(verifySnapshotArchivePage(last, verified.receipts[12])).toEqual(bytes)
  directory.receipts[0].digest = 'f'.repeat(64)
  expect((await second.directory(identity, writer.archiveId)).receipts[0].digest).not.toBe('f'.repeat(64))
  await expect(second.directory(other, writer.archiveId)).rejects.toThrow('unavailable')
  await store.close(identity, writer.archiveId)
  await expect(second.directory(identity, writer.archiveId)).rejects.toThrow('unavailable')
})

test('a directory read refuses a missing staged receipt', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  await db('snapshot_archive_pages').where({ archiveId: writer.archiveId, sequence: 7 }).delete()
  await expect(store.directory(identity, writer.archiveId)).rejects.toThrow('unavailable')
})

test.each(['closing', 'expired'])('a directory read rechecks %s after loading receipts', async state => {
  const { db, peer, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  const original = db.client.query.bind(db.client)
  const intercept = jest.spyOn(db.client, 'query').mockImplementation(async (connection, query, ...rest) => {
    const result = await original(connection, query, ...rest)
    if (typeof query !== 'string' && query.sql.includes('from `snapshot_archive_pages`')) {
      await peer('snapshot_archives')
        .where({ archiveId: writer.archiveId })
        .update(state === 'closing' ? { state: 'closing' } : { expiresAt: 0 })
    }
    return result
  })
  try {
    await expect(store.directory(identity, writer.archiveId)).rejects.toThrow('unavailable')
  } finally {
    intercept.mockRestore()
  }
})

test('profile and internal capture ownership remain independent authorization boundaries', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await expect(
    store.append(
      { ...writer, writerToken: '0'.repeat(64) },
      { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes }
    )
  ).rejects.toThrow('unavailable')
  await complete(store, writer)
  await expect(store.inspect(other, writer.archiveId)).rejects.toThrow('unavailable')
  await expect(store.read(other, writer.archiveId, 0)).rejects.toThrow('unavailable')
  await store.close(other, writer.archiveId)
  expect((await store.inspect(identity, writer.archiveId)).pages).toBe(13)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1 })
})

test('lost page acknowledgements replay exactly, rejecting gaps and changed content or metadata', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  const first = { sequence: 0, table: 'provenTxs' as const, rows: 1, done: false, bytes: new Uint8Array([1, 2, 3]) }
  await store.append(writer, first)
  const before = await db('snapshot_archives').first()
  await store.append(writer, first)
  expect(await db('snapshot_archives').first()).toEqual(before)
  expect(await db('snapshot_archive_pages')).toHaveLength(1)
  for (const change of [{ bytes }, { rows: 2 }, { done: true }, { table: 'outputs' as const }, { sequence: 2 }]) {
    await expect(store.append(writer, { ...first, ...change })).rejects.toThrow('unavailable')
  }
  expect(await db('snapshot_archives').first()).toEqual(before)
  await expect(store.append(writer, { ...first, sequence: 1, table: 'outputs' })).rejects.toThrow('unavailable')
  await store.append(writer, { ...first, sequence: 1, rows: 0, done: true })
  expect((await db('snapshot_archives').first()).tableIndex).toBe(1)
})

test('an interrupted atomic append preserves the prior cursor, accounting and pages', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  const before = await db('snapshot_archives').first()
  await db.raw(
    "CREATE TRIGGER archive_checkpoint_failure BEFORE UPDATE ON snapshot_archives WHEN NEW.nextSequence > OLD.nextSequence BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END"
  )
  await expect(store.append(writer, { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes })).rejects.toThrow(
    'synthetic checkpoint failure'
  )
  await db.raw('DROP TRIGGER archive_checkpoint_failure')
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  expect(await db('snapshot_archives').first()).toEqual(before)
  await store.append(writer, { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes })
  expect(await db('snapshot_archive_pages')).toHaveLength(1)
})

test('quota exhaustion rejects before persistence and retains the original reservation', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding, { maxBytes: 8192 })
  const before = await db('snapshot_archives').first()
  await expect(
    store.append(writer, { sequence: 0, table: 'provenTxs', rows: 1, done: true, bytes: new Uint8Array(8192) })
  ).rejects.toThrow('reservation exhausted')
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  expect(await db('snapshot_archives').first()).toEqual(before)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 8192 })
  await store.close(identity, writer.archiveId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('independent profiles enforce both global byte and handle limits', async () => {
  const { db, peer, store } = await fixture()
  const owners: Array<{ identityKey: string; writer: SnapshotArchiveWriter }> = []
  for (let n = 0; n < 4; n++) {
    const identityKey = '02' + n.toString(16).padStart(64, '0')
    owners.push({ identityKey, writer: await store.begin({ ...binding, user: { ...binding.user, identityKey } }) })
  }
  await expect(new KnexSnapshotArchiveStore(peer).begin(binding)).rejects.toThrow('occupied')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 4, reservedBytes: 128 * 1024 * 1024 })
  for (const owner of owners) await store.close(owner.identityKey, owner.writer.archiveId)
  for (let n = 0; n < 8; n++) {
    await store.begin(
      { ...binding, user: { ...binding.user, identityKey: '02' + n.toString(16).padStart(64, '0') } },
      { maxBytes: 8192 }
    )
  }
  await expect(new KnexSnapshotArchiveStore(peer).begin(binding, { maxBytes: 8192 })).rejects.toThrow('occupied')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 8, reservedBytes: 65536 })
})

test('expiry from an independent store never publishes partial staging and reclaims its reservation', async () => {
  const { db, peer, store } = await fixture()
  const writer = await store.begin(binding)
  await store.append(writer, { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes })
  const restarted = new KnexSnapshotArchiveStore(peer)
  await expect(restarted.inspect(identity, writer.archiveId)).rejects.toThrow('unavailable')
  await db('snapshot_archives').where({ archiveId: writer.archiveId }).update({ expiresAt: 0 })
  await expect(
    store.append(writer, { sequence: 1, table: 'provenTxReqs', rows: 0, done: true, bytes })
  ).rejects.toThrow('unavailable')
  await expect(restarted.seal(writer)).rejects.toThrow('unavailable')
  await restarted.reap()
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  expect(await db('snapshot_archives')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('interrupted bounded cleanup remains recoverable and does not release capacity early', async () => {
  const { db, peer, store } = await fixture()
  const writer = await store.begin(binding)
  for (let sequence = 0; sequence < 70; sequence++) {
    await store.append(writer, { sequence, table: 'provenTxs', rows: 1, done: false, bytes })
  }
  const original = db.client.query.bind(db.client)
  let deletions = 0
  const failure = new Error('synthetic deletion failure')
  const intercept = jest.spyOn(db.client, 'query').mockImplementation(async (connection, query, ...rest) => {
    if (typeof query !== 'string' && query.sql.startsWith('delete from `snapshot_archive_pages`')) {
      if (++deletions === 2) throw failure
      expect(query.bindings.length).toBeLessThanOrEqual(33)
    }
    return await original(connection, query, ...rest)
  })
  await expect(store.close(identity, writer.archiveId)).rejects.toBe(failure)
  intercept.mockRestore()
  expect(await db('snapshot_archive_pages')).toHaveLength(38)
  expect((await db('snapshot_archives').first()).state).toBe('closing')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({
    archives: 1,
    reservedBytes: snapshotArchiveLimits.archiveBytes
  })
  const restarted = new KnexSnapshotArchiveStore(peer)
  await expect(restarted.begin(binding)).rejects.toThrow('occupied')
  await restarted.reap()
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await restarted.reap()
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('corrupted staged bytes are never returned as a verified page', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  await db('snapshot_archive_pages')
    .where({ archiveId: writer.archiveId, sequence: 0 })
    .update({ payload: Buffer.from([0]) })
  await expect(store.read(identity, writer.archiveId, 0)).rejects.toThrow('unavailable')
})

test('staging migration recovers partial auxiliary DDL without resetting existing reservations', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await addSnapshotArchiveTables(db)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1 })
  expect((await db('snapshot_archives').first()).archiveId).toBe(writer.archiveId)
  await store.close(identity, writer.archiveId)
  await db.schema.dropTable('snapshot_archive_pages')
  await addSnapshotArchiveTables(db)
  expect(await db.schema.hasTable('snapshot_archive_pages')).toBe(true)
  await removeSnapshotArchiveTables(db)
  for (const table of ['snapshot_archive_pages', 'snapshot_archives', 'snapshot_archive_capacity']) {
    expect(await db.schema.hasTable(table)).toBe(false)
  }
})

test('the exact page and reservation limits admit the boundary and reject the next byte', async () => {
  const { db, store } = await fixture()
  const payload = new Uint8Array(1024 * 1024).fill(7)
  const exactBytes = new TextEncoder().encode(JSON.stringify(binding)).length + 4096 + 512 + payload.length
  const writer = await store.begin(binding, { maxBytes: exactBytes })
  await store.append(writer, { sequence: 0, table: 'provenTxs', rows: 1000, done: false, bytes: payload })
  expect(Number((await db('snapshot_archives').first()).usedBytes)).toBe(exactBytes)
  await expect(store.append(writer, { sequence: 1, table: 'provenTxs', rows: 1, done: false, bytes })).rejects.toThrow(
    'reservation exhausted'
  )
  await store.close(identity, writer.archiveId)
  const next = await store.begin(binding)
  await expect(
    store.append(next, {
      sequence: 0,
      table: 'provenTxs',
      rows: 1,
      done: true,
      bytes: new Uint8Array(payload.length + 1)
    })
  ).rejects.toThrow('page')
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
})

test('caller mutation cannot rebind a pending archive or replace pending page bytes', async () => {
  const { db, store } = await fixture()
  const mutable = structuredClone(binding)
  const opening = store.begin(mutable)
  mutable.user.identityKey = other
  mutable.user.activeStorage = 'changed'
  mutable.sourceStorage.storageIdentityKey = 'changed'
  const writer = await opening
  expect((await db('snapshot_archives').first()).identityKey).toBe(identity)
  const payload = new Uint8Array([1, 2, 3])
  const append = store.append(writer, { sequence: 0, table: 'provenTxs', rows: 1, done: false, bytes: payload })
  payload.fill(0)
  await append
  expect(new Uint8Array((await db('snapshot_archive_pages').first()).payload)).toEqual(new Uint8Array([1, 2, 3]))
  expect(JSON.parse((await db('snapshot_archives').first()).binding).user.activeStorage).toBe('historical primary')
})

test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 3600001])(
  'invalid lifetime %s never reserves capacity',
  async lifetimeMs => {
    const { db, store } = await fixture()
    await expect(store.begin(binding, { lifetimeMs })).rejects.toThrow('lifetimeMs')
    expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  }
)

test.each([0, 4096, 1.5, Number.NaN, 33554433])(
  'invalid byte reservation %s never persists a handle',
  async maxBytes => {
    const { db, store } = await fixture()
    await expect(store.begin(binding, { maxBytes })).rejects.toThrow('maxBytes')
    expect(await db('snapshot_archives')).toHaveLength(0)
  }
)

test('metadata limits and original schema/profile bindings reject malformed inputs', async () => {
  const { db, store } = await fixture()
  const variants = [
    { ...binding, version: 2 },
    { ...binding, snapshotId: '' },
    { ...binding, sourceSchema: '' },
    { ...binding, sourceSchema: 'x'.repeat(257) },
    { ...binding, sourceSchema: 1 },
    { ...binding, sourceStorage: { ...binding.sourceStorage, chain: 'other' } },
    { ...binding, sourceStorage: { ...binding.sourceStorage, storageIdentityKey: '' } },
    { ...binding, sourceStorage: { ...binding.sourceStorage, storageIdentityKey: 'x'.repeat(131) } },
    { ...binding, sourceStorage: { ...binding.sourceStorage, storageIdentityKey: 1 } },
    { ...binding, sourceStorage: { ...binding.sourceStorage, created_at: new Date(Number.NaN) } },
    { ...binding, user: { ...binding.user, updated_at: '2026-01-01' } },
    { ...binding, user: { ...binding.user, userId: 0 } },
    { ...binding, user: { ...binding.user, identityKey: 'invalid' } }
  ]
  for (const value of variants)
    await expect(store.begin(value as SnapshotArchiveBinding)).rejects.toBeInstanceOf(WERR_INVALID_PARAMETER)
  await expect(
    store.begin({ ...binding, sourceStorage: { ...binding.sourceStorage, storageName: 'x'.repeat(65536) } })
  ).rejects.toThrow('metadata')
  await expect(store.begin(binding, { maxBytes: 4097 })).rejects.toThrow('metadata')
  expect(await db('snapshot_archives')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('invalid page shapes do not advance the capture', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  const first = { sequence: 0, table: 'provenTxs' as const, rows: 1, done: false, bytes }
  const variants = [
    { sequence: -1 },
    { sequence: 4096 },
    { rows: -1 },
    { rows: 1001 },
    { rows: 0 },
    { done: undefined },
    { bytes: [] },
    { bytes: new Uint8Array() },
    { table: 'users' }
  ]
  for (const variant of variants)
    await expect(store.append(writer, { ...first, ...variant } as typeof first)).rejects.toBeInstanceOf(
      WERR_INVALID_PARAMETER
    )
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  expect((await db('snapshot_archives').first()).nextSequence).toBe(0)
  for (const bad of ['', 'a'.repeat(63), 'g'.repeat(64)]) {
    await expect(store.inspect(identity, bad)).rejects.toThrow('archiveId')
    await expect(store.close(identity, bad)).rejects.toThrow('archiveId')
    await expect(store.seal({ ...writer, writerToken: bad })).rejects.toThrow('writerToken')
  }
  await expect(store.inspect('invalid', writer.archiveId)).rejects.toThrow('identityKey')
})

test('missing capacity metadata fails closed before creating a capture', async () => {
  const { db, store } = await fixture()
  await db('snapshot_archive_capacity').delete()
  await expect(store.begin(binding)).rejects.toThrow('schema is unavailable')
  expect(await db('snapshot_archives')).toHaveLength(0)
})

test('an expiry or close between header and payload reads cannot return a newly stale page', async () => {
  const { db, peer, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  const original = db.client.query.bind(db.client)
  let intercepted = false
  const intercept = jest.spyOn(db.client, 'query').mockImplementation(async (connection, query, ...rest) => {
    if (!intercepted && typeof query !== 'string' && query.sql.startsWith('select * from `snapshot_archive_pages`')) {
      intercepted = true
      await peer('snapshot_archives').where({ archiveId: writer.archiveId }).update({ expiresAt: 0 })
    }
    return await original(connection, query, ...rest)
  })
  await expect(store.read(identity, writer.archiveId, 0)).rejects.toThrow('unavailable')
  intercept.mockRestore()
  expect(intercepted).toBe(true)
})

test('missing persisted page content cannot become an acknowledged replay or read', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  await db('snapshot_archive_pages').where({ archiveId: writer.archiveId, sequence: 0 }).delete()
  await expect(store.append(writer, { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes })).rejects.toThrow(
    'unavailable'
  )
  await expect(store.read(identity, writer.archiveId, 0)).rejects.toThrow('unavailable')
})

test('capture cannot append or seal once cleanup has begun', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  await db('snapshot_archives').where({ archiveId: writer.archiveId }).update({ state: 'closing' })
  await expect(store.append(writer, { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes })).rejects.toThrow(
    'unavailable'
  )
  await expect(store.seal(writer)).rejects.toThrow('unavailable')
  await store.reap()
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('the MySQL adapter uses the shared database clock and a blob type admitting bounded pages', async () => {
  const { db, store } = await fixture()
  const raw = jest.fn(async () => [[{ now: '1790770000000' }]])
  const readClock = Reflect.get(store, 'now') as (database: unknown) => Promise<number>
  expect(await readClock.call(store, { client: { config: { client: 'mysql2' } }, raw })).toBe(1790770000000)
  expect(raw).toHaveBeenCalledWith('SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now')
  await db.schema.dropTable('snapshot_archive_pages')
  const original = db.client.config.client
  try {
    // Keep the SQLite executor while checking the dialect-dependent declared
    // type. Native MySQL qualification independently executes the emitted DDL.
    db.client.config.client = 'mysql2'
    await addSnapshotArchiveTables(db)
  } finally {
    db.client.config.client = original
  }
  const columns: Array<{ name: string; type: string }> = await db.raw('PRAGMA table_info(snapshot_archive_pages)')
  expect(columns.find(column => column.name === 'payload')?.type.toUpperCase()).toBe('MEDIUMBLOB')
})

test('parallel profile captures never overwrite, seal, or collect each other', async () => {
  const { db, store } = await fixture()
  const second = await store.begin({ ...binding, user: { ...binding.user, identityKey: other } }, { maxBytes: 16384 })
  const secondBefore = await db('snapshot_archives').where({ archiveId: second.archiveId }).first()
  const first = await store.begin(binding, { maxBytes: 32768 })
  await complete(store, first)
  expect(await db('snapshot_archives').where({ archiveId: second.archiveId }).first()).toEqual(secondBefore)
  const secondManifest = await complete(store, second)
  const secondPages = await db('snapshot_archive_pages').where({ archiveId: second.archiveId }).orderBy('sequence')
  const projections: string[] = []
  const observe = (query: { sql: string }): void => {
    if (query.sql.startsWith('select') && query.sql.includes('snapshot_archive_pages')) projections.push(query.sql)
  }
  db.on('query', observe)
  await Promise.all([store.close(identity, first.archiveId), store.close(identity, first.archiveId)])
  db.removeListener('query', observe)
  expect(projections.length).toBeGreaterThan(0)
  expect(projections.every(query => query.startsWith('select `sequence` from'))).toBe(true)
  expect(await store.inspect(other, second.archiveId)).toEqual(secondManifest)
  expect(await db('snapshot_archive_pages').where({ archiveId: second.archiveId }).orderBy('sequence')).toEqual(
    secondPages
  )
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 16384 })
  await store.close(other, second.archiveId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('valid identifier and metadata boundary values remain admitted', async () => {
  const { store } = await fixture()
  for (const sourceSchema of ['x', 'x'.repeat(256)]) {
    for (const storageIdentityKey of ['x', 'x'.repeat(130)]) {
      const writer = await store.begin({
        ...binding,
        sourceSchema,
        sourceStorage: { ...binding.sourceStorage, storageIdentityKey }
      })
      await store.close(identity, writer.archiveId)
    }
  }
  const base = new TextEncoder().encode(JSON.stringify(binding)).length
  const large = {
    ...binding,
    sourceStorage: {
      ...binding.sourceStorage,
      storageName: 'x'.repeat(65536 - base + binding.sourceStorage.storageName.length)
    }
  }
  expect(new TextEncoder().encode(JSON.stringify(large))).toHaveLength(65536)
  const writer = await store.begin(large, { maxBytes: 65536 + 4096 })
  await store.close(identity, writer.archiveId)
})

test('identifiers reject prefixes, suffixes and non-string coercions before SQL', async () => {
  const { store } = await fixture()
  const writer = await store.begin(binding)
  for (const bad of ['x' + writer.archiveId, writer.archiveId + 'x', { toString: () => writer.archiveId }]) {
    await expect(store.inspect(identity, bad as string)).rejects.toBeInstanceOf(WERR_INVALID_PARAMETER)
    await expect(store.seal({ ...writer, archiveId: bad as string })).rejects.toBeInstanceOf(WERR_INVALID_PARAMETER)
  }
  for (const bad of ['x' + identity, identity + 'x', { toString: () => identity }]) {
    await expect(store.inspect(bad as string, writer.archiveId)).rejects.toBeInstanceOf(WERR_INVALID_PARAMETER)
  }
  for (const malformed of [undefined, { ...binding, user: undefined }, { ...binding, sourceStorage: undefined }]) {
    await expect(store.begin(malformed as unknown as SnapshotArchiveBinding)).rejects.toBeInstanceOf(
      WERR_INVALID_PARAMETER
    )
  }
})

test('expiry is inclusive at the shared-clock boundary for both writer and reader', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  const row = await db('snapshot_archives').first()
  const readClock = jest
    .spyOn(store as unknown as { now: () => Promise<number> }, 'now')
    .mockResolvedValue(Number(row.expiresAt))
  try {
    await expect(store.seal(writer)).rejects.toThrow('unavailable')
    await expect(store.read(identity, writer.archiveId, 0)).rejects.toThrow('unavailable')
  } finally {
    readClock.mockRestore()
  }
})

test('only acknowledged sequence positions are readable, even if an unacknowledged page exists', async () => {
  const { db, store } = await fixture()
  const writer = await store.begin(binding)
  await complete(store, writer)
  const page = await db('snapshot_archive_pages').where({ archiveId: writer.archiveId, sequence: 0 }).first()
  await db('snapshot_archive_pages').insert({ ...page, sequence: 13 })
  await expect(store.read(identity, writer.archiveId, 13)).rejects.toThrow('unavailable')
  for (const sequence of [-1, 4096]) {
    await expect(store.read(identity, writer.archiveId, sequence)).rejects.toBeInstanceOf(WERR_INVALID_PARAMETER)
    await expect(
      store.append(writer, { sequence, table: 'provenTxs', rows: 0, done: true, bytes })
    ).rejects.toBeInstanceOf(WERR_INVALID_PARAMETER)
  }
})

test('the auxiliary migration is registered after the durable sync schema', async () => {
  const migrations = new KnexMigrations('test', 'source', 'source', 1024)
  expect(await migrations.getLatestMigration()).toBe('2026-09-30-003 add snapshot archive requests')
})

test('MySQL DDL accommodates the declared metadata and page byte ceilings', async () => {
  const mysql = knex({ client: 'mysql2' })
  const commands: string[] = []
  const fake = Object.assign(() => ({ insert: () => ({ onConflict: () => ({ ignore: async () => undefined }) }) }), {
    client: mysql.client,
    schema: {
      hasTable: async () => false,
      createTable: async (name: string, define: (table: Knex.CreateTableBuilder) => void) => {
        commands.push(
          ...mysql.schema
            .createTable(name, define)
            .toSQL()
            .map(query => query.sql)
        )
      }
    }
  })
  try {
    await addSnapshotArchiveTables(fake as unknown as Knex)
    expect(commands.find(sql => sql.startsWith('create table `snapshot_archives`'))).toContain(
      '`binding` mediumtext not null'
    )
    expect(commands.find(sql => sql.startsWith('create table `snapshot_archive_pages`'))).toContain(
      '`payload` MEDIUMBLOB not null'
    )
  } finally {
    await mysql.destroy()
  }
})
