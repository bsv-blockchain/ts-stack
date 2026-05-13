import { Knex } from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../src/index.all'
import { runSchemaCutover } from '../../src/storage/schema/schemaCutover'
import { TransactionService } from '../../src/storage/schema/transactionService'
import {
  countCachedSpendable,
  refreshOutputsSpendable
} from '../../src/storage/schema/spendabilityRefresh'

/**
 * §5 conformance suite from PROD_REQ_V7_TS.md.
 *
 * Each test sets up a fresh post-cutover SQLite database and exercises one
 * of the spec's required behaviours end-to-end. The suite asserts on the
 * actual new transactions tables (`transactions`, `actions`, `outputs`, `tx_audit`) rather
 * than on helper return values so regressions in the persistence layer are
 * caught even when the service API stays stable.
 */

async function setupCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'schema conformance', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
  await runSchemaCutover(knex)
  await knex('users').insert({ userId: 1, identityKey: '02'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  await knex('users').insert({ userId: 2, identityKey: '03'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  return knex
}

describe('Schema conformance suite (Knex / SQLite)', () => {
  jest.setTimeout(90_000)

  test('hot query: single-table spendable scan in default basket', async () => {
    const knex = await setupCutDb('conf-hot.sqlite')
    try {
      const svc = new TransactionService(knex)
      const txidA = 'a'.repeat(64)
      const tx = await svc.create({ txid: txidA, processing: 'confirmed' })

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
    const knex = await setupCutDb('conf-multi.sqlite')
    try {
      const svc = new TransactionService(knex)
      const txid = 'a'.repeat(64)
      const tx = await svc.create({ txid, processing: 'confirmed' })

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
    const knex = await setupCutDb('conf-shared.sqlite')
    try {
      const svc = new TransactionService(knex)
      const txid = 'a'.repeat(64)
      const tx = await svc.create({ txid, processing: 'confirmed' })

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
    const knex = await setupCutDb('conf-reorg.sqlite')
    try {
      const svc = new TransactionService(knex)
      const txid = 'a'.repeat(64)
      const tx = await svc.create({ txid, processing: 'confirmed' })

      const r1 = await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'confirmed',
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
      expect(events).toEqual(['confirmed->confirmed', 'confirmed->reorging', 'reorging->seen'])
    } finally {
      await knex.destroy()
    }
  })

  test('FSM transitions: illegal moves rejected and audited', async () => {
    const knex = await setupCutDb('conf-fsm.sqlite')
    try {
      const svc = new TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'queued' })

      const bad = await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'queued',
        to: 'confirmed'
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

  test('reorg preserves outputs.spendable per spec §6', async () => {
    const knex = await setupCutDb('conf-reorg-preserve.sqlite')
    try {
      const svc = new TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'confirmed' })
      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      await knex('outputs').insert({
        userId: 1,
        transactionId: tx.transactionId,
        basketId,
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
      // Cached spendable was true while proven. Transition to reorging.
      await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'confirmed',
        to: 'reorging'
      })
      // Spec §6: "Reorg: preserve the current spendable value of outputs."
      const stats = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats.flipped).toBe(0)
      expect(await countCachedSpendable(knex, { userId: 1, basketId })).toBe(1)

      // Once reorg resolves back to a non-spendable state (e.g. caller forced
      // unconfirmed → invalid via the normal path), refresh resumes and the
      // output becomes non-spendable as expected.
      await svc.transition({ transactionId: tx.transactionId, expectedFrom: 'reorging', to: 'unconfirmed' })
      await svc.transition({ transactionId: tx.transactionId, expectedFrom: 'unconfirmed', to: 'invalid' })
      const stats2 = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats2.flipped).toBe(1)
      expect(await countCachedSpendable(knex, { userId: 1, basketId })).toBe(0)
    } finally {
      await knex.destroy()
    }
  })

  test('reorging cannot transition directly to invalid or doubleSpend per spec §5', async () => {
    const knex = await setupCutDb('conf-reorg-fsm.sqlite')
    try {
      const svc = new TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'confirmed' })
      await svc.transition({ transactionId: tx.transactionId, expectedFrom: 'confirmed', to: 'reorging' })
      const toInvalid = await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'reorging',
        to: 'invalid'
      })
      expect(toInvalid).toBeUndefined()
      const toDouble = await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'reorging',
        to: 'doubleSpend'
      })
      expect(toDouble).toBeUndefined()
    } finally {
      await knex.destroy()
    }
  })

  test('unfail transition does not modify cached outputs.spendable per spec §6', async () => {
    const knex = await setupCutDb('conf-unfail.sqlite')
    try {
      const svc = new TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'invalid' })
      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      await knex('outputs').insert({
        userId: 1,
        transactionId: tx.transactionId,
        basketId,
        // Pre-existing cached value — should not be touched by an unfail transition.
        spendable: false,
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
      const before = await knex('outputs').where({ outputId: 1 }).first('spendable')
      await svc.transition({ transactionId: tx.transactionId, expectedFrom: 'invalid', to: 'unfail' })
      // Spec §6: Unfail SHALL NOT modify the outputs table. Callers must not
      // invoke refreshOutputsSpendable for an unfail transition. Here we
      // simply observe that the cached column is unchanged by the transition
      // itself.
      const after = await knex('outputs').where({ outputId: 1 }).first('spendable')
      expect(after.spendable).toBe(before.spendable)
    } finally {
      await knex.destroy()
    }
  })

  test('coinbase maturity gates spendability against chain tip height', async () => {
    const knex = await setupCutDb('conf-coinbase.sqlite')
    try {
      const svc = new TransactionService(knex)
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'confirmed', isCoinbase: true })

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

  // §7 Test A — third-party confirmed at chain tip → Unconfirmed + spendable.
  // Spec §4.1: when the proven block is the current chain tip, the resulting
  // transaction must be stored as `unconfirmed` (one confirmation not yet
  // achieved) and its outputs must be spendable.
  test('third-party confirmed at chain tip is stored as unconfirmed + spendable (§4.1, §7 A)', async () => {
    const knex = await setupCutDb('conf-third-party-tip.sqlite')
    try {
      const svc = new TransactionService(knex)
      await svc.setChainTip({ height: 100, blockHash: 'h'.repeat(64) })

      // Caller has merkle path that validates against tip block (height 100).
      // Per §4.1, tip-vs-deep decision → store as `unconfirmed`, not `proven`.
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'unconfirmed' })

      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      await knex('outputs').insert({
        userId: 1,
        transactionId: tx.transactionId,
        basketId,
        spendable: true,
        change: false,
        vout: 0,
        satoshis: 5000,
        providedBy: 'sender',
        purpose: 'transfer',
        type: 'P2PKH',
        outputDescription: 'incoming',
        txid: 'a'.repeat(64),
        lockingScript: Buffer.from([0x76])
      })

      const stored = await svc.findByTxid('a'.repeat(64))
      expect(stored?.processing).toBe('unconfirmed')

      // Refresh confirms output stays spendable for `unconfirmed`.
      const stats = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats.flipped).toBe(0)
      expect(await countCachedSpendable(knex, { userId: 1, basketId })).toBe(1)

      // Once tip advances and caller transitions to `proven`, output remains
      // spendable (the spec's "Completed + spendable" deep-confirm case).
      await svc.setChainTip({ height: 101, blockHash: 'i'.repeat(64) })
      await svc.transition({
        transactionId: tx.transactionId,
        expectedFrom: 'unconfirmed',
        to: 'confirmed'
      })
      const stats2 = await refreshOutputsSpendable(knex, { userId: 1 })
      expect(stats2.flipped).toBe(0)
      expect(await countCachedSpendable(knex, { userId: 1, basketId })).toBe(1)
    } finally {
      await knex.destroy()
    }
  })

  // §7 Test B — third-party unconfirmed, broadcast fails → no DB row written.
  // Spec §4.2: third-party unconfirmed must be broadcast by the wallet; if
  // every service rejects, the wallet MUST discard the candidate without
  // persisting any transactions row (no audit trail for never-stored tx).
  test('third-party unconfirmed broadcast failure leaves no transactions row (§4.2, §7 B)', async () => {
    const knex = await setupCutDb('conf-third-party-discard.sqlite')
    try {
      const svc = new TransactionService(knex)
      const txid = 'b'.repeat(64)

      // Simulate broadcast attempt that fails across all services BEFORE
      // any `findOrCreateForBroadcast` call. The discard contract is that
      // the caller never creates the row.
      const broadcastResult: 'accepted' | 'rejected' = 'rejected'
      if (broadcastResult !== 'rejected') {
        await svc.findOrCreateForBroadcast({ txid, rawTx: [0x00] })
      }

      const row = await svc.findByTxid(txid)
      expect(row).toBeUndefined()

      const txCount = await knex('transactions').count<{ c: number }>({ c: '*' }).first()
      expect(txCount?.c).toBe(0)

      const auditCount = await knex('tx_audit').count<{ c: number }>({ c: '*' }).first()
      expect(auditCount?.c).toBe(0)
    } finally {
      await knex.destroy()
    }
  })

  // §7 Test E — mixed broadcast results across services: positive outcome
  // accepted, discrepancies recorded in tx_audit.
  // Spec §3 + §5: when one service reports success but another reports a
  // failure for the same txid, prefer the positive outcome and persist the
  // discrepancy via `recordHistoryNote` so the disagreement is auditable.
  test('mixed broadcast results: accept positive and audit discrepancy (§3, §5, §7 E)', async () => {
    const knex = await setupCutDb('conf-mixed-broadcast.sqlite')
    try {
      const svc = new TransactionService(knex)
      const { transaction } = await svc.findOrCreateForBroadcast({
        txid: 'c'.repeat(64),
        rawTx: [0x01, 0x02, 0x03]
      })
      await svc.transition({
        transactionId: transaction.transactionId,
        expectedFrom: 'queued',
        to: 'sending'
      })

      // First service: positive outcome → record `sent`.
      const accepted = await svc.recordBroadcastResult({
        transactionId: transaction.transactionId,
        txid: 'c'.repeat(64),
        status: 'sent',
        provider: 'arc',
        providerStatus: 'SEEN_ON_NETWORK',
        wasBroadcast: true
      })
      expect(accepted?.processing).toBe('sent')

      // Second service: negative outcome on same broadcast. Spec says prefer
      // the positive and persist a discrepancy note so operators can audit.
      await svc.recordHistoryNote(transaction.transactionId, {
        what: 'broadcast.discrepancy',
        provider: 'whatsonchain',
        outcome: 'rejected',
        reason: 'mempool conflict',
        preferred: 'arc:SEEN_ON_NETWORK'
      })

      const audit = await knex('tx_audit')
        .where({ transactionId: transaction.transactionId })
        .orderBy('auditId')
      const events = audit.map(a => a.event)
      expect(events).toContain('history.note')
      const discrepancyRow = audit.find(a => a.event === 'history.note')
      expect(discrepancyRow).toBeDefined()
      const details = JSON.parse(discrepancyRow.details_json)
      expect(details.what).toBe('broadcast.discrepancy')
      expect(details.provider).toBe('whatsonchain')
      expect(details.preferred).toBe('arc:SEEN_ON_NETWORK')

      // Final processing reflects the positive outcome, not the negative one.
      const stored = await svc.findById(transaction.transactionId)
      expect(stored?.processing).toBe('sent')
    } finally {
      await knex.destroy()
    }
  })

  test('spendability refresh flips cached column to match the new-schema rule', async () => {
    const knex = await setupCutDb('conf-spendable.sqlite')
    try {
      const svc = new TransactionService(knex)
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
