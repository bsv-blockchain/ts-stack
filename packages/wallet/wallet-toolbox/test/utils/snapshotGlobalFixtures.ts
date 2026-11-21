import { knex, type Knex } from 'knex'
import { runInSeries } from '../../src/utility/runInSeries'

/** Independent standard-source graph; auxiliary definitions are not its oracle. */
export async function createGlobalSource(k: Knex, collation = 'BINARY'): Promise<void> {
  if (!['BINARY', 'NOCASE', 'RTRIM'].includes(collation)) throw new Error('Unsupported fixture collation')
  const mysql = String(k.client.config.client).includes('mysql')
  const integer = mysql ? 'INT UNSIGNED' : 'INTEGER'
  const text = mysql ? 'VARCHAR(64)' : `VARCHAR(64) COLLATE ${collation}`
  const suffix = mysql ? ' ENGINE=InnoDB' : ''
  await k.raw(`CREATE TABLE proven_txs(provenTxId ${integer} NOT NULL PRIMARY KEY)${suffix}`)
  await k.raw(
    `CREATE TABLE proven_tx_reqs(provenTxReqId ${integer} NOT NULL PRIMARY KEY,provenTxId ${integer},txid ${text} NOT NULL UNIQUE)${suffix}`
  )
  await k.raw(
    `CREATE TABLE transactions(transactionId ${integer} NOT NULL PRIMARY KEY,userId ${integer} NOT NULL,provenTxId ${integer},txid ${text})${suffix}`
  )
  await k.schema.alterTable('transactions', table => {
    void table.index('txid')
  })
}

export async function minimalGlobalDatabase(collation = 'BINARY'): Promise<Knex> {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await createGlobalSource(k, collation)
    return k
  } catch (error) {
    await k.destroy()
    throw error
  }
}

interface Edge {
  transactionId: number
  requestId: number
  tableId: number
  rowId: number
  userId: number
}
export async function expectGlobalMembership(k: Knex): Promise<void> {
  const direct: Edge[] = await k('transactions')
    .select(k.raw('transactionId,0 AS requestId,1 AS tableId,provenTxId AS rowId,userId'))
    .whereNotNull('provenTxId')
  const requests: Edge[] = await k('transactions AS t')
    .join('proven_tx_reqs AS r', 'r.txid', 't.txid')
    .select(k.raw('t.transactionId,r.provenTxReqId AS requestId,0 AS tableId,r.provenTxReqId AS rowId,t.userId'))
  const indirect: Edge[] = await k('transactions AS t')
    .join('proven_tx_reqs AS r', 'r.txid', 't.txid')
    .select(k.raw('t.transactionId,r.provenTxReqId AS requestId,1 AS tableId,r.provenTxId AS rowId,t.userId'))
    .whereNotNull('r.provenTxId')
  const expected = [...direct, ...requests, ...indirect]
  const order = (rows: Edge[]) =>
    rows
      .map(row => [row.transactionId, row.requestId, row.tableId, row.rowId, row.userId])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  expect(order(await k('snapshot_global_edges'))).toEqual(order(expected))
  const proofs = new Set((await k('proven_txs').select('provenTxId')).map(row => row.provenTxId))
  const counts = new Map<string, number>()
  for (const row of expected) {
    const key = JSON.stringify([row.tableId, row.userId, row.rowId])
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const actual = await k('snapshot_global_keys')
  expect(actual).toHaveLength(counts.size)
  for (const row of actual) {
    expect(Number(row.refs)).toBe(counts.get(JSON.stringify([row.tableId, row.userId, row.rowId])))
    expect(Number(row.present)).toBe(row.tableId === 0 || proofs.has(row.rowId) ? 1 : 0)
  }
  const guards = await k('snapshot_global_guards').orderBy('proofId')
  expect(guards.map(row => row.proofId)).toEqual(
    [...new Set(expected.filter(row => row.tableId === 1).map(row => row.rowId))].sort((a, b) => a - b)
  )
  for (const row of guards) expect(Number(row.present)).toBe(proofs.has(row.proofId) ? 1 : 0)
}

export interface GlobalOperation {
  kind: number
  id: number
  userId: number
  otherId: number
  nullable: boolean
}
export async function clearGlobalSource(k: Knex): Promise<void> {
  await runInSeries(['transactions', 'proven_tx_reqs', 'proven_txs'], async table => {
    await k(table).delete()
  })
}
export async function applyGlobalOperation(k: Knex, op: GlobalOperation): Promise<void> {
  const provenTxId = op.nullable ? null : op.otherId
  const txid = op.nullable ? null : 'r' + op.otherId
  try {
    switch (op.kind) {
      case 0:
        await k('transactions')
          .insert({ transactionId: op.id, userId: op.userId, txid, provenTxId })
          .onConflict('transactionId')
          .merge()
        break
      case 1:
        await k('transactions').where('transactionId', op.id).delete()
        break
      case 2:
        await k('transactions').where('transactionId', op.id).update({ userId: op.userId, txid, provenTxId })
        break
      case 3:
        await k('proven_tx_reqs')
          .insert({ provenTxReqId: op.id, txid: 'r' + op.id, provenTxId })
          .onConflict('provenTxReqId')
          .merge()
        break
      case 4:
        await k('proven_tx_reqs').where('provenTxReqId', op.id).delete()
        break
      case 5:
        await k('proven_tx_reqs')
          .where('provenTxReqId', op.id)
          .update({ txid: 'r' + op.otherId, provenTxId })
        break
      case 6:
        await k('proven_txs').insert({ provenTxId: op.id }).onConflict('provenTxId').ignore()
        break
      case 7:
        await k('proven_txs').where('provenTxId', op.id).delete()
        break
      case 8:
        await k('proven_txs').where('provenTxId', op.id).update({ provenTxId: op.otherId })
        break
      default:
        throw new Error('Unsupported generated operation')
    }
  } catch (error) {
    if (
      !['ER_DUP_ENTRY', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE'].includes(
        (error as { code?: string }).code ?? ''
      )
    )
      throw error
  }
}
