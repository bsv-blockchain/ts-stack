/**
 * Integration tests for runIdbSchemaCutover.
 *
 * Uses fake-indexeddb/auto to patch the global `indexedDB` so the idb library
 * operates entirely in memory inside Node.
 *
 * Test layout:
 *   1. open a fresh DB at version 1 with upgradeAllStoresV1 (the pre-cutover
 *      schema that has both `transactions` and `transactions_new`).
 *   2. seed rows into `transactions`, `proven_txs`, `proven_tx_reqs`, and
 *      `transactions_new`.
 *   3. run the cutover.
 *   4. assert the post-cutover object-store names and that rows migrated
 *      to the correct stores.
 *   5. verify that a second call to runIdbSchemaCutover is a no-op (idempotent).
 */

import 'fake-indexeddb/auto'

import { openDB } from 'idb'
import { upgradeAllStoresV1 } from '../../src/storage/idbHelpers'
import { runIdbSchemaCutover } from '../../src/storage/schema/schemaCutoverIdb'
import type { StorageIdbSchema } from '../../src/storage/schema/StorageIdbSchema'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Open a fresh version-1 database with the full pre-cutover schema. */
async function openV1 (name: string) {
  return openDB<StorageIdbSchema>(name, 1, {
    upgrade (db) {
      upgradeAllStoresV1(db)
    }
  })
}

/** Minimal TableTransaction row — only required fields. */
function makeLegacyTx (transactionId: number, txid: string, reference: string) {
  const now = new Date()
  return {
    transactionId,
    userId: 1,
    status: 'completed' as const,
    reference,
    isOutgoing: true,
    satoshis: 1000,
    description: 'test tx',
    txid,
    created_at: now,
    updated_at: now
  }
}

/** Minimal TableProvenTx row. */
function makeProvenTx (provenTxId: number, txid: string) {
  const now = new Date()
  return {
    provenTxId,
    txid,
    height: 800_001,
    index: 0,
    merklePath: [1, 2, 3],
    rawTx: [0xde, 0xad],
    blockHash: 'b'.repeat(64),
    merkleRoot: 'm'.repeat(64),
    created_at: now,
    updated_at: now
  }
}

/** Minimal TableProvenTxReq row. */
function makeProvenTxReq (provenTxReqId: number, txid: string) {
  const now = new Date()
  return {
    provenTxReqId,
    txid,
    status: 'completed' as const,
    attempts: 1,
    notified: true,
    history: '{}',
    notify: '{}',
    rawTx: [0xbe, 0xef],
    created_at: now,
    updated_at: now
  }
}

/** Minimal TableTransactionNew row. */
function makeNewTx (transactionId: number, txid: string) {
  const now = new Date()
  return {
    transactionId,
    txid,
    processing: 'proven' as const,
    processingChangedAt: now,
    attempts: 0,
    rebroadcastCycles: 0,
    wasBroadcast: true,
    isCoinbase: false,
    rowVersion: 0,
    created_at: now,
    updated_at: now
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runIdbSchemaCutover (IDB)', () => {
  // Each test gets its own uniquely-named database so they are fully isolated.
  let dbCounter = 0
  function freshDbName (): string {
    return `test-db-schema-cutover-${++dbCounter}`
  }

  test('post-cutover store names are correct', async () => {
    const dbName = freshDbName()
    const v1 = await openV1(dbName)

    // Seed one row in each store that will be renamed.
    const tx = v1.transaction(['transactions', 'proven_txs', 'proven_tx_reqs', 'transactions_new'], 'readwrite')
    await tx.objectStore('transactions').put(makeLegacyTx(1, 'a'.repeat(64), 'ref-a'))
    await tx.objectStore('proven_txs').put(makeProvenTx(1, 'a'.repeat(64)))
    await tx.objectStore('proven_tx_reqs').put(makeProvenTxReq(1, 'a'.repeat(64)))
    await tx.objectStore('transactions_new').put(makeNewTx(1, 'c'.repeat(64)))
    await tx.done

    v1.close()

    const db = await runIdbSchemaCutover(dbName, 2)

    const names = Array.from(db.objectStoreNames)

    // Must contain the four post-cutover stores.
    expect(names).toContain('transactions')
    expect(names).toContain('transactions_legacy')
    expect(names).toContain('proven_tx_reqs_legacy')
    expect(names).toContain('proven_txs_legacy')

    // Must NOT contain transactions_new — it was renamed to `transactions`.
    expect(names).not.toContain('transactions_new')

    db.close()
  })

  test('legacy transactions rows migrate to transactions_legacy', async () => {
    const dbName = freshDbName()
    const v1 = await openV1(dbName)

    const tx = v1.transaction(['transactions', 'transactions_new'], 'readwrite')
    // Two legacy rows.
    await tx.objectStore('transactions').put(makeLegacyTx(1, 'a'.repeat(64), 'ref-a'))
    await tx.objectStore('transactions').put(makeLegacyTx(2, 'b'.repeat(64), 'ref-b'))
    // One new-schema row so the cutover actually runs.
    await tx.objectStore('transactions_new').put(makeNewTx(10, 'c'.repeat(64)))
    await tx.done

    v1.close()

    const db = await runIdbSchemaCutover(dbName, 2)

    // Both legacy rows should now be in transactions_legacy.
    const legacyRows = await (db as any).getAll('transactions_legacy')
    const legacyTxids = legacyRows.map((r: any) => r.txid).sort()
    expect(legacyTxids).toEqual(['a'.repeat(64), 'b'.repeat(64)])

    db.close()
  })

  test('transactions_new rows are accessible via renamed transactions store', async () => {
    const dbName = freshDbName()
    const v1 = await openV1(dbName)

    const tx = v1.transaction(['transactions', 'transactions_new'], 'readwrite')
    // One legacy row needed so the pre-cutover schema is correct.
    await tx.objectStore('transactions').put(makeLegacyTx(1, 'a'.repeat(64), 'ref-a'))
    // Two new-schema rows that should become accessible through `transactions`.
    await tx.objectStore('transactions_new').put(makeNewTx(1, 'c'.repeat(64)))
    await tx.objectStore('transactions_new').put(makeNewTx(2, 'd'.repeat(64)))
    await tx.done

    v1.close()

    const db = await runIdbSchemaCutover(dbName, 2)

    const rows = await (db as any).getAll('transactions')
    const txids = rows.map((r: any) => r.txid).sort()
    expect(txids).toEqual(['c'.repeat(64), 'd'.repeat(64)])

    db.close()
  })

  test('proven_txs rows migrate to proven_txs_legacy', async () => {
    const dbName = freshDbName()
    const v1 = await openV1(dbName)

    const tx = v1.transaction(['transactions', 'proven_txs', 'transactions_new'], 'readwrite')
    await tx.objectStore('transactions').put(makeLegacyTx(1, 'a'.repeat(64), 'ref-a'))
    await tx.objectStore('proven_txs').put(makeProvenTx(1, 'a'.repeat(64)))
    await tx.objectStore('transactions_new').put(makeNewTx(1, 'c'.repeat(64)))
    await tx.done

    v1.close()

    const db = await runIdbSchemaCutover(dbName, 2)

    const rows = await (db as any).getAll('proven_txs_legacy')
    expect(rows).toHaveLength(1)
    expect(rows[0].txid).toBe('a'.repeat(64))

    db.close()
  })

  test('proven_tx_reqs rows migrate to proven_tx_reqs_legacy', async () => {
    const dbName = freshDbName()
    const v1 = await openV1(dbName)

    const tx = v1.transaction(['transactions', 'proven_tx_reqs', 'transactions_new'], 'readwrite')
    await tx.objectStore('transactions').put(makeLegacyTx(1, 'a'.repeat(64), 'ref-a'))
    await tx.objectStore('proven_tx_reqs').put(makeProvenTxReq(1, 'a'.repeat(64)))
    await tx.objectStore('transactions_new').put(makeNewTx(1, 'c'.repeat(64)))
    await tx.done

    v1.close()

    const db = await runIdbSchemaCutover(dbName, 2)

    const rows = await (db as any).getAll('proven_tx_reqs_legacy')
    expect(rows).toHaveLength(1)
    expect(rows[0].txid).toBe('a'.repeat(64))

    db.close()
  })

  test('second call to runIdbSchemaCutover is a no-op (idempotent)', async () => {
    const dbName = freshDbName()
    const v1 = await openV1(dbName)

    const tx = v1.transaction(['transactions', 'transactions_new'], 'readwrite')
    await tx.objectStore('transactions').put(makeLegacyTx(1, 'a'.repeat(64), 'ref-a'))
    await tx.objectStore('transactions_new').put(makeNewTx(1, 'c'.repeat(64)))
    await tx.done

    v1.close()

    // First call — performs the cutover.
    const db1 = await runIdbSchemaCutover(dbName, 2)
    db1.close()

    // Second call — must not throw and must return the same store layout.
    const db2 = await runIdbSchemaCutover(dbName, 2)

    const names = Array.from(db2.objectStoreNames)
    expect(names).toContain('transactions')
    expect(names).toContain('transactions_legacy')
    expect(names).not.toContain('transactions_new')

    db2.close()
  })
})
