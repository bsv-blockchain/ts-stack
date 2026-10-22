import { knex, type Knex } from 'knex'
import { readSnapshotJournalContentRevision } from './SnapshotJournalContentRevision'
import { SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL } from './SnapshotJournalSqliteObservers'
import { createSnapshotSyncContentRevision, snapshotSyncContentPosition } from '../SnapshotSyncContentRevision'

let k: Knex
beforeEach(async () => {
  k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  for (const sql of SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL) await k.raw(sql)
})
afterEach(async () => await k.destroy())

const input = () => ({
  binding: '11'.repeat(32),
  floor: '0',
  highWater: '9223372036854775807',
  primaryEpoch: '0',
  sourceStorage: {
    storageIdentityKey: 'content-source',
    storageName: 'content query fixture',
    chain: 'test' as const,
    dbtype: 'SQLite' as const,
    maxOutputScript: 2048,
    created_at: new Date('2020-01-01T00:00:00.000Z'),
    updated_at: new Date('2020-01-01T00:00:00.000Z')
  },
  user: {
    userId: 1,
    identityKey: '02' + '22'.repeat(32),
    activeStorage: 'content-source',
    created_at: new Date('2020-01-01T00:00:00.000Z'),
    updated_at: new Date('2020-01-01T00:00:00.000Z')
  }
})

// Ordinary real SQLite tests of bounded DATA queries, not native admission or
// a replacement for the actual retained-source integration tests.
test('all15 metadata maxima use bounded covering-index seeks and exact signed64 values', async () => {
  for (let tableId = 0; tableId < 13; tableId++) {
    await k.batchInsert(
      'snapshot_journal_scope',
      Array.from({ length: 100 }, (_, index) => ({
        tableId,
        userId: 1,
        id1: index + 1,
        id2: 0,
        exactText: '',
        revision: String(index + 1),
        present: 1
      })),
      50
    )
    await k('snapshot_journal_scope').insert({
      tableId,
      userId: 2,
      id1: 1,
      id2: 0,
      exactText: '',
      revision: '9007199254740994',
      present: 1
    })
  }
  for (const tableId of [8, 9])
    await k.batchInsert(
      'snapshot_journal_physical',
      Array.from({ length: 100 }, (_, index) => ({
        tableId,
        id1: index + 1,
        id2: 0,
        exactText: '',
        revision: String(index + 1),
        generation: '1',
        present: 1
      })),
      50
    )
  await k('snapshot_journal_physical').where({ tableId: 9, id1: 100 }).update({ revision: '9007199254740993' })
  const queries: Array<{ sql: string; bindings: Knex.RawBinding[] }> = [],
    observe = (query: { sql: string; bindings: Knex.RawBinding[] }): void => {
      if (/from .*snapshot_journal_(scope|physical)/i.test(query.sql))
        queries.push({ sql: query.sql, bindings: [...query.bindings] })
    }
  k.on('query', observe)
  let revision: Awaited<ReturnType<typeof readSnapshotJournalContentRevision>>
  try {
    revision = await k.transaction(async trx => await readSnapshotJournalContentRevision(trx, input()))
  } finally {
    k.off('query', observe)
  }
  expect(queries).toHaveLength(15)
  const revisions = Array<string>(15).fill('100')
  revisions[14] = '9007199254740993'
  expect(revision).toEqual(createSnapshotSyncContentRevision({ ...input(), revisions }))
  for (const query of queries) {
    const plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + query.sql, query.bindings)
    expect(plan.some(row => /USING (?:COVERING )?INDEX snapshot_journal_(scope|physical)_page/i.test(row.detail))).toBe(
      true
    )
    expect(plan.some(row => /TEMP B-TREE/i.test(row.detail))).toBe(false)
    expect(query.bindings[query.bindings.length - 1]).toBe(1)
  }
})

test('empty streams remain bounded and retention-floor changes cannot reuse their content fingerprint', async () => {
  const a = await k.transaction(async trx => await readSnapshotJournalContentRevision(trx, input())),
    b = await k.transaction(
      async trx => await readSnapshotJournalContentRevision(trx, { ...input(), highWater: '100' })
    ),
    pruned = await k.transaction(async trx => await readSnapshotJournalContentRevision(trx, { ...input(), floor: '1' }))
  expect(a.content).toEqual(b.content)
  expect(a.highWater).not.toEqual(b.highWater)
  expect(a.content).not.toEqual(pruned.content)
})

test('unchanged confirmation advances only within retained same-metadata history', async () => {
  const original = await k.transaction(
      async trx => await readSnapshotJournalContentRevision(trx, { ...input(), highWater: '100' })
    ),
    since = snapshotSyncContentPosition(original)
  const observed = await k.transaction(
    async trx => await readSnapshotJournalContentRevision(trx, { ...input(), floor: '1', highWater: '200' }, since)
  )
  expect(observed.unchangedSince).toBe('100')
  expect(observed.highWater).toBe('200')
  expect(observed.content).not.toBe(original.content)
  const lostHistory = await k.transaction(
    async trx => await readSnapshotJournalContentRevision(trx, { ...input(), floor: '101', highWater: '200' }, since)
  )
  expect(lostHistory.unchangedSince).toBeUndefined()
  const changedMetadata = await k.transaction(
    async trx =>
      await readSnapshotJournalContentRevision(trx, { ...input(), primaryEpoch: '1', highWater: '200' }, since)
  )
  expect(changedMetadata.unchangedSince).toBeUndefined()
  await expect(
    k.transaction(async trx => await readSnapshotJournalContentRevision(trx, { ...input(), highWater: '99' }, since))
  ).rejects.toThrow('exceeds its actual source high-water')
})

test('a real metadata event after the confirmed position prevents a no-change confirmation', async () => {
  const original = await k.transaction(
    async trx => await readSnapshotJournalContentRevision(trx, { ...input(), highWater: '100' })
  )
  await k('snapshot_journal_scope').insert({
    tableId: 3,
    userId: 1,
    id1: 1,
    id2: 0,
    exactText: '',
    revision: '101',
    present: 0
  })
  const changed = await k.transaction(
    async trx =>
      await readSnapshotJournalContentRevision(
        trx,
        { ...input(), highWater: '200' },
        snapshotSyncContentPosition(original)
      )
  )
  expect(changed.unchangedSince).toBeUndefined()
  expect(changed.content).not.toBe(original.content)
})

test('an ordinary root is refused before issuing metadata queries', async () => {
  const observe = jest.fn()
  k.on('query', observe)
  try {
    await expect(readSnapshotJournalContentRevision(k as Knex.Transaction, input())).rejects.toThrow(
      'actual retained transaction'
    )
    expect(observe).not.toHaveBeenCalled()
  } finally {
    k.off('query', observe)
  }
})
