import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import {
  beginBrc38SqlCanonicalStructuredField,
  appendBrc38SqlCanonicalStructuredField,
  completeBrc38SqlCanonicalStructuredField
} from './Brc38SqlCanonicalStructuredStaging'
import { readBrc38SqlSourceFieldContent, compareBrc38SqlSourceFieldCounts } from './Brc38SqlSourceFieldRead'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
async function read<T>(store: KnexBrc38StagingStore, work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return await store.knex.transaction(async trx => {
    await trx.raw('PRAGMA query_only=ON')
    try {
      return await work(trx)
    } finally {
      await trx.raw('PRAGMA query_only=OFF')
    }
  })
}
/** Authored UNRUN synthetic field/source-phase fixture. This does not establish
 * complete row/archive semantics, crypto authentication or native admission. */
async function fixture(structured = true) {
  const parent = await mkdtemp(join(tmpdir(), 'brc38-source-field-read-')),
    store = await KnexBrc38StagingStore.create(parent, {
      maximumRows: 100,
      maximumLogicalBytes: 2097152,
      maximumPhysicalBytes: 16777216,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 65536,
      expiresAt: Date.now() + 60000
    }),
    bytes = Buffer.alloc(131089, 43),
    text = Buffer.from('{"notes":[{"what":"' + 'x'.repeat(65537) + '","when":"2026-01-01T00:00:00.000Z"}]}'),
    binary = { rawTx: { field: 'rawTx', encoding: 'base64' as const, bytes: bytes.length, sha256: digest(bytes) } },
    json = { history: { field: 'history', encoding: 'utf8-json' as const, bytes: text.length, sha256: digest(text) } }
  try {
    await store.beginBinaryField('provenTxReqs', 0, 'rawTx', 'base64', bytes.length)
    for (let offset = 0; offset < bytes.length; offset += 65536)
      await store.appendBinaryField('provenTxReqs', 0, 'rawTx', offset, bytes.subarray(offset, offset + 65536))
    await store.finishBinaryField('provenTxReqs', 0, binary.rawTx)
    if (structured) {
      await store.beginStructuredField('provenTxReqs', 0, 'history', text.length)
      for (let offset = 0; offset < text.length; offset += 65536)
        await store.appendStructuredField('provenTxReqs', 0, 'history', offset, text.subarray(offset, offset + 65536))
      await store.finishStructuredField('provenTxReqs', 0, json.history)
      await store.knex.transaction(
        async trx =>
          await beginBrc38SqlCanonicalStructuredField(
            trx,
            'provenTxReqs',
            0,
            'history',
            'utf8-json',
            text.length,
            2097152,
            100,
            json.history
          )
      )
      for (let offset = 0; offset < text.length; offset += 65536)
        await store.knex.transaction(
          async trx =>
            await appendBrc38SqlCanonicalStructuredField(
              trx,
              'provenTxReqs',
              0,
              'history',
              offset,
              text.subarray(offset, offset + 65536),
              2097152
            )
        )
      await completeBrc38SqlCanonicalStructuredField(
        work => read(store, work),
        async work => await store.knex.transaction(work),
        'provenTxReqs',
        0,
        json.history,
        () => {},
        1024
      )
    }
    await store.appendStreamed(
      { table: 'provenTxReqs', index: 0, row: { provenTxReqId: 7 }, uniqueKeys: [], memberships: [] },
      binary,
      structured ? json : undefined
    )
    return {
      store,
      close: async () => {
        bytes.fill(0)
        text.fill(0)
        await store.discard(new Error('fixture cleanup'))
        await rm(parent, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    bytes.fill(0)
    text.fill(0)
    await store.discard(cause)
    await rm(parent, { recursive: true, force: true })
    throw cause
  }
}
test('all three source field families hash in query-only windows before a payload-free writer', async () => {
  const f = await fixture()
  let queryOnly = false,
    windows = 0,
    queries = 0
  const observe = (query: { sql: string }): void => {
    if (++queries > 16384 || query.sql.length > 65536) throw new Error('Finite source-field SQL observer exceeded')
    if (/^PRAGMA query_only=ON$/i.test(query.sql)) queryOnly = true
    if (/^PRAGMA query_only=OFF$/i.test(query.sql)) queryOnly = false
    if (
      /select/i.test(query.sql) &&
      /payload/i.test(query.sql) &&
      /private_(binary|structured|canonical_structured)_chunks/i.test(query.sql)
    ) {
      if (!queryOnly) throw new Error('Source field writer read payload')
      windows++
    }
    if (/^(insert|update) /i.test(query.sql) && queryOnly) throw new Error('Source field read mutated data')
  }
  try {
    f.store.knex.on('query', observe)
    const prepared = await read(
      f.store,
      async trx => await readBrc38SqlSourceFieldContent(trx, 100, 1024, true, true, () => {})
    )
    expect(prepared.binary).toEqual({ fields: 1, chunks: 3 })
    expect(prepared.structured).toEqual({ fields: 1, chunks: 2 })
    expect(prepared.canonical).toEqual({ fields: 1, chunks: 2 })
    await f.store.knex.transaction(async trx => {
      await compareBrc38SqlSourceFieldCounts(trx, prepared, true, true, () => {})
      await trx('metadata').where({ slot: 1 }).update({ state: 'sealed' })
    })
    expect(windows).toBeGreaterThan(100)
    expect(queryOnly).toBe(false)
  } finally {
    f.store.knex.off('query', observe)
    await f.close()
  }
})
test('production binary source sealing drains hashing before its actual state/header writer', async () => {
  const f = await fixture(false),
    header = semanticStageFixture()
  for (const table of brc38StageTables) header.tables[table] = []
  const counts = Object.fromEntries(brc38StageTables.map(table => [table, table === 'provenTxReqs' ? 1 : 0])) as Record<
    Brc38StageTable,
    number
  >
  let queryOnly = false,
    windows = 0
  const observe = (query: { sql: string }): void => {
    if (/^PRAGMA query_only=ON$/i.test(query.sql)) queryOnly = true
    if (/^PRAGMA query_only=OFF$/i.test(query.sql)) queryOnly = false
    if (/select/i.test(query.sql) && /payload/i.test(query.sql) && /private_binary_chunks/i.test(query.sql)) {
      if (!queryOnly) throw new Error('Production seal writer read binary payload')
      windows++
    }
  }
  try {
    f.store.knex.on('query', observe)
    await f.store.sealStreamed(header, counts)
    expect((await f.store.knex('metadata').where({ slot: 1 }).first()).state).toBe('sealed')
    expect(windows).toBeGreaterThan(3)
    expect(queryOnly).toBe(false)
  } finally {
    f.store.knex.off('query', observe)
    await f.close()
  }
})
test('a field insertion after drainage invalidates source counts before a seal can commit', async () => {
  const f = await fixture()
  try {
    const prepared = await read(
      f.store,
      async trx => await readBrc38SqlSourceFieldContent(trx, 100, 1024, true, true, () => {})
    )
    await f.store.beginBinaryField('provenTxReqs', 1, 'rawTx', 'base64', 0)
    await f.store.finishBinaryField('provenTxReqs', 1, {
      field: 'rawTx',
      encoding: 'base64',
      bytes: 0,
      sha256: digest(new Uint8Array())
    })
    await expect(
      f.store.knex.transaction(async trx => {
        await compareBrc38SqlSourceFieldCounts(trx, prepared, true, true, () => {})
        await trx('metadata').where({ slot: 1 }).update({ state: 'sealed' })
      })
    ).rejects.toThrow('current counts differs')
    expect((await f.store.knex('metadata').where({ slot: 1 }).first()).state).toBe('staging')
  } finally {
    await f.close()
  }
})
test('restored guards cannot reuse a stale read, and a fresh read independently detects corrupted canonical bytes', async () => {
  const f = await fixture()
  try {
    const prepared = await read(
        f.store,
        async trx => await readBrc38SqlSourceFieldContent(trx, 100, 1024, true, true, () => {})
      ),
      guard = await f.store
        .knex('sqlite_schema')
        .where({ name: 'private_canonical_structured_chunks_prefix_update' })
        .first('sql')
    await f.store.knex.raw('DROP TRIGGER private_canonical_structured_chunks_prefix_update')
    await f.store
      .knex('private_canonical_structured_chunks')
      .where({ offset: 0 })
      .update({ payload: Buffer.alloc(65536, 99) })
    await f.store.knex.raw(guard.sql)
    await expect(
      f.store.knex.transaction(async trx => await compareBrc38SqlSourceFieldCounts(trx, prepared, true, true, () => {}))
    ).rejects.toThrow('current counts differs')
    await expect(
      read(f.store, async trx => await readBrc38SqlSourceFieldContent(trx, 100, 1024, true, true, () => {}))
    ).rejects.toThrow('chunk content differs')
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
  } finally {
    await f.close()
  }
})
test('whole-source content hashing requires readonly mode and the original selected family negotiation', async () => {
  const f = await fixture()
  try {
    await expect(
      f.store.knex.transaction(async trx => await readBrc38SqlSourceFieldContent(trx, 100, 1024, true, true, () => {}))
    ).rejects.toThrow('current counts differs')
    await expect(
      read(f.store, async trx => await readBrc38SqlSourceFieldContent(trx, 100, 1024, true, false, () => {}))
    ).rejects.toThrow('current counts differs')
    await expect(
      read(f.store, async trx => await readBrc38SqlSourceFieldContent(trx, 100, 0, true, true, () => {}))
    ).rejects.toThrow('original content window')
    expect(await f.store.knex.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
  } finally {
    await f.close()
  }
})
test('a plain source without staged fields does not acquire a fictitious content window', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'brc38-empty-source-field-read-')),
    store = await KnexBrc38StagingStore.create(parent, {
      maximumRows: 100,
      maximumLogicalBytes: 2097152,
      maximumPhysicalBytes: 16777216,
      maximumRowBytes: 4096,
      maximumRowAllocationBytes: 8192,
      expiresAt: Date.now() + 60000
    }),
    header = semanticStageFixture()
  for (const table of brc38StageTables) header.tables[table] = []
  try {
    await store.seal(
      header,
      Object.fromEntries(brc38StageTables.map(table => [table, 0])) as Record<Brc38StageTable, number>
    )
    expect((await store.knex('metadata').where({ slot: 1 }).first()).state).toBe('sealed')
  } finally {
    await store.discard(new Error('fixture cleanup'))
    await rm(parent, { recursive: true, force: true })
  }
})
