const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex, oracle, sequential, sourceSchema, generated } = require('./snapshotGlobalIndexFixtures.cjs')
const helper = require('../../out/src/storage/schema/snapshotGlobalIndexMigration.js')
async function qualifySchedules(k, collation) {
  await sourceSchema(k, collation)
  await k('proven_txs').insert([{ provenTxId: 7 }, { provenTxId: 9 }])
  await k('proven_tx_reqs').insert([
    { provenTxReqId: 5, txid: 'a', provenTxId: 9 },
    { provenTxReqId: 6, txid: 'b', provenTxId: 7 }
  ])
  await runInSeries([0, 200, 400], async start => {
    await k('transactions').insert(
      Array.from({ length: 200 }, (_, i) => ({
        transactionId: start + i + 1,
        userId: ((start + i) % 3) + 1,
        txid: (start + i) % 2 ? 'a' : 'b',
        provenTxId: (start + i) % 2 ? 7 : null
      }))
    )
  })
  assert.equal(await helper.readSnapshotGlobalIndexState(k), false)
  await helper.addSnapshotGlobalIndexes(k)
  const bootstrap = await oracle(k)
  const before = await k('snapshot_global_keys').orderBy(['tableId', 'userId', 'rowId'])
  await helper.addSnapshotGlobalIndexes(k)
  assert.deepEqual(await k('snapshot_global_keys').orderBy(['tableId', 'userId', 'rowId']), before)
  await k('snapshot_global_index_progress').where('id', 0).update({ afterRowId: 0, complete: false })
  await helper.addSnapshotGlobalIndexes(k)
  assert.deepEqual(await k('snapshot_global_keys').orderBy(['tableId', 'userId', 'rowId']), before)
  assert.equal(await helper.readSnapshotGlobalIndexState(k), false)
  await k.schema.createTable('knex_migrations', t => t.string('name'))
  await k('knex_migrations').insert({ name: helper.SNAPSHOT_GLOBAL_INDEX_MIGRATION })
  assert.equal(await helper.readSnapshotGlobalIndexState(k), true)
  await k('transactions').delete()
  await k('proven_tx_reqs').delete()
  await k('proven_txs').delete()
  const transitions = await sequential(k)
  const schedules = await generated(k)
  const source = await k('transactions').orderBy('transactionId')
  await helper.removeSnapshotGlobalIndexes(k)
  assert.deepEqual(await k('transactions').orderBy('transactionId'), source)
  await assert.rejects(helper.readSnapshotGlobalIndexState(k), /incomplete/)
  await helper.addSnapshotGlobalIndexes(k)
  await oracle(k)
  assert.equal(await helper.readSnapshotGlobalIndexState(k), true)
  return {
    dialect: k.client.config.client,
    collation,
    bootstrap,
    bootstrapRows: 600,
    repeatedInstall: true,
    resumedReplay: true,
    journalAdoption: true,
    removalPreservesSource: true,
    sequential: transitions.length,
    ...schedules
  }
}
async function qualifyBoundaries(k, collation) {
  await sourceSchema(k, collation)
  await helper.addSnapshotGlobalIndexes(k)
  await k('proven_txs').insert({ provenTxId: 4294967295 })
  await k('proven_tx_reqs').insert({ provenTxReqId: 4294967294, txid: 'A', provenTxId: 4294967295 })
  await k('transactions').insert({ transactionId: 4294967293, userId: 4294967292, txid: 'A', provenTxId: 4294967295 })
  await oracle(k)
  await runInSeries(['a', 'a ', 'é', 'e\u0301', 'A\0B', '😀'.repeat(64)], async text => {
    await k('proven_tx_reqs').where('provenTxReqId', 4294967294).update({ txid: text })
    await oracle(k)
    await k('transactions').where('transactionId', 4294967293).update({ txid: text })
    await oracle(k)
  })
  await k('snapshot_global_index_progress').where('id', 0).update({ afterRowId: 0, complete: false })
  await helper.addSnapshotGlobalIndexes(k)
  await oracle(k)
  return { collation, unsignedIdBoundary: 4294967295, txidTextAndReplay: true }
}
async function qualifyMysqlGlobalIndexSchedules(admin, connection) {
  const results = []
  await runInSeries(['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin'], async collation => {
    await runInSeries(
      [
        ['schedules', qualifySchedules],
        ['boundaries', qualifyBoundaries]
      ],
      async ([name, qualify]) => {
        const database = 'ts569_global_' + randomUUID().replaceAll('-', '')
        await admin.raw(`CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE ${collation}`, [database])
        const k = knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
        try {
          results.push({ name, ...(await qualify(k, collation)) })
        } finally {
          await k.destroy()
          await admin.raw('DROP DATABASE ??', [database])
        }
      }
    )
  })
  return results
}
module.exports = { qualifyMysqlGlobalIndexSchedules }
