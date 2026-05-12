import { Knex } from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../src/index.all'
import { runV7Cutover } from '../../src/storage/schema/v7Cutover'
import { V7TransactionService } from '../../src/storage/schema/v7Service'
import { backfillCoinbaseMaturity } from '../../src/storage/schema/v7CoinbaseMaturityBackfill'

/**
 * Backfill helper coverage for `outputs.matures_at_height` (V7 migration
 * `2026-05-13-001`). Mirrors the `setupCutDb` pattern from
 * `v7Conformance.test.ts` so the seed data reflects a real post-cutover
 * layout.
 */

async function setupCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'v7 coinbase backfill', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
  await runV7Cutover(knex)
  await knex('users').insert({ userId: 1, identityKey: '02'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  return knex
}

describe('backfillCoinbaseMaturity', () => {
  jest.setTimeout(90_000)

  test('populates matures_at_height for legacy coinbase outputs and is idempotent', async () => {
    const knex = await setupCutDb('v7-coinbase-backfill.sqlite')
    try {
      const svc = new V7TransactionService(knex)

      // Coinbase transaction recorded at block 800000 (height column is
      // populated as it would be after a recordProof). is_coinbase=true.
      const coinbaseTxid = 'a'.repeat(64)
      const coinbase = await svc.create({
        txid: coinbaseTxid,
        processing: 'proven',
        isCoinbase: true
      })
      await knex('transactions')
        .where({ transactionId: coinbase.transactionId })
        .update({ height: 800000 })

      // Non-coinbase transaction at the same height — its outputs must not
      // be touched by the backfill.
      const normalTxid = 'b'.repeat(64)
      const normal = await svc.create({
        txid: normalTxid,
        processing: 'proven',
        isCoinbase: false
      })
      await knex('transactions')
        .where({ transactionId: normal.transactionId })
        .update({ height: 800000 })

      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })

      // Two legacy coinbase outputs (vout 0 and 1) — both have NULL
      // matures_at_height because they were inserted before migration
      // 2026-05-13-001.
      const insertOutput = async (args: {
        txid: string
        transactionId: number
        vout: number
        purpose: string
      }): Promise<number> => {
        const [id] = await knex('outputs').insert({
          userId: 1,
          transactionId: args.transactionId,
          basketId,
          spendable: false,
          change: false,
          vout: args.vout,
          satoshis: 5000_000_000,
          providedBy: 'storage',
          purpose: args.purpose,
          type: 'P2PKH',
          outputDescription: args.purpose,
          txid: args.txid,
          lockingScript: Buffer.from([0x76])
        })
        return id
      }

      const cbOut0 = await insertOutput({
        txid: coinbaseTxid,
        transactionId: coinbase.transactionId,
        vout: 0,
        purpose: 'coinbase'
      })
      const cbOut1 = await insertOutput({
        txid: coinbaseTxid,
        transactionId: coinbase.transactionId,
        vout: 1,
        purpose: 'coinbase'
      })
      const nonCbOut = await insertOutput({
        txid: normalTxid,
        transactionId: normal.transactionId,
        vout: 0,
        purpose: 'transfer'
      })

      // Sanity: all three rows start with NULL matures_at_height.
      const seeded = await knex('outputs')
        .whereIn('outputId', [cbOut0, cbOut1, nonCbOut])
        .select('outputId', 'matures_at_height as maturesAtHeight')
      expect(seeded.map(r => r.maturesAtHeight)).toEqual([null, null, null])

      const stats1 = await backfillCoinbaseMaturity(knex)
      expect(stats1.examined).toBe(2)
      expect(stats1.updated).toBe(2)

      // Coinbase outputs now reflect the +100 BSV maturity rule.
      const cbRows = await knex('outputs')
        .whereIn('outputId', [cbOut0, cbOut1])
        .orderBy('outputId')
        .select('outputId', 'matures_at_height as maturesAtHeight')
      expect(cbRows.map(r => r.maturesAtHeight)).toEqual([800100, 800100])

      // Non-coinbase output was left alone.
      const nonCbRow = await knex('outputs')
        .where({ outputId: nonCbOut })
        .first('matures_at_height as maturesAtHeight')
      expect(nonCbRow?.maturesAtHeight).toBeNull()

      // Idempotency: a second backfill finds no remaining NULL coinbase
      // outputs to update.
      const stats2 = await backfillCoinbaseMaturity(knex)
      expect(stats2.examined).toBe(0)
      expect(stats2.updated).toBe(0)
    } finally {
      await knex.destroy()
    }
  })

  test('skips coinbase outputs whose owning transaction has no recorded height', async () => {
    const knex = await setupCutDb('v7-coinbase-backfill-no-height.sqlite')
    try {
      const svc = new V7TransactionService(knex)

      // Coinbase transaction without a height (e.g. pending proof).
      const txid = 'c'.repeat(64)
      const tx = await svc.create({ txid, processing: 'sent', isCoinbase: true })

      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      const [outputId] = await knex('outputs').insert({
        userId: 1,
        transactionId: tx.transactionId,
        basketId,
        spendable: false,
        change: false,
        vout: 0,
        satoshis: 5000_000_000,
        providedBy: 'storage',
        purpose: 'coinbase',
        type: 'P2PKH',
        outputDescription: 'reward',
        txid,
        lockingScript: Buffer.from([0x76])
      })

      const stats = await backfillCoinbaseMaturity(knex)
      expect(stats.examined).toBe(0)
      expect(stats.updated).toBe(0)

      const row = await knex('outputs')
        .where({ outputId })
        .first('matures_at_height as maturesAtHeight')
      expect(row?.maturesAtHeight).toBeNull()
    } finally {
      await knex.destroy()
    }
  })

  test('respects custom batch size', async () => {
    const knex = await setupCutDb('v7-coinbase-backfill-batch.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const txid = 'd'.repeat(64)
      const tx = await svc.create({ txid, processing: 'proven', isCoinbase: true })
      await knex('transactions')
        .where({ transactionId: tx.transactionId })
        .update({ height: 700000 })

      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      for (let i = 0; i < 5; i++) {
        await knex('outputs').insert({
          userId: 1,
          transactionId: tx.transactionId,
          basketId,
          spendable: false,
          change: false,
          vout: i,
          satoshis: 1_000_000_000,
          providedBy: 'storage',
          purpose: 'coinbase',
          type: 'P2PKH',
          outputDescription: 'reward',
          txid,
          lockingScript: Buffer.from([0x76])
        })
      }

      const stats = await backfillCoinbaseMaturity(knex, { batchSize: 2 })
      expect(stats.examined).toBe(5)
      expect(stats.updated).toBe(5)

      const rows = await knex('outputs')
        .where({ transactionId: tx.transactionId })
        .orderBy('vout')
        .select('vout', 'matures_at_height as maturesAtHeight')
      expect(rows).toHaveLength(5)
      for (const r of rows) expect(r.maturesAtHeight).toBe(700100)
    } finally {
      await knex.destroy()
    }
  })
})
