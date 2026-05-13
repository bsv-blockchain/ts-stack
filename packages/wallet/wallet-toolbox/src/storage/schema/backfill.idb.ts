import { IDBPDatabase, IDBPTransaction } from 'idb'
import { StorageIdbSchema } from './StorageIdbSchema'
import {
  TableAction,
  TableProvenTx,
  TableProvenTxReq,
  TableTransaction,
  TableTransactionNew
} from './tables'
import { runBackfill, BackfillDriver, BackfillStats } from './backfill.runner'

type IdbStoreName = keyof StorageIdbSchema

const BACKFILL_STORES: IdbStoreName[] = [
  'proven_tx_reqs' as IdbStoreName,
  'proven_txs' as IdbStoreName,
  'transactions' as IdbStoreName,
  'transactions_new' as IdbStoreName,
  'actions' as IdbStoreName,
  'tx_labels_map' as IdbStoreName
]

/**
 * IndexedDB driver for the the backfill.
 *
 * The orchestrator is driven entirely from this driver inside a single
 * `readwrite` transaction across the legacy + new-schema stores. The streams cache
 * the keys up-front (`getAllKeys`) and then walk them one at a time so the
 * idb cursor lifetime does not span an external `await`.
 */
export class IdbBackfillDriver implements BackfillDriver {
  constructor (
    private readonly trx: IDBPTransaction<StorageIdbSchema, IdbStoreName[], 'readwrite'>
  ) {}

  async * streamLegacyReqs (): AsyncIterable<{ req: TableProvenTxReq, proven?: TableProvenTx }> {
    const reqStore = (this.trx.objectStore as any)('proven_tx_reqs')
    const provenStore = (this.trx.objectStore as any)('proven_txs')
    const reqKeys: number[] = await reqStore.getAllKeys()
    for (const key of reqKeys) {
      const req: TableProvenTxReq = await reqStore.get(key)
      let proven: TableProvenTx | undefined
      if (req.provenTxId != null) proven = await provenStore.get(req.provenTxId)
      yield { req, proven }
    }
  }

  async * streamLegacyTransactions (): AsyncIterable<TableTransaction> {
    const store = (this.trx.objectStore as any)('transactions')
    const keys: number[] = await store.getAllKeys()
    for (const key of keys) {
      const row: TableTransaction = await store.get(key)
      yield row
    }
  }

  async upsertTransactionNew (row: Omit<TableTransactionNew, 'transactionId'>): Promise<number> {
    const store = (this.trx.objectStore as any)('transactions_new')
    const txidIndex = store.index('txid')
    const existing: TableTransactionNew | undefined = await txidIndex.get(row.txid)
    if (existing != null) {
      const merged: TableTransactionNew = { ...existing, ...row, transactionId: existing.transactionId }
      await store.put(merged)
      return existing.transactionId
    }
    const newId = await store.add(row as any)
    return newId as number
  }

  async upsertAction (row: Omit<TableAction, 'actionId'>): Promise<number> {
    const store = (this.trx.objectStore as any)('actions')
    const idx = store.index('userId_transactionId')
    const existing: TableAction | undefined = await idx.get([row.userId, row.transactionId])
    if (existing != null) {
      const merged: TableAction = { ...existing, ...row, actionId: existing.actionId }
      await store.put(merged)
      return existing.actionId
    }
    const newId = await store.add(row as any)
    return newId as number
  }

  async repointTxLabelMap (legacyTransactionId: number, actionId: number): Promise<void> {
    if (legacyTransactionId === actionId) return
    const store = (this.trx.objectStore as any)('tx_labels_map')
    const idx = store.index('transactionId')
    const matches = await idx.getAll(legacyTransactionId)
    for (const m of matches) {
      const updated = { ...m, transactionId: actionId }
      await store.delete([m.txLabelId, legacyTransactionId])
      await store.add(updated)
    }
  }
}

/**
 * Convenience entry point that opens the required readwrite transaction and
 * runs the orchestrator against it.
 */
export async function runIdbBackfill (
  db: IDBPDatabase<StorageIdbSchema>,
  now: Date = new Date()
): Promise<BackfillStats> {
  const trx = (db.transaction as any)(BACKFILL_STORES, 'readwrite')
  const driver = new IdbBackfillDriver(trx)
  const stats = await runBackfill(driver, now)
  await trx.done
  return stats
}
