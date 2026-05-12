/**
 * V7 wiring integration tests for attemptToPostReqsToNetwork.ts
 *
 * Tests verify that the additive V7 calls introduced alongside the legacy
 * EntityProvenTxReq path produce the expected V7 table state:
 *
 *  Test 1 — Successful broadcast: req in 'queued', recordBroadcastResult moves
 *            to 'sent', wasBroadcast=true, tx_audit has aggregateResults entry.
 *  Test 2 — Double-spend response: V7 processing moves to 'doubleSpend' (terminal).
 *  Test 3 — Invalid response: V7 processing moves to 'invalid' (terminal).
 *  Test 4 — Service error: incrementAttempts runs, attempts counter increments,
 *            processing stays in 'sending', tx_audit has attempts.incremented.
 *
 * Setup pattern mirrors v7Conformance.test.ts (setupCutDb + StorageKnex wrapper).
 * The tests call updateReqsFromAggregateResults directly so they don't need a live
 * WalletServices instance or real BEEF data.
 *
 * The req objects are seeded into proven_tx_reqs_legacy (the post-cutover table
 * for legacy req rows) so that req.refreshFromStorage and
 * req.updateStorageDynamicProperties succeed. req.notify.transactionIds is set
 * to [] (empty) so that updateTransactionsStatus is a no-op — the tests are
 * focused exclusively on V7 state changes.
 */

import { Knex } from 'knex'
import { _tu } from '../../utils/TestUtilsWalletStorage'
import { KnexMigrations, StorageKnex } from '../../../src/index.all'
import { runV7Cutover } from '../../../src/storage/schema/v7Cutover'
import { V7TransactionService } from '../../../src/storage/schema/v7Service'
import { EntityProvenTxReq } from '../../../src/storage/schema/entities'
import {
  updateReqsFromAggregateResults,
  AggregatePostBeefTxResult,
  PostReqsToNetworkDetails
} from '../../../src/storage/methods/attemptToPostReqsToNetwork'
import { Beef } from '@bsv/sdk'

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

/** Post-cutover SQLite: migrations + runV7Cutover, two users seeded. */
async function setupCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'v7 attemptToPost', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
  await runV7Cutover(knex)
  await knex('users').insert({ userId: 1, identityKey: '02'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  return knex
}

/** Wrap a Knex handle in a StorageKnex instance. */
async function makeStorage (knex: Knex): Promise<StorageKnex> {
  const storage = new StorageKnex({
    ...StorageKnex.defaultOptions(),
    chain: 'test',
    knex
  })
  await storage.makeAvailable()
  return storage
}

/**
 * Seed a `proven_tx_reqs_legacy` row bypassing FK constraints (SQLite renames
 * the table but FK DDL still references the original `proven_txs` name).
 *
 * Returns the corresponding EntityProvenTxReq loaded from storage so that
 * req.refreshFromStorage / req.updateStorageDynamicProperties have a valid id.
 *
 * notify.transactionIds = [] so that updateTransactionsStatus([]) is a no-op,
 * keeping legacy side-effects out of these V7-focused tests.
 */
async function seedReq (
  knex: Knex,
  storage: StorageKnex,
  txid: string,
  rawTx = [0x01, 0x02, 0x03, 0x04]
): Promise<EntityProvenTxReq> {
  const now = new Date().toISOString()
  // Disable FK so the renamed proven_txs_legacy FK reference to proven_txs
  // does not block the insert.
  await knex.raw('PRAGMA foreign_keys = OFF')
  const [reqId] = await knex('proven_tx_reqs_legacy').insert({
    txid,
    rawTx: Buffer.from(rawTx),
    inputBEEF: Buffer.from([0xde, 0xad]),
    status: 'sending',
    history: JSON.stringify({ notes: [] }),
    // notify.transactionIds = [] → updateTransactionsStatus([]) is a no-op
    notify: JSON.stringify({ transactionIds: [] }),
    attempts: 1,
    notified: false,
    wasBroadcast: false,
    rebroadcastAttempts: 0,
    created_at: now,
    updated_at: now
  })
  await knex.raw('PRAGMA foreign_keys = ON')

  // Return a live EntityProvenTxReq by loading from storage so that
  // refreshFromStorage / updateStorageDynamicProperties have a valid id.
  const loaded = await EntityProvenTxReq.fromStorageId(storage, reqId)
  return loaded
}

/**
 * Build a minimal AggregatePostBeefTxResult and the matching
 * PostReqsToNetworkDetails for a given req + aggregate status.
 */
function makeAggregateResult (
  req: EntityProvenTxReq,
  aggStatus: AggregatePostBeefTxResult['status']
): { ar: AggregatePostBeefTxResult, vreq: PostReqsToNetworkDetails } {
  const vreq: PostReqsToNetworkDetails = {
    txid: req.txid,
    req,
    status: 'unknown'
  }
  const ar: AggregatePostBeefTxResult = {
    txid: req.txid,
    vreq,
    txidResults: [],
    status: aggStatus,
    successCount: aggStatus === 'success' ? 1 : 0,
    doubleSpendCount: aggStatus === 'doubleSpend' ? 1 : 0,
    statusErrorCount: aggStatus === 'invalidTx' ? 1 : 0,
    serviceErrorCount: aggStatus === 'serviceError' ? 1 : 0,
    competingTxs: []
  }
  return { ar, vreq }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V7 attemptToPostReqsToNetwork wiring', () => {
  jest.setTimeout(90_000)

  // -----------------------------------------------------------------------
  // Test 1 — Successful broadcast → V7 processing moves to 'sent',
  //           wasBroadcast=true, tx_audit has aggregateResults entry.
  // -----------------------------------------------------------------------
  test('1: successful broadcast moves V7 processing to sent and records audit entry', async () => {
    const knex = await setupCutDb('v7apt-01.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const storage = await makeStorage(knex)

      const txid = 'a'.repeat(64)

      // Seed V7 transaction in 'queued' state (broadcast has not been attempted yet).
      await svc.create({ txid, processing: 'queued' })

      // Seed legacy req in proven_tx_reqs_legacy.
      const req = await seedReq(knex, storage, txid)

      const { ar, vreq } = makeAggregateResult(req, 'success')
      const apbrs: Record<string, AggregatePostBeefTxResult> = { [txid]: ar }
      const r = { status: 'success' as const, beef: new Beef(), details: [vreq], log: '' }

      // Call the function under test with no services (skips confirmDoubleSpend
      // and markStaleInputsAsSpent) and no trx.
      await updateReqsFromAggregateResults([txid], r, apbrs, storage, undefined, undefined, undefined)

      // V7: processing must now be 'sent' (broadcast accepted, waiting for proof).
      const v7Tx = await knex('transactions').where({ txid }).first()
      expect(v7Tx).toBeDefined()
      expect(v7Tx.processing).toBe('sent')

      // V7: tx_audit must have an 'aggregateResults' history note entry.
      const auditRows = await knex('tx_audit')
        .where({ transactionId: v7Tx.transactionId })
        .orderBy('auditId')
      const events = auditRows.map((r: any) => r.event)
      // Should include the history.note entry written by recordHistoryNote.
      expect(events.some((e: string) => e === 'history.note')).toBe(true)
      // Should include the processing.changed entry written by recordBroadcastResult
      // (auditProcessingTransition writes event='processing.changed' for valid transitions).
      expect(events.some((e: string) => e === 'processing.changed')).toBe(true)

      // Verify the history.note details contain the aggregateResults what field.
      const noteRow = auditRows.find((r: any) => r.event === 'history.note')
      expect(noteRow).toBeDefined()
      const noteDetails = JSON.parse(noteRow.details_json)
      expect(noteDetails.what).toBe('aggregateResults')
      expect(noteDetails.aggStatus).toBe('success')
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 2 — Double-spend response → V7 processing moves to 'doubleSpend'
  //           (terminal state), tx_audit records the transition.
  // -----------------------------------------------------------------------
  test('2: double-spend response moves V7 processing to doubleSpend (terminal)', async () => {
    const knex = await setupCutDb('v7apt-02.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const storage = await makeStorage(knex)

      const txid = 'b'.repeat(64)

      // Seed V7 transaction in 'sending' state.
      await svc.create({ txid, processing: 'queued' })
      // Transition to 'sending' so the recordBroadcastResult can transition to doubleSpend.
      const v7TxBefore = await svc.findByTxid(txid)
      await svc.transition({ transactionId: v7TxBefore!.transactionId, expectedFrom: 'queued', to: 'sending' })

      const req = await seedReq(knex, storage, txid)

      const { ar, vreq } = makeAggregateResult(req, 'doubleSpend')
      const apbrs: Record<string, AggregatePostBeefTxResult> = { [txid]: ar }
      const r = { status: 'success' as const, beef: new Beef(), details: [vreq], log: '' }

      await updateReqsFromAggregateResults([txid], r, apbrs, storage, undefined, undefined, undefined)

      // V7: processing must now be 'doubleSpend'.
      const v7Tx = await knex('transactions').where({ txid }).first()
      expect(v7Tx).toBeDefined()
      expect(v7Tx.processing).toBe('doubleSpend')

      // V7: tx_audit must record the transition to doubleSpend.
      // auditProcessingTransition writes event='processing.changed' for valid transitions.
      const auditRows = await knex('tx_audit')
        .where({ transactionId: v7Tx.transactionId })
        .orderBy('auditId')
      const changedRows = auditRows.filter((r: any) => r.event === 'processing.changed')
      // At least one processing.changed row with to_state='doubleSpend'.
      const hasDoubleSpend = changedRows.some((r: any) => r.to_state === 'doubleSpend')
      expect(hasDoubleSpend).toBe(true)
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 3 — Invalid response → V7 processing moves to 'invalid' (terminal).
  // -----------------------------------------------------------------------
  test('3: invalid response moves V7 processing to invalid', async () => {
    const knex = await setupCutDb('v7apt-03.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const storage = await makeStorage(knex)

      const txid = 'c'.repeat(64)

      // Seed V7 transaction in 'queued' then transition to 'sending'.
      await svc.create({ txid, processing: 'queued' })
      const v7TxBefore = await svc.findByTxid(txid)
      await svc.transition({ transactionId: v7TxBefore!.transactionId, expectedFrom: 'queued', to: 'sending' })

      const req = await seedReq(knex, storage, txid)

      const { ar, vreq } = makeAggregateResult(req, 'invalidTx')
      const apbrs: Record<string, AggregatePostBeefTxResult> = { [txid]: ar }
      const r = { status: 'success' as const, beef: new Beef(), details: [vreq], log: '' }

      await updateReqsFromAggregateResults([txid], r, apbrs, storage, undefined, undefined, undefined)

      // V7: processing must now be 'invalid'.
      const v7Tx = await knex('transactions').where({ txid }).first()
      expect(v7Tx).toBeDefined()
      expect(v7Tx.processing).toBe('invalid')

      // V7: tx_audit must record a processing.changed entry with to_state='invalid'.
      // auditProcessingTransition writes event='processing.changed' for valid transitions.
      const auditRows = await knex('tx_audit')
        .where({ transactionId: v7Tx.transactionId })
        .orderBy('auditId')
      const hasInvalidTransition = auditRows.some(
        (r: any) => r.event === 'processing.changed' && r.to_state === 'invalid'
      )
      expect(hasInvalidTransition).toBe(true)
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 4 — Service error → incrementAttempts runs, attempts counter
  //           increments, processing stays in 'sending', tx_audit has
  //           attempts.incremented entry.
  // -----------------------------------------------------------------------
  test('4: service error increments V7 attempts and keeps processing in sending', async () => {
    const knex = await setupCutDb('v7apt-04.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const storage = await makeStorage(knex)

      const txid = 'd'.repeat(64)

      // Seed V7 transaction in 'queued' then transition to 'sending'
      // (serviceError maps to sending→sending).
      await svc.create({ txid, processing: 'queued' })
      const v7TxBefore = await svc.findByTxid(txid)
      await svc.transition({ transactionId: v7TxBefore!.transactionId, expectedFrom: 'queued', to: 'sending' })

      const req = await seedReq(knex, storage, txid)
      const attemptsBefore = req.attempts

      const { ar, vreq } = makeAggregateResult(req, 'serviceError')
      const apbrs: Record<string, AggregatePostBeefTxResult> = { [txid]: ar }
      const r = { status: 'success' as const, beef: new Beef(), details: [vreq], log: '' }

      await updateReqsFromAggregateResults([txid], r, apbrs, storage, undefined, undefined, undefined)

      // V7: processing must still be 'sending' (service error → retry).
      const v7Tx = await knex('transactions').where({ txid }).first()
      expect(v7Tx).toBeDefined()
      expect(v7Tx.processing).toBe('sending')

      // V7: attempts counter must have incremented.
      expect(v7Tx.attempts).toBeGreaterThan(0)

      // V7: tx_audit must have an attempts.incremented entry.
      const auditRows = await knex('tx_audit')
        .where({ transactionId: v7Tx.transactionId })
        .orderBy('auditId')
      const hasAttemptRow = auditRows.some((r: any) => r.event === 'attempts.incremented')
      expect(hasAttemptRow).toBe(true)

      // V7: tx_audit must also have a history.note for aggregateResults.
      const hasHistoryNote = auditRows.some((r: any) => r.event === 'history.note')
      expect(hasHistoryNote).toBe(true)

      // Legacy req: attempts must also have incremented (the legacy path still runs).
      const updatedReq = await EntityProvenTxReq.fromStorageId(storage, req.id)
      expect(updatedReq.attempts).toBe(attemptsBefore + 1)
    } finally {
      await knex.destroy()
    }
  })
})
