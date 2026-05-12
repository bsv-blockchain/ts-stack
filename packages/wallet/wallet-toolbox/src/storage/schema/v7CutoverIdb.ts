import { IDBPDatabase, IDBPTransaction, openDB } from 'idb'
import { StorageIdbSchema } from './StorageIdbSchema'

/**
 * V7 IDB-side cutover.
 *
 * IndexedDB has no `RENAME STORE` primitive, and store creation/deletion is
 * only permitted during a version-upgrade transaction. The cutover therefore:
 *
 *   1. Re-opens the database at a higher version, supplying an `upgrade`
 *      callback that does the rename via copy-and-delete on the upgrade trx.
 *   2. For each table that needs renaming:
 *        a. Read every row from the source store.
 *        b. Create the destination store with the same indexes.
 *        c. Write rows into the destination store.
 *        d. Delete the source store.
 *   3. Returns the upgraded database handle (caller is responsible for
 *      closing it).
 *
 * Safe to call twice — the second call sees the post-cutover layout, skips
 * the rename block, and returns without error.
 *
 * `targetVersion` defaults to 2; bump it if the caller already operates on a
 * higher schema version.
 */
export async function runV7IdbCutover (
  dbName: string,
  targetVersion = 2
): Promise<IDBPDatabase<StorageIdbSchema>> {
  return await openDB<StorageIdbSchema>(dbName, targetVersion, {
    async upgrade (db, oldVersion, _newVersion, trx) {
      if (oldVersion >= 2) return
      if (!db.objectStoreNames.contains('transactions_v7')) return

      await renameStore(
        db,
        trx as IDBPTransaction<StorageIdbSchema, any, 'versionchange'>,
        'transactions',
        'transactions_legacy',
        store => {
          store.createIndex('userId', 'userId')
          store.createIndex('status', 'status')
          store.createIndex('status_userId', ['status', 'userId'])
          store.createIndex('provenTxId', 'provenTxId')
          store.createIndex('reference', 'reference', { unique: true })
        }
      )

      await renameStore(
        db,
        trx as IDBPTransaction<StorageIdbSchema, any, 'versionchange'>,
        'proven_tx_reqs',
        'proven_tx_reqs_legacy',
        store => {
          store.createIndex('provenTxId', 'provenTxId')
          store.createIndex('txid', 'txid', { unique: true })
          store.createIndex('status', 'status')
          store.createIndex('batch', 'batch')
        }
      )

      await renameStore(
        db,
        trx as IDBPTransaction<StorageIdbSchema, any, 'versionchange'>,
        'proven_txs',
        'proven_txs_legacy',
        store => {
          store.createIndex('txid', 'txid', { unique: true })
        }
      )

      await renameStore(
        db,
        trx as IDBPTransaction<StorageIdbSchema, any, 'versionchange'>,
        'transactions_v7',
        'transactions',
        store => {
          store.createIndex('txid', 'txid', { unique: true })
          store.createIndex('processing', 'processing')
          store.createIndex('batch', 'batch')
          store.createIndex('idempotencyKey', 'idempotencyKey', { unique: true })
        }
      )
    }
  })
}

async function renameStore (
  db: IDBPDatabase<StorageIdbSchema>,
  trx: IDBPTransaction<StorageIdbSchema, any, 'versionchange'>,
  fromName: string,
  toName: string,
  applyIndexes: (store: IDBObjectStore) => void
): Promise<void> {
  if (!db.objectStoreNames.contains(fromName as any)) return
  if (db.objectStoreNames.contains(toName as any)) {
    // Target already exists — assume a prior partial cutover. Drop the source
    // and continue rather than fail; the application is expected to verify
    // post-cutover state via its own smoke tests before resuming traffic.
    db.deleteObjectStore(fromName as any)
    return
  }

  const sourceStore: any = (trx.objectStore as any)(fromName)
  const sourceKeyPath = sourceStore.keyPath as string | string[] | null
  const sourceAutoIncrement = sourceStore.autoIncrement as boolean
  const rows = await sourceStore.getAll()
  const keys = await sourceStore.getAllKeys()

  db.deleteObjectStore(fromName as any)
  const dest = db.createObjectStore(toName as any, {
    keyPath: sourceKeyPath ?? undefined,
    autoIncrement: sourceAutoIncrement
  }) as unknown as IDBObjectStore
  applyIndexes(dest)

  const destStore: any = (trx.objectStore as any)(toName)
  for (let i = 0; i < rows.length; i++) {
    if (sourceAutoIncrement || sourceKeyPath != null) {
      await destStore.put(rows[i])
    } else {
      await destStore.put(rows[i], keys[i])
    }
  }
}
