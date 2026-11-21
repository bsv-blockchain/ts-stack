import { createSyncMap } from '../../schema/entities/EntityBase'
import { brc38ImportTargetIndexName } from '../../portable/Brc38ImportTargetIndexes'
import { verifySnapshotJournalDestinationIdentity } from './SnapshotJournalDestinationIdentities'
import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { readSnapshotJournalSourceIdentities } from './SnapshotJournalSourceIdentities'
import type { SnapshotJournalSourceReference } from './SnapshotJournalSourceGenerations'

jest.setTimeout(30000)
let db: Knex
let directory: string
const high = snapshotJournalRevision('9223372036854775807')
const definitions = [
  [0, 'transactions', 'transactionId', 'reference TEXT NOT NULL,txid TEXT'],
  [1, 'outputs', 'outputId', 'transactionId INTEGER NOT NULL,vout INTEGER NOT NULL,txid TEXT'],
  [2, 'certificates', 'certificateId', 'serialNumber TEXT NOT NULL,certifier TEXT NOT NULL'],
  [3, 'tx_labels', 'txLabelId', 'label TEXT NOT NULL'],
  [4, 'output_baskets', 'basketId', 'name TEXT NOT NULL'],
  [5, 'output_tags', 'outputTagId', 'tag TEXT NOT NULL'],
  [6, 'commissions', 'commissionId', 'transactionId INTEGER NOT NULL,keyOffset TEXT'],
  [8, 'proven_txs', 'provenTxId', 'txid TEXT NOT NULL'],
  [9, 'proven_tx_reqs', 'provenTxReqId', 'txid TEXT NOT NULL']
] as const
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-source-identities-'))
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
  for (const [, name, id, fields] of definitions)
    await db.raw('CREATE TABLE ??(?? INTEGER PRIMARY KEY,userId INTEGER NOT NULL,' + fields + ',rawTx BLOB)', [
      name,
      id
    ])
})
afterEach(async () => {
  await db.destroy()
  rmSync(directory, { recursive: true, force: true })
})
async function live(
  tableId: SnapshotJournalSourceReference['tableId'],
  incomingId: number,
  natural: Record<string, unknown>,
  userId = 1,
  generation = '2'
) {
  const [, name, id] = definitions.find(x => x[0] === tableId)!
  await db(name).insert({ [id]: incomingId, userId, ...natural })
  await db('snapshot_journal_physical').insert({
    tableId,
    id1: incomingId,
    id2: 0,
    exactText: '',
    generation,
    revision: generation,
    present: 1
  })
  if (tableId < 7)
    await db('snapshot_profile_keys_v2').insert({
      snapshotTableId: tableId,
      snapshotUserId: userId,
      snapshotRowId: incomingId
    })
  else
    await db('snapshot_global_keys_v2').insert({
      tableId: tableId === 8 ? 1 : 0,
      userId,
      rowId: incomingId,
      refs: 1,
      present: 1
    })
}
async function read(references: SnapshotJournalSourceReference[]) {
  return await db.transaction(async trx => await readSnapshotJournalSourceIdentities(trx, 1, high, references))
}

test('extracts all nine entity natural keys with exact signed64-safe generation metadata', async () => {
  await live(0, 11, { reference: 'local-reference', txid: 'a'.repeat(64) }, 1, '9007199254740993')
  const values = [
    [1, { transactionId: 11, vout: 2 }],
    [2, { serialNumber: 'serial', certifier: 'certifier' }],
    [3, { label: 'label' }],
    [4, { name: 'basket' }],
    [5, { tag: 'tag' }],
    [6, { transactionId: 11 }],
    [8, { txid: 'b'.repeat(64) }],
    [9, { txid: 'c'.repeat(64) }]
  ] as const
  for (const [tableId, row] of values) await live(tableId, 12, row)
  const actual = await read([
    { tableId: 0, incomingId: 11 },
    ...values.map(([tableId]) => ({ tableId, incomingId: 12 }))
  ])
  expect(actual.size).toBe(9)
  expect(actual.get('0:11')?.generation).toBe('9007199254740993')
  for (const value of actual.values()) {
    expect(value.required).toBe(false)
    expect(value.naturalIdentity).toMatch(/^[0-9a-f]{64}$/)
  }
  expect(actual.get('2:12')?.naturalKey).toEqual({
    tableId: 2,
    serialNumber: 'serial',
    certifier: 'certifier'
  })
})
test('learning a txid preserves the reference association while exposing the txid lookup preference', async () => {
  await live(0, 11, { reference: 'local-reference' })
  const before = (await read([{ tableId: 0, incomingId: 11 }])).get('0:11')!
  await db('transactions')
    .where({ transactionId: 11 })
    .update({ txid: 'a'.repeat(64) })
  const after = (await read([{ tableId: 0, incomingId: 11 }])).get('0:11')!
  expect(after.naturalIdentity).toBe(before.naturalIdentity)
  expect(after.naturalKey).toEqual({
    tableId: 0,
    reference: 'local-reference',
    txid: 'a'.repeat(64)
  })
})
test('output identity ignores optional output txid and binds an unchanged acknowledged parent', async () => {
  await live(0, 11, { reference: 'parent' })
  await live(1, 12, { transactionId: 11, vout: 3, txid: 'a'.repeat(64) })
  const before = await read([{ tableId: 1, incomingId: 12 }])
  expect(before.get('0:11')?.required).toBe(true)
  expect(before.get('1:12')?.required).toBe(false)
  await db('outputs')
    .where({ outputId: 12 })
    .update({ txid: 'b'.repeat(64) })
  expect((await read([{ tableId: 1, incomingId: 12 }])).get('1:12')?.naturalIdentity).toBe(
    before.get('1:12')?.naturalIdentity
  )
  expect(
    (
      await read([
        { tableId: 1, incomingId: 12 },
        { tableId: 0, incomingId: 11 }
      ])
    ).get('0:11')?.required
  ).toBe(false)
})
test('parent replacement generation changes both output and commission association fingerprints', async () => {
  await live(0, 11, { reference: 'parent' })
  await live(1, 12, { transactionId: 11, vout: 3 })
  await live(6, 13, { transactionId: 11, keyOffset: 'first' })
  const refs = [
    { tableId: 1 as const, incomingId: 12 },
    { tableId: 6 as const, incomingId: 13 }
  ]
  const before = await read(refs)
  await db('commissions').where({ commissionId: 13 }).update({ keyOffset: 'second' })
  expect((await read(refs)).get('6:13')?.naturalIdentity).toBe(before.get('6:13')?.naturalIdentity)
  await db('snapshot_journal_physical').where({ tableId: 0, id1: 11 }).update({ generation: '9', revision: '9' })
  const after = await read(refs)
  expect(after.get('1:12')?.naturalIdentity).not.toBe(before.get('1:12')?.naturalIdentity)
  expect(after.get('6:13')?.naturalIdentity).not.toBe(before.get('6:13')?.naturalIdentity)
})
test('foreign, withdrawn and absent parents cannot supply an association', async () => {
  await live(0, 11, { reference: 'foreign' }, 2)
  await live(1, 12, { transactionId: 11, vout: 0 })
  await expect(read([{ tableId: 1, incomingId: 12 }])).rejects.toThrow('pinned journal natural identity')
  await db('transactions').where({ transactionId: 11 }).update({ userId: 1 })
  await db('snapshot_profile_keys_v2').where({ snapshotTableId: 0, snapshotRowId: 11 }).update({ snapshotUserId: 1 })
  await db('snapshot_journal_physical').where({ tableId: 0, id1: 11 }).update({ present: 0 })
  await expect(read([{ tableId: 1, incomingId: 12 }])).rejects.toThrow('pinned journal source generation')
  await db('transactions').where({ transactionId: 11 }).delete()
  await expect(read([{ tableId: 1, incomingId: 12 }])).rejects.toThrow('pinned journal natural identity')
})
test('exact Unicode, embedded NUL, case and whitespace remain distinct natural keys', async () => {
  const names = ['A', 'a', ' a ', 'e\u0301', '\u00e9', 'x\0y', '\u{1f600}'.repeat(300)]
  for (let i = 0; i < names.length; i++) await live(4, i + 1, { name: names[i] })
  const actual = await read(names.map((_, i) => ({ tableId: 4 as const, incomingId: i + 1 })))
  expect(new Set([...actual.values()].map(x => x.naturalIdentity)).size).toBe(names.length)
  expect([...actual.values()].map(x => x.naturalKey)).toEqual(names.map(name => ({ tableId: 4, name })))
})
test('SQL bounds oversized key cells and distinguishes malformed optional txids from absent txids', async () => {
  await live(4, 11, { name: 'x'.repeat(1201) })
  await expect(read([{ tableId: 4, incomingId: 11 }])).rejects.toThrow('pinned journal natural identity')
  await live(0, 12, { reference: 'parent', txid: 'x'.repeat(257) })
  await expect(read([{ tableId: 0, incomingId: 12 }])).rejects.toThrow('pinned journal natural identity')
  await db('transactions').where({ transactionId: 12 }).update({ txid: null })
  expect((await read([{ tableId: 0, incomingId: 12 }])).get('0:12')?.naturalKey).toEqual({
    tableId: 0,
    reference: 'parent'
  })
})
test('source replacement rollback and later calls read fresh data without cross-call caching', async () => {
  await live(4, 11, { name: 'old' })
  await expect(
    db.transaction(async trx => {
      await trx('output_baskets').where({ basketId: 11 }).update({ name: 'rolled-back' })
      expect(
        (await readSnapshotJournalSourceIdentities(trx, 1, high, [{ tableId: 4, incomingId: 11 }])).get('4:11')
          ?.naturalKey
      ).toEqual({ tableId: 4, name: 'rolled-back' })
      throw new Error('natural identity rollback')
    })
  ).rejects.toThrow('natural identity rollback')
  expect((await read([{ tableId: 4, incomingId: 11 }])).get('4:11')?.naturalKey).toEqual({
    tableId: 4,
    name: 'old'
  })
  await db('output_baskets').where({ basketId: 11 }).update({ name: 'new' })
  expect((await read([{ tableId: 4, incomingId: 11 }])).get('4:11')?.naturalKey).toEqual({
    tableId: 4,
    name: 'new'
  })
})
test('detaches references before awaiting and never selects unrelated payload columns', async () => {
  await live(4, 11, { name: 'basket', rawTx: Buffer.alloc(4096, 7) })
  const sql: string[] = []
  db.on('query', query => sql.push(query.sql))
  await db.transaction(async trx => {
    const refs: SnapshotJournalSourceReference[] = [
      { tableId: 4, incomingId: 11 },
      { tableId: 4, incomingId: 11 }
    ]
    const pending = readSnapshotJournalSourceIdentities(trx, 1, high, refs)
    refs[0].incomingId = 99
    refs.length = 0
    expect((await pending).size).toBe(1)
  })
  expect(sql.filter(x => /^select/i.test(x)).every(x => !/rawTx|keyOffset|select\s+\*/i.test(x))).toBe(true)
})
test('rejects invalid reference sets and high water before SQL, including unsupported provenance/composite tables', async () => {
  let queries = 0
  db.on('query', () => queries++)
  await db.transaction(async trx => {
    const initial = queries
    await expect(
      readSnapshotJournalSourceIdentities(
        trx,
        1,
        high,
        Array.from({ length: 257 }, () => ({ tableId: 4 as const, incomingId: 1 }))
      )
    ).rejects.toThrow()
    await expect(
      readSnapshotJournalSourceIdentities(trx, 1, high, [
        { tableId: 7 as SnapshotJournalSourceReference['tableId'], incomingId: 1 }
      ])
    ).rejects.toThrow()
    await expect(readSnapshotJournalSourceIdentities(trx, 1, snapshotJournalRevision('0'), [])).rejects.toThrow()
    expect(queries).toBe(initial)
  })
})
test('global identities require retained profile membership and domain-separate their table type', async () => {
  await live(8, 11, { txid: 'a'.repeat(64) })
  await live(9, 12, { txid: 'a'.repeat(64) })
  const actual = await read([
    { tableId: 8, incomingId: 11 },
    { tableId: 9, incomingId: 12 }
  ])
  expect(actual.get('8:11')?.naturalIdentity).not.toBe(actual.get('9:12')?.naturalIdentity)
  await db('snapshot_global_keys_v2').where({ tableId: 1, userId: 1, rowId: 11 }).update({ refs: 0 })
  await expect(read([{ tableId: 8, incomingId: 11 }])).rejects.toThrow('pinned journal natural identity')
})

test('actual indexed proof identity preserves captured mixed-case spelling in source and destination', async () => {
  const txid = 'aBcD'.repeat(16)
  await live(8, 23, { txid })
  await db.raw('CREATE INDEX ?? ON proven_txs(txid)', [brc38ImportTargetIndexName('provenTxs', db)])
  const reference = (await read([{ tableId: 8, incomingId: 23 }])).get('8:23')
  if (reference === undefined) throw new Error('Actual captured global proof identity missing')
  expect(reference.naturalKey).toEqual({ tableId: 8, txid })
  const verified = await db.transaction(
    async trx =>
      await verifySnapshotJournalDestinationIdentity(
        trx,
        1,
        reference,
        { generation: reference.generation, naturalIdentity: reference.naturalIdentity, localId: 23 },
        createSyncMap()
      )
  )
  expect(verified).toBe(true)
  expect((await db('proven_txs').where('provenTxId', 23).first('txid')).txid).toBe(txid)
  // The original complete-row validator legitimately writes canonical hex.
  // Preserve that path too, without changing the captured source spelling.
  await db('proven_txs').where('provenTxId', 23).update({ txid: txid.toLowerCase() })
  expect(
    await db.transaction(
      async trx =>
        await verifySnapshotJournalDestinationIdentity(
          trx,
          1,
          reference,
          { generation: reference.generation, naturalIdentity: reference.naturalIdentity, localId: 23 },
          createSyncMap()
        )
    )
  ).toBe(true)
  expect(reference.naturalKey).toEqual({ tableId: 8, txid })
  await db('proven_txs')
    .where('provenTxId', 23)
    .update({ txid: 'f'.repeat(64) })
  await expect(
    db.transaction(
      async trx =>
        await verifySnapshotJournalDestinationIdentity(
          trx,
          1,
          reference,
          { generation: reference.generation, naturalIdentity: reference.naturalIdentity, localId: 23 },
          createSyncMap()
        )
    )
  ).rejects.toThrow('no longer identifies')
})
