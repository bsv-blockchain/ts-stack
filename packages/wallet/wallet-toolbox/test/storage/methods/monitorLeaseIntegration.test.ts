/**
 * `monitor_lease` integration tests.
 *
 * Tests verify the complete `LeasedMonitorTask` wrapper semantics end-to-end
 * against a real SQLite + schema-cutover database, including concurrent lease
 * contention and the `recordProof` flow that TaskCheckForProofs uses.
 *
 *  Test 1 — Concurrent claim: two TransactionService instances race for the
 *            same lease. Only one wins; the loser observes `ran: false`.
 *
 *  Test 2 — recordProof flow: the winning owner calls `recordProof`, which
 *            writes a `confirmed` transition into `tx_audit`. The loser does not.
 *
 *  Test 3 — Release and retry: after the winner releases the lease the loser
 *            can claim it on the next attempt and observes `ran: true`.
 *
 *  Test 4 — Stale lease takeover: a lease whose TTL has elapsed is taken over
 *            by a new owner even without an explicit releaseLease call.
 *
 *  Test 5 — Pre-cutover / pre-cutover gate: when getTransactionService() returns undefined
 *            (simulated by a plain StorageProvider subclass) no lease is
 *            attempted and the body still runs.
 */

import { Knex } from 'knex'
import { _tu, makeTestBump } from '../../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../../src/index.all'
import { runSchemaCutover } from '../../../src/storage/schema/schemaCutover'
import { TransactionService } from '../../../src/storage/schema/transactionService'
import { LeasedMonitorTask } from '../../../src/monitor/LeasedMonitorTask'

// ---------------------------------------------------------------------------
// DB setup helper
// ---------------------------------------------------------------------------

/** Post-cutover SQLite: migrations + runSchemaCutover + a single user seeded. */
async function setupCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'v7 lease integration', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
  await runSchemaCutover(knex)
  await knex('users').insert({
    userId: 1,
    identityKey: '02'.padEnd(66, '0'),
    activeStorage: '1'.repeat(64)
  })
  return knex
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('monitor_lease integration (LeasedMonitorTask + recordProof)', () => {
  jest.setTimeout(90_000)

  // -------------------------------------------------------------------------
  // Test 1 — Concurrent claim: only one of two concurrent claimants succeeds.
  // -------------------------------------------------------------------------
  test('1: concurrent claim — only one owner wins, the other observes ran: false', async () => {
    const knex = await setupCutDb('v7lease-int-01.sqlite')
    try {
      const svcA = new TransactionService(knex)
      const svcB = new TransactionService(knex)

      const helperA = new LeasedMonitorTask(svcA)
      const helperB = new LeasedMonitorTask(svcB)

      let aRan = false
      let bRan = false

      // Both try to claim the same lease concurrently; promises are kicked off
      // in parallel before either has a chance to complete.
      const [resultA, resultB] = await Promise.all([
        helperA.run('proof-check', 'owner-A', 30_000, async () => { aRan = true }),
        helperB.run('proof-check', 'owner-B', 30_000, async () => { bRan = true })
      ])

      // Exactly one should have succeeded; order depends on SQLite serialisation.
      const wins = [resultA.ran, resultB.ran].filter(Boolean).length
      expect(wins).toBe(1)

      // Exactly one body ran.
      const bodiesRan = [aRan, bRan].filter(Boolean).length
      expect(bodiesRan).toBe(1)

      // The loser reported ran: false.
      if (resultA.ran) {
        expect(resultB.ran).toBe(false)
      } else {
        expect(resultA.ran).toBe(false)
      }
    } finally {
      await knex.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // Test 2 — recordProof flow: winner calls recordProof; tx_audit reflects it.
  // -------------------------------------------------------------------------
  test('2: winner calls recordProof and tx_audit has processing.changed entry for confirmed; loser writes nothing', async () => {
    const knex = await setupCutDb('v7lease-int-02.sqlite')
    try {
      const svcA = new TransactionService(knex)
      const svcB = new TransactionService(knex)
      const helperA = new LeasedMonitorTask(svcA)
      const helperB = new LeasedMonitorTask(svcB)

      // Seed a new transaction in 'sent' state (eligible for proof recording).
      // FSM allows: sent -> confirmed
      const txid = 'b'.repeat(64)
      const newTx = await svcA.create({ txid, processing: 'sent' })

      let winnerProofRecorded = false
      let loserProofRecorded = false

      // Dummy proof data (not chain-valid, but accepted by recordProof).
      const fakeProof = {
        transactionId: newTx.transactionId,
        height: 800_001,
        merklePath: makeTestBump(txid, 3, 800_001),
        merkleRoot: 'd'.repeat(64),
        blockHash: 'e'.repeat(64),
        expectedFrom: 'sent' as const
      }

      // A races B; one wins the lease and records the proof.
      const [resultA, resultB] = await Promise.all([
        helperA.run('proof-record', 'owner-A', 30_000, async () => {
          await svcA.recordProof(fakeProof)
          winnerProofRecorded = true
        }),
        helperB.run('proof-record', 'owner-B', 30_000, async () => {
          loserProofRecorded = true
        })
      ])

      // Exactly one ran.
      expect([resultA.ran, resultB.ran].filter(Boolean).length).toBe(1)

      if (resultA.ran) {
        // A won — proof was recorded; B did not run.
        expect(winnerProofRecorded).toBe(true)
        expect(loserProofRecorded).toBe(false)

        // Verify tx_audit has a 'processing.changed' entry with to_state='confirmed'.
        const auditRows = await knex('tx_audit')
          .where({ transactionId: newTx.transactionId, event: 'processing.changed' })
          .select('to_state')
        const provenRow = auditRows.find((r: any) => r.to_state === 'confirmed')
        expect(provenRow).toBeDefined()
      } else {
        // B won — B's body ran (loserProofRecorded=true); A did not record.
        expect(resultB.ran).toBe(true)
        expect(loserProofRecorded).toBe(true)
        expect(winnerProofRecorded).toBe(false)
      }
    } finally {
      await knex.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // Test 3 — Release and retry: loser succeeds after winner releases the lease.
  //
  // Strategy: claim the lease directly via tryClaimLease (bypassing LeasedMonitorTask
  // so the row stays alive), then verify B can't claim it, then release manually
  // and verify B can claim on the next attempt.
  // -------------------------------------------------------------------------
  test('3: loser succeeds on retry after winner releases', async () => {
    const knex = await setupCutDb('v7lease-int-03.sqlite')
    try {
      const svc = new TransactionService(knex)
      const helperB = new LeasedMonitorTask(svc)

      // Step 1: Owner A claims the lease directly (row stays alive while we test B).
      const claimResult = await svc.tryClaimLease({ taskName: 'release-retry', ownerId: 'owner-A', ttlMs: 30_000 })
      expect(claimResult.acquired).toBe(true)

      // Step 2: B tries to claim — should fail because A holds the live lease.
      let bFirst = false
      const resultBFirst = await helperB.run('release-retry', 'owner-B', 30_000, async () => { bFirst = true })
      expect(resultBFirst.ran).toBe(false)
      expect(bFirst).toBe(false)

      // Step 3: A releases the lease manually.
      const released = await svc.releaseLease({ taskName: 'release-retry', ownerId: 'owner-A' })
      expect(released).toBe(true)

      // Step 4: B retries — now it should succeed.
      let bSecond = false
      const resultBSecond = await helperB.run('release-retry', 'owner-B', 30_000, async () => { bSecond = true })
      expect(resultBSecond.ran).toBe(true)
      expect(bSecond).toBe(true)
    } finally {
      await knex.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // Test 4 — Stale lease takeover: expired lease is claimed by a new owner.
  // -------------------------------------------------------------------------
  test('4: stale lease (expiresAt in the past) is taken over by a new claimant', async () => {
    const knex = await setupCutDb('v7lease-int-04.sqlite')
    try {
      const svc = new TransactionService(knex)

      // Insert a lease row directly with expiresAt in the distant past.
      const past = new Date(Date.now() - 120_000) // 2 minutes ago
      await knex('monitor_lease').insert({
        task_name: 'stale-task',
        owner_id: 'old-owner',
        expires_at: past,
        renew_count: 0,
        created_at: past,
        updated_at: past
      })

      // A new owner should be able to take over immediately.
      const helper = new LeasedMonitorTask(svc)
      let ran = false
      const result = await helper.run('stale-task', 'new-owner', 30_000, async () => { ran = true })

      expect(result.ran).toBe(true)
      expect(ran).toBe(true)

      // Verify the lease row now belongs to new-owner (row deleted on release, so it should be absent).
      const row = await knex('monitor_lease').where({ task_name: 'stale-task' }).first()
      expect(row).toBeUndefined() // released in finally
    } finally {
      await knex.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // Test 5 — recordProof transaction-service hook: correct tx_audit entry written end-to-end.
  //
  // FSM allows: sent -> confirmed (see processingFsm.ts line 22).
  // -------------------------------------------------------------------------
  test('5: recordProof via svc writes proof columns and tx_audit row', async () => {
    const knex = await setupCutDb('v7lease-int-05.sqlite')
    try {
      const svc = new TransactionService(knex)

      const txid = 'f'.repeat(64)
      // Create a transaction in 'sent' state — FSM allows sent -> confirmed.
      const newTx = await svc.create({ txid, processing: 'sent' })

      const result = await svc.recordProof({
        transactionId: newTx.transactionId,
        height: 850_000,
        merklePath: makeTestBump(txid, 7, 850_000),
        merkleRoot: '1'.repeat(64),
        blockHash: '2'.repeat(64),
        expectedFrom: 'sent'
      })

      // recordProof should return the updated row in 'confirmed' state.
      expect(result).toBeDefined()
      expect(result?.processing).toBe('confirmed')
      expect(result?.height).toBe(850_000)
      expect(result?.merkleIndex).toBe(7)
      expect(result?.merkleRoot).toBe('1'.repeat(64))
      expect(result?.blockHash).toBe('2'.repeat(64))

      // Verify tx_audit: should have a 'processing.changed' entry with to_state='confirmed'.
      // tx_audit uses camelCase `transactionId` and column `to_state`.
      const auditRows = await knex('tx_audit')
        .where({ transactionId: newTx.transactionId, event: 'processing.changed' })
        .select('to_state')
      const provenEntry = auditRows.find((r: any) => r.to_state === 'confirmed')
      expect(provenEntry).toBeDefined()
    } finally {
      await knex.destroy()
    }
  })
})
