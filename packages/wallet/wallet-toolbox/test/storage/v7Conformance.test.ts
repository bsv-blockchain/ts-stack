import { Knex } from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../src/index.all'
import { runV7Cutover } from '../../src/storage/schema/v7Cutover'
import { V7TransactionService } from '../../src/storage/schema/v7Service'
import {
  countCachedSpendable,
  refreshOutputsSpendable
} from '../../src/storage/schema/v7SpendabilityRefresh'

/**
 * §5 conformance suite from PROD_REQ_V7_TS.md.
 *
 * Each test sets up a fresh post-cutover SQLite database and exercises one
 * of the spec's required behaviours end-to-end. The suite asserts on the
 * actual V7 tables (`transactions`, `actions`, `outputs`, `tx_audit`) rather
 * than on helper return values so regressions in the persistence layer are
 * caught even when the service API stays stable.
 */

async function setupCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'v7 conformance', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
  await runV7Cutover(knex)
  await knex('users').insert({ userId: 1, identityKey: '02'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  await knex('users').insert({ userId: 2, identityKey: '03'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  return knex
}

describe('V7 §5 conformance suite (Knex / SQLite)', () => {
  jest.setTimeout(90_000)

  test('hot query: single-table spendable scan in default basket', async () => {
    const knex = await setupCutDb('v7conf-hot.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const txidA = 'a'.repeat(64)
      const tx = await svc.create({ txid: txidA, processing: 'proven' })

      // Seed a basket plus a handful of spendable outputs for user 1.
      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      for (let i = 0; i < 10; i++) {
        await knex('outputs').insert({
          userId: 1,
          transactionId: tx.transactionId,
          basketId,
          spendable: true,
          change: false,
          vout: i,
          satoshis: 1000 + i,
          providedBy: 'storage',
          purpose: 'transfer',
          type: 'P2PKH',
          outputDescription: 'r',
          txid: txidA,
          lockingScript: Buffer.from([0x76])
        })
      }

      const start = Date.now()
      const rows = await knex('outputs')
        .where({ userId: 1, spendable: true, basketId })
        .orderBy('satoshis', 'desc')
        .limit(100)
      const elapsed = Date.now() - start
      expect(rows).toHaveLength(10)
      // Sanity: must execute as an index scan without joins under
      // a generous budget. 200ms is conservative for 10 rows on SQLite.
      expect(elapsed).toBeLessThan(200)
    } finally {
      await knex.destroy()
    }
  })

  test('multi-user dedup: one transactions row, multiple actions rows', async () => {
    const knex = await setupCutDb('v7conf-multi.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const txid = 'a'.repeat(64)
      const tx = await svc.create({ txid, processing: 'proven' })

      const aId1 = await svc.createAction({
        userId: 1,
        transactionId: tx.transactionId,
        reference: 'r-1',
        description: 'user 1 view',
        isOutgoing: true,
        satoshisDelta: 1000
      })
      const aId2 = await svc.createAction({
        userId: 2,
        transactionId: tx.transactionId,
        reference: 'r-2',
        description: 'user 2 view',
        isOutgoing: false,
        satoshisDelta: -1000
      })

      const txRows = await knex('transactions').select('*')
      expect(txRows).toHaveLength(1)

      const actionRows = await knex('actions').select('*').orderBy('userId')
      expect(actionRows).toHaveLength(2)
      expect(actionRows.map(r => r.userId)).toEqual([1, 2])
      expect(actionRows[0].actionId).toBe(aId1)
      expect(actionRows[1].actionId).toBe(aId2)
    } finally {
      await knex.destroy()
    }
  })

  test('shared output: same txid+vout duplicates per user', async () => {
    const knex = await setupCutDb('v7conf-shared.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const txid = 'a'.repeat(64)
      const tx = await svc.create({ txid, processing: 'proven' })

      for (const userId of [1, 2]) {
        await knex('outputs').insert({
          userId,
          transactionId: tx.transactionId,
          spendable: true,
          change: false,
          vout: 0,
          satoshis: 1000,
          providedBy: 'sender',
          purpose: 'transfer',
          type: 'P2PKH',
          outputDescription: 'shared',
          txid,
          lockingScript: Buffer.from([0x76])
        })
      }
      const rows = await knex('outputs')
        .where({ txid, vout: 0 })
        .orderBy('userId')
        .select('userId', 'transactionId', 'vout', 'txid')
      expect(rows).toHaveLength(2)
      expect(rows.map(r => r.userId)).toEqual([1, 2])
      expect(rows[0].transactionId).toBe(rows[1].transactionId)
    } finally {
      await knex.destroy()
    }
  })

  test('reorg: proven -> reorging -> seen and audit trail', async () => {
    const knex = await setupCutDb('v7conf-reorg.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const txid = 'a'.repeat(64)
      const tx = await svc.create({ txid, processing: 'proven' })

      const r1 = await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'proven',
        to: 'reorging',
        details: { trigger: 'block invalidated' }
      })
      expect(r1?.processing).toBe('reorging')

      const r2 = await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'reorging',
        to: 'seen',
        details: { recovered: true }
      })
      expect(r2?.processing).toBe('seen')

      const audit = await knex('tx_audit').where({ transactionId: tx.transactionId }).orderBy('auditId')
      const events = audit.map(a => `${a.from_state ?? ''}->${a.to_state ?? ''}`)
      // First row from `create`, then the two real transitions.
      expect(events).toEqual(['proven->proven', 'proven->reorging', 'reorging->seen'])
    } finally {
      await knex.destroy()
    }
  })

  test('FSM transitions: illegal moves rejected and audited', async () => {
    const knex = await setupCutDb('v7conf-fsm.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'queued' })

      const bad = await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'queued',
        to: 'proven'
      })
      expect(bad).toBeUndefined()

      const rejected = await knex('tx_audit')
        .where({ transactionId: tx.transactionId, event: 'processing.rejected' })
        .first()
      expect(rejected).toBeDefined()
      expect(JSON.parse(rejected.details_json).reason).toMatch(/illegal transition/)
    } finally {
      await knex.destroy()
    }
  })

  test('coinbase maturity gates spendability against chain tip height', async () => {
    const knex = await setupCutDb('v7conf-coinbase.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'proven', isCoinbase: true })

      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      await knex('outputs').insert({
        userId: 1,
        transactionId: tx.transactionId,
        basketId,
        spendable: true,
        change: false,
        vout: 0,
        satoshis: 5000_000_000,
        providedBy: 'storage',
        purpose: 'coinbase',
        type: 'P2PKH',
        outputDescription: 'reward',
        txid: 'a'.repeat(64),
        lockingScript: Buffer.from([0x76]),
        matures_at_height: 1000
      })

      // Tip below maturity: refresh must flip spendable to false.
      await svc.setChainTip({ height: 999, blockHash: 'h'.repeat(64) })
      const stats1 = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats1.flipped).toBe(1)
      expect(await countCachedSpendable(knex, { userId: 1, basketId })).toBe(0)

      // Tip at maturity: refresh must flip spendable back to true.
      await svc.setChainTip({ height: 1000, blockHash: 'i'.repeat(64) })
      const stats2 = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats2.flipped).toBe(1)
      expect(await countCachedSpendable(knex, { userId: 1, basketId })).toBe(1)
    } finally {
      await knex.destroy()
    }
  })

  test('spendability refresh flips cached column to match V7 rule', async () => {
    const knex = await setupCutDb('v7conf-spendable.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'queued' })

      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      await knex('outputs').insert({
        userId: 1,
        transactionId: tx.transactionId,
        basketId,
        // Cached spendable=true even though processing is `queued`. Refresh
        // must flip it to false.
        spendable: true,
        change: false,
        vout: 0,
        satoshis: 1000,
        providedBy: 'storage',
        purpose: 'transfer',
        type: 'P2PKH',
        outputDescription: 'r',
        txid: 'a'.repeat(64),
        lockingScript: Buffer.from([0x76])
      })

      const before = await countCachedSpendable(knex, { userId: 1, basketId })
      expect(before).toBe(1)

      const stats = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats.examined).toBe(1)
      expect(stats.flipped).toBe(1)

      const after = await countCachedSpendable(knex, { userId: 1, basketId })
      expect(after).toBe(0)

      // Now transition the tx to a spendable state and re-run; expect the
      // output to flip back to spendable.
      await svc.transition({ transactionId: tx.transactionId, expectedFrom: 'queued', to: 'sending' })
      await svc.transition({ transactionId: tx.transactionId, expectedFrom: 'sending', to: 'sent' })

      const stats2 = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats2.flipped).toBe(1)
      expect(await countCachedSpendable(knex, { userId: 1, basketId })).toBe(1)
    } finally {
      await knex.destroy()
    }
  })
})
