import type { IDBPDatabase } from 'idb'
import type { StorageIdbSchema } from './schema/StorageIdbSchema'
import type { PackedSnapshotRow, WalletSnapshotTable, WalletSnapshotTables } from './snapshot/WalletReadSnapshot'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'
import { packedIdbDateTimestamp, packedIdbIsAbortError } from './idbPackedFields'

export interface IdbPackedCursor {
  version: 1
  database: string
  schemaVersion: number
  storageIdentityKey: string
  identityKey: string
  table: WalletSnapshotTable
  /** Last examined native primary key, including an irrelevant global row. */
  after: number | string | Array<number | string>
}
export interface IdbPackedPageOptions {
  maximumRows?: number
  maximumExamined?: number
  maximumBytes?: number
  signal?: AbortSignal
}
export interface IdbPackedPage<T extends WalletSnapshotTable> {
  version: 1
  /** This page owns one readonly transaction. Cross-page immutability requires
   * a separate retained/MVCC source; this cursor does not claim one. */
  consistency: 'transaction'
  rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>>
  examined: number
  payloadBytes: number
  complete: boolean
  cursor?: IdbPackedCursor
}
// The selected physical schema is checked against the actual stores below.
type PackedSchema = unknown
interface Definition {
  store: string
  scoped?: true
  binary?: readonly string[]
  booleans?: readonly string[]
}
const definitions: Readonly<Record<WalletSnapshotTable, Definition>> = Object.freeze({
  provenTxs: { store: 'proven_txs', binary: ['merklePath', 'rawTx'] },
  provenTxReqs: { store: 'proven_tx_reqs', binary: ['rawTx', 'inputBEEF'], booleans: ['notified', 'wasBroadcast'] },
  outputBaskets: { store: 'output_baskets', scoped: true, booleans: ['isDeleted'] },
  transactions: {
    store: 'transactions',
    scoped: true,
    binary: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
    booleans: ['isOutgoing']
  },
  commissions: { store: 'commissions', scoped: true, binary: ['lockingScript'], booleans: ['isRedeemed'] },
  outputs: { store: 'outputs', scoped: true, binary: ['lockingScript'], booleans: ['spendable', 'change'] },
  outputTags: { store: 'output_tags', scoped: true, booleans: ['isDeleted'] },
  outputTagMaps: { store: 'output_tags_map', booleans: ['isDeleted'] },
  txLabels: { store: 'tx_labels', scoped: true, booleans: ['isDeleted'] },
  txLabelMaps: { store: 'tx_labels_map', booleans: ['isDeleted'] },
  certificates: { store: 'certificates', scoped: true, booleans: ['isDeleted'] },
  certificateFields: { store: 'certificate_fields', scoped: true },
  syncStates: { store: 'sync_states', scoped: true, booleans: ['init'] }
})
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Packed IndexedDB page differs from its current profile or schema')
}
function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new WERR_INVALID_PARAMETER(name, `an integer from 1 to ${maximum}`)
  return result
}
function key(value: unknown): IdbPackedCursor['after'] {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
  if (typeof value === 'string' && value.length <= 400) return value
  if (Array.isArray(value) && value.length === 2)
    return value.map(item => {
      const result = key(item)
      if (Array.isArray(result)) invalid()
      return result
    })
  return invalid()
}
function rowCharge(row: Record<string, unknown>): number {
  let bytes = 64
  for (const [name, value] of Object.entries(row)) {
    bytes += 64 + 2 * name.length
    if (typeof value === 'string') bytes += 2 * value.length
    else if (value instanceof Uint8Array) bytes += 2 * value.byteLength
    else if (Array.isArray(value)) bytes += 64 * value.length
    else if (
      value !== undefined &&
      value !== null &&
      typeof value === 'object' &&
      packedIdbDateTimestamp(value) === undefined
    )
      invalid()
    if (!Number.isSafeInteger(bytes)) invalid()
  }
  return bytes
}
function packed(row: Record<string, unknown>, definition: Definition): Record<string, unknown> {
  const result = { ...row }
  for (const field of definition.binary ?? []) {
    const value = row[field]
    if (value == null) continue
    if (value instanceof Uint8Array) result[field] = value.slice()
    else if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))
      result[field] = Uint8Array.from(value)
    else invalid()
  }
  for (const field of definition.booleans ?? []) {
    const value = row[field]
    if (value == null) continue
    if (value !== true && value !== false && value !== 0 && value !== 1) invalid()
    result[field] = value === true || value === 1
  }
  for (const field of ['created_at', 'updated_at']) {
    const value = row[field]
    const timestamp = packedIdbDateTimestamp(value)
    if (timestamp === undefined || !Number.isFinite(timestamp)) invalid()
    result[field] = new Date(timestamp)
  }
  return result
}

/** Versioned native IDB adapter. It reads the actual user/settings and indexed
 * relations afresh inside the same readonly transaction as the page, including
 * original sync-state data. It never calls legacy array-expanding find methods.
 * IDB clones a value before JS can inspect its length: maximumBytes bounds the
 * returned page and extra JS copies, not the browser's initial value clone.
 * Large-value metadata/chunk storage must provide that separate preflight. */
export async function readIdbPackedPage<T extends WalletSnapshotTable>(
  database: IDBPDatabase<StorageIdbSchema>,
  identityKey: string,
  chain: string,
  table: T,
  previous?: IdbPackedCursor,
  options: IdbPackedPageOptions = {}
): Promise<IdbPackedPage<T>> {
  if (typeof table !== 'string' || !Object.hasOwn(definitions, table)) invalid()
  const definition = definitions[table]
  if (typeof identityKey !== 'string' || identityKey.length < 1 || identityKey.length > 130) invalid()
  const maximumRows = limit(options.maximumRows, 128, 256, 'maximumRows')
  const maximumExamined = limit(options.maximumExamined, 256, 256, 'maximumExamined')
  const maximumBytes = limit(options.maximumBytes, 262144, 16777216, 'maximumBytes')
  options.signal?.throwIfAborted()
  const db = database as unknown as IDBPDatabase<PackedSchema>
  if (db.version < 6 || db.version > 2147483647) invalid()
  const stores = [
    ...new Set([
      'settings',
      'users',
      definition.store,
      'transactions',
      'outputs',
      'output_tags',
      'tx_labels',
      'certificates',
      'proven_txs',
      'proven_tx_reqs'
    ])
  ]
  if (stores.some(name => !db.objectStoreNames.contains(name))) invalid()
  const trx = db.transaction(stores, 'readonly')
  // Attach immediately: aborted transaction rejection must remain observed even
  // if an earlier request rejects before the final lifetime await.
  void trx.done.catch(() => undefined)
  let failure: { error: unknown } | undefined
  let answer: IdbPackedPage<T> | undefined
  try {
    const users = trx.objectStore('users')
    if (!users.indexNames.contains('identityKey')) invalid()
    const user = await users.index('identityKey').get(identityKey)
    const settings = await trx.objectStore('settings').getAll(undefined, 2)
    if (
      user === undefined ||
      user.identityKey !== identityKey ||
      typeof user.userId !== 'number' ||
      !Number.isSafeInteger(user.userId) ||
      user.userId < 1
    )
      throw new WERR_UNAUTHORIZED()
    if (
      settings.length !== 1 ||
      settings[0].chain !== chain ||
      typeof settings[0].storageIdentityKey !== 'string' ||
      settings[0].storageIdentityKey.length < 1 ||
      settings[0].storageIdentityKey.length > 256
    )
      invalid()
    const storageIdentityKey = settings[0].storageIdentityKey
    const source = {
      version: 1 as const,
      database: db.name,
      schemaVersion: db.version,
      storageIdentityKey,
      identityKey,
      table
    }
    const after = previous === undefined ? undefined : key(previous.after)
    if (
      previous !== undefined &&
      (previous.version !== 1 ||
        previous.database !== db.name ||
        previous.schemaVersion !== db.version ||
        previous.storageIdentityKey !== storageIdentityKey ||
        previous.identityKey !== identityKey ||
        previous.table !== table)
    )
      invalid()
    const owned = async (name: string, id: unknown): Promise<boolean> => {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) invalid()
      const target = trx.objectStore(name)
      if (!target.indexNames.contains('userId')) invalid()
      let member = await target.index('userId').openKeyCursor(user.userId)
      if (member !== null && indexedDB.cmp(member.primaryKey, id) < 0)
        member = await member.continuePrimaryKey(user.userId, id)
      return member !== null && indexedDB.cmp(member.primaryKey, id) === 0
    }
    const referenced = async (row: Record<string, unknown>): Promise<boolean> => {
      if (definition.scoped) {
        if (row.userId !== user.userId) return false
        if (table === 'certificateFields' && !(await owned('certificates', row.certificateId))) invalid()
        return true
      }
      if (table === 'outputTagMaps' || table === 'txLabelMaps') {
        const left =
          table === 'outputTagMaps'
            ? await owned('outputs', row.outputId)
            : await owned('transactions', row.transactionId)
        const right =
          table === 'outputTagMaps'
            ? await owned('output_tags', row.outputTagId)
            : await owned('tx_labels', row.txLabelId)
        if (left !== right) invalid()
        return left && right
      }
      const idField = table === 'provenTxs' ? 'provenTxId' : 'provenTxReqId'
      const rowId = row[idField]
      if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId) || rowId < 1) invalid()
      const transactions = trx.objectStore('transactions'),
        requests = trx.objectStore('proven_tx_reqs')
      if (
        !transactions.indexNames.contains('provenTxId') ||
        !transactions.indexNames.contains('txid_userId') ||
        !requests.indexNames.contains('provenTxId')
      )
        invalid()
      // Match the original archive closure: requests are selected by profile
      // transaction txid; proofs by transaction ID or those selected requests.
      if (table === 'provenTxs') {
        let reference = await transactions.index('provenTxId').openKeyCursor(rowId)
        // Bound relation discovery independently; a pathological shared global
        // row is refused rather than silently omitted or scanned without limit.
        for (let count = 0; reference !== null; count++) {
          if (count >= 256)
            throw new SnapshotResourceLimitError('Packed IDB global reference lookup exceeds its bounded policy')
          if (await owned('transactions', reference.primaryKey)) return true
          reference = await reference.continue()
        }
        let request = await requests.index('provenTxId').openCursor(rowId)
        for (let count = 0; request !== null; count++) {
          if (count >= 256)
            throw new SnapshotResourceLimitError('Packed IDB proof-request lookup exceeds its bounded policy')
          const txid = request.value.txid
          if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) invalid()
          if ((await transactions.index('txid_userId').getKey([txid, user.userId])) !== undefined) return true
          request = await request.continue()
        }
        return false
      }
      if (typeof row.txid !== 'string' || !/^[0-9a-f]{64}$/.test(row.txid)) invalid()
      return (await transactions.index('txid_userId').getKey([row.txid, user.userId])) !== undefined
    }
    const store = trx.objectStore(definition.store)
    if (definition.scoped && !store.indexNames.contains('userId')) invalid()
    let cursor = definition.scoped
      ? await store.index('userId').openCursor(user.userId)
      : await store.openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true))
    if (definition.scoped && cursor !== null && after !== undefined && indexedDB.cmp(cursor.primaryKey, after) <= 0) {
      cursor = await cursor.continuePrimaryKey(user.userId, after)
      if (cursor !== null && indexedDB.cmp(cursor.primaryKey, after) === 0) cursor = await cursor.continue()
    }
    const rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>> = []
    let examined = 0,
      payloadBytes = 0,
      last: IdbPackedCursor['after'] | undefined
    while (cursor !== null && examined < maximumExamined && rows.length < maximumRows) {
      options.signal?.throwIfAborted()
      const nativeKey = key(cursor.primaryKey)
      if (await referenced(cursor.value)) {
        const charge = rowCharge(cursor.value)
        if (charge > maximumBytes - payloadBytes) {
          if (rows.length === 0)
            throw new SnapshotResourceLimitError('Packed IDB row exceeds the selected page byte budget')
          break
        }
        rows.push(packed(cursor.value, definition) as unknown as PackedSnapshotRow<WalletSnapshotTables[T]>)
        payloadBytes += charge
      }
      examined++
      last = nativeKey
      cursor = await cursor.continue()
    }
    answer = {
      version: 1,
      consistency: 'transaction',
      rows,
      examined,
      payloadBytes,
      complete: cursor === null,
      ...(last === undefined ? {} : { cursor: { ...source, after: last } })
    }
  } catch (error) {
    failure = { error }
    try {
      trx.abort()
    } catch {
      /* It may already have settled. Await done below. */
    }
  }
  try {
    await trx.done
  } catch (error) {
    if (failure === undefined) failure = { error }
    else if (!packedIdbIsAbortError(error) && error !== failure.error)
      failure = {
        error: new AggregateError([failure.error, error], 'Packed IDB page and transaction cleanup failed', {
          cause: failure.error
        })
      }
  }
  if (failure !== undefined) throw failure.error
  options.signal?.throwIfAborted()
  if (answer === undefined) invalid()
  return answer
}
