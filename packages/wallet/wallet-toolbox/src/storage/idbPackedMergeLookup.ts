import type { StorageIdb } from './StorageIdb'
import { getPackedIdbConnection } from './idbPackedConnection'
import { packedIdbKey, packedIdbPositive, type PackedIdbTransaction } from './idbPackedFields'
import { readPackedIdbCurrentMetadata, type PackedIdbCurrentMetadata } from './idbPackedCurrentMetadata'
import { createSyncMap, type SyncMap } from './schema/entities/EntityBase'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'

/** Natural identity only. A selector contains no payload or fabricated DTO. IDs
 * in this input belong to the source; maps are captured before the first yield
 * and both actual destination parents are freshly inspected in the same view. */
export type PackedIdbMergeIdentity =
  | { readonly table: 'provenTxs' | 'provenTxReqs'; readonly txid: string }
  | { readonly table: 'outputBaskets'; readonly name: string }
  | { readonly table: 'outputTags'; readonly tag: string }
  | { readonly table: 'txLabels'; readonly label: string }
  | { readonly table: 'transactions'; readonly txid?: string | null; readonly reference?: string | null }
  | { readonly table: 'outputs'; readonly transactionId: number; readonly vout: number }
  | { readonly table: 'txLabelMaps'; readonly transactionId: number; readonly txLabelId: number }
  | { readonly table: 'outputTagMaps'; readonly outputId: number; readonly outputTagId: number }
  | { readonly table: 'certificates'; readonly certifier: string; readonly serialNumber: string }
  | { readonly table: 'certificateFields'; readonly certificateId: number; readonly fieldName: string }
  | { readonly table: 'commissions'; readonly transactionId: number }

function invalid(): never {
  throw new Error('Packed destination natural identity, mapping, index or current parent differs')
}
function capture(value: PackedIdbMergeIdentity): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value),
    result: Record<string, unknown> = Object.create(null)
  if (Object.keys(descriptors).length > 5) invalid()
  for (const [name, property] of Object.entries(descriptors)) {
    if (
      !Object.hasOwn(property, 'value') ||
      !property.enumerable ||
      ![
        'table',
        'txid',
        'name',
        'tag',
        'label',
        'reference',
        'transactionId',
        'vout',
        'txLabelId',
        'outputId',
        'outputTagId',
        'certifier',
        'serialNumber',
        'certificateId',
        'fieldName'
      ].includes(name)
    )
      invalid()
    const scalar: unknown = property.value
    if (
      (scalar !== undefined && scalar !== null && typeof scalar !== 'number' && typeof scalar !== 'string') ||
      (typeof scalar === 'string' && scalar.length > 4096)
    )
      invalid()
    result[name] = scalar
  }
  return Object.freeze(result)
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) invalid()
  return value
}
function mapped(
  map: SyncMap,
  entity: 'transaction' | 'output' | 'outputTag' | 'txLabel' | 'certificate',
  incoming: unknown
): number {
  const sourceId = packedIdbPositive(incoming),
    property = Object.getOwnPropertyDescriptor(map[entity].idMap, String(sourceId))
  if (property === undefined || !Object.hasOwn(property, 'value')) invalid()
  return packedIdbPositive(property.value)
}

/** Detached selector/map DATA for a scheduled owned read. It grants no lookup,
 * profile, semantic or write authority; the actual current parents and native
 * indexes are checked by every later read, including the final writer. */
export function capturePackedIdbMergeLookupInputs(
  selected: PackedIdbMergeIdentity,
  map: SyncMap
): {
  readonly identity: PackedIdbMergeIdentity
  readonly map: SyncMap
} {
  const data = capture(selected),
    copied = createSyncMap(),
    copy = (entity: 'transaction' | 'output' | 'outputTag' | 'txLabel' | 'certificate', name: string): number => {
      const incoming = packedIdbPositive(data[name])
      copied[entity].idMap[incoming] = mapped(map, entity, incoming)
      return incoming
    }
  let identity: PackedIdbMergeIdentity
  switch (data.table) {
    case 'provenTxs':
    case 'provenTxReqs':
      identity = { table: data.table, txid: text(data.txid) }
      break
    case 'outputBaskets':
      identity = { table: data.table, name: text(data.name) }
      break
    case 'outputTags':
      identity = { table: data.table, tag: text(data.tag) }
      break
    case 'txLabels':
      identity = { table: data.table, label: text(data.label) }
      break
    case 'transactions':
      identity = {
        table: data.table,
        txid: data.txid == null ? data.txid : text(data.txid),
        reference: data.reference == null ? data.reference : text(data.reference)
      }
      break
    case 'outputs':
      if (typeof data.vout !== 'number' || !Number.isSafeInteger(data.vout) || data.vout < 0) invalid()
      identity = { table: data.table, transactionId: copy('transaction', 'transactionId'), vout: data.vout }
      break
    case 'txLabelMaps':
      identity = {
        table: data.table,
        transactionId: copy('transaction', 'transactionId'),
        txLabelId: copy('txLabel', 'txLabelId')
      }
      break
    case 'outputTagMaps':
      identity = {
        table: data.table,
        outputId: copy('output', 'outputId'),
        outputTagId: copy('outputTag', 'outputTagId')
      }
      break
    case 'certificates':
      identity = { table: data.table, certifier: text(data.certifier), serialNumber: text(data.serialNumber) }
      break
    case 'certificateFields':
      identity = {
        table: data.table,
        certificateId: copy('certificate', 'certificateId'),
        fieldName: text(data.fieldName)
      }
      break
    case 'commissions':
      identity = { table: data.table, transactionId: copy('transaction', 'transactionId') }
      break
    default:
      invalid()
  }
  return Object.freeze({ identity: Object.freeze(identity), map: copied })
}

/** Payload-free lookup in an actual current operational transaction. Every
 * query returns at most TWO native keys, so ambiguity is refused without a
 * row/payload scan. Tombstones retain their entity identity. Current metadata,
 * not a cached lookup result, must be compared again in the final writer. */
export async function findPackedIdbMergeMetadata(
  storage: StorageIdb,
  selectedTx: PackedIdbTransaction,
  selected: PackedIdbMergeIdentity,
  userId: number,
  map: SyncMap,
  maximumMetadataBytes: number,
  signal?: AbortSignal
): Promise<Readonly<PackedIdbCurrentMetadata> | undefined> {
  const identity = capture(selected),
    parents: Array<[string, number]> = []
  packedIdbPositive(userId)
  if (!Number.isSafeInteger(maximumMetadataBytes) || maximumMetadataBytes < 1 || maximumMetadataBytes > 16777216)
    invalid()
  // Resolve source-to-local relationships synchronously, before current-view
  // admission yields. A supplied map cannot establish existence or profile.
  const parent = (
    entity: 'transaction' | 'output' | 'outputTag' | 'txLabel' | 'certificate',
    field: string,
    store: string
  ): number => {
    const id = mapped(map, entity, identity[field])
    parents.push([store, id])
    return id
  }
  let storeName: string,
    indexName: string | undefined,
    indexPath: string | string[] | undefined,
    indexUnique = false,
    query: IDBValidKey | undefined,
    fallback: string | undefined
  switch (identity.table) {
    case 'provenTxs':
    case 'provenTxReqs':
      storeName = identity.table === 'provenTxs' ? 'proven_txs' : 'proven_tx_reqs'
      indexName = 'txid'
      indexPath = 'txid'
      indexUnique = true
      query = text(identity.txid)
      break
    case 'outputBaskets':
      storeName = 'output_baskets'
      indexName = 'name_userId'
      indexPath = ['name', 'userId']
      indexUnique = true
      query = [text(identity.name), userId]
      break
    case 'outputTags':
      storeName = 'output_tags'
      indexName = 'tag_userId'
      indexPath = ['tag', 'userId']
      indexUnique = true
      query = [text(identity.tag), userId]
      break
    case 'txLabels':
      storeName = 'tx_labels'
      indexName = 'label_userId'
      indexPath = ['label', 'userId']
      indexUnique = true
      query = [text(identity.label), userId]
      break
    case 'transactions': {
      storeName = 'transactions'
      indexName = 'txid_userId'
      indexPath = ['txid', 'userId']
      const txid = identity.txid == null ? '' : text(identity.txid)
      fallback = identity.reference == null ? '' : text(identity.reference)
      query = txid ? [txid, userId] : undefined
      break
    }
    case 'outputs': {
      const id = parent('transaction', 'transactionId', 'transactions'),
        vout = identity.vout
      // Zero is a legal output index, not a packed native row ID.
      if (typeof vout !== 'number' || !Number.isSafeInteger(vout) || vout < 0) invalid()
      storeName = 'outputs'
      indexName = 'transactionId_vout_userId'
      indexPath = ['transactionId', 'vout', 'userId']
      indexUnique = true
      query = [id, vout, userId]
      break
    }
    case 'txLabelMaps':
      storeName = 'tx_labels_map'
      query = [parent('txLabel', 'txLabelId', 'tx_labels'), parent('transaction', 'transactionId', 'transactions')]
      break
    case 'outputTagMaps':
      storeName = 'output_tags_map'
      query = [parent('outputTag', 'outputTagId', 'output_tags'), parent('output', 'outputId', 'outputs')]
      break
    case 'certificates':
      storeName = 'certificates'
      indexName = 'userId_certifier_serialNumber'
      indexPath = ['userId', 'certifier', 'serialNumber']
      query = [userId, text(identity.certifier), text(identity.serialNumber)]
      break
    case 'certificateFields':
      storeName = 'certificate_fields'
      query = [parent('certificate', 'certificateId', 'certificates'), text(identity.fieldName)]
      break
    case 'commissions':
      storeName = 'commissions'
      indexName = 'transactionId'
      indexPath = 'transactionId'
      indexUnique = true
      query = parent('transaction', 'transactionId', 'transactions')
      break
    default:
      invalid()
  }
  const db = storage.db,
    owner = db === undefined ? undefined : getPackedIdbConnection(db)
  if (owner === undefined || db === undefined || db.name !== storage.dbName) invalid()
  const tx = owner.operationalMetadataTransaction(selectedTx),
    fresh = async (): Promise<void> => {
      signal?.throwIfAborted()
      if (storage.db !== db || storage.dbName !== db.name || getPackedIdbConnection(db) !== owner) invalid()
      owner.operationalMetadataTransaction(tx)
      await owner.checkOperationalTransaction(tx)
      signal?.throwIfAborted()
    }
  await fresh()
  let available = maximumMetadataBytes
  for (const [name, id] of parents) {
    if (available < 1)
      throw new SnapshotResourceLimitError('Packed lookup parent metadata exceeds its original page allowance')
    const current = await readPackedIdbCurrentMetadata(storage, tx, name, id, userId, available, signal)
    if (current === undefined) invalid()
    available -= current.allocationBytes
  }
  const store = tx.objectStore(storeName),
    lookup = async (
      name: string,
      path: string | string[],
      unique: boolean,
      key: IDBValidKey
    ): Promise<IDBValidKey | undefined> => {
      if (!store.indexNames.contains(name)) invalid()
      const index = store.index(name)
      if (index.multiEntry || index.unique !== unique || JSON.stringify(index.keyPath) !== JSON.stringify(path))
        invalid()
      const keys = await index.getAllKeys(key, 2)
      if (keys.length > 1) invalid()
      return keys.length === 0 ? undefined : packedIdbKey(keys[0])
    }
  let key: IDBValidKey | undefined
  if (query !== undefined) {
    if (indexName === undefined) key = await store.getKey(query)
    else {
      if (indexPath === undefined) invalid()
      key = await lookup(indexName, indexPath, indexUnique, query)
    }
  }
  if (key === undefined && storeName === 'transactions' && fallback)
    key = await lookup('reference', 'reference', true, fallback)
  if (key === undefined) {
    await fresh()
    return undefined
  }
  if (available < 1)
    throw new SnapshotResourceLimitError('Packed lookup row metadata exceeds its original page allowance')
  const result = await readPackedIdbCurrentMetadata(
    storage,
    tx,
    storeName,
    packedIdbKey(key),
    userId,
    available,
    signal
  )
  await fresh()
  return result === undefined
    ? undefined
    : Object.freeze({ ...result, allocationBytes: maximumMetadataBytes - available + result.allocationBytes })
}
