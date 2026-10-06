const { runInSeries } = require('../../out/src/utility/runInSeries.js')
// Native current-read and exact reference-count concurrency qualification.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { oracle, knex, sourceSchema } = require('./snapshotGlobalIndexFixtures.cjs')
const { addSnapshotGlobalIndexes } = require('../../out/src/storage/schema/snapshotGlobalIndexMigration.js')
const settle = p =>
  p.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
const success = result => {
  if (!result.ok) throw result.error
}
async function cases(control, connection, isolation) {
  const database = 'ts569_global_locks_' + randomUUID().replaceAll('-', '')
  await control.raw('CREATE DATABASE ??', [database])
  const open = () => knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
  const k = open(),
    writer = open(),
    observer = open(),
    results = []
  let trx
  try {
    await runInSeries([k, writer], async db => {
      await db.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation.toUpperCase())
    })
    await sourceSchema(k, 'utf8mb4_0900_ai_ci')
    await addSnapshotGlobalIndexes(k)
    const requester = Number((await k.raw('SELECT CONNECTION_ID() AS id'))[0][0].id)
    const wait = async () => {
      let observed
      function* pending() {
        for (let i = 0; i < 1000 && !observed; i++) yield i
      }
      await runInSeries(pending(), async () => {
        const [rows] = await observer.raw(
          'SELECT l.OBJECT_NAME AS tableName,l.LOCK_MODE AS lockMode FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND t.PROCESSLIST_ID=?',
          [requester]
        )
        if (rows.length) observed = rows
        else await new Promise(resolve => setTimeout(resolve, 5))
      })
      if (observed) return observed
      throw new Error('No native lock observed within five seconds')
    }
    const reset = async () => {
      await k('transactions').delete()
      await k('proven_tx_reqs').delete()
      await k('proven_txs').delete()
      await oracle(k)
    }
    const locked = async (name, held, pending) => {
      trx = await writer.transaction()
      let operation
      try {
        await held(trx)
        operation = settle(pending())
        const locks = await wait()
        await trx.commit()
        success(await operation)
        results.push({ name, locks, ...(await oracle(k)) })
      } finally {
        if (!trx.isCompleted()) await trx.rollback()
        if (operation) success(await operation)
      }
    }
    await locked(
      'proof insertion waits for absent-proof membership publication',
      t => t('transactions').insert({ transactionId: 1, userId: 1, txid: 'a', provenTxId: 71 }),
      () => k('proven_txs').insert({ provenTxId: 71 })
    )
    await reset()
    await locked(
      'membership waits for proof insertion',
      t => t('proven_txs').insert({ provenTxId: 71 }),
      () => k('transactions').insert({ transactionId: 1, userId: 1, txid: 'a', provenTxId: 71 })
    )
    await reset()
    await k('transactions').insert({ transactionId: 1, userId: 1, txid: 'a', provenTxId: 71 })
    trx = await writer.transaction()
    try {
      assert.equal(Number((await trx('snapshot_global_guards').where('proofId', 71).first()).present), 0)
      await k('proven_txs').insert({ provenTxId: 71 })
      await trx('transactions').insert({ transactionId: 2, userId: 2, txid: 'b', provenTxId: 71 })
      await trx.commit()
      results.push({ name: 'old snapshot cannot publish stale proof presence', ...(await oracle(k)) })
    } finally {
      if (!trx.isCompleted()) await trx.rollback()
    }
    await reset()
    await k('proven_txs').insert([{ provenTxId: 71 }, { provenTxId: 72 }])
    await k('proven_tx_reqs').insert({ provenTxReqId: 5, txid: 'a', provenTxId: 71 })
    trx = await writer.transaction()
    try {
      assert.equal((await trx('proven_tx_reqs').where('provenTxReqId', 5).first()).provenTxId, 71)
      await k('proven_tx_reqs').where('provenTxReqId', 5).update({ provenTxId: 72 })
      await trx('transactions').insert({ transactionId: 1, userId: 1, txid: 'a', provenTxId: null })
      await trx.commit()
      results.push({ name: 'old snapshot cannot restore old request proof', ...(await oracle(k)) })
    } finally {
      if (!trx.isCompleted()) await trx.rollback()
    }
    await reset()
    await k('proven_txs').insert({ provenTxId: 71 })
    await k('transactions').insert([
      { transactionId: 1, userId: 1, txid: 'a', provenTxId: 71 },
      { transactionId: 2, userId: 1, txid: 'b', provenTxId: 71 }
    ])
    await locked(
      'concurrent final reference removals preserve exact count',
      t => t('transactions').where('transactionId', 1).delete(),
      () => k('transactions').where('transactionId', 2).delete()
    )
    await reset()
    await k('proven_txs').insert({ provenTxId: 71 })
    await locked(
      'request insertion sees pending matching transaction',
      t => t('transactions').insert({ transactionId: 1, userId: 1, txid: 'a', provenTxId: null }),
      () => k('proven_tx_reqs').insert({ provenTxReqId: 5, txid: 'a', provenTxId: 71 })
    )
    return { isolation, results }
  } finally {
    if (trx && !trx.isCompleted()) await trx.rollback()
    await Promise.all([k.destroy(), writer.destroy(), observer.destroy()])
    await control.raw('DROP DATABASE ??', [database])
  }
}
async function qualifyMysqlGlobalIndexLocks(control, connection) {
  const results = []
  await runInSeries(['read committed', 'repeatable read'], async isolation => {
    results.push(await cases(control, connection, isolation))
  })
  return results
}
module.exports = { qualifyMysqlGlobalIndexLocks }
