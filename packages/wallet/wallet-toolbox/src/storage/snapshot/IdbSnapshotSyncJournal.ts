import { promiseFromSync } from '../../utility/promiseFromSync'
import {
  parseSnapshotSyncContentRevision,
  snapshotSyncContentConfirms,
  snapshotSyncContentRevisionData,
  type SnapshotSyncContentRevision
} from './SnapshotSyncContentRevision'
import { packedIdbSnapshotContentRevision } from './PackedIdbSnapshotContentRevision'
import type { SnapshotSyncContentReceipt } from './SnapshotSync'
import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection, type PackedIdbConnection } from '../idbPackedConnection'
import {
  chargePackedIdb,
  packedIdbDateTimestamp,
  packedIdbIsAbortError,
  newPackedIdbId,
  packedIdbMetadataCharge,
  packedIdbPositive,
  packedIdbStores,
  packedIdbMarker,
  requirePackedIdbWriter,
  readPackedIdbClock,
  readPackedIdbMetadataRequests,
  readPackedIdbExtent,
  packedIdbKey,
  unpackPackedIdbMetadata,
  type PackedIdbClock,
  type PackedIdbTransaction
} from '../idbPackedFields'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { copySnapshotCursor, sameSnapshotArchivePosition } from './SnapshotCursor'
import {
  collectSnapshotSyncReferences,
  collectSnapshotSyncFieldReferences,
  type SnapshotSyncPageReferences
} from './SnapshotSyncRowData'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncCommit,
  type SnapshotSyncSource,
  type SnapshotSyncTable
} from './SnapshotSync'
import type { TableSettings, TableUser } from '../schema/tables'
import type { WalletSnapshotCursor } from './WalletReadSnapshot'
import { Brc38OwnedImportReads } from '../portable/Brc38OwnedImportReads'
import {
  capturePackedIdbMergeLookupInputs,
  findPackedIdbMergeMetadata,
  type PackedIdbMergeIdentity
} from '../idbPackedMergeLookup'
import { readPackedIdbCurrentMetadata, type PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { requirePackedIdbSnapshotInTransaction } from '../idbPackedSnapshot'
import { PackedIdbCurrentStructuredRead, type PackedIdbCurrentStructuredLimits } from './PackedIdbCurrentStructuredRead'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import { packedIdbQuarantineReclaim, packedIdbUnresolvedReclaim } from '../idbPackedReclaimMetadata'
import { isSyncChain } from '../sync/syncFailure'

interface IdbContentReceiptData {
  readonly version: 1
  readonly source: Readonly<SnapshotSyncContentRevision>
  readonly destination?: Readonly<SnapshotSyncContentRevision>
}
function contentReceiptData(input: unknown): Readonly<IdbContentReceiptData> {
  if (input === null || typeof input !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(input)))
    invalid()
  const keys = Reflect.ownKeys(input)
  if (
    keys.length < 2 ||
    keys.length > 3 ||
    keys.some(key => !['version', 'source', 'destination'].includes(String(key)))
  )
    invalid()
  const value = (key: string) => {
    const d = Object.getOwnPropertyDescriptor(input, key)
    if (d === undefined || !Object.hasOwn(d, 'value') || !d.enumerable) invalid()
    return d.value
  }
  if (value('version') !== 1) invalid()
  return Object.freeze({
    version: 1,
    source: snapshotSyncContentRevisionData(value('source')),
    ...(Object.hasOwn(input, 'destination')
      ? { destination: snapshotSyncContentRevisionData(value('destination')) }
      : {})
  })
}
function contentReceiptJson(input: unknown): string {
  return JSON.stringify(contentReceiptData(input))
}
function storedContentReceipt(input: unknown): Readonly<IdbContentReceiptData> {
  if (typeof input !== 'string' || input.length > 2048) invalid()
  const data = contentReceiptData(JSON.parse(input))
  if (JSON.stringify(data) !== input) invalid()
  return data
}
interface Session {
  format: 'wallet-packed-sync/v1'
  userId: number
  identityKey: string
  sourceStorageIdentityKey: string
  destinationStorageIdentityKey: string
  sessionId: string
  snapshotId: string
  sourceUserId: number
  sourceUserCreatedAt: string
  sourceUserUpdatedAt: string
  sourceActiveStorage: string | null
  chain: TableSettings['chain']
  epoch: string
  userRevision: number
  activeStorage: string | null
  expiresAt: number
  sequence: number
  tableIndex: number
  cursor: string | null
  content?: string
}
interface Header {
  readonly clock: PackedIdbClock
  readonly user: TableUser
  readonly settings: Record<string, unknown>
  readonly userRevision: number
}
const localEntities = Object.freeze({
  provenTx: ['proven_txs', 'provenTxId'],
  outputBasket: ['output_baskets', 'basketId'],
  outputTag: ['output_tags', 'outputTagId'],
  txLabel: ['tx_labels', 'txLabelId'],
  transaction: ['transactions', 'transactionId'],
  output: ['outputs', 'outputId'],
  certificate: ['certificates', 'certificateId'],
  commission: ['commissions', 'commissionId'],
  provenTxReq: ['proven_tx_reqs', 'provenTxReqId']
} as const)
export interface IdbSnapshotSyncFieldLoan {
  readonly bytes: Uint8Array
  /** Release only after consumption; clears the actual transferred window. */
  close(): void
}
interface CurrentExtent {
  readonly store: string
  readonly key: IDBValidKey
  readonly revision: number
  readonly field: string
  readonly content: string
  readonly kind: 'array' | 'typed' | 'utf16'
  readonly bytes: number
  readonly sha256: string
  readonly offset: number
  readonly length: number
}
function currentExtent(
  input: PackedIdbCurrentMetadata,
  field: string,
  offset: number,
  length: number
): Readonly<CurrentExtent> {
  if (
    typeof field !== 'string' ||
    field.length < 1 ||
    field.length > 128 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 65536
  )
    invalid()
  const value = (record: object, name: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(record, name)
      if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) invalid()
      return property.value
    },
    store = value(input, 'store'),
    key = packedIdbKey(value(input, 'key')),
    revision = value(input, 'revision'),
    extents = value(input, 'extents')
  if (
    typeof store !== 'string' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    extents === null ||
    typeof extents !== 'object' ||
    Array.isArray(extents)
  )
    invalid()
  const selected = value(extents, field)
  if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) invalid()
  const content = value(selected, 'content'),
    kind = value(selected, 'kind'),
    bytes = value(selected, 'bytes'),
    sha256 = value(selected, 'sha256')
  if (
    typeof content !== 'string' ||
    !/^[0-9a-f]{32}$/.test(content) ||
    !['array', 'typed', 'utf16'].includes(kind as string) ||
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > 1000000000 ||
    offset + length > bytes ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    invalid()
  return Object.freeze({
    store,
    key: Array.isArray(key) ? (Object.freeze([...key]) as unknown as IDBValidKey) : key,
    revision,
    field,
    content,
    kind: kind as CurrentExtent['kind'],
    bytes,
    sha256,
    offset,
    length
  })
}
export interface IdbSnapshotSyncWriter {
  readonly transaction: PackedIdbTransaction<'readwrite'>
  /** Actual native wallet row revision at entry to this effect (DATA only). */
  readonly walletRevision: number
  readonly transactionMembershipRevision: number
  readonly user: Readonly<TableUser>
  readonly sourceUser: Readonly<TableUser>
  readonly sourceUserId: number
  /** Fresh current BRC-177 state and quarantine in this same actual writer. */
  unresolvedReclaim(txid: string, signal?: AbortSignal): Promise<boolean>
  quarantineReclaim(txid: string, signal?: AbortSignal): Promise<void>
  /** Load only this detached page's IDs and parent references. */
  loadMappings(table: SnapshotSyncTable, chunk: SyncChunk): Promise<{ map: SyncMap; persist(): Promise<void> }>
  /** Scalar metadata only. Structured notification mappings use their own bounded reader. */
  loadFieldMappings(
    table: SnapshotSyncTable,
    rows: readonly Readonly<Record<string, unknown>>[]
  ): Promise<{ map: SyncMap; persist(): Promise<void> }>
  /** Bounded current native field DATA, with freshly re-read row/extent fences.
   * Only small scalar metadata belongs in a writer; proof/large-field reads
   * must use independent drained read phases before write admission. */
  readCurrentExtent(
    identity: PackedIdbMergeIdentity,
    map: SyncMap,
    current: PackedIdbCurrentMetadata,
    field: string,
    offset: number,
    length: number,
    working: Brc38WorkingAllocation,
    signal?: AbortSignal
  ): Promise<IdbSnapshotSyncFieldLoan>
  /** Current indexed metadata only; no source or payload I/O in the writer. */
  findCurrentRow(
    identity: PackedIdbMergeIdentity,
    map: SyncMap,
    maximumMetadataBytes: number,
    signal?: AbortSignal
  ): Promise<Readonly<PackedIdbCurrentMetadata> | undefined>
}
/** Read-only preparation within this actual current operational session. All
 * returned metadata/maps are DATA; the final writer must recheck them. No
 * transaction or read facade may be used after this callback drains. */
export interface IdbSnapshotSyncRead {
  readonly transaction: PackedIdbTransaction<'readonly'>
  readonly walletRevision: number
  readonly transactionMembershipRevision: number
  readonly user: Readonly<TableUser>
  readonly sourceUserId: number
  readonly expiresAt: number
  loadMappings(table: SnapshotSyncTable, chunk: SyncChunk): Promise<SyncMap>
  loadFieldMappings(table: SnapshotSyncTable, rows: readonly Readonly<Record<string, unknown>>[]): Promise<SyncMap>
  /** One original <=64KiB window in this actual native read phase. Returning
   * the loan keeps its original allocation charged until consumed/cleared. */
  readCurrentExtent(
    identity: PackedIdbMergeIdentity,
    map: SyncMap,
    current: PackedIdbCurrentMetadata,
    field: string,
    offset: number,
    length: number,
    working: Brc38WorkingAllocation,
    signal?: AbortSignal
  ): Promise<IdbSnapshotSyncFieldLoan>
  findCurrentRow(
    identity: PackedIdbMergeIdentity,
    map: SyncMap,
    maximumMetadataBytes: number,
    signal?: AbortSignal
  ): Promise<Readonly<PackedIdbCurrentMetadata> | undefined>
}
function invalid(): never {
  throw new Error('Packed snapshot sync session, profile, primary or checkpoint changed')
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) invalid()
  return value
}
function primary(value: unknown): string {
  // Preserve the legacy empty-string and undefined/null distinctions.
  if (typeof value !== 'string' || value.length > 256) invalid()
  return value
}
function time(value: unknown): string {
  const timestamp = packedIdbDateTimestamp(value)
  if (timestamp === undefined || !Number.isFinite(timestamp)) invalid()
  return new Date(timestamp).toISOString()
}
function live(expiresAt: number): void {
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt)
    throw new SnapshotResourceLimitError('Packed snapshot source original admission expired')
}
function checkpoint(row: Session): SnapshotSyncCheckpoint {
  return {
    version: 1,
    sessionId: row.sessionId,
    identityKey: row.identityKey,
    sourceStorageIdentityKey: row.sourceStorageIdentityKey,
    destinationStorageIdentityKey: row.destinationStorageIdentityKey,
    snapshotId: row.snapshotId,
    sequence: row.sequence,
    tableIndex: row.tableIndex,
    cursor: row.cursor === null ? undefined : (JSON.parse(row.cursor) as WalletSnapshotCursor),
    done: row.tableIndex === snapshotSyncTables.length
  }
}
export function captureIdbSnapshotSyncCheckpoint(value: SnapshotSyncCheckpoint): SnapshotSyncCheckpoint {
  if (
    value.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(value.sessionId) ||
    !/^[0-9a-f]{64}$/.test(value.snapshotId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Number.isSafeInteger(value.tableIndex) ||
    value.tableIndex < 0 ||
    value.tableIndex > snapshotSyncTables.length ||
    value.done !== (value.tableIndex === snapshotSyncTables.length)
  )
    invalid()
  text(value.identityKey, 130)
  text(value.sourceStorageIdentityKey)
  text(value.destinationStorageIdentityKey)
  if (value.cursor !== undefined) {
    const cursor = value.cursor
    if (
      cursor.version !== 1 ||
      cursor.snapshotId !== value.snapshotId ||
      cursor.table !== snapshotSyncTables[value.tableIndex] ||
      !Array.isArray(cursor.after) ||
      cursor.after.length < 1 ||
      cursor.after.length > 3 ||
      cursor.after.some(item =>
        typeof item === 'number'
          ? !Number.isSafeInteger(item) || item < 1
          : typeof item !== 'string' || item.length < 1 || item.length > 4096
      )
    )
      invalid()
  }
  return {
    version: 1,
    sessionId: value.sessionId,
    snapshotId: value.snapshotId,
    identityKey: value.identityKey,
    sourceStorageIdentityKey: value.sourceStorageIdentityKey,
    destinationStorageIdentityKey: value.destinationStorageIdentityKey,
    sequence: value.sequence,
    tableIndex: value.tableIndex,
    done: value.done,
    cursor: copySnapshotCursor(value.cursor)
  }
}
function same(a: SnapshotSyncCheckpoint, b: SnapshotSyncCheckpoint): boolean {
  return (
    a.version === b.version &&
    a.sessionId === b.sessionId &&
    a.identityKey === b.identityKey &&
    a.sourceStorageIdentityKey === b.sourceStorageIdentityKey &&
    a.destinationStorageIdentityKey === b.destinationStorageIdentityKey &&
    a.snapshotId === b.snapshotId &&
    a.sequence === b.sequence &&
    a.tableIndex === b.tableIndex &&
    a.done === b.done &&
    a.cursor?.version === b.cursor?.version &&
    a.cursor?.snapshotId === b.cursor?.snapshotId &&
    a.cursor?.table === b.cursor?.table &&
    JSON.stringify(a.cursor?.after) === JSON.stringify(b.cursor?.after) &&
    sameSnapshotArchivePosition(a.cursor?.archivePosition, b.cursor?.archivePosition)
  )
}
function stored(value: unknown): Session {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Session
  packedIdbMetadataCharge(row as unknown as Record<string, unknown>)
  if (
    row.format !== 'wallet-packed-sync/v1' ||
    !isSyncChain(row.chain) ||
    !/^[0-9a-f]{64}$/.test(row.snapshotId) ||
    !/^[0-9a-f]{64}$/.test(row.sessionId) ||
    !/^[0-9a-f]{32}$/.test(row.epoch) ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 0 ||
    !Number.isSafeInteger(row.tableIndex) ||
    row.tableIndex < 0 ||
    row.tableIndex > snapshotSyncTables.length ||
    !Number.isSafeInteger(row.userRevision) ||
    row.userRevision < 1 ||
    !Number.isSafeInteger(row.expiresAt) ||
    (row.cursor !== null && (typeof row.cursor !== 'string' || row.cursor.length > 8192)) ||
    (row.tableIndex === snapshotSyncTables.length && row.cursor !== null)
  )
    invalid()
  packedIdbPositive(row.userId)
  packedIdbPositive(row.sourceUserId)
  text(row.identityKey, 130)
  text(row.sourceStorageIdentityKey)
  text(row.destinationStorageIdentityKey)
  for (const active of [row.activeStorage, row.sourceActiveStorage]) if (active !== null) primary(active)
  for (const date of [row.sourceUserCreatedAt, row.sourceUserUpdatedAt])
    if (typeof date !== 'string' || date.length > 32 || new Date(date).toISOString() !== date) invalid()
  if (row.cursor !== null) {
    const cursor = checkpoint(row).cursor!
    if (
      cursor.version !== 1 ||
      cursor.snapshotId !== row.snapshotId ||
      cursor.table !== snapshotSyncTables[row.tableIndex] ||
      !Array.isArray(cursor.after) ||
      cursor.after.length < 1 ||
      cursor.after.length > 3 ||
      cursor.after.some(value =>
        typeof value === 'number'
          ? !Number.isSafeInteger(value) || value < 1
          : typeof value !== 'string' || value.length < 1 || value.length > 4096
      )
    )
      invalid()
    copySnapshotCursor(cursor)
  }
  if (Object.hasOwn(row, 'content')) {
    const content = storedContentReceipt(row.content)
    if (content.destination !== undefined && row.tableIndex !== snapshotSyncTables.length) invalid()
  }
  return row
}

/** Operational journal for occupied packed wallets, independent of the isolated
 * restore journal. Hashes, rows, cursors and mappings are DATA. Every operation
 * freshly checks the actual connection/schema/settings/user/MVCC head. Only
 * prepared effects run inside its short, same-owner writer; their atomic
 * checkpoint is returned AFTER the native transaction commits. */
export class IdbSnapshotSyncJournal {
  readonly #storage: StorageIdb
  readonly #owner: PackedIdbConnection
  readonly #name: string
  private constructor(storage: StorageIdb, owner: PackedIdbConnection) {
    this.#storage = storage
    this.#owner = owner
    this.#name = storage.dbName
  }
  static async open(storage: StorageIdb): Promise<IdbSnapshotSyncJournal> {
    const db = await storage.verifyDB(),
      owner = getPackedIdbConnection(db)
    if (owner === undefined || !owner.isOpen || storage.dbName !== db.name) invalid()
    const journal = new IdbSnapshotSyncJournal(storage, owner)
    await journal.#run('readonly', () => promiseFromSync(() => undefined))
    return journal
  }
  #check(): void {
    if (
      !this.#owner.isOpen ||
      this.#storage.dbName !== this.#name ||
      this.#storage.db !== this.#owner.database ||
      getPackedIdbConnection(this.#owner.database) !== this.#owner
    )
      invalid()
  }
  /** Concrete factory/connection identity only, never session/profile/source
   * admission. Preparation stages must belong to this same actual provider. */
  requireStorage(storage: StorageIdb): void {
    this.#check()
    if (storage !== this.#storage) invalid()
  }
  async #run<T, Mode extends 'readonly' | 'readwrite'>(
    mode: Mode,
    action: (wallet: PackedIdbTransaction<Mode>, raw: PackedIdbTransaction<Mode>) => Promise<T>
  ): Promise<T> {
    this.#check()
    const { wallet, journal } = this.#owner.operationalTransaction(['settings', ...this.#storage.allStores], mode)
    try {
      // This actual-owner gate already reads the complete fresh clock/schema
      // before checking the operational restore phase in this transaction.
      await this.#owner.checkOperationalTransaction(journal)
      const result = await action(wallet, journal)
      await this.#owner.sealOperationalEffects(wallet)
      await journal.done
      this.#check()
      return result
    } catch (cause) {
      try {
        journal.abort()
      } catch {
        /* Already settled. */
      }
      try {
        await journal.done
      } catch (error_) {
        if (error_ !== cause && !packedIdbIsAbortError(error_))
          throw new AggregateError([cause, error_], 'Packed snapshot writer and physical drainage failed', { cause })
      }
      throw cause
    }
  }
  async #header(raw: PackedIdbTransaction, identityKey: string): Promise<Header> {
    text(identityKey, 130)
    const [clock, settingsRows, users] = await readPackedIdbMetadataRequests(
      () => readPackedIdbClock(raw),
      () => raw.objectStore('settings').getAll(undefined, 2),
      () => raw.objectStore('users').index('identityKey').getAll(identityKey, 2)
    )
    if (settingsRows.length !== 1 || users.length !== 1) invalid()
    // Header fields must be inline metadata. Native getAll is bounded to two
    // rows and avoids hydrating data which this same header would refuse.
    // Initial settings predate packing; preserve that versionchange form.
    const inline = (value: Record<string, unknown>, initialSettings = false): Record<string, unknown> => {
      if (initialSettings && !Object.hasOwn(value, packedIdbMarker)) {
        packedIdbMetadataCharge(value)
        return { ...value }
      }
      const row = unpackPackedIdbMetadata(value)
      if (Object.keys(row.extents).length !== 0) invalid()
      return row.fields
    }
    const settings = inline(settingsRows[0], true),
      user = inline(users[0]) as unknown as TableUser
    if (settings.chain !== this.#storage.chain || user.identityKey !== identityKey) invalid()
    text(settings.storageIdentityKey)
    packedIdbPositive(user.userId)
    time(user.created_at)
    time(user.updated_at)
    if (user.activeStorage != null) primary(user.activeStorage)
    const head = await raw.objectStore(packedIdbStores.heads).get(['users', user.userId])
    if (
      head?.store !== 'users' ||
      head.key !== user.userId ||
      !Number.isSafeInteger(head.revision) ||
      (head.revision as number) < 1 ||
      (head.revision as number) > clock.revision ||
      head.portableKey !== user.userId ||
      head.replicaKey !== user.userId
    )
      invalid()
    const version = await raw.objectStore(packedIdbStores.versions).get(['users', user.userId, head.revision as number])
    if (
      version?.deleted !== false ||
      version.obsoleteAt !== undefined ||
      version.revision !== head.revision ||
      version.store !== 'users' ||
      version.key !== user.userId
    )
      invalid()
    const metadata = unpackPackedIdbMetadata(version.value)
    if (Object.keys(metadata.extents).length !== 0 || Object.keys(metadata.fields).length !== Object.keys(user).length)
      invalid()
    for (const [name, value] of Object.entries(metadata.fields)) {
      const actual: unknown = Reflect.get(user, name)
      const timestamp = packedIdbDateTimestamp(value)
      if (timestamp === undefined ? value !== actual : timestamp !== packedIdbDateTimestamp(actual)) invalid()
    }
    return { clock, user, settings, userRevision: head.revision as number }
  }
  #binding(row: Session, header: Header, observeOnly = false): void {
    if (
      row.userId !== header.user.userId ||
      row.identityKey !== header.user.identityKey ||
      row.epoch !== header.clock.epoch ||
      (!observeOnly &&
        (row.userRevision !== header.userRevision || row.activeStorage !== (header.user.activeStorage ?? null))) ||
      row.chain !== header.settings.chain ||
      row.destinationStorageIdentityKey !== header.settings.storageIdentityKey
    )
      invalid()
  }
  #contentRevision(header: Header) {
    return packedIdbSnapshotContentRevision({
      epoch: header.clock.epoch,
      revision: header.clock.revision,
      userRevision: header.userRevision,
      databaseName: this.#owner.database.name,
      databaseVersion: this.#owner.database.version,
      sourceStorage: header.settings as unknown as TableSettings,
      user: header.user
    })
  }

  async #contentHeader(raw: PackedIdbTransaction, identityKey: string): Promise<Header | undefined> {
    text(identityKey, 130)
    // A first backup has no destination user yet. Comparison does not create
    // that user; an existing user's malformed header still refuses normally.
    if ((await raw.objectStore('users').index('identityKey').getKey(identityKey)) === undefined) return undefined
    return await this.#header(raw, identityKey)
  }

  async previousContentReceipt(
    identityKey: string,
    sourceIdentity: string
  ): Promise<SnapshotSyncContentReceipt | undefined> {
    text(sourceIdentity)
    return await this.#run('readonly', async (_wallet, raw) => {
      const header = await this.#contentHeader(raw, identityKey)
      if (header === undefined) return undefined
      const value = await raw.objectStore(packedIdbStores.syncSessions).get([header.user.userId, sourceIdentity])
      if (value === undefined) return undefined
      const row = stored(value)
      this.#binding(row, header, true)
      const content = row.content === undefined ? undefined : storedContentReceipt(row.content)
      if (row.sourceStorageIdentityKey !== sourceIdentity) invalid()
      if (
        row.tableIndex !== snapshotSyncTables.length ||
        content?.destination === undefined ||
        row.userRevision !== header.userRevision ||
        row.activeStorage !== (header.user.activeStorage ?? null)
      )
        return undefined
      return { checkpoint: checkpoint(row), source: content.source }
    })
  }

  async confirmContentReceipt(
    identityKey: string,
    sourceIdentity: string,
    input: SnapshotSyncContentRevision
  ): Promise<SnapshotSyncCheckpoint | undefined> {
    const source = parseSnapshotSyncContentRevision(input)
    text(sourceIdentity)
    return await this.#run('readwrite', async (_wallet, raw) => {
      const header = await this.#contentHeader(raw, identityKey)
      if (header === undefined) return undefined
      const store = raw.objectStore(packedIdbStores.syncSessions),
        value = await store.get([header.user.userId, sourceIdentity])
      if (value === undefined) return undefined
      const row = stored(value)
      this.#binding(row, header, true)
      const content = row.content === undefined ? undefined : storedContentReceipt(row.content)
      if (row.sourceStorageIdentityKey !== sourceIdentity) invalid()
      if (
        row.tableIndex !== snapshotSyncTables.length ||
        content?.destination === undefined ||
        row.userRevision !== header.userRevision ||
        row.activeStorage !== (header.user.activeStorage ?? null) ||
        !snapshotSyncContentConfirms(content.source, source)
      )
        return undefined
      const destination = this.#contentRevision(header)
      if (!snapshotSyncContentConfirms(content.destination, destination)) return undefined
      row.content = contentReceiptJson({ version: 1, source, destination })
      stored(row)
      await store.put(row as unknown as Record<string, unknown>)
      return checkpoint(row)
    })
  }

  async begin(
    input: SnapshotSyncSource,
    activeStorage: string | undefined,
    contentInput?: SnapshotSyncContentRevision
  ): Promise<SnapshotSyncCheckpoint> {
    const content = contentInput === undefined ? undefined : contentReceiptJson({ version: 1, source: contentInput })
    if (
      input.version !== 1 ||
      !isSyncChain(input.sourceStorage.chain) ||
      !/^[0-9a-f]{64}$/.test(input.snapshotId) ||
      !/^(02|03)[0-9a-f]{64}$/i.test(input.user.identityKey) ||
      input.expiresAt > Date.now() + 3600000
    )
      invalid()
    live(input.expiresAt)
    packedIdbPositive(input.user.userId)
    const source = {
      snapshotId: input.snapshotId,
      identityKey: text(input.user.identityKey, 130),
      sourceStorageIdentityKey: text(input.sourceStorage.storageIdentityKey),
      chain: input.sourceStorage.chain,
      sourceUserId: input.user.userId,
      sourceUserCreatedAt: time(input.user.created_at),
      sourceUserUpdatedAt: time(input.user.updated_at),
      sourceActiveStorage: activeStorage === undefined ? null : primary(activeStorage),
      expiresAt: input.expiresAt
    }
    // Initial creation has no source-selected primary; first-page entity policy
    // remains responsible for backup metadata, inside the journal writer.
    await this.#run('readonly', async wallet => {
      const settings = await wallet.objectStore('settings').getAll(undefined, 2)
      if (
        settings.length !== 1 ||
        source.chain !== settings[0].chain ||
        source.chain !== this.#storage.chain ||
        source.sourceStorageIdentityKey === settings[0].storageIdentityKey
      )
        invalid()
    })
    await this.#storage.findOrInsertUser(source.identityKey)
    return await this.#run('readwrite', async (_wallet, raw) => {
      live(source.expiresAt)
      const header = await this.#header(raw, source.identityKey),
        store = raw.objectStore(packedIdbStores.syncSessions),
        scope = [header.user.userId, source.sourceStorageIdentityKey],
        previous = await store.get(scope)
      if (
        source.chain !== header.settings.chain ||
        source.sourceStorageIdentityKey === header.settings.storageIdentityKey
      )
        invalid()
      if (previous !== undefined) {
        const row = stored(previous)
        if (row.snapshotId === source.snapshotId) {
          this.#binding(row, header)
          live(row.expiresAt)
          for (const [key, value] of Object.entries(source)) if (Reflect.get(row, key) !== value) invalid()
          if (content !== undefined) {
            if (row.content === undefined) {
              if (row.tableIndex !== 0 || row.sequence !== 0) invalid()
              row.content = content
              stored(row)
              await store.put(row as unknown as Record<string, unknown>)
            } else if (
              JSON.stringify(storedContentReceipt(row.content).source) !==
              JSON.stringify(storedContentReceipt(content).source)
            )
              invalid()
          }
          return checkpoint(row)
        }
      } else await chargePackedIdb(raw, 32768, 1)
      const chain = this.#storage.chain
      if (!isSyncChain(chain)) invalid()
      const row: Session = {
        ...source,
        format: 'wallet-packed-sync/v1',
        userId: header.user.userId,
        destinationStorageIdentityKey: text(header.settings.storageIdentityKey),
        sessionId: newPackedIdbId() + newPackedIdbId(),
        chain,
        epoch: header.clock.epoch,
        userRevision: header.userRevision,
        activeStorage: header.user.activeStorage ?? null,
        sequence: 0,
        tableIndex: 0,
        cursor: null,
        ...(content === undefined ? {} : { content })
      }
      stored(row)
      await store.put(row as unknown as Record<string, unknown>)
      return checkpoint(row)
    })
  }
  async checkpoint(identityKey: string, sourceIdentity: string): Promise<SnapshotSyncCheckpoint | undefined> {
    text(sourceIdentity)
    return await this.#run('readonly', async (_wallet, raw) => {
      const header = await this.#header(raw, identityKey),
        value = await raw.objectStore(packedIdbStores.syncSessions).get([header.user.userId, sourceIdentity])
      if (value === undefined) return undefined
      const row = stored(value)
      if (row.sourceStorageIdentityKey !== sourceIdentity) invalid()
      this.#binding(row, header, true)
      // Observe a durable ACK even after source expiry. Expiry still prevents
      // begin/resume/commit and cannot be renewed through this observation.
      return checkpoint(row)
    })
  }
  /** Bounded local metadata preparation only. Remote/source/proof/staging I/O
   * belongs outside this native read callback. It observes the exact expected
   * session/checkpoint and original expiry; a lost-ACK observation cannot grant
   * this operation permission to resume an expired or changed-primary session. */
  async inspect<T>(
    expectedInput: SnapshotSyncCheckpoint,
    work: (read: Readonly<IdbSnapshotSyncRead>) => Promise<T>
  ): Promise<T> {
    const expected = captureIdbSnapshotSyncCheckpoint(expectedInput)
    if (expected.done) invalid()
    return await this.#run('readonly', async (_wallet, raw) => {
      const header = await this.#header(raw, expected.identityKey),
        row = stored(
          await raw
            .objectStore(packedIdbStores.syncSessions)
            .get([header.user.userId, expected.sourceStorageIdentityKey])
        )
      this.#binding(row, header)
      live(row.expiresAt)
      if (!same(checkpoint(row), expected)) invalid()
      const scope = new Brc38OwnedImportReads(),
        read: Readonly<IdbSnapshotSyncRead> = Object.freeze<IdbSnapshotSyncRead>({
          transaction: raw,
          walletRevision: header.clock.revision,
          transactionMembershipRevision: header.clock.transactionMembershipRevision ?? 0,
          user: Object.freeze({ ...header.user }),
          sourceUserId: row.sourceUserId,
          expiresAt: row.expiresAt,
          loadMappings: async (table: SnapshotSyncTable, chunk: SyncChunk) => {
            // Capture only scalar ID references before the read scope yields;
            // caller mutation cannot change the pending page's requested IDs.
            const references = collectSnapshotSyncReferences(row.sourceUserId, table, chunk)
            return await scope.run(async () => {
              this.#check()
              live(row.expiresAt)
              const loaded = await this.#mappings(raw, row, table, references)
              this.#check()
              live(row.expiresAt)
              return loaded.map
            })
          },
          loadFieldMappings: (table, rows) => {
            const references = collectSnapshotSyncFieldReferences(row.sourceUserId, table, rows)
            return scope.run(async () => {
              this.#check()
              live(row.expiresAt)
              const loaded = await this.#mappings(raw, row, table, references)
              this.#check()
              live(row.expiresAt)
              return loaded.map
            })
          },
          readCurrentExtent: (identity, map, current, field, offset, length, working, signal) => {
            const captured = capturePackedIdbMergeLookupInputs(identity, map),
              extent = currentExtent(current, field, offset, length)
            if (captured.identity.table !== snapshotSyncTables[row.tableIndex]) invalid()
            return scope.run(
              async () => await this.#extent(raw, row, captured.identity, captured.map, extent, working, signal)
            )
          },
          findCurrentRow: (
            identity: PackedIdbMergeIdentity,
            map: SyncMap,
            maximumMetadataBytes: number,
            signal?: AbortSignal
          ) => {
            const captured = capturePackedIdbMergeLookupInputs(identity, map)
            if (captured.identity.table !== snapshotSyncTables[row.tableIndex]) invalid()
            return scope.run(async () => {
              this.#check()
              live(row.expiresAt)
              const current = await findPackedIdbMergeMetadata(
                this.#storage,
                raw,
                captured.identity,
                row.userId,
                captured.map,
                maximumMetadataBytes,
                signal
              )
              this.#check()
              live(row.expiresAt)
              return current
            })
          }
        })
      const result = await scope.retain(async () => await work(read))
      live(row.expiresAt)
      this.#binding(row, await this.#header(raw, expected.identityKey))
      return result
    })
  }
  /** Open a retained destination TEXT field under this actual original
   * operational session. Every later window/index operation repeats the exact
   * checkpoint, profile, primary, natural-key and current-row read, together
   * with the genuine retained snapshot lease in the same native transaction.
   * No source I/O or temporary-index writer runs inside inspect's callback. */
  async openCurrentStructuredField(
    expectedInput: SnapshotSyncCheckpoint,
    selected: PackedIdbMergeIdentity,
    selectedMap: SyncMap,
    field: string,
    selectedLimits: PackedIdbCurrentStructuredLimits,
    working: Brc38WorkingAllocation
  ): Promise<PackedIdbCurrentStructuredRead> {
    const expected = captureIdbSnapshotSyncCheckpoint(expectedInput),
      captured = capturePackedIdbMergeLookupInputs(selected, selectedMap),
      limits = Object.freeze({
        maximumMetadataBytes: selectedLimits.maximumMetadataBytes,
        maximumStructuredBytes: selectedLimits.maximumStructuredBytes,
        maximumReadBytes: selectedLimits.maximumReadBytes,
        maximumTemporaryIndexBytes: selectedLimits.maximumTemporaryIndexBytes,
        maximumGrammarIndexBytes: selectedLimits.maximumGrammarIndexBytes,
        maximumIndexMembers: selectedLimits.maximumIndexMembers,
        expiresAt: selectedLimits.expiresAt,
        signal: selectedLimits.signal
      })
    if (
      captured.identity.table !== snapshotSyncTables[expected.tableIndex] ||
      typeof field !== 'string' ||
      field.length < 1 ||
      field.length > 128
    )
      invalid()
    this.#check()
    return await PackedIdbCurrentStructuredRead.open(
      this.#storage,
      this.#owner,
      expected.identityKey,
      captured.identity.table,
      field,
      limits,
      working,
      async view =>
        await this.inspect(expected, async read => {
          const metadata = await read.findCurrentRow(
            captured.identity,
            captured.map,
            limits.maximumMetadataBytes,
            limits.signal
          )
          if (metadata === undefined) invalid()
          if (view !== undefined) await requirePackedIdbSnapshotInTransaction(view, this.#owner, read.transaction)
          return Object.freeze({ metadata, expiresAt: read.expiresAt })
        })
    )
  }
  /** Bounded large-notification map read without JSON.parse or a full ID map.
   * Zero/signed source IDs cannot name native wallet rows and remain unmapped.
   * Positive mapped IDs freshly name actual current destination transactions
   * belonging to this profile. Results are DATA, not final-writer permission. */
  async readNotificationMappings(
    expectedInput: SnapshotSyncCheckpoint,
    selected: readonly number[],
    maximumMetadataBytes: number,
    signal?: AbortSignal
  ): Promise<readonly (number | undefined)[]> {
    const expected = captureIdbSnapshotSyncCheckpoint(expectedInput)
    if (
      snapshotSyncTables[expected.tableIndex] !== 'provenTxReqs' ||
      !Array.isArray(selected) ||
      selected.length > 128 ||
      !Number.isSafeInteger(maximumMetadataBytes) ||
      maximumMetadataBytes < 1 ||
      maximumMetadataBytes > 16777216
    )
      invalid()
    const incoming: number[] = []
    for (let position = 0; position < selected.length; position++) {
      const property = Object.getOwnPropertyDescriptor(selected, String(position))
      if (
        property === undefined ||
        !Object.hasOwn(property, 'value') ||
        !property.enumerable ||
        !Number.isInteger(property.value)
      )
        invalid()
      incoming.push(property.value as number)
    }
    return await this.#run('readonly', async (_wallet, raw) => {
      signal?.throwIfAborted()
      const header = await this.#header(raw, expected.identityKey),
        row = stored(
          await raw
            .objectStore(packedIdbStores.syncSessions)
            .get([header.user.userId, expected.sourceStorageIdentityKey])
        )
      this.#binding(row, header)
      live(row.expiresAt)
      if (!same(checkpoint(row), expected)) invalid()
      const output: Array<number | undefined> = [],
        ids = raw.objectStore(packedIdbStores.syncIds)
      let remaining = maximumMetadataBytes - 4096 - 64 * incoming.length
      if (remaining < 1)
        throw new SnapshotResourceLimitError('Notification mapping batch exceeds its original metadata allowance')
      for (const incomingId of incoming) {
        signal?.throwIfAborted()
        this.#check()
        live(row.expiresAt)
        // Legacy normalized notifications may retain unsafe integer Numbers;
        // those cannot name a native safe-ID mapping and remain unmapped.
        if (!Number.isSafeInteger(incomingId) || incomingId < 1) {
          output.push(undefined)
          continue
        }
        const mapping = await ids.get([
          row.userId,
          row.sourceStorageIdentityKey,
          row.sessionId,
          'transaction',
          incomingId
        ])
        if (mapping === undefined) {
          output.push(undefined)
          continue
        }
        remaining -= packedIdbMetadataCharge(mapping)
        if (
          mapping.userId !== row.userId ||
          mapping.sourceStorageIdentityKey !== row.sourceStorageIdentityKey ||
          mapping.sessionId !== row.sessionId ||
          mapping.expiresAt !== row.expiresAt ||
          mapping.entity !== 'transaction' ||
          mapping.incomingId !== incomingId
        )
          invalid()
        const localId = packedIdbPositive(mapping.localId)
        if (remaining < 1)
          throw new SnapshotResourceLimitError('Notification mappings exceed the original metadata allowance')
        const current = await readPackedIdbCurrentMetadata(
          this.#storage,
          raw,
          'transactions',
          localId,
          row.userId,
          remaining,
          signal
        )
        if (current === undefined || current.fields.transactionId !== localId) invalid()
        remaining -= current.allocationBytes
        output.push(localId)
      }
      signal?.throwIfAborted()
      this.#check()
      live(row.expiresAt)
      this.#binding(row, await this.#header(raw, expected.identityKey))
      return Object.freeze(output)
    })
  }
  async commit(
    expectedInput: SnapshotSyncCheckpoint,
    nextTable: number,
    nextCursor: string | null,
    apply: (writer: IdbSnapshotSyncWriter) => Promise<{ inserts: number; updates: number }>
  ): Promise<SnapshotSyncCommit> {
    const expected = captureIdbSnapshotSyncCheckpoint(expectedInput)
    if (
      !Number.isSafeInteger(nextTable) ||
      (nextTable !== expected.tableIndex && nextTable !== expected.tableIndex + 1) ||
      nextTable > snapshotSyncTables.length ||
      (nextTable !== expected.tableIndex && nextCursor !== null) ||
      (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length > 8192))
    )
      invalid()
    return await this.#run('readwrite', async (wallet, raw) => {
      const header = await this.#header(raw, expected.identityKey),
        sessions = raw.objectStore(packedIdbStores.syncSessions),
        scope = [header.user.userId, expected.sourceStorageIdentityKey],
        row = stored(await sessions.get(scope))
      this.#binding(row, header)
      live(row.expiresAt)
      if (!same(checkpoint(row), expected) || expected.done) invalid()
      let phaseOpen = true,
        failure: unknown
      const pending = new Set<Promise<unknown>>(),
        own = <T>(action: () => Promise<T>): Promise<T> => {
          if (!phaseOpen) return Promise.reject(new Error('Packed snapshot mapping effect phase ended'))
          const result: Promise<T> = (async () => {
            try {
              live(row.expiresAt)
              return await action()
            } catch (cause) {
              failure = cause
              try {
                raw.abort()
              } catch {
                /* settled */
              }
              throw cause
            }
          })().finally(() => {
            pending.delete(result)
          })
          pending.add(result)
          void result.catch(() => undefined)
          return result
        }
      const writer: IdbSnapshotSyncWriter = {
        transaction: wallet,
        walletRevision: header.clock.revision,
        transactionMembershipRevision: header.clock.transactionMembershipRevision ?? 0,
        user: Object.freeze({ ...header.user }),
        sourceUserId: row.sourceUserId,
        sourceUser: Object.freeze({
          userId: row.sourceUserId,
          identityKey: row.identityKey,
          created_at: new Date(row.sourceUserCreatedAt),
          updated_at: new Date(row.sourceUserUpdatedAt),
          activeStorage: (row.sourceActiveStorage ?? undefined) as string
        }),
        unresolvedReclaim: (txid, signal) => {
          if (snapshotSyncTables[row.tableIndex] !== 'outputs' || typeof txid !== 'string') invalid()
          return own(
            async () =>
              await packedIdbUnresolvedReclaim(this.#storage, wallet, row.userId, txid, () => {
                this.#check()
                signal?.throwIfAborted()
                live(row.expiresAt)
              })
          )
        },
        quarantineReclaim: (txid, signal) => {
          if (snapshotSyncTables[row.tableIndex] !== 'transactions' || typeof txid !== 'string') invalid()
          return own(
            async () =>
              await packedIdbQuarantineReclaim(this.#storage, wallet, row.userId, txid, () => {
                this.#check()
                signal?.throwIfAborted()
                live(row.expiresAt)
              })
          )
        },
        readCurrentExtent: (identity, map, current, field, offset, length, working, signal) => {
          const captured = capturePackedIdbMergeLookupInputs(identity, map),
            extent = currentExtent(current, field, offset, length)
          if (captured.identity.table !== snapshotSyncTables[row.tableIndex]) invalid()
          return own(async () => await this.#extent(raw, row, captured.identity, captured.map, extent, working, signal))
        },
        findCurrentRow: (identity, map, maximumMetadataBytes, signal) => {
          const captured = capturePackedIdbMergeLookupInputs(identity, map)
          if (captured.identity.table !== snapshotSyncTables[row.tableIndex]) invalid()
          return own(
            async () =>
              await findPackedIdbMergeMetadata(
                this.#storage,
                raw,
                captured.identity,
                row.userId,
                captured.map,
                maximumMetadataBytes,
                signal
              )
          )
        },
        loadMappings: (table, chunk) =>
          own(async () => {
            const loaded = await this.#mappings(
              raw,
              row,
              table,
              collectSnapshotSyncReferences(row.sourceUserId, table, chunk)
            )
            return { map: loaded.map, persist: () => own(loaded.persist) }
          }),
        loadFieldMappings: (table, rows) => {
          // Detach IDs before the first owned await, then use the same actual
          // journal/current-parent writer as full-row mapping persistence.
          const references = collectSnapshotSyncFieldReferences(row.sourceUserId, table, rows)
          return own(async () => {
            const loaded = await this.#mappings(raw, row, table, references)
            return { map: loaded.map, persist: () => own(loaded.persist) }
          })
        }
      }
      let result: { inserts: number; updates: number }
      try {
        result = await apply(writer)
      } catch (cause) {
        phaseOpen = false
        try {
          raw.abort()
        } catch {
          /* settled */
        }
        await Promise.allSettled(pending)
        throw cause
      } finally {
        phaseOpen = false
      }
      if (pending.size !== 0) {
        try {
          raw.abort()
        } catch {
          /* settled */
        }
        await Promise.allSettled(pending)
        throw new Error('Packed snapshot returned with unawaited mapping effects')
      }
      if (failure !== undefined) throw failure
      await this.#owner.sealOperationalEffects(wallet)
      live(row.expiresAt)
      for (const count of [result.inserts, result.updates])
        if (!Number.isSafeInteger(count) || count < 0 || count > 8192) invalid()
      const current = await this.#header(raw, row.identityKey)
      row.sequence++
      row.tableIndex = nextTable
      row.cursor = nextCursor
      row.userRevision = current.userRevision
      row.activeStorage = current.user.activeStorage ?? null
      if (nextTable === snapshotSyncTables.length && row.content !== undefined) {
        const content = storedContentReceipt(row.content)
        if (content.destination !== undefined) invalid()
        row.content = contentReceiptJson({
          version: 1,
          source: content.source,
          destination: this.#contentRevision(current)
        })
      }
      stored(row)
      await sessions.put(row as unknown as Record<string, unknown>)
      return { checkpoint: checkpoint(row), ...result }
    })
  }
  async #extent(
    raw: PackedIdbTransaction,
    session: Session,
    identity: PackedIdbMergeIdentity,
    map: SyncMap,
    expected: CurrentExtent,
    selectedWorking: Brc38WorkingAllocation,
    signal?: AbortSignal
  ): Promise<IdbSnapshotSyncFieldLoan> {
    const working = brc38WorkingAllocation(selectedWorking)
    if (working === undefined) invalid()
    const allocation = working.claim(16384 + 32 * 65536 + 8 * 65536 + 4 * expected.length)
    let bytes: Uint8Array | undefined
    const check = async (): Promise<void> => {
      this.#check()
      signal?.throwIfAborted()
      live(session.expiresAt)
      const actual = await findPackedIdbMergeMetadata(this.#storage, raw, identity, session.userId, map, 65536, signal),
        extent = actual?.extents[expected.field]
      if (
        actual === undefined ||
        actual.store !== expected.store ||
        indexedDB.cmp(actual.key, expected.key) !== 0 ||
        actual.revision !== expected.revision ||
        extent === undefined ||
        extent.content !== expected.content ||
        extent.kind !== expected.kind ||
        extent.bytes !== expected.bytes ||
        extent.sha256 !== expected.sha256
      )
        invalid()
      this.#check()
      signal?.throwIfAborted()
      live(session.expiresAt)
    }
    try {
      await check()
      bytes = await readPackedIdbExtent(
        raw,
        { content: expected.content, kind: expected.kind, bytes: expected.bytes, sha256: expected.sha256 },
        expected.offset,
        expected.length
      )
      await check()
      let closed = false
      const actual = bytes
      return Object.freeze({
        bytes: actual,
        close: (): void => {
          if (!closed) {
            closed = true
            actual.fill(0)
            allocation.close()
          }
        }
      })
    } catch (cause) {
      bytes?.fill(0)
      allocation.close()
      throw cause
    }
  }
  async #mappings(
    raw: PackedIdbTransaction,
    row: Session,
    table: SnapshotSyncTable,
    references: SnapshotSyncPageReferences
  ) {
    if (table !== snapshotSyncTables[row.tableIndex]) invalid()
    const { wanted, required } = references,
      map = createSyncMap(),
      ids = raw.objectStore(packedIdbStores.syncIds),
      known = new Map<keyof SyncMap, Map<number, number>>()
    for (const [entity, values] of wanted) {
      const existing = new Map<number, number>()
      known.set(entity, existing)
      for (const incomingId of values) {
        const value = await ids.get([row.userId, row.sourceStorageIdentityKey, row.sessionId, entity, incomingId])
        if (value !== undefined) {
          if (
            value.userId !== row.userId ||
            value.sourceStorageIdentityKey !== row.sourceStorageIdentityKey ||
            value.sessionId !== row.sessionId ||
            value.expiresAt !== row.expiresAt ||
            value.entity !== entity ||
            value.incomingId !== incomingId
          )
            invalid()
          const localId = packedIdbPositive(value.localId)
          if (!Object.hasOwn(localEntities, entity)) invalid()
          const [store, id] = localEntities[entity as keyof typeof localEntities],
            metadata = await readPackedIdbCurrentMetadata(this.#storage, raw, store, localId, row.userId, 65536)
          if (metadata === undefined || metadata.fields[id] !== localId) invalid()
          map[entity].idMap[incomingId] = localId
          existing.set(incomingId, localId)
        }
      }
    }
    for (const [entity, values] of required) for (const id of values) if (map[entity].idMap[id] === undefined) invalid()
    return {
      map,
      persist: async () => {
        for (const [entity, values] of wanted)
          for (const incomingId of values) {
            const localId = map[entity].idMap[incomingId],
              previous = known.get(entity)?.get(incomingId)
            if (previous !== undefined) {
              if (localId !== previous) invalid()
              continue
            }
            if (localId === undefined) continue
            packedIdbPositive(localId)
            if (!Object.hasOwn(localEntities, entity)) invalid()
            const [store, id] = localEntities[entity as keyof typeof localEntities],
              metadata = await readPackedIdbCurrentMetadata(this.#storage, raw, store, localId, row.userId, 65536)
            if (metadata === undefined || metadata.fields[id] !== localId) invalid()
            await chargePackedIdb(raw, 2048, 1)
            await requirePackedIdbWriter(raw).objectStore(packedIdbStores.syncIds).add({
              userId: row.userId,
              sourceStorageIdentityKey: row.sourceStorageIdentityKey,
              sessionId: row.sessionId,
              expiresAt: row.expiresAt,
              entity,
              incomingId,
              localId
            })
          }
      }
    }
  }
  /** Finite metadata-only retirement under current actual ownership/quota.
   * Expired source admissions cannot resume; checkpoint DATA remain readable.
   * This never deletes wallet rows, provenance or a live session's mappings. */
  async collectExpiredMappings(maximumRecords = 128): Promise<number> {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 256) invalid()
    const cutoff = Date.now()
    return await this.#run('readwrite', async (_wallet, raw) => {
      let cursor = await raw
          .objectStore(packedIdbStores.syncIds)
          .index('expiresAt')
          .openCursor(IDBKeyRange.upperBound(cutoff)),
        removed = 0
      while (cursor !== null && removed < maximumRecords) {
        const value = cursor.value
        packedIdbMetadataCharge(value)
        packedIdbPositive(value.userId)
        packedIdbPositive(value.incomingId)
        packedIdbPositive(value.localId)
        text(value.sourceStorageIdentityKey)
        if (
          typeof value.sessionId !== 'string' ||
          !/^[0-9a-f]{64}$/.test(value.sessionId) ||
          typeof value.entity !== 'string' ||
          !Object.hasOwn(createSyncMap(), value.entity) ||
          typeof value.expiresAt !== 'number' ||
          !Number.isSafeInteger(value.expiresAt) ||
          value.expiresAt > cutoff ||
          JSON.stringify(cursor.primaryKey) !==
            JSON.stringify([
              value.userId,
              value.sourceStorageIdentityKey,
              value.sessionId,
              value.entity,
              value.incomingId
            ])
        )
          invalid()
        const current = await raw
          .objectStore(packedIdbStores.syncSessions)
          .get([value.userId as number, value.sourceStorageIdentityKey as string])
        if (current !== undefined) {
          const row = stored(current)
          if (row.sessionId === value.sessionId && row.expiresAt !== value.expiresAt) invalid()
        }
        await cursor.delete()
        await chargePackedIdb(raw, -2048, -1)
        removed++
        cursor = await cursor.continue()
      }
      return removed
    })
  }
}
