import { utf16CodeUnitAt } from '../utility/utf16CodeUnitAt'
import { promiseFromSync } from '../utility/promiseFromSync'
import { unwrap, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'

/** This is a new, explicitly selected database layout. It never upgrades an
 * existing array-valued wallet in place. All persisted payload values are at
 * most 64 KiB; the row and version records contain bounded metadata only. */
export const packedIdbStores = Object.freeze({
  clock: '_wallet_packed_clock',
  contents: '_wallet_packed_contents',
  chunks: '_wallet_packed_chunks',
  versions: '_wallet_packed_versions',
  heads: '_wallet_packed_heads',
  leases: '_wallet_packed_leases',
  jsonStages: '_wallet_packed_json_stages',
  jsonMembers: '_wallet_packed_json_members',
  syncSessions: '_wallet_packed_sync_sessions',
  syncIds: '_wallet_packed_sync_ids'
})
export const packedIdbMarker = '__walletPackedV1'
export const packedIdbChunkBytes = 65536
export const packedIdbMetadataBytes = 65536
export const packedIdbAllocationBytes = 16777216
// These physical stores are selected and verified at runtime. idb's DBSchema
// mode accepts enumerated keys; a string-only index signature yields no known
// stores. Use its dynamic-schema mode and validate persisted values at each
// read boundary below, rather than pretending to enumerate this connection.
export type PackedIdbSchema = unknown
export type PackedIdbDatabase = IDBPDatabase<PackedIdbSchema>
export type PackedIdbTransaction<Mode extends 'readonly' | 'readwrite' = 'readonly' | 'readwrite'> = IDBPTransaction<
  PackedIdbSchema,
  string[],
  Mode
>
export function requirePackedIdbWriter(tx: PackedIdbTransaction): PackedIdbTransaction<'readwrite'> {
  checkPackedIdbTransactionTime(tx)
  if (tx.mode !== 'readwrite') packedIdbInvalid()
  return tx as PackedIdbTransaction<'readwrite'>
}
export interface PackedIdbField {
  content: string
  kind: 'array' | 'typed' | 'utf16'
  bytes: number
  sha256: string
}
export interface PackedIdbRow {
  fields: Record<string, unknown>
  extents: Record<string, PackedIdbField>
}
export interface PackedIdbClock {
  format: 'wallet-packed-idb/v1'
  epoch: string
  revision: number
  /** Monotone DATA for transaction identity/membership changes. Older packed
   * stores start at zero; ordinary payload/status edits do not advance it. */
  transactionMembershipRevision?: number
  bytes: number
  records: number
  maximumBytes: number
  maximumRecords: number
}
const deadlines = new WeakMap<
  object,
  { wall: number; monotonic: number; maximumBytes: number; maximumRecords: number }
>()
/** Transaction lifetime data installed by the actual connection factory. */
export function boundPackedIdbTransaction(
  tx: PackedIdbTransaction,
  maximumBytes: number,
  maximumRecords: number
): void {
  if (deadlines.has(tx)) packedIdbInvalid()
  deadlines.set(tx, { wall: Date.now() + 30000, monotonic: performance.now() + 30000, maximumBytes, maximumRecords })
  const timer = setTimeout(() => {
    try {
      tx.abort()
    } catch {
      /* Already settled. */
    }
  }, 30000)
  void tx.done.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer)
  )
}
export function checkPackedIdbTransactionTime(tx: PackedIdbTransaction): void {
  const deadline = deadlines.get(tx)
  if (deadline === undefined || Date.now() >= deadline.wall || performance.now() >= deadline.monotonic)
    throw new SnapshotResourceLimitError('Packed IndexedDB transaction lifetime reached')
}
export function packedIdbInvalid(): never {
  throw new Error('Packed IndexedDB layout, content or current ownership differs')
}

const dateGetTime = Date.prototype.getTime
const domExceptionName =
  typeof DOMException === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get

/** Read the Date internal slot, including genuine dates cloned in another realm.
 * Labels, prototypes, user getTime methods and Proxy wrappers confer no brand. */
export function packedIdbDateTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    return dateGetTime.call(value)
  } catch {
    return undefined
  }
}

/** Only a genuine DOMException AbortError represents native transaction abort.
 * A foreign-realm error is valid; an ordinary Error with that name is not. */
export function packedIdbIsAbortError(value: unknown): boolean {
  if (domExceptionName === undefined) return false
  try {
    return domExceptionName.call(value) === 'AbortError'
  } catch {
    return false
  }
}
const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag
)?.get
const isArrayBufferView = ArrayBuffer.isView
/** Genuine Uint8Array internal slots, including native structured clones from
 * another realm. Prototype copies, tag impostors and proxies confer no brand. */
export function packedIdbIsUint8Array(value: unknown): value is Uint8Array {
  if (typedArrayName === undefined || !isArrayBufferView(value)) return false
  try {
    return typedArrayName.call(value) === 'Uint8Array'
  } catch {
    return false
  }
}
export function packedIdbPositive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) packedIdbInvalid()
  return value
}
export function packedIdbKey(value: unknown): IDBValidKey {
  if (typeof value === 'number') return packedIdbPositive(value)
  if (typeof value === 'string' && value.length > 0 && value.length <= 4096) return value
  if (Array.isArray(value) && value.length >= 1 && value.length <= 3)
    return value.map(item => {
      const key = packedIdbKey(item)
      if (Array.isArray(key)) packedIdbInvalid()
      return key
    })
  return packedIdbInvalid()
}
export function packedIdbPortableKey(store: string, native: IDBValidKey): IDBValidKey {
  if (store === 'output_tags_map' || store === 'tx_labels_map') {
    if (!Array.isArray(native) || native.length !== 2) packedIdbInvalid()
    return [native[1], native[0]]
  }
  return native
}
/** Replica key order is independent of the BRC-38 portable order. In
 * particular certificate fields are replicated by (fieldName, certificateId),
 * while their native and portable keys are (certificateId, fieldName). */
export function packedIdbReplicaKey(store: string, native: IDBValidKey): IDBValidKey {
  if (store === 'certificate_fields') {
    if (!Array.isArray(native) || native.length !== 2) packedIdbInvalid()
    return [native[1], native[0]]
  }
  return native
}
export function newPackedIdbId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
export function packedIdbMetadataCharge(row: Record<string, unknown>): number {
  let bytes = 128
  if (Object.keys(row).length > 128) packedIdbInvalid()
  for (const [name, value] of Object.entries(row)) {
    if (name.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(name)) packedIdbInvalid()
    bytes += 64 + 2 * name.length
    if (typeof value === 'string') bytes += 2 * value.length
    else if (packedIdbDateTimestamp(value) !== undefined) {
      if (!Number.isFinite(packedIdbDateTimestamp(value))) packedIdbInvalid()
      bytes += 16
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) packedIdbInvalid()
      bytes += 8
    } else if (value !== undefined && value !== null && typeof value !== 'boolean') packedIdbInvalid()
    if (bytes > packedIdbMetadataBytes)
      throw new SnapshotResourceLimitError('Packed IndexedDB row metadata exceeds 64 KiB')
  }
  return bytes
}
export function upgradePackedIdb(db: PackedIdbDatabase, maximumBytes: number, maximumRecords: number): void {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1048576 ||
    maximumBytes > 17179869184 ||
    !Number.isSafeInteger(maximumRecords) ||
    maximumRecords < 1 ||
    maximumRecords > 2000000000
  )
    packedIdbInvalid()
  for (const name of Object.values(packedIdbStores)) if (db.objectStoreNames.contains(name)) packedIdbInvalid()
  const clock = db.createObjectStore(packedIdbStores.clock)
  void clock.add(
    {
      format: 'wallet-packed-idb/v1',
      epoch: newPackedIdbId(),
      revision: 0,
      bytes: 0,
      records: 0,
      maximumBytes,
      maximumRecords
    },
    'clock'
  )
  const contents = db.createObjectStore(packedIdbStores.contents, { keyPath: 'id' })
  contents.createIndex('digest', ['kind', 'sha256', 'bytes'])
  contents.createIndex('retired', 'retired')
  contents.createIndex('expiresAt', 'expiresAt')
  const chunks = db.createObjectStore(packedIdbStores.chunks, { keyPath: ['content', 'index'] })
  chunks.createIndex('content', 'content')
  const versions = db.createObjectStore(packedIdbStores.versions, { keyPath: ['store', 'key', 'revision'] })
  versions.createIndex('obsoleteAt', 'obsoleteAt')
  versions.createIndex('txid', ['store', 'txid'])
  versions.createIndex('proof', ['store', 'provenTxId'])
  versions.createIndex('deletedAt', 'deletedAt')
  // Slot-qualified compound keys preserve multiplicity when two fields in
  // ONE version reference the same content. A content-only multiEntry index
  // would count that record once and silently undercount its actual refs.
  versions.createIndex('references', 'references', { multiEntry: true })
  const heads = db.createObjectStore(packedIdbStores.heads, { keyPath: ['store', 'key'] })
  heads.createIndex('portable', ['store', 'portableKey'])
  heads.createIndex('replica', ['store', 'replicaKey'])
  const leases = db.createObjectStore(packedIdbStores.leases, { keyPath: 'id' })
  leases.createIndex('expiresAt', 'expiresAt')
  leases.createIndex('revision', 'revision')
  const jsonStages = db.createObjectStore(packedIdbStores.jsonStages, { keyPath: 'id' })
  jsonStages.createIndex('expiresAt', 'expiresAt')
  const jsonMembers = db.createObjectStore(packedIdbStores.jsonMembers, { keyPath: ['stage', 'objectOffset', 'key'] })
  jsonMembers.createIndex('stage', 'stage')
  db.createObjectStore(packedIdbStores.syncSessions, { keyPath: ['userId', 'sourceStorageIdentityKey'] })
  const syncIds = db.createObjectStore(packedIdbStores.syncIds, {
    keyPath: ['userId', 'sourceStorageIdentityKey', 'sessionId', 'entity', 'incomingId']
  })
  syncIds.createIndex('scope', ['userId', 'sourceStorageIdentityKey', 'sessionId'])
  syncIds.createIndex('expiresAt', 'expiresAt')
}
const packedSchemaDefinitions: Array<[string, string | string[] | null, Record<string, string | string[]>]> = [
  [packedIdbStores.clock, null, {}],
  [packedIdbStores.contents, 'id', { digest: ['kind', 'sha256', 'bytes'], retired: 'retired', expiresAt: 'expiresAt' }],
  [packedIdbStores.chunks, ['content', 'index'], { content: 'content' }],
  [
    packedIdbStores.versions,
    ['store', 'key', 'revision'],
    {
      obsoleteAt: 'obsoleteAt',
      txid: ['store', 'txid'],
      proof: ['store', 'provenTxId'],
      deletedAt: 'deletedAt',
      references: 'references'
    }
  ],
  [packedIdbStores.heads, ['store', 'key'], { portable: ['store', 'portableKey'], replica: ['store', 'replicaKey'] }],
  [packedIdbStores.leases, 'id', { expiresAt: 'expiresAt', revision: 'revision' }],
  [packedIdbStores.jsonStages, 'id', { expiresAt: 'expiresAt' }],
  [packedIdbStores.jsonMembers, ['stage', 'objectOffset', 'key'], { stage: 'stage' }],
  [packedIdbStores.syncSessions, ['userId', 'sourceStorageIdentityKey'], {}],
  [
    packedIdbStores.syncIds,
    ['userId', 'sourceStorageIdentityKey', 'sessionId', 'entity', 'incomingId'],
    { scope: ['userId', 'sourceStorageIdentityKey', 'sessionId'], expiresAt: 'expiresAt' }
  ]
]
/** Queue only independent bounded metadata requests in the caller's one actual
 * transaction. Drain every request, then preserve the original error order.
 * Results are comparison DATA, never a retained schema or admission verdict. */
export async function readPackedIdbMetadataRequests<const T extends readonly (() => Promise<unknown>)[]>(
  ...reads: T
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  if (reads.length < 1 || reads.length > 5) packedIdbInvalid()
  const results = await Promise.allSettled(reads.map(read => promiseFromSync(read))),
    values: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
    values.push(result.value)
  }
  return values as { [K in keyof T]: Awaited<ReturnType<T[K]>> }
}

/** Fresh schema and budget on the actual transaction. The clock returned here
 * is data belonging to that view, not a cached schema/admission verdict. */
export async function readPackedIdbClock(
  tx: PackedIdbTransaction,
  retirementMetadataJson?: string
): Promise<PackedIdbClock> {
  checkPackedIdbTransactionTime(tx)
  // idb's wrapper is needed for requests, but native schema properties are
  // read directly from this same actual transaction without proxy allocation.
  // Every store/index attribute is still checked on every clock read.
  const schema = unwrap(tx) ?? tx
  for (const [name, path, indexes] of packedSchemaDefinitions) {
    if (!schema.objectStoreNames.contains(name)) packedIdbInvalid()
    const store = schema.objectStore(name)
    if (
      store.autoIncrement ||
      JSON.stringify(store.keyPath) !== JSON.stringify(path) ||
      store.indexNames.length !== Object.keys(indexes).length
    )
      packedIdbInvalid()
    for (const [indexName, indexPath] of Object.entries(indexes)) {
      if (!store.indexNames.contains(indexName)) packedIdbInvalid()
      const index = store.index(indexName)
      if (
        index.unique ||
        index.multiEntry !== (name === packedIdbStores.versions && indexName === 'references') ||
        JSON.stringify(index.keyPath) !== JSON.stringify(indexPath)
      )
        packedIdbInvalid()
    }
  }
  const value = await tx.objectStore(packedIdbStores.clock).get('clock')
  if (
    value?.format !== 'wallet-packed-idb/v1' ||
    typeof value.epoch !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.epoch)
  )
    packedIdbInvalid()
  // A durable terminal marker revokes ordinary reads, stages and writers.
  // The cleanup-only actor can inspect exactly the current marker DATA; it
  // still independently checks actual namespace/profile/original admission.
  if (
    (Object.hasOwn(value, 'restoreRetirementJson') &&
      (retirementMetadataJson === undefined || value.restoreRetirementJson !== retirementMetadataJson)) ||
    (retirementMetadataJson !== undefined && value.restoreRetirementJson !== retirementMetadataJson)
  )
    packedIdbInvalid()
  for (const field of ['revision', 'bytes', 'records', 'maximumBytes', 'maximumRecords'])
    if (typeof value[field] !== 'number' || !Number.isSafeInteger(value[field]) || (value[field] as number) < 0)
      packedIdbInvalid()
  if (
    Object.hasOwn(value, 'transactionMembershipRevision') &&
    (typeof value.transactionMembershipRevision !== 'number' ||
      !Number.isSafeInteger(value.transactionMembershipRevision) ||
      value.transactionMembershipRevision < 0 ||
      value.transactionMembershipRevision > (value.revision as number))
  )
    packedIdbInvalid()
  if (
    (value.bytes as number) > (value.maximumBytes as number) ||
    (value.records as number) > (value.maximumRecords as number) ||
    (value.maximumBytes as number) < 1048576 ||
    (value.maximumBytes as number) > 17179869184 ||
    (value.maximumRecords as number) < 1 ||
    (value.maximumRecords as number) > 2000000000
  )
    packedIdbInvalid()
  const budget = deadlines.get(tx)
  if (
    budget === undefined ||
    value.maximumBytes !== budget.maximumBytes ||
    value.maximumRecords !== budget.maximumRecords
  )
    packedIdbInvalid()
  return value as unknown as PackedIdbClock
}
export async function chargePackedIdb(tx: PackedIdbTransaction, bytes: number, records: number): Promise<void> {
  const writer = requirePackedIdbWriter(tx)
  if (tx.mode !== 'readwrite' || !Number.isSafeInteger(bytes) || !Number.isSafeInteger(records)) packedIdbInvalid()
  const clock = await readPackedIdbClock(tx),
    nextBytes = clock.bytes + bytes,
    nextRecords = clock.records + records
  if (!Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(nextRecords) || nextBytes < 0 || nextRecords < 0)
    packedIdbInvalid()
  if (nextBytes > clock.maximumBytes || nextRecords > clock.maximumRecords)
    throw new SnapshotResourceLimitError('Packed IndexedDB retained logical storage quota reached')
  await writer.objectStore(packedIdbStores.clock).put({ ...clock, bytes: nextBytes, records: nextRecords }, 'clock')
}
function descriptor(value: unknown): PackedIdbField {
  if (value === null || typeof value !== 'object') packedIdbInvalid()
  const v = value as Record<string, unknown>
  if (
    typeof v.content !== 'string' ||
    !/^[0-9a-f]{32}$/.test(v.content) ||
    !['array', 'typed', 'utf16'].includes(v.kind as string) ||
    typeof v.bytes !== 'number' ||
    !Number.isSafeInteger(v.bytes) ||
    v.bytes < 0 ||
    v.bytes > 1000000000 ||
    (v.kind === 'utf16' && v.bytes % 2 !== 0) ||
    typeof v.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(v.sha256)
  )
    packedIdbInvalid()
  return { content: v.content, kind: v.kind as PackedIdbField['kind'], bytes: v.bytes, sha256: v.sha256 }
}
export function unpackPackedIdbMetadata(value: unknown): PackedIdbRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) packedIdbInvalid()
  const input = value as Record<string, unknown>,
    fields = { ...input },
    extents: Record<string, PackedIdbField> = {}
  const markers = fields[packedIdbMarker]
  delete fields[packedIdbMarker]
  if (markers === null || typeof markers !== 'object' || Array.isArray(markers) || Object.keys(markers).length > 128)
    packedIdbInvalid()
  for (const [name, marker] of Object.entries(markers)) {
    if (
      name.length > 128 ||
      ['__proto__', 'constructor', 'prototype', packedIdbMarker].includes(name) ||
      Object.hasOwn(fields, name)
    )
      packedIdbInvalid()
    extents[name] = descriptor(marker)
  }
  if (packedIdbMetadataCharge(fields) + Object.keys(extents).length * 256 > packedIdbMetadataBytes) packedIdbInvalid()
  return { fields, extents }
}
/** Compare complete already-decoded metadata DATA. Each caller must retain
 * its own fresh native view/profile/revision/content checks; equality neither
 * grants ownership nor caches an admission result. */
export function packedIdbRowMetadataEqual(first: Readonly<PackedIdbRow>, second: Readonly<PackedIdbRow>): boolean {
  for (const name of ['fields', 'extents'] as const)
    if (JSON.stringify(Object.keys(first[name]).sort()) !== JSON.stringify(Object.keys(second[name]).sort()))
      return false
  for (const [name, value] of Object.entries(first.fields)) {
    const timestamp = packedIdbDateTimestamp(value)
    if (
      timestamp === undefined
        ? value !== second.fields[name]
        : timestamp !== packedIdbDateTimestamp(second.fields[name])
    )
      return false
  }
  for (const [name, field] of Object.entries(first.extents)) {
    const actual = second.extents[name]
    if (
      field.content !== actual.content ||
      field.kind !== actual.kind ||
      field.bytes !== actual.bytes ||
      field.sha256 !== actual.sha256
    )
      return false
  }
  return true
}

export function packedIdbRowValue(row: PackedIdbRow): Record<string, unknown> {
  if (packedIdbMetadataCharge(row.fields) + Object.keys(row.extents).length * 256 > packedIdbMetadataBytes)
    packedIdbInvalid()
  return { ...row.fields, [packedIdbMarker]: row.extents }
}
/** Reference-position DATA for the new explicit layout's native multiEntry
 * index. These keys never admit content; an audit must freshly compare them
 * with actual row descriptors, native records/refcounts and complete chunks. */
export function packedIdbReferences(row: Pick<PackedIdbRow, 'extents'>): Array<[string, number]> {
  const names = Object.keys(row.extents).sort((a, b) => Number(a > b) - Number(a < b))
  if (names.length > 128) packedIdbInvalid()
  return names.map((name, ordinal) => [descriptor(row.extents[name]).content, ordinal])
}
export function verifyPackedIdbReferences(selected: unknown, row: Pick<PackedIdbRow, 'extents'>): void {
  if (
    !Array.isArray(selected) ||
    selected.length > 128 ||
    JSON.stringify(selected) !== JSON.stringify(packedIdbReferences(row))
  )
    packedIdbInvalid()
}
export function packedIdbVersionCharge(row: PackedIdbRow | undefined): number {
  return row === undefined ? 256 : packedIdbMetadataCharge(row.fields) + 256 + Object.keys(row.extents).length * 384
}
export async function checkPackedIdbContent(
  tx: PackedIdbTransaction,
  field: PackedIdbField
): Promise<Record<string, unknown>> {
  const expected = descriptor(field),
    actual = await tx.objectStore(packedIdbStores.contents).get(field.content)
  if (
    actual?.id !== expected.content ||
    actual.kind !== expected.kind ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256 ||
    actual.state !== 'sealed' ||
    typeof actual.refs !== 'number' ||
    !Number.isSafeInteger(actual.refs) ||
    actual.refs < 0 ||
    actual.retired !== (actual.refs === 0 ? 1 : 0)
  )
    packedIdbInvalid()
  return actual
}
export async function readPackedIdbExtent(
  tx: PackedIdbTransaction,
  field: PackedIdbField,
  offset: number,
  length: number
): Promise<Uint8Array> {
  checkPackedIdbTransactionTime(tx)
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > packedIdbChunkBytes ||
    offset + length > field.bytes
  )
    packedIdbInvalid()
  await checkPackedIdbContent(tx, field)
  const output = new Uint8Array(length)
  for (let used = 0; used < length;) {
    const index = Math.floor((offset + used) / packedIdbChunkBytes),
      start = (offset + used) % packedIdbChunkBytes
    const chunk = await tx.objectStore(packedIdbStores.chunks).get([field.content, index])
    if (
      chunk?.content !== field.content ||
      chunk.index !== index ||
      !packedIdbIsUint8Array(chunk.data) ||
      chunk.data.length !== Math.min(packedIdbChunkBytes, field.bytes - index * packedIdbChunkBytes) ||
      typeof chunk.sha256 !== 'string' ||
      new SHA256().update(chunk.data).digestHex() !== chunk.sha256
    )
      packedIdbInvalid()
    const take = Math.min(length - used, chunk.data.length - start)
    if (take < 1) packedIdbInvalid()
    output.set(chunk.data.subarray(start, start + take), used)
    used += take
  }
  return output
}
export async function hashPackedIdbContent(tx: PackedIdbTransaction, field: PackedIdbField): Promise<void> {
  await checkPackedIdbContent(tx, field)
  if (
    (await tx.objectStore(packedIdbStores.chunks).index('content').count(field.content)) !==
    Math.ceil(field.bytes / packedIdbChunkBytes)
  )
    packedIdbInvalid()
  const hash = new SHA256()
  for (let offset = 0; offset < field.bytes; offset += packedIdbChunkBytes)
    hash.update(await readPackedIdbExtent(tx, field, offset, Math.min(packedIdbChunkBytes, field.bytes - offset)))
  if (hash.digestHex() !== field.sha256) packedIdbInvalid()
}
function sourceChunk(value: string | Uint8Array | number[], offset: number, bytes: number): Uint8Array {
  const chunk = new Uint8Array(bytes)
  if (typeof value === 'string') {
    for (let i = 0; i < bytes; i += 2) {
      const unit = utf16CodeUnitAt(value, (offset + i) / 2)
      chunk[i] = unit & 255
      chunk[i + 1] = unit >>> 8
    }
  } else {
    for (let i = 0; i < bytes; i++) {
      const property = Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, String(offset + i)) : undefined
      if (Array.isArray(value) && (property === undefined || !Object.hasOwn(property, 'value'))) packedIdbInvalid()
      const byte = Array.isArray(value) ? (property!.value as number) : value[offset + i]
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) packedIdbInvalid()
      chunk[i] = byte
    }
  }
  return chunk
}
/** Bounded ordinary DTO writer. Large individual fields use the separately
 * staged extent API; no callback or network operation runs inside this writer. */
export async function packIdbRow(
  tx: PackedIdbTransaction<'readwrite'>,
  input: unknown,
  indexedFields: ReadonlySet<string>
): Promise<PackedIdbRow> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || tx.mode !== 'readwrite') packedIdbInvalid()
  const source = input as Record<string, unknown>
  const prototype: unknown = Object.getPrototypeOf(source)
  if ((prototype !== null && prototype !== Object.prototype) || Object.hasOwn(source, packedIdbMarker))
    packedIdbInvalid()
  const pending: Array<{
    name: string
    value: string | Uint8Array | number[]
    bytes: number
    kind: PackedIdbField['kind']
  }> = []
  const fields: Record<string, unknown> = {},
    extents: Record<string, PackedIdbField> = {}
  let allocation = 262144
  let fieldCount = 0
  for (const name in source) {
    if (!Object.hasOwn(source, name)) continue
    if (++fieldCount > 128) packedIdbInvalid()
    const property = Object.getOwnPropertyDescriptor(source, name)
    if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) packedIdbInvalid()
    const value: unknown = property.value
    if (name.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(name)) packedIdbInvalid()
    if (
      value instanceof Uint8Array ||
      Array.isArray(value) ||
      (typeof value === 'string' && value.length > 4096 && !indexedFields.has(name))
    ) {
      const bytes = typeof value === 'string' ? 2 * value.length : value.length
      allocation += (typeof value === 'string' ? 4 : 16) * bytes + 512
      if (allocation > packedIdbAllocationBytes)
        throw new SnapshotResourceLimitError('Packed IndexedDB ordinary DTO requires staged extents')
      if (indexedFields.has(name)) packedIdbInvalid()
      pending.push({
        name,
        value,
        bytes,
        kind: typeof value === 'string' ? 'utf16' : value instanceof Uint8Array ? 'typed' : 'array'
      })
    } else {
      const timestamp = packedIdbDateTimestamp(value)
      fields[name] = timestamp === undefined ? value : new Date(timestamp)
    }
  }
  packedIdbMetadataCharge(fields)
  for (const item of pending) {
    const hash = new SHA256()
    for (let offset = 0; offset < item.bytes; offset += packedIdbChunkBytes) {
      checkPackedIdbTransactionTime(tx)
      hash.update(sourceChunk(item.value, offset, Math.min(packedIdbChunkBytes, item.bytes - offset)))
    }
    const sha256 = hash.digestHex(),
      contents = tx.objectStore(packedIdbStores.contents)
    const reusable = await contents.index('digest').openCursor([item.kind, sha256, item.bytes])
    let field: PackedIdbField
    if (reusable !== null && reusable.value.state === 'sealed' && reusable.value.expiresAt === undefined) {
      field = descriptor({ content: reusable.value.id, kind: item.kind, bytes: item.bytes, sha256 })
      await hashPackedIdbContent(tx, field)
    } else {
      field = { content: newPackedIdbId(), kind: item.kind, bytes: item.bytes, sha256 }
      await chargePackedIdb(tx, item.bytes + 512, 1)
      await contents.add({
        id: field.content,
        kind: field.kind,
        bytes: field.bytes,
        sha256,
        state: 'pending',
        refs: 0,
        retired: 1
      })
      const actualHash = new SHA256()
      for (let offset = 0; offset < item.bytes; offset += packedIdbChunkBytes) {
        const data = sourceChunk(item.value, offset, Math.min(packedIdbChunkBytes, item.bytes - offset))
        actualHash.update(data)
        await chargePackedIdb(tx, 256, 1)
        await tx.objectStore(packedIdbStores.chunks).add({
          content: field.content,
          index: offset / packedIdbChunkBytes,
          data,
          sha256: new SHA256().update(data).digestHex()
        })
      }
      if (actualHash.digestHex() !== sha256) packedIdbInvalid()
      await contents.put({
        id: field.content,
        kind: field.kind,
        bytes: field.bytes,
        sha256,
        state: 'sealed',
        refs: 0,
        retired: 1
      })
    }
    extents[item.name] = field
  }
  return { fields, extents }
}
export function packedIdbRowAllocation(row: PackedIdbRow, arrays: boolean): number {
  let charge = packedIdbMetadataCharge(row.fields) + 512
  for (const field of Object.values(row.extents)) {
    const actual = descriptor(field)
    charge += (actual.kind === 'utf16' ? 4 : arrays && actual.kind === 'array' ? 16 : 2) * actual.bytes + 512
  }
  if (!Number.isSafeInteger(charge)) packedIdbInvalid()
  return charge
}
export async function hydratePackedIdbRow(
  tx: PackedIdbTransaction,
  row: PackedIdbRow,
  arrays: boolean,
  maximumBytes = packedIdbAllocationBytes
): Promise<Record<string, unknown>> {
  if (packedIdbRowAllocation(row, arrays) > maximumBytes)
    throw new SnapshotResourceLimitError('Packed IndexedDB materialized row exceeds its byte budget')
  const result = { ...row.fields }
  for (const [name, field] of Object.entries(row.extents)) {
    const hash = new SHA256()
    if (
      (await tx.objectStore(packedIdbStores.chunks).index('content').count(field.content)) !==
      Math.ceil(field.bytes / packedIdbChunkBytes)
    )
      packedIdbInvalid()
    if (field.kind === 'utf16') {
      const pieces: string[] = []
      for (let offset = 0; offset < field.bytes; offset += packedIdbChunkBytes) {
        const data = await readPackedIdbExtent(tx, field, offset, Math.min(packedIdbChunkBytes, field.bytes - offset))
        hash.update(data)
        let text = ''
        for (let i = 0; i < data.length; i += 2) text += String.fromCodePoint(data[i] | (data[i + 1] << 8))
        pieces.push(text)
      }
      result[name] = pieces.join('')
    } else {
      const data = new Uint8Array(field.bytes)
      for (let offset = 0; offset < field.bytes; offset += packedIdbChunkBytes) {
        const chunk = await readPackedIdbExtent(tx, field, offset, Math.min(packedIdbChunkBytes, field.bytes - offset))
        hash.update(chunk)
        data.set(chunk, offset)
      }
      result[name] = arrays && field.kind === 'array' ? Array.from(data) : data
    }
    if (hash.digestHex() !== field.sha256) packedIdbInvalid()
  }
  return result
}
export async function retainPackedIdbFields(
  tx: PackedIdbTransaction<'readwrite'>,
  row: PackedIdbRow,
  delta: 1 | -1
): Promise<void> {
  requirePackedIdbWriter(tx)
  for (const field of Object.values(row.extents)) {
    const actual = await checkPackedIdbContent(tx, field),
      refs = (actual.refs as number) + delta
    if (!Number.isSafeInteger(refs) || refs < 0) packedIdbInvalid()
    await tx.objectStore(packedIdbStores.contents).put({ ...actual, refs, retired: refs === 0 ? 1 : 0 })
  }
}
