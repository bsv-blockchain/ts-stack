import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { completeBrc38SqlBinaryField } from './Brc38SqlBinaryStaging'
import { verifyBrc38SqlStructuredPrefixGuards } from './Brc38SqlStructuredPrefixGuards'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
/** Authored UNRUN. Actual provisional SQLite operations, not native qualification. */
async function fixture(size = 131089) {
  const parent = await mkdtemp(join(tmpdir(), 'brc38-binary-completion-')),
    store = await KnexBrc38StagingStore.create(parent, {
      maximumRows: 100,
      maximumLogicalBytes: 2097152,
      maximumPhysicalBytes: 16777216,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 65536,
      expiresAt: Date.now() + 60000
    }),
    bytes = Buffer.alloc(size, 37),
    descriptor = { field: 'rawTx', encoding: 'base64' as const, bytes: size, sha256: digest(bytes) }
  try {
    await store.beginBinaryField('transactions', 0, 'rawTx', 'base64', size + 16)
    for (let offset = 0; offset < size; offset += 65536)
      await store.appendBinaryField('transactions', 0, 'rawTx', offset, bytes.subarray(offset, offset + 65536))
    return {
      store,
      bytes,
      descriptor,
      close: async () => {
        bytes.fill(0)
        await store.discard(new Error('fixture cleanup'))
        await rm(parent, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    bytes.fill(0)
    await store.discard(cause)
    await rm(parent, { recursive: true, force: true })
    throw cause
  }
}
const withRead =
  (store: KnexBrc38StagingStore) =>
  async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
    await store.knex.transaction(async trx => {
      await trx.raw('PRAGMA query_only=ON')
      try {
        return await work(trx)
      } finally {
        await trx.raw('PRAGMA query_only=OFF')
      }
    })

test.each([0, 131089])('binary completion of %i bytes hashes only in its drained query-only phase', async size => {
  const f = await fixture(size)
  let read = false,
    windows = 0,
    writes = 0,
    queries = 0
  const observe = (query: { sql: string }): void => {
    if (++queries > 8192 || query.sql.length > 65536) throw new Error('Finite SQL observation exceeded')
    if (/^PRAGMA query_only=ON$/i.test(query.sql)) read = true
    if (/^PRAGMA query_only=OFF$/i.test(query.sql)) read = false
    if (/select/i.test(query.sql) && /substr\(payload/i.test(query.sql)) {
      if (!read) throw new Error('Binary completion read content in its writer')
      windows++
    }
    if (/^update /i.test(query.sql)) {
      if (read) throw new Error('Binary completion wrote in query-only mode')
      writes++
    }
  }
  try {
    f.store.knex.on('query', observe)
    await f.store.finishBinaryField('transactions', 0, f.descriptor)
    f.store.knex.off('query', observe)
    if (size === 0) expect(windows).toBe(0)
    else expect(windows).toBeGreaterThan(3)
    expect(writes).toBe(1)
    expect(read).toBe(false)
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
    expect(await f.store.knex('private_binary_fields').first('state', 'sha256', 'bytes')).toEqual({
      state: 'complete',
      sha256: f.descriptor.sha256,
      bytes: size
    })
    const chunk = await f.store.readBinaryFieldChunk('transactions', 0, 'rawTx', 0)
    if (size === 0) expect(chunk).toBeUndefined()
    else {
      expect(chunk!.bytes).toEqual(f.bytes.subarray(0, 65536))
      chunk!.bytes.fill(0)
    }
  } finally {
    f.store.knex.off('query', observe)
    await f.close()
  }
})
test('binary provisional prefixes cannot be replaced between content read and completion', async () => {
  const f = await fixture()
  try {
    await verifyBrc38SqlStructuredPrefixGuards(f.store.knex, 'binary')
    const key = { tableName: 'transactions', position: 0, field: 'rawTx', offset: 0 },
      original = await f.store.knex('private_binary_chunks').where(key).first(),
      withWrite = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
        await expect(
          f.store
            .knex('private_binary_chunks')
            .where(key)
            .update({ payload: Buffer.alloc(original.bytes) })
        ).rejects.toThrow()
        await expect(f.store.knex('private_binary_chunks').where(key).delete()).rejects.toThrow()
        await expect(
          f.store.knex.raw(
            'INSERT OR REPLACE INTO private_binary_chunks SELECT * FROM private_binary_chunks WHERE offset=0'
          )
        ).rejects.toThrow()
        await expect(f.store.knex('private_binary_fields').update({ bytes: f.bytes.byteLength - 1 })).rejects.toThrow()
        return await f.store.knex.transaction(work)
      }
    await completeBrc38SqlBinaryField(withRead(f.store), withWrite, 'transactions', 0, f.descriptor, () => {}, 1024)
    expect(await f.store.knex('private_binary_chunks').where(key).first()).toEqual(original)
  } finally {
    await f.close()
  }
})
test('an appended prefix after read drainage rejects a stale binary completion', async () => {
  const f = await fixture()
  try {
    const withWrite = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
      await f.store.appendBinaryField('transactions', 0, 'rawTx', f.bytes.byteLength, new Uint8Array([5]))
      return await f.store.knex.transaction(work)
    }
    await expect(
      completeBrc38SqlBinaryField(withRead(f.store), withWrite, 'transactions', 0, f.descriptor, () => {}, 1024)
    ).rejects.toThrow('content or coordinate differs')
    expect(await f.store.knex('private_binary_fields').first('state', 'sha256', 'bytes')).toEqual({
      state: 'writing',
      sha256: null,
      bytes: f.bytes.byteLength + 1
    })
    const extended = Buffer.concat([f.bytes, Buffer.from([5])])
    try {
      await f.store.finishBinaryField('transactions', 0, {
        ...f.descriptor,
        bytes: extended.byteLength,
        sha256: digest(extended)
      })
    } finally {
      extended.fill(0)
    }
  } finally {
    await f.close()
  }
})
test('binary hash failure restores read mode and keeps the original provisional field recoverable', async () => {
  const f = await fixture()
  try {
    await expect(
      f.store.finishBinaryField('transactions', 0, { ...f.descriptor, sha256: 'a'.repeat(64) })
    ).rejects.toThrow('content or coordinate differs')
    expect(await f.store.knex('private_binary_fields').first('state', 'sha256')).toEqual({
      state: 'writing',
      sha256: null
    })
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
    await f.store.finishBinaryField('transactions', 0, f.descriptor)
  } finally {
    await f.close()
  }
})
test('binary completion rejects an intervening drop and exact recreation of its prefix guard', async () => {
  const f = await fixture()
  try {
    const guard = await f.store
        .knex('sqlite_schema')
        .where({ name: 'private_binary_chunks_prefix_update' })
        .first('sql'),
      withWrite = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
        await f.store.knex.raw('DROP TRIGGER private_binary_chunks_prefix_update')
        await f.store.knex.raw(guard.sql)
        return await f.store.knex.transaction(work)
      }
    await expect(
      completeBrc38SqlBinaryField(withRead(f.store), withWrite, 'transactions', 0, f.descriptor, () => {}, 1024)
    ).rejects.toThrow('content or coordinate differs')
    expect(await f.store.knex('private_binary_fields').first('state', 'sha256')).toEqual({
      state: 'writing',
      sha256: null
    })
    await f.store.finishBinaryField('transactions', 0, f.descriptor)
  } finally {
    await f.close()
  }
})
