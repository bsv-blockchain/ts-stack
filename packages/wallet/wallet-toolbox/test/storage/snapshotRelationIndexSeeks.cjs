// Invoked only by the verified disposable native MySQL fixture.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex } = require('knex')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const {
  createKnexWalletSnapshotPageReader: pageReader
} = require('../../out/src/storage/snapshot/KnexWalletReadSnapshot.js')
async function largeSeeks(source, userId, otherId, mysql) {
  const k = source.knex
  const date = mysql ? new Date('2026-01-01T00:00:00Z') : '2026-01-01T00:00:00Z'
  const common = { created_at: date, updated_at: date, isDeleted: false }
  for (let start = 100; start < 8292; start += 256) {
    const ids = Array.from({ length: Math.min(256, 8292 - start) }, (_, i) => start + i)
    await k.transaction(async trx => {
      await trx('tx_labels').insert(
        ids.map(id => ({ ...common, txLabelId: id, userId: id % 2 ? otherId : userId, label: 'large-' + id }))
      )
      await trx('output_tags').insert(
        ids.map(id => ({ ...common, outputTagId: id, userId: id % 2 ? otherId : userId, tag: 'large-' + id }))
      )
      await trx('tx_labels_map').insert(ids.map(id => ({ ...common, txLabelId: id, transactionId: id % 2 ? 2 : 1 })))
      await trx('output_tags_map').insert(ids.map(id => ({ ...common, outputTagId: id, outputId: id % 2 ? 2 : 1 })))
    })
  }
  if (mysql) await k.raw('ANALYZE TABLE snapshot_relation_keys, tx_labels_map, output_tags_map')
  const view = await source.openReadSnapshot()
  const read = pageReader(source, userId, 'large-seek-fixture', view, true, true)
  const results = []
  const counters = () =>
    view.read(async trx =>
      Object.fromEntries(
        (await source.toDb(trx).raw("SHOW SESSION STATUS LIKE 'Handler_read_%'"))[0].map(row => [
          row.Variable_name,
          Number(row.Value)
        ])
      )
    )
  try {
    for (const table of ['txLabelMaps', 'outputTagMaps']) {
      await read(table, undefined, { maxRows: 1 })
      for (const leftId of [1500, 7000, 8280]) {
        const queries = []
        const listener = q => {
          if (q.sql.startsWith('select') && q.sql.includes('snapshot_relation_keys') && q.sql.includes('cross join'))
            queries.push(q)
        }
        const before = mysql ? await counters() : {}
        k.on('query', listener)
        let page
        try {
          page = await read(
            table,
            { version: 1, snapshotId: 'large-seek-fixture', table, after: [leftId, 1] },
            { maxRows: 16, maxBytes: 131072 }
          )
        } finally {
          k.off('query', listener)
        }
        const after = mysql ? await counters() : {}
        const deltas = Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]))
        const expectedIds = Array.from({ length: Math.min(16, (8290 - leftId) / 2) }, (_, i) => leftId + (i + 1) * 2)
        const field = table === 'txLabelMaps' ? 'txLabelId' : 'outputTagId'
        assert.deepEqual(
          page.rows.map(row => row[field]),
          expectedIds
        )
        const plans = []
        for (const q of queries)
          plans.push(
            await view.read(async trx =>
              mysql
                ? (await source.toDb(trx).raw('EXPLAIN ' + q.sql, q.bindings))[0]
                : await source.toDb(trx).raw('EXPLAIN QUERY PLAN ' + q.sql, q.bindings)
            )
          )
        const result = { table, after: leftId, rows: page.rows.length, deltas, plans, queries }
        results.push(result)
        if (mysql) {
          assert.ok(deltas.Handler_read_next <= 64, 'The page must not scan prior or foreign relation keys')
          assert.ok(deltas.Handler_read_rnd_next <= 64, 'The page must not scan rows into a temporary table')
          assert.ok(
            plans.every(plan => plan[0].table === 'snapshot_relation_keys' && plan[0].type === 'range'),
            'Both page passes must seek the composite profile range'
          )
        }
      }
    }
  } finally {
    await view.close()
  }
  return results
}

async function qualifyMysqlRelationIndexSeeks(control, connection) {
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const database = 'ts569_relation_seeks_' + randomUUID().replaceAll('-', '')
  await control.raw('CREATE DATABASE ??', [database])
  const source = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
  })
  try {
    await source.migrate('synthetic relation seek', 'synthetic-relation-seek')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
    for (const [id, userId] of [
      [1, user.userId],
      [2, other.userId]
    ]) {
      await source
        .knex('transactions')
        .insert({
          ...dates,
          transactionId: id,
          userId,
          status: 'completed',
          reference: 'relation-' + id,
          isOutgoing: true,
          satoshis: 0,
          description: ''
        })
      await source
        .knex('outputs')
        .insert({
          ...dates,
          outputId: id,
          userId,
          transactionId: id,
          spendable: false,
          change: false,
          vout: 0,
          satoshis: 1,
          providedBy: 'you',
          purpose: '',
          type: 'P2PKH'
        })
    }
    return await largeSeeks(source, user.userId, other.userId, true)
  } finally {
    await source.destroy()
    await control.raw('DROP DATABASE ??', [database])
  }
}
module.exports = { qualifyMysqlRelationIndexSeeks }
