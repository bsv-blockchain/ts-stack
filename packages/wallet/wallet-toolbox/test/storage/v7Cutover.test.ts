import { Knex } from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../src/index.all'
import { runV7Cutover } from '../../src/storage/schema/v7Cutover'

async function migrateLatest (knex: Knex): Promise<void> {
  const source = new KnexMigrations('test', 'v7 cutover test', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
}

async function seedLegacy (knex: Knex): Promise<void> {
  const txidA = 'a'.repeat(64)

  await knex('users').insert({ userId: 1, identityKey: '02'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  await knex('users').insert({ userId: 2, identityKey: '03'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })

  const [provenId] = await knex('proven_txs').insert({
    txid: txidA,
    height: 800001,
    index: 4,
    merklePath: Buffer.from([5, 6]),
    rawTx: Buffer.from([1, 2]),
    blockHash: 'h'.repeat(64),
    merkleRoot: 'm'.repeat(64)
  })

  await knex('proven_tx_reqs').insert({
    provenTxId: provenId,
    status: 'completed',
    attempts: 2,
    notified: true,
    txid: txidA,
    history: '{}',
    notify: '{}',
    rawTx: Buffer.from([1, 2]),
    wasBroadcast: true,
    rebroadcastAttempts: 1
  })

  const [txA1] = await knex('transactions').insert({
    userId: 1,
    provenTxId: provenId,
    status: 'completed',
    reference: 'ref-A1',
    isOutgoing: true,
    satoshis: 1000,
    description: 'A1',
    txid: txidA
  })
  const [txA2] = await knex('transactions').insert({
    userId: 2,
    provenTxId: provenId,
    status: 'completed',
    reference: 'ref-A2',
    isOutgoing: false,
    satoshis: -1000,
    description: 'A2',
    txid: txidA
  })
  const [txB] = await knex('transactions').insert({
    userId: 1,
    status: 'sending',
    reference: 'ref-B',
    isOutgoing: true,
    satoshis: 500,
    description: 'B',
    txid: 'b'.repeat(64)
  })

  await knex('outputs').insert({
    userId: 1,
    transactionId: txA1,
    spendable: false,
    change: true,
    vout: 0,
    satoshis: 1000,
    providedBy: 'storage',
    purpose: 'change',
    type: 'P2PKH',
    outputDescription: 'change A1',
    txid: 'a'.repeat(64),
    spentBy: txB
  })

  await knex('outputs').insert({
    userId: 2,
    transactionId: txA2,
    spendable: true,
    change: false,
    vout: 1,
    satoshis: 1000,
    providedBy: 'sender',
    purpose: 'transfer',
    type: 'P2PKH',
    outputDescription: 'transfer A2',
    txid: 'a'.repeat(64)
  })

  const [labelId] = await knex('tx_labels').insert({ userId: 1, label: 'topup' })
  await knex('tx_labels_map').insert({ txLabelId: labelId, transactionId: txA1 })
}

describe('V7 cutover (Knex / SQLite)', () => {
  jest.setTimeout(60_000)

  test('full legacy -> V7 cutover remaps outputs/commissions/tx_labels_map', async () => {
    const file = await _tu.newTmpFile('v7cutover-full.sqlite', true, false, false)
    const knex = _tu.createLocalSQLite(file)

    try {
      await migrateLatest(knex)
      await seedLegacy(knex)

      await runV7Cutover(knex)

      expect(await knex.schema.hasTable('transactions_legacy')).toBe(true)
      expect(await knex.schema.hasTable('proven_tx_reqs_legacy')).toBe(true)
      expect(await knex.schema.hasTable('proven_txs_legacy')).toBe(true)
      expect(await knex.schema.hasTable('transactions')).toBe(true)
      expect(await knex.schema.hasTable('transactions_v7')).toBe(false)

      const rows = await knex('transactions').select('txid', 'processing').orderBy('txid')
      expect(rows.map(r => r.txid)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
      const byTxid = Object.fromEntries(rows.map(r => [r.txid, r]))
      expect(byTxid['a'.repeat(64)].processing).toBe('proven')
      expect(byTxid['b'.repeat(64)].processing).toBe('sending')

      const outs = await knex('outputs').select('vout', 'userId', 'transactionId', 'spentBy', 'txid').orderBy('vout')
      const v7A = await knex('transactions').where({ txid: 'a'.repeat(64) }).first('transactionId')
      const v7B = await knex('transactions').where({ txid: 'b'.repeat(64) }).first('transactionId')
      expect(outs[0].transactionId).toBe(v7A.transactionId)
      expect(outs[0].spentBy).toBe(v7B.transactionId)
      expect(outs[1].transactionId).toBe(v7A.transactionId)
      expect(outs[1].spentBy).toBeNull()

      const labelMaps = await knex('tx_labels_map').select('*')
      expect(labelMaps).toHaveLength(1)
      const action = await knex('actions')
        .where({ userId: 1, transactionId: v7A.transactionId })
        .first('actionId')
      expect(labelMaps[0].transactionId).toBe(action.actionId)

      const actions = await knex('actions').select('userId', 'transactionId', 'reference').orderBy('reference')
      expect(actions).toHaveLength(3)
      expect(actions.map(a => a.reference)).toEqual(['ref-A1', 'ref-A2', 'ref-B'])
    } finally {
      await knex.destroy()
    }
  })

  test('cutover on a fresh empty DB still produces final layout', async () => {
    const file = await _tu.newTmpFile('v7cutover-empty.sqlite', true, false, false)
    const knex = _tu.createLocalSQLite(file)

    try {
      await migrateLatest(knex)
      await runV7Cutover(knex)

      expect(await knex.schema.hasTable('transactions_legacy')).toBe(true)
      expect(await knex.schema.hasTable('transactions')).toBe(true)
      expect(await knex.schema.hasTable('transactions_v7')).toBe(false)
      const cnt = await knex('transactions').count<{ c: number }>({ c: '*' }).first()
      expect(cnt?.c).toBe(0)
    } finally {
      await knex.destroy()
    }
  })

  test('cutover is idempotent on second run', async () => {
    const file = await _tu.newTmpFile('v7cutover-idem.sqlite', true, false, false)
    const knex = _tu.createLocalSQLite(file)
    try {
      await migrateLatest(knex)
      await seedLegacy(knex)
      await runV7Cutover(knex)
      const beforeOuts = await knex('outputs').count<{ c: number }>({ c: '*' }).first()
      await runV7Cutover(knex)
      const afterOuts = await knex('outputs').count<{ c: number }>({ c: '*' }).first()
      expect(afterOuts?.c).toBe(beforeOuts?.c)
    } finally {
      await knex.destroy()
    }
  })
})
