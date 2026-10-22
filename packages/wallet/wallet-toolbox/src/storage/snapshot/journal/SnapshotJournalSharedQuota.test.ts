import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  withSnapshotJournalOwnedWriter,
  requireSnapshotJournalOwnedWriter,
  withSnapshotJournalOwnedSavepoint
} from './SnapshotJournalOwnedWriter'
import { snapshotJournalProvenanceDdl } from './SnapshotJournalProvenance'
import {
  snapshotJournalFieldCacheDdl,
  snapshotJournalFieldCacheNames,
  beginSnapshotJournalFieldCache,
  appendSnapshotJournalFieldCache,
  readSnapshotJournalFieldCacheChunk,
  readSnapshotJournalFieldCacheVersion,
  sealSnapshotJournalFieldCache,
  retireSnapshotJournalFieldCache,
  collectSnapshotJournalFieldCacheVersion,
  type SnapshotJournalFieldCacheScope
} from './SnapshotJournalNativePayload'
import { knex, type Knex } from 'knex'
import {
  SNAPSHOT_JOURNAL_SHARED_QUOTA,
  SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
  SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
  snapshotJournalSharedQuotaDdl,
  snapshotJournalSharedQuotaTriggers
} from './SnapshotJournalSharedQuota'

const table = 'snapshot_reconciliation_independent_fixture'
const ddl = `CREATE TABLE ${table}(id INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id))`
const charge = (id: number, payload: string): number =>
  4096 + 4 * (Buffer.byteLength(String(id), 'utf8') + Buffer.byteLength(payload, 'utf8'))

async function fixture(work: (database: Knex) => Promise<void>): Promise<void> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await database.raw(snapshotJournalSharedQuotaDdl(database))
    await database.raw(ddl)
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).insert({
      id: 0,
      byteLimit: SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
      rowLimit: SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
      bytes: 0,
      rows: 0,
      changeBit: 0
    })
    for (const trigger of snapshotJournalSharedQuotaTriggers(database, [ddl])) await database.raw(trigger.sql)
    await work(database)
  } finally {
    await database.destroy()
  }
}

test('physical SQLite quota triggers retain independent UTF8 charges across inserts, conflict updates and deletion', async () => {
  await fixture(async database => {
    const counter = async () => await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).first('bytes', 'rows')
    await database(table).insert({ id: 12, payload: 'é😀' })
    await database(table).insert({ id: -7, payload: '' })
    expect(await counter()).toEqual({ bytes: charge(12, 'é😀') + charge(-7, ''), rows: 2 })
    await database(table).insert({ id: 12, payload: 'replacement 名字' }).onConflict('id').merge()
    expect(await counter()).toEqual({ bytes: charge(12, 'replacement 名字') + charge(-7, ''), rows: 2 })
    await expect(database(table).insert({ id: 12, payload: 'duplicate' })).rejects.toThrow()
    expect(await counter()).toEqual({ bytes: charge(12, 'replacement 名字') + charge(-7, ''), rows: 2 })
    await database(table).where('id', 12).update({ payload: '' })
    expect(await counter()).toEqual({ bytes: charge(12, '') + charge(-7, ''), rows: 2 })
    await database(table).where('id', -7).delete()
    expect(await counter()).toEqual({ bytes: charge(12, ''), rows: 1 })
    await database(table).where('id', 12).delete()
    expect(await counter()).toEqual({ bytes: 0, rows: 0 })
  })
})

test('SQLite quota exhaustion and inconsistent counter underflow preserve actual rows and counters atomically', async () => {
  await fixture(async database => {
    const initial = SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT - charge(1, 'original') + 1
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).update({ bytes: initial })
    await expect(database(table).insert({ id: 1, payload: 'original' })).rejects.toThrow(
      'Shared journal quota exhausted or inconsistent'
    )
    expect(await database(table)).toEqual([])
    expect(await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).first('bytes', 'rows')).toEqual({
      bytes: initial,
      rows: 0
    })
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).update({ bytes: 0 })
    await database(table).insert({ id: 1, payload: 'original' })
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).update({ bytes: 0 })
    await expect(database(table).where('id', 1).delete()).rejects.toThrow(
      'Shared journal quota exhausted or inconsistent'
    )
    expect(await database(table)).toEqual([{ id: 1, payload: 'original' }])
    expect(await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).first('bytes', 'rows')).toEqual({
      bytes: 0,
      rows: 1
    })
  })
})

async function fieldCustodyFixture(
  work: (
    database: Knex,
    write: <T>(operation: (trx: Knex, scope: SnapshotJournalFieldCacheScope) => Promise<T>) => Promise<T>
  ) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'journal-field-custody-')),
    database = knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'target.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  try {
    await database.raw('PRAGMA journal_mode=WAL')
    const ddl = [...snapshotJournalProvenanceDdl(database), ...snapshotJournalFieldCacheDdl(database)]
    await database.raw(snapshotJournalSharedQuotaDdl(database))
    for (const sql of ddl) await database.raw(sql)
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).insert({
      id: 0,
      byteLimit: SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
      rowLimit: SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
      bytes: 0,
      rows: 0,
      changeBit: 0
    })
    for (const trigger of snapshotJournalSharedQuotaTriggers(database, ddl)) await database.raw(trigger.sql)
    const write = async <T>(operation: (trx: Knex, scope: SnapshotJournalFieldCacheScope) => Promise<T>): Promise<T> =>
      await withSnapshotJournalOwnedWriter(
        database.client.config,
        () => undefined,
        async (trx, backend) =>
          await operation(trx, { root: database, backend, userId: 7, lineage: 'a'.repeat(64), maximumBytes: 65536 }),
        undefined,
        database
      )
    await work(database, write)
  } finally {
    await database.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
}
const fieldInput = (bytes: Uint8Array) => ({
  userId: 7,
  lineage: 'a'.repeat(64),
  sourceStorageIdentity: 'independent-source',
  sessionId: 'b'.repeat(64),
  windowBinding: 'c'.repeat(64),
  frameDigest: 'd'.repeat(64),
  changeIndex: 0,
  incomingId: -7,
  sourceGeneration: 'e'.repeat(64),
  sourceRevision: '9223372036854775807',
  fieldName: 'syncMap',
  kind: 'binary' as const,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  expiresAt: Date.now() + 60000
})

test('field custody uses actual current physical SQL writers, resumes charged chunks and detects direct byte events', async () => {
  await fieldCustodyFixture(async (database, write) => {
    const bytes = Buffer.from('independent\u0000雪😀'.repeat(1200)),
      input = fieldInput(bytes)
    let lastWriter: { trx: Knex; scope: SnapshotJournalFieldCacheScope } | undefined
    let header = await write(async (trx, scope) => {
      requireSnapshotJournalOwnedWriter(trx, database, scope.backend)
      let finishedChild: Knex | undefined
      await withSnapshotJournalOwnedSavepoint(trx, async child => {
        requireSnapshotJournalOwnedWriter(child, database, scope.backend)
        finishedChild = child
        await withSnapshotJournalOwnedSavepoint(child, async grandchild => {
          requireSnapshotJournalOwnedWriter(grandchild, database, scope.backend)
          expect(() => requireSnapshotJournalOwnedWriter(Object.create(grandchild), database, scope.backend)).toThrow()
        })
      })
      expect(() => requireSnapshotJournalOwnedWriter(finishedChild!, database, scope.backend)).toThrow()
      requireSnapshotJournalOwnedWriter(trx, database, scope.backend)
      expect(() => requireSnapshotJournalOwnedWriter(Object.create(trx), database, scope.backend)).toThrow(
        'Actual current'
      )
      expect(() => requireSnapshotJournalOwnedWriter(trx, database, 'wrong-backend')).toThrow('Actual current')
      const other = knex(database.client.config)
      try {
        expect(() => requireSnapshotJournalOwnedWriter(trx, other, scope.backend)).toThrow('Actual current')
      } finally {
        await other.destroy()
      }
      lastWriter = { trx, scope }
      return await beginSnapshotJournalFieldCache(trx, scope, input)
    })
    if (lastWriter === undefined) throw new Error('Actual writer was not observed')
    expect(() => requireSnapshotJournalOwnedWriter(lastWriter!.trx, database, lastWriter!.scope.backend)).toThrow(
      'Actual current'
    )
    const first = bytes.subarray(0, 16384)
    header = await write(async (trx, scope) => await appendSnapshotJournalFieldCache(trx, scope, header, first))
    const resumed = await write(async (trx, scope) => await beginSnapshotJournalFieldCache(trx, scope, input))
    expect(resumed).toEqual(header)
    expect((await database(snapshotJournalFieldCacheNames.budgets).first()).reserved).toBe(bytes.length)
    header = await write(
      async (trx, scope) => await appendSnapshotJournalFieldCache(trx, scope, resumed, bytes.subarray(first.length))
    )
    const independentlyRead = await write(async (trx, scope) => {
      const hash = createHash('sha256')
      let offset = 0
      while (offset < header.accepted) {
        const chunk = await readSnapshotJournalFieldCacheChunk(trx, scope, header, offset)
        try {
          hash.update(chunk.bytes)
          offset = chunk.nextOffset
        } finally {
          chunk.bytes.fill(0)
        }
      }
      expect((await readSnapshotJournalFieldCacheChunk(trx, scope, header, offset)).bytes).toHaveLength(0)
      return hash.digest('hex')
    })
    expect(independentlyRead).toBe(input.sha256)
    header = await write(async (trx, scope) => await sealSnapshotJournalFieldCache(trx, scope, header))
    const before = header
    const changed = Buffer.from(bytes.subarray(0, 16384))
    changed[0] ^= 1
    await database(snapshotJournalFieldCacheNames.chunks)
      .where({ versionId: header.versionId, byteOffset: 0 })
      .update({ payload: changed, sha256: createHash('sha256').update(changed).digest('hex') })
    await expect(
      write(async (trx, scope) => await readSnapshotJournalFieldCacheChunk(trx, scope, before, 0))
    ).rejects.toThrow('Journal payload differs')
    await database(snapshotJournalFieldCacheNames.chunks)
      .where({ versionId: header.versionId, byteOffset: 0 })
      .update({ payload: first, sha256: createHash('sha256').update(first).digest('hex') })
    header = await write(async (trx, scope) => await readSnapshotJournalFieldCacheVersion(trx, scope, header.versionId))
    expect(BigInt(header.revision)).toBe(BigInt(before.revision) + 2n)
    await expect(
      database(snapshotJournalFieldCacheNames.versions)
        .where('versionId', header.versionId)
        .update({ sha256: '0'.repeat(64), revision: database.raw('revision+1') })
    ).rejects.toThrow('custody differs')
    header = await write(async (trx, scope) => await retireSnapshotJournalFieldCache(trx, scope, header))
    expect(await write(async (trx, scope) => await collectSnapshotJournalFieldCacheVersion(trx, scope, header))).toBe(
      true
    )
    expect((await database(snapshotJournalFieldCacheNames.budgets).first()).reserved).toBe(0)
    expect((await database(snapshotJournalFieldCacheNames.budgets).first()).versions).toBe(0)
    bytes.fill(0)
    changed.fill(0)
  })
})
test('field custody atomically refuses quota, oversized chunks, incomplete sealing and failed append transactions', async () => {
  await fieldCustodyFixture(async (database, write) => {
    const bytes = new Uint8Array(32768),
      input = fieldInput(bytes)
    let header = await write(async (trx, scope) => await beginSnapshotJournalFieldCache(trx, scope, input))
    await expect(
      write(
        async (trx, scope) =>
          await beginSnapshotJournalFieldCache(trx, scope, { ...input, fieldName: 'errorLocal', bytes: 40000 })
      )
    ).rejects.toThrow('logical capacity')
    await expect(
      write(async (trx, scope) => await appendSnapshotJournalFieldCache(trx, scope, header, bytes))
    ).rejects.toThrow()
    await expect(write(async (trx, scope) => await sealSnapshotJournalFieldCache(trx, scope, header))).rejects.toThrow()
    const rollback = new Error('Independent append rollback')
    await expect(
      write(async (trx, scope) => {
        await appendSnapshotJournalFieldCache(trx, scope, header, bytes.subarray(0, 16384))
        throw rollback
      })
    ).rejects.toBe(rollback)
    expect(await database(snapshotJournalFieldCacheNames.chunks)).toHaveLength(0)
    expect(
      await write(async (trx, scope) => await readSnapshotJournalFieldCacheVersion(trx, scope, header.versionId))
    ).toEqual(header)
    header = await write(async (trx, scope) => await retireSnapshotJournalFieldCache(trx, scope, header))
    expect(await write(async (trx, scope) => await collectSnapshotJournalFieldCacheVersion(trx, scope, header))).toBe(
      true
    )
  })
})
