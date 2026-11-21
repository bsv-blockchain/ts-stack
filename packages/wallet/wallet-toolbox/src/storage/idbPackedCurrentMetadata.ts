import type { StorageIdb } from './StorageIdb'
import { getPackedIdbConnection } from './idbPackedConnection'
import {
  packedIdbKey,
  packedIdbRowMetadataEqual,
  packedIdbDateTimestamp,
  packedIdbMetadataCharge,
  packedIdbPortableKey,
  packedIdbReplicaKey,
  packedIdbPositive,
  packedIdbStores,
  readPackedIdbClock,
  unpackPackedIdbMetadata,
  verifyPackedIdbReferences,
  checkPackedIdbContent,
  type PackedIdbTransaction,
  type PackedIdbField
} from './idbPackedFields'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'

const stores = Object.freeze([
  'proven_txs',
  'proven_tx_reqs',
  'output_baskets',
  'transactions',
  'outputs',
  'output_tags',
  'output_tags_map',
  'tx_labels',
  'tx_labels_map',
  'certificates',
  'certificate_fields',
  'commissions'
])
export interface PackedIdbCurrentMetadata {
  readonly store: string
  readonly key: IDBValidKey
  readonly revision: number
  readonly fields: Readonly<Record<string, unknown>>
  readonly extents: Readonly<Record<string, Readonly<PackedIdbField>>>
  /** Returned metadata allocation charge, not native/VM resident memory. */
  readonly allocationBytes: number
}
function invalid(): never {
  throw new Error('Current packed destination row, profile, revision or field metadata differs')
}
const sameKey = (a: unknown, b: IDBValidKey): boolean => indexedDB.cmp(packedIdbKey(a), b) === 0

/** Compare freshly read metadata DATA in full. This does not establish or
 * retain source, profile, primary, transaction or checkpoint authorization;
 * each caller performs its original live checks before invoking it. */
export function packedIdbCurrentMetadataEqual(
  previous: Readonly<PackedIdbCurrentMetadata> | undefined,
  actual: Readonly<PackedIdbCurrentMetadata> | undefined
): boolean {
  if (previous === undefined || actual === undefined) return previous === actual
  if (
    previous.store !== actual.store ||
    previous.revision !== actual.revision ||
    indexedDB.cmp(previous.key, actual.key) !== 0 ||
    !packedIdbRowMetadataEqual(previous, actual)
  )
    return false
  return true
}

/** Payload-free current destination inspection inside the actual caller-owned
 * operational transaction. The enclosing journal checks its exact session,
 * profile/primary/expiry before and after this read. No source/schema/semantic
 * verdict is retained; the final writer must freshly compare current revision
 * and metadata. Native records are bounded by the packed format independently
 * of this returned-metadata ceiling. Content descriptors identify DATA only. */
export async function readPackedIdbCurrentMetadata(
  storage: StorageIdb,
  tx: PackedIdbTransaction,
  storeName: string,
  selectedKey: IDBValidKey,
  userId: number,
  maximumMetadataBytes: number,
  signal?: AbortSignal
): Promise<Readonly<PackedIdbCurrentMetadata> | undefined> {
  const key = packedIdbKey(selectedKey),
    db = storage.db
  if (
    db === undefined ||
    !stores.includes(storeName) ||
    !Number.isSafeInteger(maximumMetadataBytes) ||
    maximumMetadataBytes < 1 ||
    maximumMetadataBytes > 16777216
  )
    invalid()
  const owner = getPackedIdbConnection(db)
  if (owner === undefined || storage.dbName !== db.name) invalid()
  // Normalize to the actual native transaction before any row fetch; an
  // ordinary wallet facade would otherwise hydrate its large fields.
  tx = owner.operationalMetadataTransaction(tx)
  const fresh = async (): Promise<void> => {
    signal?.throwIfAborted()
    if (storage.db !== db || storage.dbName !== db.name || getPackedIdbConnection(db) !== owner) invalid()
    owner.operationalMetadataTransaction(tx)
    await owner.checkOperationalTransaction(tx)
    signal?.throwIfAborted()
  }
  packedIdbPositive(userId)
  await fresh()
  const clock = await readPackedIdbClock(tx),
    store = tx.objectStore(storeName),
    value = await store.get(key),
    head = await tx.objectStore(packedIdbStores.heads).get([storeName, key])
  if (value === undefined && head === undefined) {
    await fresh()
    return undefined
  }
  if (
    head?.store !== storeName ||
    !sameKey(head.key, key) ||
    !Number.isSafeInteger(head.revision) ||
    (head.revision as number) < 1 ||
    (head.revision as number) > clock.revision ||
    !sameKey(head.portableKey, packedIdbPortableKey(storeName, key)) ||
    !sameKey(head.replicaKey, packedIdbReplicaKey(storeName, key))
  )
    invalid()
  const version = await tx.objectStore(packedIdbStores.versions).get([storeName, key, head.revision as number])
  if (
    version?.store !== storeName ||
    !sameKey(version.key, key) ||
    version.revision !== head.revision ||
    version.obsoleteAt !== undefined ||
    typeof version.deleted !== 'boolean'
  )
    invalid()
  if (value === undefined) {
    if (!version.deleted) invalid()
    verifyPackedIdbReferences(version.references, { extents: {} })
    await fresh()
    return undefined
  }
  if (version.deleted) invalid()
  const current = unpackPackedIdbMetadata(value),
    previous = unpackPackedIdbMetadata(version.value)
  const mapParents =
    storeName === 'output_tags_map'
      ? [
          ['outputs', 'outputId'],
          ['output_tags', 'outputTagId']
        ]
      : storeName === 'tx_labels_map'
        ? [
            ['transactions', 'transactionId'],
            ['tx_labels', 'txLabelId']
          ]
        : undefined
  if (
    mapParents === undefined &&
    storeName !== 'proven_txs' &&
    storeName !== 'proven_tx_reqs' &&
    current.fields.userId !== userId
  ) {
    await fresh()
    return undefined
  }
  verifyPackedIdbReferences(version.references, previous)
  if (!packedIdbRowMetadataEqual(current, previous)) invalid()
  const extentNames = Object.keys(current.extents).sort((a, b) => Number(a > b) - Number(a < b))
  const nativeKey =
    typeof store.keyPath === 'string'
      ? current.fields[store.keyPath]
      : Array.isArray(store.keyPath)
        ? store.keyPath.map(name => current.fields[name])
        : undefined
  if (!sameKey(nativeKey, key)) invalid()
  let allocationBytes = packedIdbMetadataCharge(current.fields) + extentNames.length * 256
  if (allocationBytes > maximumMetadataBytes)
    throw new SnapshotResourceLimitError('Current packed destination metadata exceeds its original page allowance')
  const extents: Record<string, Readonly<PackedIdbField>> = Object.create(null)
  for (const name of extentNames) {
    signal?.throwIfAborted()
    const actual = current.extents[name]
    const content = await checkPackedIdbContent(tx, actual)
    if ((content.refs as number) < 1 || content.expiresAt !== undefined) invalid()
    extents[name] = Object.freeze({ ...actual })
  }
  // Link tables have no userId column. Check BOTH actual current parents in
  // this same native view; an ID map or the link itself is no profile proof.
  if (mapParents !== undefined)
    for (const [parentStore, id] of mapParents) {
      if (allocationBytes >= maximumMetadataBytes)
        throw new SnapshotResourceLimitError('Current packed link parents exceed the original metadata allowance')
      const parentId = packedIdbPositive(current.fields[id]),
        parent = await readPackedIdbCurrentMetadata(
          storage,
          tx,
          parentStore,
          parentId,
          userId,
          maximumMetadataBytes - allocationBytes,
          signal
        )
      if (parent === undefined) {
        await fresh()
        return undefined
      }
      allocationBytes += parent.allocationBytes
    }
  await fresh()
  const fields = Object.fromEntries(
    Object.entries(current.fields).map(([name, field]) => [
      name,
      packedIdbDateTimestamp(field) === undefined ? field : new Date(packedIdbDateTimestamp(field)!)
    ])
  )
  return Object.freeze({
    store: storeName,
    key: Array.isArray(key) ? (Object.freeze([...key]) as unknown as IDBValidKey) : key,
    revision: head.revision as number,
    fields: Object.freeze(fields),
    extents: Object.freeze(extents),
    allocationBytes
  })
}
