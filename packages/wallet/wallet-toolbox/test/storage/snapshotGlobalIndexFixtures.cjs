const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const assert = require('node:assert/strict')
const { knex } = require('knex')
const fc = require('fast-check')
const edges = 'snapshot_global_edges',
  keys = 'snapshot_global_keys',
  guards = 'snapshot_global_guards'
async function sourceSchema(k, collation) {
  const mysql = k.client.config.client === 'mysql2'
  const integer = mysql ? 'INT UNSIGNED' : 'INTEGER'
  const suffix = mysql ? ' ENGINE=InnoDB' : ''
  const text = `VARCHAR(64) COLLATE ${collation}`
  await k.raw(`CREATE TABLE proven_txs(provenTxId ${integer} NOT NULL PRIMARY KEY)${suffix}`)
  await k.raw(
    `CREATE TABLE proven_tx_reqs(provenTxReqId ${integer} NOT NULL PRIMARY KEY,provenTxId ${integer},txid ${text} NOT NULL UNIQUE)${suffix}`
  )
  await k.raw(
    `CREATE TABLE transactions(transactionId ${integer} NOT NULL PRIMARY KEY,userId ${integer} NOT NULL,provenTxId ${integer},txid ${text})${suffix}`
  )
  await k.schema.alterTable('transactions', t => t.index('txid'))
}
async function oracle(k) {
  const direct = k('transactions')
    .select(k.raw('transactionId,0 AS requestId,1 AS tableId,provenTxId AS rowId,userId'))
    .whereNotNull('provenTxId')
  const req = k('transactions AS t')
    .join('proven_tx_reqs AS r', 'r.txid', 't.txid')
    .select(k.raw('t.transactionId,r.provenTxReqId AS requestId,0 AS tableId,r.provenTxReqId AS rowId,t.userId'))
  const indirect = k('transactions AS t')
    .join('proven_tx_reqs AS r', 'r.txid', 't.txid')
    .select(k.raw('t.transactionId,r.provenTxReqId AS requestId,1 AS tableId,r.provenTxId AS rowId,t.userId'))
    .whereNotNull('r.provenTxId')
  const expected = [...(await direct), ...(await req), ...(await indirect)]
  const order = rows =>
    rows
      .map(row => [row.transactionId, row.requestId, row.tableId, row.rowId, row.userId])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  assert.deepEqual(order(await k(edges)), order(expected), 'Independent relational union must equal every edge')
  const proofs = new Set((await k('proven_txs')).map(row => row.provenTxId))
  const counts = new Map()
  for (const row of expected) {
    const key = JSON.stringify([row.tableId, row.userId, row.rowId])
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const actual = await k(keys)
  assert.equal(actual.length, counts.size)
  for (const row of actual) {
    const key = JSON.stringify([row.tableId, row.userId, row.rowId])
    assert.equal(row.refs, counts.get(key), key)
    assert.equal(Number(row.present), row.tableId === 0 || proofs.has(row.rowId) ? 1 : 0, key)
  }
  const expectedGuards = [...new Set(expected.filter(row => row.tableId === 1).map(row => row.rowId))].sort(
    (a, b) => a - b
  )
  const actualGuards = await k(guards).orderBy('proofId')
  assert.deepEqual(
    actualGuards.map(row => row.proofId),
    expectedGuards,
    'No unused proof serialization rows'
  )
  for (const row of actualGuards) assert.equal(Number(row.present), proofs.has(row.proofId) ? 1 : 0)
  return { edges: expected.length, keys: counts.size }
}
async function sequential(k) {
  const records = []
  const step = async (name, action) => {
    await action()
    records.push({ name, ...(await oracle(k)) })
  }
  await step('proof', () => k('proven_txs').insert({ provenTxId: 7 }))
  await step('direct owner', () => k('transactions').insert({ transactionId: 1, userId: 1, txid: 'a', provenTxId: 7 }))
  await step('duplicate owner', () =>
    k('transactions').insert({ transactionId: 2, userId: 1, txid: 'a', provenTxId: 7 })
  )
  await step('other profile', () => k('transactions').insert({ transactionId: 3, userId: 2, txid: 'a', provenTxId: 7 }))
  await step('same proof through request', () =>
    k('proven_tx_reqs').insert({ provenTxReqId: 5, txid: 'a', provenTxId: 7 })
  )
  await step('one reference removed', () => k('transactions').where('transactionId', 1).delete())
  await step('proof absent with references', () => k('proven_txs').where('provenTxId', 7).delete())
  await step('proof returned', () => k('proven_txs').insert({ provenTxId: 7 }))
  await step('new absent indirect proof', () => k('proven_tx_reqs').where('provenTxReqId', 5).update({ provenTxId: 9 }))
  await step('new proof appears', () => k('proven_txs').insert({ provenTxId: 9 }))
  await step('transaction moves profile', () => k('transactions').where('transactionId', 2).update({ userId: 3 }))
  await step('request changes txid', () => k('proven_tx_reqs').where('provenTxReqId', 5).update({ txid: 'b' }))
  await step('transaction matches new txid', () => k('transactions').where('transactionId', 3).update({ txid: 'b' }))
  await step('request changes ID', () => k('proven_tx_reqs').where('provenTxReqId', 5).update({ provenTxReqId: 6 }))
  await step('transaction changes ID', () => k('transactions').where('transactionId', 2).update({ transactionId: 20 }))
  await step('proof changes ID', () => k('proven_txs').where('provenTxId', 9).update({ provenTxId: 10 }))
  await step('request removed', () => k('proven_tx_reqs').where('provenTxReqId', 6).delete())
  await step('last direct references removed', () => k('transactions').delete())
  return records
}
async function generated(k) {
  let schedules = 0,
    steps = 0,
    expectedConstraintFailures = 0
  const op = fc.record({
    kind: fc.integer({ min: 0, max: 8 }),
    id: fc.integer({ min: 1, max: 5 }),
    userId: fc.integer({ min: 1, max: 3 }),
    otherId: fc.integer({ min: 1, max: 5 }),
    nullable: fc.boolean()
  })
  await fc.assert(
    fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 24 }), async ops => {
      await k('transactions').delete()
      await k('proven_tx_reqs').delete()
      await k('proven_txs').delete()
      await oracle(k)
      await runInSeries(ops, async o => {
        const proof = o.nullable ? null : o.otherId,
          txid = o.nullable ? null : 'r' + o.otherId
        try {
          switch (o.kind) {
            case 0:
              await k('transactions')
                .insert({ transactionId: o.id, userId: o.userId, txid, provenTxId: proof })
                .onConflict('transactionId')
                .merge()
              break
            case 1:
              await k('transactions').where('transactionId', o.id).delete()
              break
            case 2:
              await k('transactions').where('transactionId', o.id).update({ userId: o.userId, txid, provenTxId: proof })
              break
            case 3:
              await k('proven_tx_reqs')
                .insert({ provenTxReqId: o.id, txid: 'r' + o.id, provenTxId: proof })
                .onConflict('provenTxReqId')
                .merge()
              break
            case 4:
              await k('proven_tx_reqs').where('provenTxReqId', o.id).delete()
              break
            case 5:
              await k('proven_tx_reqs')
                .where('provenTxReqId', o.id)
                .update({ txid: 'r' + o.otherId, provenTxId: proof })
              break
            case 6:
              await k('proven_txs').insert({ provenTxId: o.id }).onConflict('provenTxId').ignore()
              break
            case 7:
              await k('proven_txs').where('provenTxId', o.id).delete()
              break
            case 8:
              await k('proven_txs').where('provenTxId', o.id).update({ provenTxId: o.otherId })
              break
          }
        } catch (error) {
          if (
            error.code === 'ER_DUP_ENTRY' ||
            error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
            error.code === 'SQLITE_CONSTRAINT_UNIQUE'
          )
            expectedConstraintFailures++
          else throw error
        }
        await oracle(k)
        steps++
      })
      schedules++
    }),
    { numRuns: 300, seed: 3242026, endOnFailure: true }
  )
  assert.equal(schedules, 300)
  return { schedules, steps, expectedConstraintFailures, seed: 3242026 }
}
module.exports = { oracle, sequential, sourceSchema, generated, knex }
