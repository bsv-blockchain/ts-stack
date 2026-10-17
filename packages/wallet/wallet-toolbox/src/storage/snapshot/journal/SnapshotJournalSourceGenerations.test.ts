import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import {
  readSnapshotJournalSourceGenerations,
  type SnapshotJournalSourceReference
} from './SnapshotJournalSourceGenerations'

jest.setTimeout(30000)

let db: Knex
let directory: string
const high = snapshotJournalRevision('9223372036854775807')
const definitions = [
  [0, 'transactions', 'transactionId'],
  [1, 'outputs', 'outputId'],
  [2, 'certificates', 'certificateId'],
  [3, 'tx_labels', 'txLabelId'],
  [4, 'output_baskets', 'basketId'],
  [5, 'output_tags', 'outputTagId'],
  [6, 'commissions', 'commissionId'],
  [8, 'proven_txs', 'provenTxId'],
  [9, 'proven_tx_reqs', 'provenTxReqId']
] as const
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-source-generations-'))
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'source.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  await db.raw('PRAGMA journal_mode = WAL')
  await db.raw(
    'CREATE TABLE snapshot_journal_physical(tableId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,id1,id2,exactText))'
  )
  await db.raw(
    'CREATE TABLE snapshot_profile_keys_v2(snapshotTableId INTEGER NOT NULL,snapshotUserId INTEGER NOT NULL,snapshotRowId INTEGER NOT NULL,PRIMARY KEY(snapshotTableId,snapshotUserId,snapshotRowId))'
  )
  await db.raw(
    'CREATE TABLE snapshot_global_keys_v2(tableId INTEGER NOT NULL,userId INTEGER NOT NULL,rowId INTEGER NOT NULL,refs INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,userId,rowId))'
  )
  for (const [, name, key] of definitions)
    await db.raw('CREATE TABLE ??(?? INTEGER PRIMARY KEY,userId INTEGER NOT NULL)', [name, key])
})
afterEach(async () => {
  await db.destroy()
  rmSync(directory, { recursive: true, force: true })
})
async function live(
  k: Knex,
  tableId: SnapshotJournalSourceReference['tableId'],
  incomingId: number,
  generation = '2',
  revision = '9',
  userId = 1
): Promise<void> {
  const [, name, key] = definitions.find(row => row[0] === tableId)!
  await k(name).insert({ [key]: incomingId, userId })
  await k('snapshot_journal_physical').insert({
    tableId,
    id1: incomingId,
    id2: 0,
    exactText: '',
    generation,
    revision,
    present: 1
  })
  if (tableId < 7)
    await k('snapshot_profile_keys_v2').insert({
      snapshotTableId: tableId,
      snapshotUserId: userId,
      snapshotRowId: incomingId
    })
  else
    await k('snapshot_global_keys_v2').insert({
      tableId: tableId === 8 ? 1 : 0,
      userId,
      rowId: incomingId,
      refs: 1,
      present: 1
    })
}
async function read(references: SnapshotJournalSourceReference[], profile = 1, ceiling = high) {
  return await db.transaction(
    async trx => await readSnapshotJournalSourceGenerations(trx, profile, ceiling, references)
  )
}

test('resolves all nine independent numeric entity types in the selected profile', async () => {
  const references: SnapshotJournalSourceReference[] = []
  for (const [tableId] of definitions) {
    await live(db, tableId, 10)
    references.push({ tableId, incomingId: 10 })
  }
  const actual = await read(references)
  expect([...actual]).toEqual(references.map(row => [row.tableId + ':10', { generation: '2', revision: '9' }]))
})
test('retains an unchanged parent generation older than the new delta window', async () => {
  await live(db, 4, 10, '2', '7')
  expect((await read([{ tableId: 4, incomingId: 10 }], 1, snapshotJournalRevision('100'))).get('4:10')).toEqual({
    generation: '2',
    revision: '7'
  })
})
test('preserves exact generation and revision values above JavaScript safe integer range', async () => {
  await live(db, 4, 10, '9007199254740993', '9223372036854775807')
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')).toEqual({
    generation: '9007199254740993',
    revision: '9223372036854775807'
  })
})
test('a live physical row in another profile cannot resolve as a parent', async () => {
  await live(db, 4, 10, '2', '9', 2)
  await expect(read([{ tableId: 4, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
})
test('a shared global object requires current retained membership for this profile', async () => {
  await live(db, 8, 10, '2', '9', 2)
  await expect(read([{ tableId: 8, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
  await db('snapshot_global_keys_v2').insert({
    tableId: 1,
    userId: 1,
    rowId: 10,
    refs: 1,
    present: 1
  })
  expect((await read([{ tableId: 8, incomingId: 10 }])).get('8:10')?.generation).toBe('2')
  await db('snapshot_global_keys_v2').where({ tableId: 1, userId: 1, rowId: 10 }).update({ refs: 0 })
  await expect(read([{ tableId: 8, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
})
test('a new source call sees a replacement generation instead of caching the old identity', async () => {
  await live(db, 4, 10)
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')?.generation).toBe('2')
  await db.transaction(async trx => {
    await trx('output_baskets').where({ basketId: 10 }).delete()
    await trx('output_baskets').insert({ basketId: 10, userId: 1 })
    await trx('snapshot_journal_physical').where({ tableId: 4, id1: 10 }).update({ generation: '12', revision: '12' })
  })
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')?.generation).toBe('12')
})
test('a rolled-back replacement retains the original physical identity', async () => {
  await live(db, 4, 10)
  await expect(
    db.transaction(async trx => {
      await trx('snapshot_journal_physical').where({ tableId: 4, id1: 10 }).update({ generation: '12', revision: '12' })
      expect(
        (await readSnapshotJournalSourceGenerations(trx, 1, high, [{ tableId: 4, incomingId: 10 }])).get('4:10')
          ?.generation
      ).toBe('12')
      throw new Error('source replacement rollback')
    })
  ).rejects.toThrow('source replacement rollback')
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')?.generation).toBe('2')
})
test('deduplicates and detaches the bounded reference set before its first asynchronous boundary', async () => {
  await live(db, 4, 10)
  await db.transaction(async trx => {
    const refs: SnapshotJournalSourceReference[] = [
      { tableId: 4, incomingId: 10 },
      { tableId: 4, incomingId: 10 }
    ]
    const pending = readSnapshotJournalSourceGenerations(trx, 1, high, refs)
    refs[0].incomingId = 11
    refs.length = 0
    expect([...(await pending)]).toEqual([['4:10', { generation: '2', revision: '9' }]])
  })
})
test('refuses absent, withdrawn or post-window physical metadata', async () => {
  await live(db, 4, 10)
  await expect(read([{ tableId: 4, incomingId: 11 }])).rejects.toThrow('Missing or inconsistent')
  await expect(read([{ tableId: 4, incomingId: 10 }], 1, snapshotJournalRevision('8'))).rejects.toThrow()
  await db('snapshot_journal_physical').where({ tableId: 4, id1: 10 }).update({ present: 0 })
  await expect(read([{ tableId: 4, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
})
test('bounds references before SQL and refuses provenance/composite table IDs', async () => {
  let queries = 0
  db.on('query', () => queries++)
  await db.transaction(async trx => {
    const initial = queries
    await expect(
      readSnapshotJournalSourceGenerations(
        trx,
        1,
        high,
        Array.from({ length: 257 }, () => ({ tableId: 4 as const, incomingId: 10 }))
      )
    ).rejects.toThrow('Missing or inconsistent')
    await expect(
      readSnapshotJournalSourceGenerations(trx, 1, high, [
        { tableId: 7 as SnapshotJournalSourceReference['tableId'], incomingId: 10 }
      ])
    ).rejects.toThrow('Missing or inconsistent')
    expect(queries).toBe(initial)
  })
})
