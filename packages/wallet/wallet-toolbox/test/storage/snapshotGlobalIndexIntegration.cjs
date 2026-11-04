const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex, oracle, sourceSchema } = require('./snapshotGlobalIndexFixtures.cjs')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const helper = require('../../out/src/storage/schema/snapshotGlobalIndexMigration.js')
const {
  createKnexWalletSnapshotPageReader: pageReader,
  openKnexWalletReadSnapshot
} = require('../../out/src/storage/snapshot/KnexWalletReadSnapshot.js')
const { openKnexSnapshotArchiveSource } = require('../../out/src/storage/snapshot/archive/KnexSnapshotArchiveSource.js')
const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
const identity = '02' + '11'.repeat(32)
const standardKeys = { proven_txs: 'provenTxId', proven_tx_reqs: 'provenTxReqId', transactions: 'transactionId' }
async function compareReaders(source, users) {
  const tables = [
    'provenTxs',
    'provenTxReqs',
    'outputBaskets',
    'transactions',
    'commissions',
    'outputs',
    'outputTags',
    'outputTagMaps',
    'txLabels',
    'txLabelMaps',
    'certificates',
    'certificateFields',
    'syncStates'
  ]
  const results = []
  await runInSeries(users, async userId => {
    const view = await source.openReadSnapshot()
    try {
      const legacy = pageReader(source, userId, 'global-draft', view, true, true, true, false)
      const indexed = pageReader(source, userId, 'global-draft', view, true, true, true, true)
      await runInSeries(tables, async table => {
        let cursor,
          rows = 0,
          pages = 0,
          complete = false
        function* pendingPages() {
          while (!complete) yield undefined
        }
        await runInSeries(pendingPages(), async () => {
          const options = { maxRows: 17, maxBytes: 131072 }
          const expected = await legacy(table, cursor, options)
          const actual = await indexed(table, cursor, options)
          assert.deepEqual(actual, expected, `All source rows, public cursor and byte charges must match for ${table}`)
          rows += actual.rows.length
          pages++
          assert.ok(pages < 1000)
          complete = actual.done
          cursor = actual.cursor
        })
        results.push({ userId, table, rows, pages })
      })
    } finally {
      await view.close()
    }
  })
  return results
}
async function qualifySchema(options) {
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: knex(options) })
  const k = source.knex
  try {
    await source.migrate('synthetic global draft', 'synthetic-global-draft')
    await source.makeAvailable()
    const users = []
    await runInSeries(['02' + '11'.repeat(32), '03' + '22'.repeat(32)], async identity => {
      users.push((await source.findOrInsertUser(identity)).user.userId)
    })
    await runInSeries([7, 9], async provenTxId => {
      await k('proven_txs').insert({
        ...dates,
        provenTxId,
        txid: String(provenTxId).repeat(64),
        height: 1,
        index: 0,
        merklePath: Buffer.from([1]),
        rawTx: Buffer.from([1]),
        blockHash: 'a'.repeat(64),
        merkleRoot: 'b'.repeat(64)
      })
    })
    await runInSeries([5, 6], async provenTxReqId => {
      await k('proven_tx_reqs').insert({
        ...dates,
        provenTxReqId,
        txid: String(provenTxReqId).repeat(64),
        provenTxId: 9,
        status: 'unknown',
        history: '{}',
        notify: '{}',
        rawTx: Buffer.from([1])
      })
    })
    await runInSeries([0, 1, 2], async batch => {
      await k('transactions').insert(
        Array.from({ length: 200 }, (_, i) => ({
          ...dates,
          transactionId: batch * 200 + i + 1,
          userId: users[i % 2],
          txid: String(i % 2 ? 5 : 6).repeat(64),
          provenTxId: i % 2 ? 7 : null,
          status: 'completed',
          reference: 'global-' + (batch * 200 + i),
          isOutgoing: true,
          satoshis: 0,
          description: ''
        }))
      )
    })
    const oldIndexes = {}
    await runInSeries(Object.keys(standardKeys), async table => {
      oldIndexes[table] =
        options.client === 'mysql2'
          ? (await k.raw('SHOW INDEXES FROM ??', [table]))[0].map(row => [
              row.Key_name,
              row.Seq_in_index,
              row.Column_name
            ])
          : await k.raw('PRAGMA index_list(??)', [table])
    })
    await helper.addSnapshotGlobalIndexes(k)
    const initial = await oracle(k)
    const initialReaders = await compareReaders(source, users)
    await k('transactions').where('transactionId', 1).update({ userId: users[1], provenTxId: 7 })
    await oracle(k)
    await k('proven_tx_reqs').where('provenTxReqId', 5).update({ provenTxId: 7 })
    await oracle(k)
    await k('transactions').whereIn('transactionId', [3, 7, 19, 21]).delete()
    await oracle(k)
    const changedReaders = await compareReaders(source, users)
    const standard = {}
    await runInSeries(Object.keys(standardKeys), async table => {
      standard[table] = await k(table).orderBy(standardKeys[table])
      const now =
        options.client === 'mysql2'
          ? (await k.raw('SHOW INDEXES FROM ??', [table]))[0].map(row => [
              row.Key_name,
              row.Seq_in_index,
              row.Column_name
            ])
          : await k.raw('PRAGMA index_list(??)', [table])
      assert.deepEqual(now, oldIndexes[table])
    })
    await helper.removeSnapshotGlobalIndexes(k)
    await runInSeries(Object.keys(standard), async table => {
      assert.deepEqual(await k(table).orderBy(standardKeys[table]), standard[table])
    })
    await helper.addSnapshotGlobalIndexes(k)
    const reinstalled = await oracle(k)
    return {
      realStorageKnexSchema: true,
      dialect: options.client,
      bootstrapRows: 600,
      standardIndexesPreserved: true,
      sourceRowsPreservedOnRemoval: true,
      initial,
      reinstalled,
      initialReaders,
      changedReaders
    }
  } finally {
    await source.destroy()
  }
}
async function qualifyPinned(options, archive) {
  const open = archive ? openKnexSnapshotArchiveSource : openKnexWalletReadSnapshot
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: knex(options) })
  const writer = knex(options),
    k = source.knex
  let before, after
  try {
    if (options.client === 'better-sqlite3') await k.raw('PRAGMA journal_mode = WAL')
    await source.migrate('global pinned draft', 'global-pinned-draft')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser(identity)
    await runInSeries([7, 9], async provenTxId => {
      await k('proven_txs').insert({
        ...dates,
        provenTxId,
        txid: String(provenTxId).repeat(64),
        height: 1,
        index: 0,
        merklePath: Buffer.from([1]),
        rawTx: Buffer.from([1]),
        blockHash: 'a'.repeat(64),
        merkleRoot: 'b'.repeat(64)
      })
    })
    await k('proven_tx_reqs').insert({
      ...dates,
      provenTxReqId: 5,
      txid: 'a'.repeat(64),
      provenTxId: 7,
      status: 'unknown',
      rawTx: Buffer.from([1]),
      history: '{}',
      notify: '{}'
    })
    await k('transactions').insert({
      ...dates,
      transactionId: 1,
      userId: user.userId,
      txid: 'a'.repeat(64),
      provenTxId: 7,
      status: 'completed',
      reference: 'pinned-global',
      isOutgoing: true,
      satoshis: 0,
      description: ''
    })
    const queries = []
    k.on('query', q => {
      if (q.sql.includes('cross join')) queries.push(q.sql)
    })
    before = await open(source, identity, {})
    await writer.transaction(async trx => {
      await trx('transactions').where('transactionId', 1).update({ provenTxId: 9 })
      await trx('proven_tx_reqs').where('provenTxReqId', 5).update({ provenTxId: 9 })
    })
    await oracle(writer)
    if (archive) await before.validateClosure()
    assert.deepEqual(
      (await before.readPage('provenTxs')).rows.map(row => row.provenTxId),
      [7]
    )
    assert.deepEqual(
      (await before.readPage('provenTxReqs')).rows.map(row => row.provenTxId),
      [7]
    )
    assert.ok(queries.some(sql => sql.includes('snapshot_global_keys')))
    await before.close()
    before = undefined
    after = await open(source, identity, {})
    assert.deepEqual(
      (await after.readPage('provenTxs')).rows.map(row => row.provenTxId),
      [9]
    )
    assert.deepEqual(
      (await after.readPage('provenTxReqs')).rows.map(row => row.provenTxId),
      [9]
    )
    await writer('transactions').where('transactionId', 1).delete()
    assert.deepEqual(
      (await after.readPage('provenTxs')).rows.map(row => row.provenTxId),
      [9]
    )
    await after.close()
    after = undefined
    after = await open(source, identity, {})
    assert.equal((await after.readPage('provenTxs')).rows.length, 0)
    assert.equal((await after.readPage('provenTxReqs')).rows.length, 0)
    return {
      archive,
      dialect: options.client,
      automaticJournalAdoption: true,
      independentWriterCommittedWhileOpen: true,
      retainedOldReference: true,
      freshViewNewReference: true,
      finalReferenceRemoval: true
    }
  } finally {
    if (before) await before.close()
    if (after) await after.close()
    await writer.destroy()
    await source.destroy()
  }
}
async function qualifyCascade(options) {
  const k = knex(options)
  try {
    await sourceSchema(k, 'utf8mb4_0900_ai_ci')
    await k.raw(
      'ALTER TABLE transactions ADD CONSTRAINT synthetic_cascade FOREIGN KEY(provenTxId) REFERENCES proven_txs(provenTxId) ON DELETE SET NULL'
    )
    await assert.rejects(helper.addSnapshotGlobalIndexes(k), /requires explicit row mutations/)
    assert.equal(await k.schema.hasTable('snapshot_global_guards'), false)
    await k.raw('ALTER TABLE transactions DROP FOREIGN KEY synthetic_cascade')
    await k.raw(
      'ALTER TABLE transactions ADD CONSTRAINT synthetic_restrict FOREIGN KEY(provenTxId) REFERENCES proven_txs(provenTxId) ON DELETE RESTRICT ON UPDATE RESTRICT'
    )
    await helper.addSnapshotGlobalIndexes(k)
    await k('proven_txs').insert({ provenTxId: 7 })
    await k('transactions').insert({ transactionId: 1, userId: 1, provenTxId: 7, txid: null })
    await oracle(k)
    return { unsupportedCascadeRejectedBeforeDDL: true, standardRestrictSupported: true }
  } finally {
    await k.destroy()
  }
}
async function qualifyMysqlGlobalIndexIntegration(admin, connection) {
  const results = []
  await runInSeries(
    [
      ['schema', qualifySchema],
      ['ordinary', options => qualifyPinned(options, false)],
      ['archive', options => qualifyPinned(options, true)],
      ['cascade', qualifyCascade]
    ],
    async ([name, qualify]) => {
      const database = 'ts569_global_integration_' + randomUUID().replaceAll('-', '')
      await admin.raw('CREATE DATABASE ??', [database])
      try {
        results.push({
          name,
          ...(await qualify({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } }))
        })
      } finally {
        await admin.raw('DROP DATABASE ??', [database])
      }
    }
  )
  return results
}
module.exports = { qualifyMysqlGlobalIndexIntegration }
