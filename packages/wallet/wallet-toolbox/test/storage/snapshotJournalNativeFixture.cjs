// Synthetic native fixtures and an independent source-table ownership oracle.
// This fixture does not use production journal generators to compute expected rows.
const assert = require('node:assert/strict')
const { knex } = require('knex')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const identity = '02' + '11'.repeat(32)

async function seedArchiveClosure(source, userId, otherId) {
  const instant = '2026-01-01T00:00:00.000Z'
  const date = source.knex.client.config.client === 'mysql2' ? new Date(instant) : instant
  const timestamp = { created_at: date, updated_at: date }
  const k = source.knex
  await k('output_baskets').del()
  await runInSeries([1, 2, 3], async id => {
    const profileId = id === 2 ? otherId : userId
    await k('proven_txs').insert({
      ...timestamp,
      provenTxId: id,
      txid: String(id).repeat(64),
      height: id,
      index: 0,
      merklePath: Buffer.from([id, 0, 255]),
      rawTx: Buffer.from([id, 1, 255]),
      blockHash: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64)
    })
    await k('transactions').insert({
      ...timestamp,
      transactionId: id,
      userId: profileId,
      provenTxId: id === 3 ? null : id,
      status: 'completed',
      reference: `tx-${id}`,
      isOutgoing: true,
      satoshis: 0,
      description: `tx-${id}`,
      txid: String(id).repeat(64),
      rawTx: Buffer.from([id, 2, 255]),
      inputBEEF: Buffer.from([id, 3, 255])
    })
    await k('proven_tx_reqs').insert({
      ...timestamp,
      provenTxReqId: id,
      provenTxId: id,
      txid: String(id).repeat(64),
      status: 'completed',
      attempts: 0,
      notified: true,
      history: '{}',
      notify: '{}',
      rawTx: Buffer.from([id, 4, 255]),
      wasBroadcast: true
    })
    await k('output_baskets').insert({
      ...timestamp,
      basketId: id,
      userId: profileId,
      name: `basket-${id}`,
      isDeleted: id === 3
    })
    await k('outputs').insert({
      ...timestamp,
      outputId: id,
      userId: profileId,
      transactionId: id,
      basketId: id,
      spendable: false,
      change: true,
      vout: 0,
      satoshis: 1,
      providedBy: 'you',
      purpose: '',
      type: 'P2PKH',
      lockingScript: Buffer.from([id, 5, 255])
    })
    await k('commissions').insert({
      ...timestamp,
      commissionId: id,
      userId: profileId,
      transactionId: id,
      satoshis: 0,
      keyOffset: 'offset',
      isRedeemed: true,
      lockingScript: Buffer.from([id, 6, 255])
    })
    await k('output_tags').insert({
      ...timestamp,
      outputTagId: id,
      userId: profileId,
      tag: `tag-${id}`,
      isDeleted: id === 3
    })
    await k('output_tags_map').insert({
      ...timestamp,
      outputTagId: id,
      outputId: id,
      isDeleted: id === 3
    })
    await k('tx_labels').insert({
      ...timestamp,
      txLabelId: id,
      userId: profileId,
      label: `label-${id}`,
      isDeleted: id === 3
    })
    await k('tx_labels_map').insert({
      ...timestamp,
      txLabelId: id,
      transactionId: id,
      isDeleted: id === 3
    })
    await k('certificates').insert({
      ...timestamp,
      certificateId: id,
      userId: profileId,
      serialNumber: `serial-${id}`,
      type: 'type',
      certifier: identity,
      subject: identity,
      revocationOutpoint: 'a'.repeat(64) + '.0',
      signature: 'signature',
      isDeleted: id === 3
    })
    await runInSeries(['a', 'Z', 'é', '😀'], async fieldName => {
      await k('certificate_fields').insert({
        ...timestamp,
        certificateId: id,
        userId: profileId,
        fieldName,
        fieldValue: `value-${id}`,
        masterKey: 'key'
      })
    })
    await k('sync_states').insert({
      ...timestamp,
      syncStateId: id,
      userId: profileId,
      storageIdentityKey: `peer-${id}`,
      storageName: `peer-${id}`,
      status: 'unknown',
      init: true,
      refNum: `state-${id}`,
      syncMap: '{}',
      when: date
    })
  })
  // Composite positions must handle repeated first keys and preserve deleted mappings.
  await k('output_tags_map').insert({ ...timestamp, outputTagId: 1, outputId: 3, isDeleted: true })
  await k('tx_labels_map').insert({ ...timestamp, txLabelId: 1, transactionId: 3, isDeleted: true })
}

const profiles = [
  ['transactions', 'transactionId'],
  ['outputs', 'outputId'],
  ['certificates', 'certificateId'],
  ['tx_labels', 'txLabelId'],
  ['output_baskets', 'basketId'],
  ['output_tags', 'outputTagId'],
  ['commissions', 'commissionId'],
  ['sync_states', 'syncStateId']
]
const numeric = [...profiles, ['proven_txs', 'provenTxId'], ['proven_tx_reqs', 'provenTxReqId']]
const tables = [...numeric.map(([table]) => table), 'tx_labels_map', 'output_tags_map', 'certificate_fields']
const quote = value => '`' + value.replaceAll('`', '``') + '`'
const binaryType = k => (k.client.config.client === 'mysql2' ? 'BINARY' : 'BLOB')
const empty = k => "CAST('' AS " + binaryType(k) + ')'
const rawRows = async (k, sql) => (k.client.config.client === 'mysql2' ? (await k.raw(sql))[0] : await k.raw(sql))
const tuple = (k, table, p) => {
  const key = numeric.find(([name]) => name === table)?.[1]
  if (key) return [p + '.' + quote(key), '0', empty(k)]
  if (table === 'tx_labels_map') return [p + '.txLabelId', p + '.transactionId', empty(k)]
  if (table === 'output_tags_map') return [p + '.outputTagId', p + '.outputId', empty(k)]
  return [p + '.certificateId', '0', 'CAST(' + p + '.fieldName AS ' + binaryType(k) + ')']
}
const normalized = (rows, scope) =>
  rows
    .map(row =>
      JSON.stringify([
        Number(row.tableId),
        ...(scope ? [Number(row.userId)] : []),
        Number(row.id1),
        Number(row.id2),
        Buffer.from(row.exactText).toString('hex')
      ])
    )
    .sort()
async function expected(k) {
  const selections = profiles.map(
    ([table, key], id) =>
      `SELECT ${id} tableId,userId,${quote(key)} id1,0 id2,${empty(k)} exactText FROM ${quote(table)}`
  )
  for (const [id, table, left, leftKey, right, rightKey] of [
    [10, 'tx_labels_map', 'tx_labels', 'txLabelId', 'transactions', 'transactionId'],
    [11, 'output_tags_map', 'output_tags', 'outputTagId', 'outputs', 'outputId']
  ]) {
    for (const [parent, key] of [
      [left, leftKey],
      [right, rightKey]
    ])
      selections.push(
        `SELECT ${id},p.userId,m.${leftKey},m.${rightKey},${empty(k)} FROM ${table} m JOIN ${parent} p ON m.${key}=p.${key}`
      )
  }
  selections.push(
    `SELECT 12,userId,certificateId,0,CAST(fieldName AS ${binaryType(k)}) FROM certificate_fields`,
    `SELECT 12,c.userId,f.certificateId,0,CAST(f.fieldName AS ${binaryType(k)}) FROM certificate_fields f JOIN certificates c ON c.certificateId=f.certificateId`,
    `SELECT 9,t.userId,r.provenTxReqId,0,${empty(k)} FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid`,
    `SELECT 8,t.userId,p.provenTxId,0,${empty(k)} FROM transactions t JOIN proven_txs p ON p.provenTxId=t.provenTxId`,
    `SELECT 8,t.userId,p.provenTxId,0,${empty(k)} FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid JOIN proven_txs p ON p.provenTxId=r.provenTxId`
  )
  return await rawRows(k, selections.join(' UNION '))
}
async function exact(k) {
  assert.deepEqual(
    normalized(await k('snapshot_journal_scope').where('present', 1), true),
    normalized(await expected(k), true)
  )
  const physical = await k('snapshot_journal_physical').where('present', 1)
  const selections = tables.map((table, tableId) => {
    const keys = tuple(k, table, 's')
    return `SELECT ${tableId} tableId,${keys[0]} id1,${keys[1]} id2,${keys[2]} exactText FROM ${quote(table)} s`
  })
  assert.deepEqual(normalized(physical, false), normalized(await rawRows(k, selections.join(' UNION ALL ')), false))
  for (const row of physical) assert(BigInt(String(row.generation)) > 0n)
  if (k.client.config.client === 'mysql2') assert.equal((await k('snapshot_journal_events')).length, 0)
}
module.exports = { knex, StorageKnex, StorageProvider, seedArchiveClosure, tables, exact }
