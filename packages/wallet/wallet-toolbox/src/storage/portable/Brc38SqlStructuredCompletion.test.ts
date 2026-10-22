import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createKnex, { type Knex } from 'knex'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  beginBrc38SqlCanonicalStructuredField,
  appendBrc38SqlCanonicalStructuredField,
  completeBrc38SqlCanonicalStructuredField
} from './Brc38SqlCanonicalStructuredStaging'
import { completeBrc38SqlStructuredField } from './Brc38SqlStructuredStaging'
import {
  installBrc38SqlStructuredPrefixGuards,
  verifyBrc38SqlStructuredPrefixGuards
} from './Brc38SqlStructuredPrefixGuards'

test.each(['binary', 'structured', 'canonical', 'text'] as const)(
  '%s exact prefix checks use one bounded round trip and refuse each changed or missing definition freshly',
  async family => {
    const db = createKnex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      }),
      fields = family === 'canonical' ? 'private_canonical_structured_fields' : `private_${family}_fields`,
      chunks = fields.replace(/fields$/, 'chunks')
    try {
      await db.raw(
        'CREATE TABLE ??(tableName,position,field,encoding,maximumBytes,sourceBytes,sourceSha256,state,bytes,chunks,sha256)',
        [fields]
      )
      await db.raw('CREATE TABLE ??(tableName,position,field,offset,bytes,payload)', [chunks])
      await db.transaction(async trx => await installBrc38SqlStructuredPrefixGuards(trx, family))
      let queries = 0,
        requestBytes = 0
      const observe = (query: { sql: string; bindings: unknown[] }): void => {
        queries++
        requestBytes = Math.max(requestBytes, Buffer.byteLength(JSON.stringify(query)))
      }
      db.on('query', observe)
      try {
        expect(await verifyBrc38SqlStructuredPrefixGuards(db, family)).toBe(6)
      } finally {
        db.off('query', observe)
      }
      expect(queries).toBe(1)
      expect(requestBytes).toBeLessThan(65536)
      for (const table of [fields, chunks])
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          const name = `${table}_prefix_${operation.toLowerCase()}`,
            original = await db('sqlite_schema').where({ name }).first('sql')
          await db.raw('DROP TRIGGER ??', [name])
          await expect(verifyBrc38SqlStructuredPrefixGuards(db, family)).rejects.toThrow('definitions differ')
          await db.raw(`CREATE TRIGGER ?? BEFORE ${operation} ON ?? BEGIN SELECT 1; END`, [name, table])
          expect(await db('sqlite_schema').where({ type: 'trigger' }).count({ count: '*' }).first()).toEqual({
            count: 6
          })
          await expect(verifyBrc38SqlStructuredPrefixGuards(db, family)).rejects.toThrow('definitions differ')
          await db.raw('DROP TRIGGER ??', [name])
          await db.raw(original.sql)
          expect(await verifyBrc38SqlStructuredPrefixGuards(db, family)).toBe(6)
        }
    } finally {
      await db.destroy()
    }
  }
)

/** Authored UNRUN. Provisional SQLite source checks, not native qualification. */
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'brc38-structured-completion-')),
    store = await KnexBrc38StagingStore.create(parent, {
      maximumRows: 100,
      maximumLogicalBytes: 2097152,
      maximumPhysicalBytes: 16777216,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 65536,
      expiresAt: Date.now() + 60000
    }),
    bytes = Buffer.from('[' + '0,'.repeat(65536) + '0]'),
    descriptor = {
      field: 'history',
      encoding: 'utf8-json' as const,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  try {
    await store.beginStructuredField('provenTxReqs', 0, 'history', bytes.byteLength + 16)
    for (let offset = 0; offset < bytes.byteLength; offset += 65536)
      await store.appendStructuredField('provenTxReqs', 0, 'history', offset, bytes.subarray(offset, offset + 65536))
    return {
      store,
      bytes,
      descriptor,
      close: async () => {
        await store.discard(new Error('fixture cleanup'))
        await rm(parent, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    await store.discard(cause)
    await rm(parent, { recursive: true, force: true })
    throw cause
  }
}
test('original staging completion hashes allocation-sized windows in query-only mode before its short writer', async () => {
  const f = await fixture()
  let read = false,
    windows = 0,
    writes = 0,
    queries = 0
  const observe = (query: { sql: string }): void => {
    if (++queries > 8192 || query.sql.length > 65536) throw new Error('Finite SQL observation exceeded')
    if (/^PRAGMA query_only=ON$/i.test(query.sql)) read = true
    if (/^PRAGMA query_only=OFF$/i.test(query.sql)) read = false
    if (/select/i.test(query.sql) && /substr\(payload/i.test(query.sql)) {
      if (!read) throw new Error('Completion read source bytes in its writer')
      windows++
    }
    if (/^update /i.test(query.sql)) {
      if (read) throw new Error('Completion wrote through its read transaction')
      writes++
    }
  }
  try {
    f.store.knex.on('query', observe)
    await f.store.finishStructuredField('provenTxReqs', 0, f.descriptor)
    f.store.knex.off('query', observe)
    expect(windows).toBeGreaterThan(3)
    expect(writes).toBe(1)
    expect(read).toBe(false)
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
    expect(await f.store.readStructuredFieldChunk('provenTxReqs', 0, 'history', 0)).toMatchObject({
      descriptor: f.descriptor,
      offset: 0,
      bytes: f.bytes.subarray(0, 65536)
    })
  } finally {
    f.store.knex.off('query', observe)
    await f.close()
  }
})
test.each(['structured', 'canonical'] as const)(
  '%s prefixes cannot be rewritten or replaced between completion read and writer',
  async family => {
    const f = await fixture(),
      fields = family === 'structured' ? 'private_structured_fields' : 'private_canonical_structured_fields',
      chunks = fields.replace(/fields$/, 'chunks'),
      complete = family === 'structured' ? completeBrc38SqlStructuredField : completeBrc38SqlCanonicalStructuredField
    try {
      if (family === 'canonical')
        await f.store.knex.transaction(async trx => {
          await beginBrc38SqlCanonicalStructuredField(
            trx,
            'provenTxReqs',
            0,
            'history',
            'utf8-json',
            f.bytes.byteLength,
            f.store.limits.maximumLogicalBytes,
            f.store.limits.maximumRows,
            f.descriptor
          )
          for (let offset = 0; offset < f.bytes.byteLength; offset += 65536)
            await appendBrc38SqlCanonicalStructuredField(
              trx,
              'provenTxReqs',
              0,
              'history',
              offset,
              f.bytes.subarray(offset, offset + 65536),
              f.store.limits.maximumLogicalBytes
            )
        })
      await verifyBrc38SqlStructuredPrefixGuards(f.store.knex, family)
      const key = { tableName: 'provenTxReqs', position: 0, field: 'history', offset: 0 },
        original = await f.store.knex(chunks).where(key).first(),
        withRead = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
          await f.store.knex.transaction(async trx => {
            await trx.raw('PRAGMA query_only=ON')
            try {
              return await work(trx)
            } finally {
              await trx.raw('PRAGMA query_only=OFF')
            }
          }),
        withWrite = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
          await expect(
            f.store
              .knex(chunks)
              .where(key)
              .update({ payload: Buffer.alloc(original.bytes) })
          ).rejects.toThrow()
          await expect(f.store.knex(chunks).where(key).delete()).rejects.toThrow()
          await expect(
            f.store.knex.raw('INSERT OR REPLACE INTO ?? SELECT * FROM ?? WHERE offset=0', [chunks, chunks])
          ).rejects.toThrow()
          await expect(
            f.store
              .knex(fields)
              .where({ tableName: key.tableName, position: 0, field: 'history' })
              .update({ bytes: f.bytes.byteLength - 1 })
          ).rejects.toThrow()
          return await f.store.knex.transaction(work)
        }
      await complete(withRead, withWrite, 'provenTxReqs', 0, f.descriptor, () => {}, 1024)
      expect(await f.store.knex(chunks).where(key).first()).toEqual(original)
      expect(await f.store.knex(fields).first('state', 'sha256')).toEqual({
        state: 'complete',
        sha256: f.descriptor.sha256
      })
    } finally {
      await f.close()
    }
  }
)
test('a failed content hash leaves provisional state and restores the original connection mode', async () => {
  const f = await fixture()
  try {
    await expect(
      f.store.finishStructuredField('provenTxReqs', 0, { ...f.descriptor, sha256: 'a'.repeat(64) })
    ).rejects.toThrow('content or coordinate differs')
    expect(await f.store.knex('private_structured_fields').first('state', 'sha256')).toEqual({
      state: 'writing',
      sha256: null
    })
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
    await f.store.finishStructuredField('provenTxReqs', 0, f.descriptor)
  } finally {
    await f.close()
  }
})
test('an actual appended prefix after read drainage invalidates completion instead of reusing the earlier hash', async () => {
  const f = await fixture()
  try {
    const withRead = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
        await f.store.knex.transaction(async trx => {
          await trx.raw('PRAGMA query_only=ON')
          try {
            return await work(trx)
          } finally {
            await trx.raw('PRAGMA query_only=OFF')
          }
        }),
      withWrite = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
        await f.store.appendStructuredField('provenTxReqs', 0, 'history', f.bytes.byteLength, new Uint8Array([32]))
        return await f.store.knex.transaction(work)
      }
    await expect(
      completeBrc38SqlStructuredField(withRead, withWrite, 'provenTxReqs', 0, f.descriptor, () => {}, 1024)
    ).rejects.toThrow('content or coordinate differs')
    expect(await f.store.knex('private_structured_fields').first('state', 'sha256', 'bytes')).toEqual({
      state: 'writing',
      sha256: null,
      bytes: f.bytes.byteLength + 1
    })
    const extended = Buffer.concat([f.bytes, Buffer.from(' ')])
    await f.store.finishStructuredField('provenTxReqs', 0, {
      ...f.descriptor,
      bytes: extended.byteLength,
      sha256: createHash('sha256').update(extended).digest('hex')
    })
  } finally {
    await f.close()
  }
})
test.each(['structured', 'canonical'] as const)(
  '%s completion compares current DDL generation even when prefix SQL is restored exactly',
  async family => {
    const f = await fixture(),
      fields = family === 'structured' ? 'private_structured_fields' : 'private_canonical_structured_fields',
      chunks = fields.replace(/fields$/, 'chunks'),
      complete = family === 'structured' ? completeBrc38SqlStructuredField : completeBrc38SqlCanonicalStructuredField
    try {
      if (family === 'canonical')
        await f.store.knex.transaction(async trx => {
          await beginBrc38SqlCanonicalStructuredField(
            trx,
            'provenTxReqs',
            0,
            'history',
            'utf8-json',
            f.bytes.byteLength,
            f.store.limits.maximumLogicalBytes,
            f.store.limits.maximumRows,
            f.descriptor
          )
          for (let offset = 0; offset < f.bytes.byteLength; offset += 65536)
            await appendBrc38SqlCanonicalStructuredField(
              trx,
              'provenTxReqs',
              0,
              'history',
              offset,
              f.bytes.subarray(offset, offset + 65536),
              f.store.limits.maximumLogicalBytes
            )
        })
      const guard = await f.store
          .knex('sqlite_schema')
          .where({ name: `${chunks}_prefix_update` })
          .first('sql'),
        withRead = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
          await f.store.knex.transaction(async trx => {
            await trx.raw('PRAGMA query_only=ON')
            try {
              return await work(trx)
            } finally {
              await trx.raw('PRAGMA query_only=OFF')
            }
          }),
        withWrite = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
          await f.store.knex.raw(`DROP TRIGGER ${chunks}_prefix_update`)
          await f.store.knex.raw(guard.sql)
          return await f.store.knex.transaction(work)
        }
      await expect(complete(withRead, withWrite, 'provenTxReqs', 0, f.descriptor, () => {}, 1024)).rejects.toThrow(
        'content or coordinate differs'
      )
      expect(await f.store.knex(fields).first('state', 'sha256')).toEqual({ state: 'writing', sha256: null })
    } finally {
      await f.close()
    }
  }
)
