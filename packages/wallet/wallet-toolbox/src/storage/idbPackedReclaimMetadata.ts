import type { StorageIdb } from './StorageIdb'
import { getPackedIdbConnection } from './idbPackedConnection'
import { packedIdbKey, packedIdbPositive, type PackedIdbTransaction } from './idbPackedFields'
import { readPackedIdbCurrentMetadata, type PackedIdbCurrentMetadata } from './idbPackedCurrentMetadata'

function invalid(): never {
  throw new Error('Current packed reclaim identity, profile or native index differs')
}

/** The actual writer owns this lookup and any resulting quarantine. Key-only
 * iteration never hydrates a transaction/script. Cross-profile matches are
 * excluded by fresh native metadata, not a source map or remembered verdict. */
export async function packedIdbUnresolvedReclaim(
  storage: StorageIdb,
  selected: PackedIdbTransaction,
  userId: number,
  txid: string,
  check: () => void
): Promise<boolean> {
  packedIdbPositive(userId)
  if (typeof txid !== 'string' || txid.length > 4096) invalid()
  const db = storage.db,
    owner = db === undefined ? undefined : getPackedIdbConnection(db)
  if (owner === undefined || db === undefined || db.name !== storage.dbName) invalid()
  const tx = owner.operationalMetadataTransaction(selected),
    store = tx.objectStore('transactions'),
    index = store.index('noSendExpiryReclaimTxid')
  if (index.keyPath !== 'noSendExpiryReclaimTxid' || index.unique || index.multiEntry) invalid()
  let current: Readonly<PackedIdbCurrentMetadata> | undefined,
    cursor = await index.openKeyCursor(txid)
  while (cursor !== null) {
    check()
    await owner.checkOperationalTransaction(tx)
    const row = await readPackedIdbCurrentMetadata(
      storage,
      tx,
      'transactions',
      packedIdbKey(cursor.primaryKey),
      userId,
      65536
    )
    if (row !== undefined) {
      if (current !== undefined || row.fields.noSendExpiryReclaimTxid !== txid) invalid()
      current = row
    }
    cursor = await cursor.continue()
  }
  check()
  await owner.checkOperationalTransaction(tx)
  if (current === undefined) return false
  if (current.extents.noSendExpiryState !== undefined) invalid()
  return current.fields.noSendExpiryState !== 'reclaimed'
}

/** Same-transaction equivalent of the legacy reclaim-output quarantine.
 * Native current pointers are retained by the real row writer, never attached
 * by a copied hash or hydrated complete wallet DTO. */
export async function packedIdbQuarantineReclaim(
  storage: StorageIdb,
  selected: PackedIdbTransaction,
  userId: number,
  txid: string,
  check: () => void
): Promise<void> {
  packedIdbPositive(userId)
  if (typeof txid !== 'string' || txid.length > 4096) invalid()
  const db = storage.db,
    owner = db === undefined ? undefined : getPackedIdbConnection(db)
  if (owner === undefined || db === undefined || db.name !== storage.dbName) invalid()
  const tx = owner.operationalMetadataTransaction(selected),
    index = tx.objectStore('outputs').index('txid_vout_userId')
  if (JSON.stringify(index.keyPath) !== JSON.stringify(['txid', 'vout', 'userId']) || !index.unique || index.multiEntry)
    invalid()
  check()
  await owner.checkOperationalTransaction(tx)
  const keys = await index.getAllKeys([txid, 0, userId], 2)
  if (keys.length > 1) invalid()
  if (keys.length === 0) return
  const row = await readPackedIdbCurrentMetadata(storage, tx, 'outputs', packedIdbKey(keys[0]), userId, 65536)
  check()
  if (row === undefined || row.fields.txid !== txid || row.fields.vout !== 0) invalid()
  if (row.fields.spendable === true) {
    await storage.writeStagedStorageRow(
      'outputs',
      { ...row.fields, spendable: false },
      {},
      'put',
      selected,
      Object.keys(row.extents).length === 0 ? undefined : { revision: row.revision, names: Object.keys(row.extents) }
    )
  }
  check()
  await owner.checkOperationalTransaction(tx)
}
