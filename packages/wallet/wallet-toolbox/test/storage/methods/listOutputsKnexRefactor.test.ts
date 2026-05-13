/**
 * post-cutover integration tests for listOutputsKnex.ts
 *
 * These tests verify the two fixes introduced in the new-schema wiring:
 *  1. Status filter: `t.processing IN (TX_PROCESSING_ALLOWED)` instead of
 *     the legacy `t.status IN ('completed','unproven','nosend','sending')`.
 *  2. Label join: corrected hop through `actions` so that
 *     `tx_labels_map.transactionId` (which is `actions.actionId` post-cutover)
 *     is resolved correctly.
 *
 * Setup pattern mirrors schemaConformance.test.ts and transactionServiceExpansion.test.ts.
 */

import { Validation } from '@bsv/sdk'
import { Knex } from 'knex'
import { _tu } from '../../utils/TestUtilsWalletStorage'
import { KnexMigrations, StorageKnex } from '../../../src/index.all'
import { runSchemaCutover } from '../../../src/storage/schema/schemaCutover'
import { TransactionService } from '../../../src/storage/schema/transactionService'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh post-cutover SQLite database, runs all migrations, then
 * executes `runSchemaCutover`. Two users are pre-seeded (userId 1 and 2).
 */
async function setupCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'v7 listOutputs', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
  await runSchemaCutover(knex)
  await knex('users').insert({ userId: 1, identityKey: '02'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  await knex('users').insert({ userId: 2, identityKey: '03'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  return knex
}

/**
 * Wraps an already-migrated+cutover Knex handle in a StorageKnex instance
 * and initialises its settings (makeAvailable reads from the `settings` table
 * which was created during migration and is not touched by the cutover).
 */
async function makeStorage (knex: Knex): Promise<StorageKnex> {
  const storage = new StorageKnex({
    ...StorageKnex.defaultOptions(),
    chain: 'test',
    knex
  })
  // makeAvailable() reads settings; does NOT re-run migrations.
  await storage.makeAvailable()
  return storage
}

/**
 * Build a ValidListOutputsArgs object for the given basket with sensible
 * defaults for all boolean/array fields.
 */
function makeArgs (
  basket: string,
  overrides: Partial<Validation.ValidListOutputsArgs> = {}
): Validation.ValidListOutputsArgs {
  return {
    basket: basket as Validation.ValidListOutputsArgs['basket'],
    tags: [],
    tagQueryMode: 'any',
    includeLockingScripts: false,
    includeTransactions: false,
    includeCustomInstructions: false,
    includeTags: false,
    includeLabels: false,
    limit: 100,
    offset: 0,
    seekPermission: false,
    knownTxids: [],
    ...overrides
  }
}

/**
 * Minimal valid output row. Pass overrides to customise individual fields.
 */
function outputRow (
  transactionId: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    userId: 1,
    transactionId,
    spendable: true,
    change: false,
    vout: 0,
    satoshis: 5000,
    providedBy: 'storage',
    purpose: 'transfer',
    type: 'P2PKH',
    outputDescription: 'test output',
    txid: 'a'.repeat(64),
    lockingScript: Buffer.from([0x76, 0xac]),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listOutputsKnex (new-schema) — status filter + label join', () => {
  jest.setTimeout(90_000)

  // -------------------------------------------------------------------------
  // Test 1: proven transaction + label → output returned with correct labels
  // -------------------------------------------------------------------------
  test('returns output with correct labels when transaction is proven', async () => {
    const knex = await setupCutDb('v7lo-proven.sqlite')
    try {
      const svc = new TransactionService(knex)
      const storage = await makeStorage(knex)

      // Create a new transaction in `proven` state.
      const tx = await svc.create({ txid: 'a'.repeat(64), processing: 'proven' })

      // Create the `actions` row (needed for the label join hop).
      const actionId = await svc.createAction({
        userId: 1,
        transactionId: tx.transactionId,
        reference: 'ref-proven-1',
        description: 'test proven action',
        isOutgoing: true,
        satoshisDelta: 5000
      })

      // Seed a basket and an output for user 1.
      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      await knex('outputs').insert(outputRow(tx.transactionId, { basketId }))

      // Seed a label and wire it to the action (NOT to the transaction).
      // Post-cutover: tx_labels_map.transactionId = actions.actionId.
      const [labelId] = await knex('tx_labels').insert({ userId: 1, label: 'my-label', isDeleted: false })
      await knex('tx_labels_map').insert({
        txLabelId: labelId,
        transactionId: actionId,   // <-- actionId, not transactionId!
        isDeleted: false
      })

      const result = await storage.listOutputs(
        { userId: 1, identityKey: '02'.padEnd(66, '0') },
        makeArgs('default', { includeLabels: true })
      )

      expect(result.outputs).toHaveLength(1)
      expect(result.outputs[0].labels).toBeDefined()
      expect(result.outputs[0].labels).toContain('my-label')
      expect(result.outputs[0].outpoint).toBe(`${'a'.repeat(64)}.0`)
      expect(result.outputs[0].satoshis).toBe(5000)
    } finally {
      await knex.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // Test 2: queued transaction → output NOT returned
  // -------------------------------------------------------------------------
  test('does NOT return outputs for transactions in queued state', async () => {
    const knex = await setupCutDb('v7lo-queued.sqlite')
    try {
      const svc = new TransactionService(knex)
      const storage = await makeStorage(knex)

      // Create a new transaction in `queued` state (not yet broadcast).
      const tx = await svc.create({ txid: 'b'.repeat(64), processing: 'queued' })

      // Create the `actions` row.
      await svc.createAction({
        userId: 1,
        transactionId: tx.transactionId,
        reference: 'ref-queued-1',
        description: 'test queued action',
        isOutgoing: true,
        satoshisDelta: 3000
      })

      // Seed a basket and an output — spendable=true so the only filter that
      // should block it is the processing status check.
      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      await knex('outputs').insert(
        outputRow(tx.transactionId, { basketId, txid: 'b'.repeat(64), satoshis: 3000 })
      )

      const result = await storage.listOutputs(
        { userId: 1, identityKey: '02'.padEnd(66, '0') },
        makeArgs('default')
      )

      // `queued` is excluded from TX_PROCESSING_ALLOWED — no outputs returned.
      expect(result.outputs).toHaveLength(0)
      expect(result.totalOutputs).toBe(0)
    } finally {
      await knex.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // Test 3: multi-status mix — only allowed statuses surface
  // -------------------------------------------------------------------------
  test('returns outputs for proven/sent/seen/nosend/sending but not queued/invalid', async () => {
    const knex = await setupCutDb('v7lo-mix.sqlite')
    try {
      const storage = await makeStorage(knex)

      const [basketId] = await knex('output_baskets').insert({ userId: 1, name: 'default' })

      // Seed one transaction per interesting processing state.
      const states: Array<{ processing: string, txid: string, shouldAppear: boolean }> = [
        { processing: 'proven',      txid: '1'.repeat(64), shouldAppear: true },
        { processing: 'sent',        txid: '2'.repeat(64), shouldAppear: true },
        { processing: 'seen',        txid: '3'.repeat(64), shouldAppear: true },
        { processing: 'seen_multi',  txid: '4'.repeat(64), shouldAppear: true },
        { processing: 'unconfirmed', txid: '5'.repeat(64), shouldAppear: true },
        { processing: 'nosend',      txid: '6'.repeat(64), shouldAppear: true },
        { processing: 'sending',     txid: '7'.repeat(64), shouldAppear: true },
        { processing: 'queued',      txid: '8'.repeat(64), shouldAppear: false },
        { processing: 'invalid',     txid: '9'.repeat(64), shouldAppear: false },
        { processing: 'doubleSpend', txid: '0'.padStart(64, 'd'), shouldAppear: false }
      ]

      for (const s of states) {
        // Insert raw row: bypass TransactionService.create to avoid FSM
        // constraints on terminal states (invalid / doubleSpend).
        // new transactions table uses snake_case column names.
        const [txId] = await knex('transactions').insert({
          txid: s.txid,
          processing: s.processing,
          processing_changed_at: new Date(),
          attempts: 0,
          rebroadcast_cycles: 0,
          was_broadcast: false,
          is_coinbase: false,
          row_version: 0
        })
        await knex('outputs').insert(
          outputRow(txId, { basketId, txid: s.txid, satoshis: 1000, vout: 0, userId: 1, transactionId: txId })
        )
      }

      const result = await storage.listOutputs(
        { userId: 1, identityKey: '02'.padEnd(66, '0') },
        makeArgs('default', { limit: 100 })
      )

      const expectedCount = states.filter(s => s.shouldAppear).length
      expect(result.outputs).toHaveLength(expectedCount)

      const returnedTxids = result.outputs.map(o => o.outpoint.split('.')[0])
      for (const s of states) {
        if (s.shouldAppear) {
          expect(returnedTxids).toContain(s.txid)
        } else {
          expect(returnedTxids).not.toContain(s.txid)
        }
      }
    } finally {
      await knex.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // Test 4: label join does not bleed across users
  // -------------------------------------------------------------------------
  test('label join does not bleed across users', async () => {
    const knex = await setupCutDb('v7lo-crossuser.sqlite')
    try {
      const svc = new TransactionService(knex)
      const storage = await makeStorage(knex)

      const txid = 'c'.repeat(64)
      const tx = await svc.create({ txid, processing: 'proven' })

      // User 1 and user 2 both have an action on the same transaction.
      const actionId1 = await svc.createAction({
        userId: 1,
        transactionId: tx.transactionId,
        reference: 'ref-u1',
        description: 'user1 action',
        isOutgoing: false,
        satoshisDelta: 1000
      })

      await svc.createAction({
        userId: 2,
        transactionId: tx.transactionId,
        reference: 'ref-u2',
        description: 'user2 action',
        isOutgoing: true,
        satoshisDelta: -1000
      })

      // Baskets and outputs for both users.
      const [basket1] = await knex('output_baskets').insert({ userId: 1, name: 'default' })
      const [basket2] = await knex('output_baskets').insert({ userId: 2, name: 'default' })
      await knex('outputs').insert(
        outputRow(tx.transactionId, { basketId: basket1, txid, userId: 1, vout: 0 })
      )
      await knex('outputs').insert(
        outputRow(tx.transactionId, { basketId: basket2, txid, userId: 2, vout: 1 })
      )

      // Attach a label only to user 1's action.
      const [labelId] = await knex('tx_labels').insert({ userId: 1, label: 'user1-label', isDeleted: false })
      await knex('tx_labels_map').insert({
        txLabelId: labelId,
        transactionId: actionId1,
        isDeleted: false
      })

      // User 1 should see the label on their output.
      const r1 = await storage.listOutputs(
        { userId: 1, identityKey: '02'.padEnd(66, '0') },
        makeArgs('default', { includeLabels: true })
      )
      expect(r1.outputs).toHaveLength(1)
      expect(r1.outputs[0].labels).toContain('user1-label')

      // User 2 should NOT see user 1's label on their own output.
      const r2 = await storage.listOutputs(
        { userId: 2, identityKey: '03'.padEnd(66, '0') },
        makeArgs('default', { includeLabels: true })
      )
      expect(r2.outputs).toHaveLength(1)
      expect(r2.outputs[0].labels).toHaveLength(0)
    } finally {
      await knex.destroy()
    }
  })
})
