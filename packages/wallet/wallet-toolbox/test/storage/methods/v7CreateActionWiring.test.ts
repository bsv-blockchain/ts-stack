/**
 * Integration tests for the createAction + processAction V7 wiring.
 *
 * These tests verify:
 *  1. `StorageKnex.insertLegacyTransaction()` routes to `transactions_legacy`
 *     on post-cutover databases and falls back to `transactions` pre-cutover.
 *  2. `V7TransactionService.repointLabelsToActionId()` rewrites
 *     `tx_labels_map.transactionId` from legacyTransactionId → actionId.
 *  3. The V7 row-creation block (that processAction now calls) produces the
 *     expected `transactions` + `actions` rows with correct column values.
 *
 * All tests use the `setupCutDb` helper pattern from v7Conformance.test.ts.
 * The `setupPreCutDb` variant omits the cutover to verify pre-cutover fallback.
 */

import { Knex } from 'knex'
import { _tu } from '../../utils/TestUtilsWalletStorage'
import { KnexMigrations, StorageKnex } from '../../../src/index.all'
import { runV7Cutover } from '../../../src/storage/schema/v7Cutover'
import { V7TransactionService } from '../../../src/storage/schema/v7Service'
import { TableTransaction } from '../../../src/storage/schema/tables/TableTransaction'

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

/** Post-cutover SQLite: migrations applied + runV7Cutover, two users seeded. */
async function setupCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'v7 createAction wiring', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
  await runV7Cutover(knex)
  await knex('users').insert({ userId: 1, identityKey: '02'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  await knex('users').insert({ userId: 2, identityKey: '03'.padEnd(66, '0'), activeStorage: '1'.repeat(64) })
  return knex
}

/** Pre-cutover SQLite: migrations applied but NO runV7Cutover, one user seeded. */
async function setupPreCutDb (filename: string): Promise<Knex> {
  const file = await _tu.newTmpFile(filename, true, false, false)
  const knex = _tu.createLocalSQLite(file)
  const source = new KnexMigrations('test', 'v7 createAction pre-cut', '1'.repeat(64), 1000)
  await knex.migrate.latest({ migrationSource: source })
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

/** Build the minimal fields required by `transactions_legacy` (legacy schema). */
function legacyTxRow (overrides: Partial<TableTransaction> = {}): TableTransaction {
  const now = new Date()
  return {
    created_at: now,
    updated_at: now,
    transactionId: 0,
    userId: 1,
    status: 'unsigned',
    reference: 'ref-' + Math.random().toString(36).slice(2, 10),
    isOutgoing: true,
    satoshis: 0,
    description: 'test tx',
    version: 1,
    lockTime: 0,
    txid: undefined,
    inputBEEF: undefined,
    rawTx: undefined,
    ...overrides
  }
}

// ---------------------------------------------------------------------------

describe('V7 createAction wiring', () => {
  jest.setTimeout(60_000)

  // -----------------------------------------------------------------------
  // Test 1 — insertLegacyTransaction on POST-cutover DB → transactions_legacy
  // -----------------------------------------------------------------------
  test('1: insertLegacyTransaction writes to transactions_legacy on post-cutover DB', async () => {
    const knex = await setupCutDb('v7caw-01.sqlite')
    try {
      const storage = await makeStorage(knex)

      const tx = legacyTxRow({ reference: 'post-cut-ref-1' })
      const legacyId = await storage.insertLegacyTransaction(tx)
      expect(legacyId).toBeGreaterThan(0)

      // Row must exist in transactions_legacy
      const inLegacy = await knex('transactions_legacy').where({ transactionId: legacyId }).first()
      expect(inLegacy).toBeDefined()
      expect(inLegacy.reference).toBe('post-cut-ref-1')
      expect(inLegacy.status).toBe('unsigned')

      // Row must NOT exist in V7 transactions
      const inV7 = await knex('transactions').where('transactionId', legacyId).first()
      expect(inV7).toBeUndefined()
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 2 — insertLegacyTransaction on PRE-cutover DB → transactions
  // -----------------------------------------------------------------------
  test('2: insertLegacyTransaction falls back to transactions on pre-cutover DB', async () => {
    const knex = await setupPreCutDb('v7caw-02.sqlite')
    try {
      const storage = await makeStorage(knex)

      const tx = legacyTxRow({ reference: 'pre-cut-ref-2' })
      const txId = await storage.insertLegacyTransaction(tx)
      expect(txId).toBeGreaterThan(0)

      // transactions_legacy does NOT exist pre-cutover
      const hasLegacy = await knex.schema.hasTable('transactions_legacy')
      expect(hasLegacy).toBe(false)

      // Row must exist in transactions (legacy table pre-cutover)
      const inTx = await knex('transactions').where({ transactionId: txId }).first()
      expect(inTx).toBeDefined()
      expect(inTx.reference).toBe('pre-cut-ref-2')
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 3 — repointLabelsToActionId rewrites tx_labels_map rows
  // -----------------------------------------------------------------------
  test('3: repointLabelsToActionId moves tx_labels_map.transactionId to actionId', async () => {
    const knex = await setupCutDb('v7caw-03.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const storage = await makeStorage(knex)

      // Seed a V7 transaction + action (first action: will be used as legacyTransactionId
      // placeholder so we have a valid FK target in actions)
      const txRowA = await svc.create({ txid: 'a'.repeat(64), processing: 'queued' })
      const legacyTransactionId = await svc.createAction({
        userId: 1,
        transactionId: txRowA.transactionId,
        reference: 'ref-caw3-legacy',
        description: 'legacy placeholder',
        isOutgoing: true,
        satoshisDelta: 0
      })

      // Seed a second V7 transaction + action (the "real" action after signing)
      const txRowB = await svc.create({ txid: 'b'.repeat(64), processing: 'queued' })
      const actionId = await svc.createAction({
        userId: 1,
        transactionId: txRowB.transactionId,
        reference: 'ref-caw3-real',
        description: 'real action',
        isOutgoing: true,
        satoshisDelta: 100
      })

      // Seed a tx_label and use insertLegacyTxLabelMap to write legacyTransactionId
      // (bypassing FK — exactly what createAction does post-cutover)
      await knex('tx_labels').insert({ txLabelId: 1, userId: 1, label: 'test-label', isDeleted: false })
      await storage.insertLegacyTxLabelMap({
        txLabelId: 1,
        transactionId: legacyTransactionId,
        created_at: new Date(),
        updated_at: new Date(),
        isDeleted: false
      })

      // Verify row exists under legacyTransactionId before repoint
      const before = await knex('tx_labels_map').where({ transactionId: legacyTransactionId }).first()
      expect(before).toBeDefined()

      // Run repoint
      await svc.repointLabelsToActionId(legacyTransactionId, actionId)

      // Row should now point to actionId
      const after = await knex('tx_labels_map').where({ transactionId: actionId }).first()
      expect(after).toBeDefined()
      expect(after.txLabelId).toBe(1)

      // Old legacyTransactionId row should be gone
      const stale = await knex('tx_labels_map').where({ transactionId: legacyTransactionId }).first()
      expect(stale).toBeUndefined()
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 4 — repointLabelsToActionId is a no-op when no labels exist
  // -----------------------------------------------------------------------
  test('4: repointLabelsToActionId is a no-op when no labels point to legacyTransactionId', async () => {
    const knex = await setupCutDb('v7caw-04.sqlite')
    try {
      const svc = new V7TransactionService(knex)

      // Seed a V7 transaction + action (no label rows)
      const txRow = await svc.create({ txid: 'b'.repeat(64), processing: 'queued' })
      const actionId = await svc.createAction({
        userId: 1,
        transactionId: txRow.transactionId,
        reference: 'ref-caw4',
        description: 'test',
        isOutgoing: true,
        satoshisDelta: 50
      })

      // No rows in tx_labels_map at all — should not throw
      await expect(svc.repointLabelsToActionId(12345, actionId)).resolves.toBeUndefined()

      // tx_labels_map remains empty
      const rows = await knex('tx_labels_map')
      expect(rows).toHaveLength(0)
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 5 — findOrCreateActionForTxid (processAction V7 core) creates both rows
  // -----------------------------------------------------------------------
  test('5: findOrCreateActionForTxid creates V7 transactions + actions rows', async () => {
    const knex = await setupCutDb('v7caw-05.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const txid = 'c'.repeat(64)
      const rawTx = [1, 2, 3, 4]
      const inputBeef = [5, 6, 7, 8]

      const { action, transaction, isNew } = await svc.findOrCreateActionForTxid({
        userId: 1,
        txid,
        isOutgoing: true,
        description: 'Payment',
        satoshisDelta: -1000,
        reference: 'ref-caw5',
        rawTx,
        inputBeef,
        processing: 'queued'
      })

      expect(isNew).toBe(true)

      // V7 transactions row exists with correct fields
      expect(transaction.txid).toBe(txid)
      expect(transaction.processing).toBe('queued')
      expect(Array.from(transaction.rawTx!)).toEqual(rawTx)

      // V7 actions row exists with correct fields
      expect(action.userId).toBe(1)
      expect(action.transactionId).toBe(transaction.transactionId)
      expect(action.reference).toBe('ref-caw5')
      expect(action.description).toBe('Payment')
      expect(action.isOutgoing).toBe(true)
      expect(action.satoshisDelta).toBe(-1000)
    } finally {
      await knex.destroy()
    }
  })

  // -----------------------------------------------------------------------
  // Test 6 — Full processAction V7 wiring simulation:
  //   legacy row in transactions_legacy → processAction V7 block creates V7 rows
  //   + rewrites tx_labels_map to actionId
  // -----------------------------------------------------------------------
  test('6: processAction V7 block creates V7 rows and repoints labels', async () => {
    const knex = await setupCutDb('v7caw-06.sqlite')
    try {
      const svc = new V7TransactionService(knex)
      const storage = await makeStorage(knex)

      // 1. Simulate what createAction does: insert a legacy row and attach a label.
      const legacyRef = 'ref-caw6'
      const legacyTx = legacyTxRow({ userId: 1, reference: legacyRef, satoshis: -500, description: 'Send payment' })
      const legacyId = await storage.insertLegacyTransaction(legacyTx)
      expect(legacyId).toBeGreaterThan(0)

      // Insert a label and link it to the legacy transactionId using the
      // FK-bypassing shim (exactly what createAction does post-cutover)
      await knex('tx_labels').insert({ txLabelId: 10, userId: 1, label: 'payment', isDeleted: false })
      await storage.insertLegacyTxLabelMap({
        txLabelId: 10,
        transactionId: legacyId,
        created_at: new Date(),
        updated_at: new Date(),
        isDeleted: false
      })

      // Verify legacy row exists and V7 transactions table is empty
      const inLegacy = await knex('transactions_legacy').where({ transactionId: legacyId }).first()
      expect(inLegacy).toBeDefined()
      expect(await knex('transactions').count<{ c: number }>({ c: '*' }).first().then(r => Number(r!.c))).toBe(0)

      // 2. Simulate what processAction's V7 block does (after signing produces a txid).
      const realTxid = 'd'.repeat(64)
      const rawTx = [0xaa, 0xbb, 0xcc]
      const inputBeef = [0x01, 0x02]

      const { action } = await svc.findOrCreateActionForTxid({
        userId: 1,
        txid: realTxid,
        isOutgoing: true,
        description: 'Send payment',
        satoshisDelta: -500,
        reference: legacyRef,
        rawTx,
        inputBeef,
        processing: 'queued'
      })
      await svc.repointLabelsToActionId(legacyId, action.actionId)

      // 3. Assert final state

      // V7 transactions row exists
      const v7Tx = await knex('transactions').where({ txid: realTxid }).first()
      expect(v7Tx).toBeDefined()
      expect(v7Tx.processing).toBe('queued')

      // V7 actions row exists for userId=1
      const v7Action = await knex('actions').where({ actionId: action.actionId }).first()
      expect(v7Action).toBeDefined()
      expect(v7Action.userId).toBe(1)
      expect(v7Action.reference).toBe(legacyRef)

      // tx_labels_map now points to actionId (not legacyId)
      const labelRow = await knex('tx_labels_map').where({ txLabelId: 10 }).first()
      expect(labelRow).toBeDefined()
      expect(labelRow.transactionId).toBe(action.actionId)

      // Legacy row still exists in transactions_legacy (untouched by V7 wiring)
      const stillInLegacy = await knex('transactions_legacy').where({ transactionId: legacyId }).first()
      expect(stillInLegacy).toBeDefined()
    } finally {
      await knex.destroy()
    }
  })
})
