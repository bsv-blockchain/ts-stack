const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex } = require('knex')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { addSnapshotGlobalIndexes } = require('../../out/src/storage/schema/snapshotGlobalIndexMigration.js')
const {
  createKnexWalletSnapshotPageReader: pageReader
} = require('../../out/src/storage/snapshot/KnexWalletReadSnapshot.js')
const date = new Date('2026-01-01'),
  dates = { created_at: date, updated_at: date }
const txid = id => id.toString(16).padStart(64, '0')
async function seed(source) {
  const k = source.knex
  const users = []
  await runInSeries(['02' + '11'.repeat(32), '03' + '22'.repeat(32)], async key => {
    users.push((await source.findOrInsertUser(key)).user.userId)
  })
  await runInSeries(
    Array.from({ length: 32 }, (_, i) => i * 256),
    async start => {
      const ids = Array.from({ length: 256 }, (_, i) => start + i + 1)
      await k('proven_txs').insert(
        ids.map(id => ({
          ...dates,
          provenTxId: id,
          txid: txid(id),
          height: 1,
          index: 0,
          merklePath: Buffer.from([1]),
          rawTx: Buffer.from([1]),
          blockHash: 'a'.repeat(64),
          merkleRoot: 'b'.repeat(64)
        }))
      )
      await k('proven_tx_reqs').insert(
        ids.map(id => ({
          ...dates,
          provenTxReqId: id,
          provenTxId: id,
          txid: txid(id),
          history: '{}',
          notify: '{}',
          status: 'unknown',
          rawTx: Buffer.from([1])
        }))
      )
      await k('transactions').insert(
        ids.map(id => ({
          ...dates,
          transactionId: id,
          userId: users[(id - 1) % 2],
          txid: txid(id),
          provenTxId: id,
          status: 'completed',
          reference: 'global-seek-' + id,
          isOutgoing: true,
          satoshis: 0,
          description: ''
        }))
      )
    }
  )
  await addSnapshotGlobalIndexes(k)
  return users
}
async function observe(source, view, read, table, cursor) {
  const physical = table === 'provenTxs' ? 'proven_txs' : 'proven_tx_reqs'
  const key = table === 'provenTxs' ? 'provenTxId' : 'provenTxReqId'
  const stats = async () =>
    await view.read(async trx =>
      Object.fromEntries(
        (
          await source
            .toDb(trx)
            .raw(
              'SELECT OBJECT_NAME,COUNT_FETCH FROM performance_schema.table_io_waits_summary_by_table WHERE OBJECT_SCHEMA=DATABASE()'
            )
        )[0].map(r => [r.OBJECT_NAME, Number(r.COUNT_FETCH)])
      )
    )
  const queries = []
  const listener = q => {
    if (q.sql.startsWith('select') && q.sql.includes('snapshot_global_keys') && q.sql.includes('cross join'))
      queries.push(q)
  }
  const before = await stats()
  source.knex.on('query', listener)
  let page
  try {
    page = await read(
      table,
      cursor === undefined ? undefined : { version: 1, snapshotId: 'global-native-seek', table, after: [cursor] },
      { maxRows: 16, maxBytes: 131072 }
    )
  } finally {
    source.knex.off('query', listener)
  }
  const after = await stats()
  const fetches = Object.fromEntries(Object.keys(after).map(name => [name, after[name] - (before[name] ?? 0)]))
  const expected = Array.from(
    { length: Math.min(16, Math.ceil((8192 - (cursor ?? 0)) / 2)) },
    (_, i) => (cursor ?? 0) + i * 2 + 1
  )
  assert.deepEqual(
    page.rows.map(row => row[key]),
    expected
  )
  assert.equal(fetches[physical], page.rows.length * 2, JSON.stringify(fetches))
  assert.equal(fetches.users ?? 0, 0)
  assert.ok(
    fetches.snapshot_global_keys >= page.rows.length * 2 && fetches.snapshot_global_keys <= page.rows.length * 2 + 4,
    JSON.stringify(fetches)
  )
  for (const [name, count] of Object.entries(fetches))
    if (![physical, 'snapshot_global_keys'].includes(name)) assert.equal(count, 0, name)
  assert.equal(queries.length, 2)
  const plans = []
  await runInSeries(queries, async q => {
    const plan = await view.read(async trx => (await source.toDb(trx).raw('EXPLAIN ' + q.sql, q.bindings))[0])
    assert.equal(plan[0].table, 'snapshot_global_keys')
    assert.equal(plan[0].key, 'snapshot_global_page')
    assert.ok((cursor === undefined ? ['range', 'ref'] : ['range']).includes(plan[0].type), JSON.stringify(plan))
    plans.push(plan)
  })
  return { table, cursor: cursor ?? null, rows: page.rows.length, fetches, plans }
}
async function qualifyMysqlGlobalIndexSeeks(control, connection) {
  const database = 'ts569_global_read_' + randomUUID().replaceAll('-', '')
  let source
  try {
    await control.raw('CREATE DATABASE ??', [database])
    source = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
    })
    await source.migrate('synthetic global reader seek', 'synthetic-global-reader-seek')
    await source.makeAvailable()
    const [userId] = await seed(source),
      results = []
    await runInSeries(['fresh', 'refreshed'], async statistics => {
      if (statistics === 'refreshed')
        await source.knex.raw('ANALYZE TABLE snapshot_global_keys,proven_txs,proven_tx_reqs')
      const view = await source.openReadSnapshot()
      try {
        const read = pageReader(source, userId, 'global-native-seek', view, true, true, true, true)
        await runInSeries(['provenTxs', 'provenTxReqs'], async table => {
          await runInSeries([undefined, 1500, 7000, 8180], async cursor => {
            results.push({ statistics, ...(await observe(source, view, read, table, cursor)) })
          })
        })
      } finally {
        await view.close()
      }
    })
    return { actualReaderTwoPass: true, rows: 8192, results }
  } finally {
    if (source) await source.destroy()
    await control.raw('DROP DATABASE IF EXISTS ??', [database])
  }
}
module.exports = { qualifyMysqlGlobalIndexSeeks }
