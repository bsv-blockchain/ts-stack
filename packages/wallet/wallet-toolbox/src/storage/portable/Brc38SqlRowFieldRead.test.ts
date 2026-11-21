import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { readBrc38SqlRowFieldContent, compareBrc38SqlRowFieldMetadata } from './Brc38SqlRowFieldRead'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
/** Authored UNRUN. Source/row atomicity cases do not qualify archive semantics. */
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'brc38-row-field-read-')),
    store = await KnexBrc38StagingStore.create(parent, {
      maximumRows: 100,
      maximumLogicalBytes: 2097152,
      maximumPhysicalBytes: 16777216,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 65536,
      expiresAt: Date.now() + 60000
    }),
    bytes = Buffer.alloc(131089, 37),
    history = Buffer.from('{"notes":[' + '0,'.repeat(32768) + '0]}'),
    binary = { rawTx: { field: 'rawTx', encoding: 'base64' as const, bytes: bytes.length, sha256: digest(bytes) } },
    structured = {
      history: { field: 'history', encoding: 'utf8-json' as const, bytes: history.length, sha256: digest(history) }
    }
  try {
    await store.beginBinaryField('provenTxReqs', 0, 'rawTx', 'base64', bytes.length)
    for (let offset = 0; offset < bytes.length; offset += 65536)
      await store.appendBinaryField('provenTxReqs', 0, 'rawTx', offset, bytes.subarray(offset, offset + 65536))
    await store.finishBinaryField('provenTxReqs', 0, binary.rawTx)
    await store.beginStructuredField('provenTxReqs', 0, 'history', history.length)
    for (let offset = 0; offset < history.length; offset += 65536)
      await store.appendStructuredField('provenTxReqs', 0, 'history', offset, history.subarray(offset, offset + 65536))
    await store.finishStructuredField('provenTxReqs', 0, structured.history)
    return {
      store,
      binary,
      structured,
      close: async () => {
        bytes.fill(0)
        history.fill(0)
        await store.discard(new Error('fixture cleanup'))
        await rm(parent, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    bytes.fill(0)
    history.fill(0)
    await store.discard(cause)
    await rm(parent, { recursive: true, force: true })
    throw cause
  }
}
async function read<T>(store: KnexBrc38StagingStore, operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return await store.knex.transaction(async trx => {
    await trx.raw('PRAGMA query_only=ON')
    try {
      return await operation(trx)
    } finally {
      await trx.raw('PRAGMA query_only=OFF')
    }
  })
}
test('row admission drains complete binary and raw structured hashes before its metadata/key/count writer', async () => {
  const f = await fixture()
  let queryOnly = false,
    windows = 0,
    updates = 0,
    queries = 0
  const observe = (query: { sql: string }): void => {
    if (++queries > 8192 || query.sql.length > 65536) throw new Error('Finite row SQL observation exceeded')
    if (/^PRAGMA query_only=ON$/i.test(query.sql)) queryOnly = true
    if (/^PRAGMA query_only=OFF$/i.test(query.sql)) queryOnly = false
    if (
      /select/i.test(query.sql) &&
      /payload/i.test(query.sql) &&
      /private_(binary|structured)_chunks/i.test(query.sql)
    ) {
      if (!queryOnly) throw new Error('Row writer read field payload')
      windows++
    }
    if (/^(insert|update) /i.test(query.sql)) {
      if (queryOnly) throw new Error('Row mutation occurred in query-only mode')
      if (/^update /i.test(query.sql)) updates++
    }
  }
  try {
    f.store.knex.on('query', observe)
    await f.store.appendStreamed(
      {
        table: 'provenTxReqs',
        index: 0,
        row: { provenTxReqId: 7 },
        uniqueKeys: [{ namespace: 'row-case', key: '7' }],
        memberships: []
      },
      f.binary,
      f.structured
    )
    f.store.knex.off('query', observe)
    expect(windows).toBeGreaterThan(3)
    expect(updates).toBe(2)
    expect(queryOnly).toBe(false)
    expect(await f.store.count('provenTxReqs')).toBe(1)
    expect(await f.store.row('provenTxReqs', 0)).toEqual({ provenTxReqId: 7 })
    expect(await f.store.has('row-case', '7')).toBe(true)
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
  } finally {
    f.store.knex.off('query', observe)
    await f.close()
  }
})
test('a newly completed field after read drainage invalidates the row metadata comparison', async () => {
  const f = await fixture()
  try {
    const prepared = await read(
      f.store,
      async trx => await readBrc38SqlRowFieldContent(trx, 'provenTxReqs', 0, f.binary, f.structured, 1024, () => {})
    )
    await f.store.beginBinaryField('provenTxReqs', 0, 'inputBEEF', 'base64', 0)
    await f.store.finishBinaryField('provenTxReqs', 0, {
      field: 'inputBEEF',
      encoding: 'base64',
      bytes: 0,
      sha256: digest(new Uint8Array())
    })
    await expect(
      f.store.knex.transaction(async trx => {
        await compareBrc38SqlRowFieldMetadata(trx, prepared, () => {})
        throw new Error('Stale field comparison reached row writer')
      })
    ).rejects.toThrow('current metadata differs')
    expect(await f.store.count('provenTxReqs')).toBe(0)
  } finally {
    await f.close()
  }
})
test('a failed indexed-key writer leaves no admitted row/count/charge and permits an exact retry', async () => {
  const f = await fixture()
  try {
    await f.store.knex('unique_keys').insert({ namespace: 'occupied', key: '7' })
    const before = await f.store.knex('metadata').first('state', 'rows', 'logicalBytes'),
      record = {
        table: 'provenTxReqs' as const,
        index: 0,
        row: { provenTxReqId: 7 },
        uniqueKeys: [{ namespace: 'occupied', key: '7' }],
        memberships: [{ namespace: 'member', key: '7' }]
      }
    await expect(f.store.appendStreamed(record, f.binary, f.structured)).rejects.toThrow()
    expect(await f.store.count('provenTxReqs')).toBe(0)
    expect(await f.store.row('provenTxReqs', 0)).toBeUndefined()
    expect(await f.store.knex('metadata').first('state', 'rows', 'logicalBytes')).toEqual(before)
    expect(
      await f.store.knex('memberships').where({ namespace: 'member', key: '7' }).count({ count: '*' }).first()
    ).toEqual({ count: 0 })
    await f.store.appendStreamed({ ...record, uniqueKeys: [{ namespace: 'retry', key: '7' }] }, f.binary, f.structured)
    expect(await f.store.count('provenTxReqs')).toBe(1)
    expect(await f.store.row('provenTxReqs', 0)).toEqual({ provenTxReqId: 7 })
  } finally {
    await f.close()
  }
})
test('row field reads refuse a write transaction and altered immutable-prefix definitions', async () => {
  const f = await fixture()
  try {
    await expect(
      f.store.knex.transaction(
        async trx => await readBrc38SqlRowFieldContent(trx, 'provenTxReqs', 0, f.binary, f.structured, 1024, () => {})
      )
    ).rejects.toThrow('current metadata differs')
    await f.store.knex.raw('DROP TRIGGER private_structured_chunks_prefix_update')
    await expect(
      read(
        f.store,
        async trx => await readBrc38SqlRowFieldContent(trx, 'provenTxReqs', 0, f.binary, f.structured, 1024, () => {})
      )
    ).rejects.toThrow('content or coordinate differs')
    expect(await f.store.count('provenTxReqs')).toBe(0)
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
  } finally {
    await f.close()
  }
})
test('dropping and restoring an identical prefix guard cannot reuse an earlier row content read', async () => {
  const f = await fixture()
  try {
    const prepared = await read(
        f.store,
        async trx => await readBrc38SqlRowFieldContent(trx, 'provenTxReqs', 0, f.binary, f.structured, 1024, () => {})
      ),
      guard = await f.store.knex('sqlite_schema').where({ name: 'private_binary_chunks_prefix_update' }).first('sql')
    await f.store.knex.raw('DROP TRIGGER private_binary_chunks_prefix_update')
    await f.store
      .knex('private_binary_chunks')
      .where({ offset: 0 })
      .update({ payload: Buffer.alloc(65536, 99) })
    await f.store.knex.raw(guard.sql)
    await expect(
      f.store.knex.transaction(async trx => await compareBrc38SqlRowFieldMetadata(trx, prepared, () => {}))
    ).rejects.toThrow('current metadata differs')
    await expect(
      read(
        f.store,
        async trx => await readBrc38SqlRowFieldContent(trx, 'provenTxReqs', 0, f.binary, f.structured, 1024, () => {})
      )
    ).rejects.toThrow('chunk content differs')
    expect(await f.store.count('provenTxReqs')).toBe(0)
  } finally {
    await f.close()
  }
})
