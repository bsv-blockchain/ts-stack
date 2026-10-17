import { unwrap, wrap, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toArray } from '@bsv/sdk/primitives/utils'
import { brc38StagingBinding, type Brc38StagingBinding, type Brc38StagingBoundMetadata } from './Brc38StagingBinding'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import {
  brc38StageTables,
  type Brc38StageStore,
  type Brc38StageRecord,
  type Brc38StageTable
} from './Brc38SemanticStage'
import type { PortableRow } from './Brc38PortableRows'
import type { BRC38WalletData } from './index'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38JsonStructuredField, type Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import {
  brc38PrivateIdbStructuredPolicy,
  type Brc38PrivateIdbStructuredPolicy
} from './Brc38PrivateIdbStructuredPolicy'
import {
  validateBrc38StructuredWalletField,
  type Brc38StreamedStructured,
  type Brc38JsonMember,
  type Brc38JsonMemberIndex
} from './Brc38StructuredJson'
import { brc38JsonBinaryField, type Brc38JsonStreamedField, type Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import type { Brc38StreamedStageStore } from './Brc38StreamedSemanticStage'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { Brc38PrivateIdbOwnership } from './Brc38PrivateIdbOwnership'
import { brc38Utf8ByteLength } from './Brc38Utf8Length'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { brc38JsonDecodedAllocation } from './Brc38JsonAllocation'
import { brc38JsonTextField, type Brc38JsonTextField } from './Brc38JsonTextFields'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'

export interface Brc38PrivateIdbStructuredRead {
  readonly source: Readonly<Brc38StreamedStructured>
  /** Fresh actor/lifetime check. No remembered backend or semantic verdict. */
  check(): void
  openIndex(policy: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]): Promise<Brc38JsonMemberIndex>
  close(): Promise<void>
}

interface Metadata {
  protocol: 'brc38-private-idb/v1'
  bindingJson: string
  limitsJson: string
  bindingSha256: string
  maximumKeys: number
  owner: string | null
  state: 'staging' | 'sealed' | 'deleting'
  rows: number
  keys: number
  logicalBytes: number
  header: string | null
  binaryFields: number
  binaryChunks: number
  binaryReferences: number
  jsonIndexes: number
  jsonMembers: number
}
interface StoredRow {
  payload: string
  bytes: number
  digest: string
  recordDigest: string
  binaryPayload?: string
  structuredPayload?: string
  textPayload?: string
}
type PrivateFieldDescriptor = Brc38JsonStreamedField | Brc38JsonStructuredField | Brc38JsonTextField
interface BinaryField {
  encoding: PrivateFieldDescriptor['encoding']
  maximumBytes: number
  bytes: number
  chunks: number
  sha256: string | null
  referenced: boolean
}
interface BinaryChunk {
  bytes: Uint8Array
  size: number
  sha256: string
}
interface JsonIndexRecord {
  table: Brc38StageTable
  position: number
  field: string
  sourceBytes: number
  sha256: string
  maximumBytes: number
  maximumMembers: number
  members: number
  bytes: number
  state: 'pending' | 'sealed' | 'retiring'
}
interface JsonMemberRecord extends Brc38JsonMember {
  firstKeyOffset: number
  charge: number
}
interface Schema extends DBSchema {
  metadata: { key: number; value: Metadata }
  counts: { key: string; value: number }
  rows: { key: [string, number]; value: StoredRow }
  keys: { key: [string, string]; value: { table: string; position: number; unique: boolean } }
  fields: { key: [string, number, string]; value: BinaryField }
  chunks: { key: [string, number, string, number]; value: BinaryChunk }
  jsonIndexes: { key: string; value: JsonIndexRecord }
  jsonMembers: { key: [string, number, string]; value: JsonMemberRecord }
}
const stores = ['metadata', 'counts', 'rows', 'keys', 'fields', 'chunks', 'jsonIndexes', 'jsonMembers'] as const
type Transaction<Mode extends 'readonly' | 'readwrite' = 'readonly' | 'readwrite'> = IDBPTransaction<
  Schema,
  (typeof stores)[number][],
  Mode
>
const issuer = Object.freeze({})
const issued = new WeakSet<Brc38PrivateIdbStage>()
const hash = (value: string): string => new SHA256().update(new TextEncoder().encode(value)).digestHex()
function invalid(): never {
  throw new Error('Private IndexedDB staging ownership, schema or original admission differs')
}
function nonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}
function bound(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid private IndexedDB staging bound')
}
function limitsCopy(selected: KnexBrc38StagingLimits, cleanupOnly = false): Readonly<KnexBrc38StagingLimits> {
  const limits = Object.freeze({
    maximumRows: selected.maximumRows,
    maximumLogicalBytes: selected.maximumLogicalBytes,
    maximumPhysicalBytes: selected.maximumPhysicalBytes,
    maximumRowBytes: selected.maximumRowBytes,
    maximumRowAllocationBytes: selected.maximumRowAllocationBytes,
    expiresAt: selected.expiresAt
  })
  bound(limits.maximumRows, 1, 1000000000)
  bound(limits.maximumLogicalBytes, 4096, 17179869184)
  bound(limits.maximumPhysicalBytes, 1048576, 17179869184)
  bound(limits.maximumRowBytes, 1, 1048576)
  bound(limits.maximumRowAllocationBytes, 4096, 16777216)
  bound(limits.expiresAt, 1, Number.MAX_SAFE_INTEGER)
  if (!cleanupOnly) bound(limits.expiresAt - Date.now(), 1, 3600000)
  return limits
}
function json(
  value: unknown,
  limits: KnexBrc38StagingLimits,
  signal?: AbortSignal
): { payload: string; bytes: number; digest: string } {
  const parts: string[] = [],
    decoder = new TextDecoder('utf-8', { fatal: true }),
    digest = new SHA256()
  let bytes = 0
  for (const chunk of canonicalPortableChunks(value, {
    maximumValueBytes: limits.maximumRowAllocationBytes,
    maximumChunkBytes: 4096,
    signal
  })) {
    bytes += chunk.byteLength
    if (bytes > limits.maximumRowBytes || 512 + 16 * bytes > limits.maximumRowAllocationBytes)
      throw new SnapshotResourceLimitError('Private IndexedDB row preparation allowance reached')
    digest.update(chunk)
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return { payload: parts.join(''), bytes, digest: digest.digestHex() }
}

/** Private browser namespace only. No active wallet connection, profile switch,
 * native schema or activation grant is available from this store. Sealing is
 * staging DATA, not evidence of envelope authentication or full semantics.
 * Browser physical allocation/eviction needs its separate host qualification. */
export class Brc38PrivateIdbStage implements Brc38StageStore, Brc38StreamedStageStore {
  readonly #native: IDBDatabase
  readonly #transaction: IDBDatabase['transaction']
  readonly #nativeClose: IDBDatabase['close']
  readonly #databaseName: string
  readonly #limits: Readonly<KnexBrc38StagingLimits>
  readonly #maximumKeys: number
  readonly #signal?: AbortSignal
  readonly #ownsCreation: boolean
  readonly #factory: IDBFactory
  readonly #deleteDatabase: IDBFactory['deleteDatabase']
  readonly #claim: string
  readonly #ownership: Brc38PrivateIdbOwnership
  readonly #bound: Readonly<Brc38StagingBoundMetadata>
  readonly #monotonicDeadline: number
  readonly #cleanupOnly: boolean
  #open = true
  #nativeClosed = false
  #busy = false
  #fieldBusy = false
  #fieldActive: Promise<unknown> = Promise.resolve()
  #active: Promise<unknown> = Promise.resolve()
  #closing?: Promise<void>
  #released = false
  #deleting = false
  #deleteCompletion?: Promise<void>
  #deleteSettled = false
  #deleteFailed = false
  #deleteRetry?: Promise<void>
  readonly #deleteOpenCleanup = new Set<Brc38StagingCleanupError>()
  #claimAcquired = false
  #needsReleasedDisposal = false
  #releasedDisposal?: Promise<void>
  #releasedFactoryCleanup?: Brc38StagingCleanupError
  readonly #jsonCleanup = new Set<Brc38JsonMemberIndex>()
  readonly #jsonFailedCleanup = new Set<Brc38JsonMemberIndex>()
  readonly #structuredReaders = new Set<Brc38PrivateIdbStructuredRead>()
  private constructor(
    token: object,
    databaseName: string,
    database: IDBPDatabase<Schema>,
    limits: Readonly<KnexBrc38StagingLimits>,
    maximumKeys: number,
    binding: Readonly<Brc38StagingBoundMetadata>,
    claim: string,
    monotonicDeadline: number,
    ownership: Brc38PrivateIdbOwnership,
    signal?: AbortSignal,
    ownsCreation = false,
    cleanupOnly = false
  ) {
    if (token !== issuer || typeof IDBDatabase === 'undefined') invalid()
    const native = unwrap(database)
    if (native === undefined) invalid()
    this.#databaseName = databaseName
    this.#limits = limits
    this.#maximumKeys = maximumKeys
    this.#cleanupOnly = cleanupOnly
    this.#signal = signal
    this.#ownsCreation = ownsCreation
    this.#factory = globalThis.indexedDB
    this.#deleteDatabase = IDBFactory.prototype.deleteDatabase
    this.#native = native
    this.#transaction = IDBDatabase.prototype.transaction
    this.#nativeClose = IDBDatabase.prototype.close
    // An intrinsic call establishes an actual database receiver, not a label.
    const probe = wrap(this.#transaction.call(native, [...stores], 'readonly')) as Transaction
    void probe.done.catch(() => undefined)
    probe.abort()
    this.#claim = claim
    this.#bound = binding
    this.#monotonicDeadline = monotonicDeadline
    ownership.assertOwned()
    this.#ownership = ownership
    issued.add(this)
    IDBDatabase.prototype.addEventListener.call(native, 'versionchange', () => {
      this.#open = false
      this.#nativeClosed = true
      this.#nativeClose.call(native)
    })
    IDBDatabase.prototype.addEventListener.call(native, 'close', () => {
      this.#open = false
      this.#nativeClosed = true
    })
  }
  get databaseName(): string {
    return this.#databaseName
  }
  get limits(): Readonly<KnexBrc38StagingLimits> {
    return this.#limits
  }
  get maximumKeys(): number {
    return this.#maximumKeys
  }
  static async create(
    selected: KnexBrc38StagingLimits,
    selectedBinding: Brc38StagingBinding,
    maximumKeys: number,
    signal?: AbortSignal
  ): Promise<Brc38PrivateIdbStage> {
    const began = performance.now(),
      limits = limitsCopy(selected),
      boundMetadata = brc38StagingBinding(selectedBinding, limits),
      deadline = began + Math.max(0, limits.expiresAt - Date.now()),
      claim = nonce(),
      name = 'wallet-toolbox-brc38-private-v1-' + nonce()
    bound(maximumKeys, 1, 2000000000)
    signal?.throwIfAborted()
    const ownership = await Brc38PrivateIdbOwnership.acquire(name, limits.expiresAt, signal)
    let database: IDBPDatabase<Schema>
    try {
      database = await Brc38PrivateIdbStage.#openDatabase(name, ownership, limits.expiresAt, signal, {
        limits,
        binding: boundMetadata.binding,
        metadata: boundMetadata,
        maximumKeys,
        claim
      })
    } catch (cause) {
      if (!(cause instanceof Brc38StagingCleanupError)) await ownership.release()
      throw cause
    }
    let owner: Brc38PrivateIdbStage
    try {
      owner = new Brc38PrivateIdbStage(
        issuer,
        name,
        database,
        limits,
        maximumKeys,
        boundMetadata,
        claim,
        deadline,
        ownership,
        signal,
        true
      )
    } catch (cause) {
      database.close()
      try {
        await ownership.release()
        await Brc38PrivateIdbStage.discardReleased(name, limits, boundMetadata.binding, maximumKeys)
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private IndexedDB creation retains namespace cleanup',
          async () => {
            await ownership.release()
            await Brc38PrivateIdbStage.discardReleased(name, limits, boundMetadata.binding, maximumKeys)
          }
        )
      }
      throw cause
    }
    owner.#claimAcquired = true
    try {
      owner.#check()
      return owner
    } catch (cause) {
      try {
        await owner.discard(cause)
      } catch (error_) {
        throw new Brc38StagingCleanupError([cause, error_], 'Private IndexedDB creation retains disposal', () =>
          owner.discard(cause)
        )
      }
      throw cause
    }
  }
  /** A fresh actual origin lock permits recovery after a terminated context.
   * The original persisted expiry and binding remain unchanged; an active
   * owner cannot be displaced by a database name, digest or claim string. */
  static async resume(
    databaseName: string,
    selected: KnexBrc38StagingLimits,
    selectedBinding: Brc38StagingBinding,
    maximumKeys: number,
    signal?: AbortSignal
  ): Promise<Brc38PrivateIdbStage> {
    if (!/^wallet-toolbox-brc38-private-v1-[0-9a-f]{32}$/.test(databaseName)) invalid()
    const began = performance.now(),
      limits = limitsCopy(selected),
      metadata = brc38StagingBinding(selectedBinding, limits),
      claim = nonce()
    bound(maximumKeys, 1, 2000000000)
    signal?.throwIfAborted()
    const ownership = await Brc38PrivateIdbOwnership.acquire(databaseName, limits.expiresAt, signal)
    let database: IDBPDatabase<Schema>
    try {
      database = await Brc38PrivateIdbStage.#openDatabase(databaseName, ownership, limits.expiresAt, signal)
    } catch (cause) {
      if (!(cause instanceof Brc38StagingCleanupError)) await ownership.release()
      throw cause
    }
    let owner: Brc38PrivateIdbStage
    try {
      owner = new Brc38PrivateIdbStage(
        issuer,
        databaseName,
        database,
        limits,
        maximumKeys,
        metadata,
        claim,
        began + Math.max(0, limits.expiresAt - Date.now()),
        ownership,
        signal
      )
    } catch (cause) {
      database.close()
      await ownership.release()
      throw cause
    }
    try {
      await owner.#run(
        'readwrite',
        async tx => {
          const previous = await owner.#metadata(tx, true)
          ownership.assertOwned()
          await tx.objectStore('metadata').put({ ...previous, owner: claim }, 1)
          void tx.done.then(
            () => {
              owner.#claimAcquired = true
            },
            () => undefined
          )
        },
        true
      )
      // A terminated context cannot leave a reusable semantic index. Retire
      // original scratch under this fresh actual lock before source access.
      await owner.#retireStaleJsonIndexes()
      return owner
    } catch (cause) {
      await owner.close()
      throw cause
    }
  }
  /** Recovery has no row access or renewed source lifetime. A fresh exclusive
   * browser lock plus the complete original persisted binding permits only
   * disposal, including after expiry or a context dying during deletion. */
  static async discardReleased(
    databaseName: string,
    selected: KnexBrc38StagingLimits,
    selectedBinding: Brc38StagingBinding,
    maximumKeys: number
  ): Promise<void> {
    if (!/^wallet-toolbox-brc38-private-v1-[0-9a-f]{32}$/.test(databaseName)) invalid()
    const limits = limitsCopy(selected, true),
      metadata = brc38StagingBinding(selectedBinding, limits),
      claim = nonce()
    bound(maximumKeys, 1, 2000000000)
    // This finite interval bounds cleanup acquisition, never the archive's
    // original expiry. No source operation can use this cleanup-only actor.
    const ownership = await Brc38PrivateIdbOwnership.acquire(databaseName, Date.now() + 30000)
    let database: IDBPDatabase<Schema>
    try {
      database = await Brc38PrivateIdbStage.#openDatabase(databaseName, ownership, Date.now() + 30000)
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError)
        throw new Brc38StagingCleanupError(
          [cause],
          'Private browser recovery retains acquisition drainage before original disposal',
          async () => {
            await cause.retryCleanup()
            await Brc38PrivateIdbStage.discardReleased(databaseName, limits, metadata.binding, maximumKeys)
          }
        )
      await ownership.release()
      throw cause
    }
    let owner: Brc38PrivateIdbStage
    try {
      owner = new Brc38PrivateIdbStage(
        issuer,
        databaseName,
        database,
        limits,
        maximumKeys,
        metadata,
        claim,
        performance.now(),
        ownership,
        undefined,
        false,
        true
      )
    } catch (cause) {
      database.close()
      await ownership.release()
      throw cause
    }
    try {
      const tx = wrap(
        owner.#transaction.call(owner.#native, [...stores], 'readwrite')
      ) as unknown as Transaction<'readwrite'>
      void tx.done.catch(() => undefined)
      const timer = setTimeout(() => {
        try {
          tx.abort()
        } catch {
          /* settled */
        }
      }, 30000)
      try {
        ownership.assertOwned()
        const previous = await owner.#metadata(tx, true, true)
        // Even a persisted DELETING owner is replaced only under the actual
        // origin lock. All original counters, admission and expiry stay exact.
        await tx.objectStore('metadata').put({ ...previous, owner: claim, state: 'deleting' }, 1)
        void tx.done.then(
          () => {
            owner.#claimAcquired = true
            owner.#deleting = true
          },
          () => undefined
        )
        await tx.done
        ownership.assertOwned()
      } catch (cause) {
        try {
          tx.abort()
        } catch {
          /* settled */
        }
        await tx.done.catch(() => undefined)
        throw cause
      } finally {
        clearTimeout(timer)
      }
      owner.#open = false
      owner.#closeNative()
      owner.#dispatchDelete()
      await owner.#awaitDelete()
    } catch (cause) {
      if (owner.#deleting)
        throw new Brc38StagingCleanupError(
          [cause],
          'Recovered private IndexedDB deletion retains its actual cleanup actor',
          () => owner.#awaitDelete()
        )
      try {
        await owner.close()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private IndexedDB recovery retains connection cleanup before original disposal',
          async () => {
            await owner.close()
            await Brc38PrivateIdbStage.discardReleased(databaseName, limits, metadata.binding, maximumKeys)
          }
        )
      }
      throw cause
    }
  }
  static async #openDatabase(
    databaseName: string,
    ownership: Brc38PrivateIdbOwnership,
    expiresAt: number,
    signal?: AbortSignal,
    initial?: {
      limits: Readonly<KnexBrc38StagingLimits>
      binding: Brc38StagingBinding
      metadata: Readonly<Brc38StagingBoundMetadata>
      maximumKeys: number
      claim: string
    },
    releaseOnFailure = true
  ): Promise<IDBPDatabase<Schema>> {
    ownership.assertOwned()
    signal?.throwIfAborted()
    const began = performance.now(),
      duration = Math.min(30000, expiresAt - Date.now())
    if (duration <= 0) throw new SnapshotResourceLimitError('Private IndexedDB acquisition expired')
    const request = IDBFactory.prototype.open.call(globalThis.indexedDB, databaseName, 1)
    let abandoned = false,
      createdUpgrade = false,
      created = false,
      database: IDBPDatabase<Schema> | undefined,
      upgradeFailure: unknown,
      timer: ReturnType<typeof setTimeout> | undefined,
      namespaceDeleted = false
    const completion = new Promise<IDBPDatabase<Schema>>((resolve, reject) => {
      request.onupgradeneeded = event => {
        try {
          ownership.assertOwned()
          signal?.throwIfAborted()
          if (
            abandoned ||
            performance.now() - began >= duration ||
            Date.now() >= expiresAt ||
            initial === undefined ||
            event.oldVersion !== 0
          )
            invalid()
          const native = request.result
          for (const store of stores) native.createObjectStore(store)
          const transaction = request.transaction
          if (transaction === null) invalid()
          transaction.objectStore('metadata').add(
            {
              protocol: 'brc38-private-idb/v1',
              bindingJson: initial.metadata.bindingJson,
              limitsJson: initial.metadata.limitsJson,
              bindingSha256: initial.metadata.digest,
              maximumKeys: initial.maximumKeys,
              owner: initial.claim,
              state: 'staging',
              rows: 0,
              keys: 0,
              logicalBytes: 4096,
              header: null,
              binaryFields: 0,
              binaryChunks: 0,
              binaryReferences: 0,
              jsonIndexes: 0,
              jsonMembers: 0
            },
            1
          )
          for (const table of brc38StageTables) transaction.objectStore('counts').add(0, table)
          createdUpgrade = true
        } catch (cause) {
          upgradeFailure = cause
          try {
            request.transaction?.abort()
          } catch {
            /* actual error completion follows */
          }
        }
      }
      request.onsuccess = () => {
        created = createdUpgrade
        database = wrap(request.result) as IDBPDatabase<Schema>
        if (abandoned) IDBDatabase.prototype.close.call(request.result)
        resolve(database)
      }
      request.onerror = () =>
        reject(upgradeFailure ?? request.error ?? new Error('Private IndexedDB acquisition failed'))
    })
    void completion.catch(() => undefined)
    const drain = async (): Promise<void> => {
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          completion.catch(() => undefined),
          new Promise<never>((_resolve, reject) => {
            drainTimer = setTimeout(
              () => reject(new Error('Actual private IndexedDB open request remains pending')),
              30000
            )
          })
        ])
        database?.close()
        if (releaseOnFailure) await ownership.release()
        if (created && initial !== undefined && !namespaceDeleted) {
          await Brc38PrivateIdbStage.discardReleased(databaseName, initial.limits, initial.binding, initial.maximumKeys)
          namespaceDeleted = true
        }
      } catch (cause) {
        throw new Brc38StagingCleanupError(
          [cause],
          'Private IndexedDB acquisition retains its actual request and namespace',
          drain
        )
      } finally {
        if (drainTimer !== undefined) clearTimeout(drainTimer)
      }
    }
    let rejectCancellation!: (cause: unknown) => void
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject
    })
    const abort = () => {
      abandoned = true
      rejectCancellation(signal?.reason ?? new Error('Private IndexedDB acquisition cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      const opened = await Promise.race([
        completion,
        cancellation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abandoned = true
            reject(new SnapshotResourceLimitError('Private IndexedDB open deadline reached'))
          }, duration)
        })
      ])
      ownership.assertOwned()
      signal?.throwIfAborted()
      if (performance.now() - began >= duration || Date.now() >= expiresAt) {
        abandoned = true
        throw new SnapshotResourceLimitError('Private IndexedDB open deadline reached')
      }
      if (initial !== undefined && !created) invalid()
      return opened
    } catch (cause) {
      abandoned = true
      // The original request cannot be cancelled. Retain its exact receiver,
      // origin lock and late-success connection until an explicit drain settles.
      // No caller may release ownership behind this cleanup object.
      try {
        await drain()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private IndexedDB acquisition requires actual request drainage',
          drain
        )
      }
      throw cause
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  #check(): void {
    if (this.#jsonFailedCleanup.size !== 0)
      throw new Brc38StagingCleanupError([], 'Private browser structured index cleanup remains', async () => {
        for (const index of this.#jsonFailedCleanup) await index.close()
      })
    this.#signal?.throwIfAborted()
    this.#ownership.assertOwned()
    if (
      !issued.has(this) ||
      this.#cleanupOnly ||
      !this.#open ||
      Date.now() >= this.#limits.expiresAt ||
      performance.now() >= this.#monotonicDeadline
    )
      throw new SnapshotResourceLimitError('Private IndexedDB staging actor is closed or expired')
  }
  #cleanupCheck(): void {
    this.#ownership.assertOwned()
    if (!issued.has(this) || this.#nativeClosed || this.#released) invalid()
  }
  #closeNative(): void {
    this.#nativeClose.call(this.#native)
    this.#nativeClosed = true
  }
  #schema(tx: Transaction): void {
    if (this.#native.version !== 1 || this.#native.objectStoreNames.length !== stores.length) invalid()
    for (const name of stores) {
      const store = tx.objectStore(name)
      if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) invalid()
    }
  }
  async #metadata(tx: Transaction, released = false, deletingAllowed = false): Promise<Metadata> {
    this.#schema(tx)
    if ((await tx.objectStore('metadata').count()) !== 1) invalid()
    const meta = await tx.objectStore('metadata').get(1)
    if (
      meta === undefined ||
      meta.protocol !== 'brc38-private-idb/v1' ||
      meta.bindingJson !== this.#bound.bindingJson ||
      meta.limitsJson !== this.#bound.limitsJson ||
      meta.bindingSha256 !== this.#bound.digest ||
      meta.maximumKeys !== this.#maximumKeys ||
      (!released && meta.owner !== this.#claim) ||
      !(deletingAllowed ? ['staging', 'sealed', 'deleting'] : ['staging', 'sealed']).includes(meta.state)
    )
      invalid()
    if (meta.owner !== null && (typeof meta.owner !== 'string' || meta.owner.length > 256)) invalid()
    bound(meta.rows, 0, this.#limits.maximumRows)
    bound(meta.keys, 0, this.#maximumKeys)
    bound(meta.logicalBytes, 4096, this.#limits.maximumLogicalBytes)
    bound(meta.binaryFields, 0, this.#maximumKeys)
    bound(meta.binaryChunks, 0, this.#maximumKeys)
    bound(meta.binaryReferences, 0, meta.binaryFields)
    bound(meta.jsonIndexes, 0, this.#maximumKeys)
    bound(meta.jsonMembers, 0, this.#maximumKeys)
    if (meta.keys + meta.binaryFields + meta.binaryChunks + meta.jsonIndexes + meta.jsonMembers > this.#maximumKeys)
      invalid()
    if (
      meta.header !== null &&
      (typeof meta.header !== 'string' ||
        meta.header.length > this.#limits.maximumRowBytes ||
        brc38Utf8ByteLength(meta.header) > this.#limits.maximumRowBytes)
    )
      invalid()
    return meta
  }
  async #run<T, Mode extends 'readonly' | 'readwrite'>(
    mode: Mode,
    work: (tx: Transaction<Mode>) => Promise<T>,
    initialize = false,
    cleanupOnly = false
  ): Promise<T> {
    if (cleanupOnly) this.#cleanupCheck()
    else this.#check()
    if (this.#busy) throw new Error('Private IndexedDB staging already owns a transaction')
    this.#busy = true
    let tx: Transaction<Mode> | undefined
    const operation = (async () => {
      tx = wrap(this.#transaction.call(this.#native, [...stores], mode)) as Transaction<Mode>
      const wall = cleanupOnly ? Date.now() + 30000 : Math.min(this.#limits.expiresAt, Date.now() + 30000),
        mono = cleanupOnly ? performance.now() + 30000 : Math.min(this.#monotonicDeadline, performance.now() + 30000),
        timer = setTimeout(
          () => {
            try {
              tx?.abort()
            } catch {
              /* settled */
            }
          },
          Math.max(0, wall - Date.now())
        )
      void tx.done.catch(() => undefined)
      try {
        this.#schema(tx)
        if (!initialize) await this.#metadata(tx)
        const result = await work(tx)
        if (cleanupOnly) this.#cleanupCheck()
        else this.#check()
        if (Date.now() >= wall || performance.now() >= mono)
          throw new SnapshotResourceLimitError('Private IndexedDB transaction expired')
        await tx.done
        if (cleanupOnly) this.#cleanupCheck()
        else this.#check()
        return result
      } catch (cause) {
        try {
          tx.abort()
        } catch {
          /* await actual completion */
        }
        try {
          await tx.done
        } catch {
          /* preserve the operation's cause */
        }
        throw cause
      } finally {
        clearTimeout(timer)
      }
    })()
    this.#active = operation
    try {
      return await operation
    } finally {
      this.#busy = false
    }
  }
  async append(record: Brc38StageRecord): Promise<void> {
    this.#fieldIdle()
    await this.#append(record)
  }
  async appendStreamed(
    record: Brc38StageRecord,
    descriptors: Brc38JsonStreamedRow['binaries'],
    structured?: NonNullable<Brc38JsonStreamedRow['structured']>,
    texts?: NonNullable<Brc38JsonStreamedRow['texts']>
  ): Promise<void> {
    this.#fieldIdle()
    const captured: Record<string, Brc38JsonStreamedField> = Object.create(null),
      names = Object.keys(descriptors)
    if (names.length > 3) invalid()
    for (const field of names) {
      const value = descriptors[field]
      if (!['base64', 'number-array'].includes(value.encoding)) invalid()
      this.#coordinate(record.table, record.index, field, value.encoding)
      if (value.field !== field || Object.hasOwn(record.row, field) || !/^[0-9a-f]{64}$/.test(value.sha256)) invalid()
      bound(value.bytes, 0, this.#limits.maximumLogicalBytes)
      captured[field] = Object.freeze({ field, encoding: value.encoding, bytes: value.bytes, sha256: value.sha256 })
    }
    const capturedJson: Record<string, Brc38JsonStructuredField> = Object.create(null),
      jsonNames = Object.keys(structured ?? {})
    if (jsonNames.length > 3) invalid()
    for (const field of jsonNames) {
      const value = structured![field]
      if (value.encoding !== 'utf8-json') invalid()
      this.#coordinate(record.table, record.index, field, value.encoding)
      if (
        value.field !== field ||
        Object.hasOwn(record.row, field) ||
        Object.hasOwn(captured, field) ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        invalid()
      bound(value.bytes, 2, this.#limits.maximumLogicalBytes)
      capturedJson[field] = Object.freeze({ field, encoding: 'utf8-json', bytes: value.bytes, sha256: value.sha256 })
    }
    const capturedText: Record<string, Brc38JsonTextField> = Object.create(null),
      textNames = Object.keys(texts ?? {})
    if (textNames.length > 7) invalid()
    for (const field of textNames) {
      const value = texts![field]
      if (value.encoding !== 'utf8') invalid()
      this.#coordinate(record.table, record.index, field, value.encoding)
      if (
        value.field !== field ||
        Object.hasOwn(record.row, field) ||
        Object.hasOwn(captured, field) ||
        Object.hasOwn(capturedJson, field) ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        invalid()
      bound(value.bytes, 0, Math.min(1000000000, this.#limits.maximumLogicalBytes))
      capturedText[field] = Object.freeze({ field, encoding: 'utf8', bytes: value.bytes, sha256: value.sha256 })
    }
    await this.#append(
      record,
      Object.freeze(captured),
      jsonNames.length === 0 ? undefined : Object.freeze(capturedJson),
      textNames.length === 0 ? undefined : Object.freeze(capturedText)
    )
  }
  async #append(
    record: Brc38StageRecord,
    descriptors?: Brc38JsonStreamedRow['binaries'],
    structured?: Brc38JsonStreamedRow['structured'],
    texts?: Brc38JsonStreamedRow['texts']
  ): Promise<void> {
    this.#check()
    if (!brc38StageTables.includes(record.table)) invalid()
    bound(record.index, 0, this.#limits.maximumRows - 1)
    if (!Array.isArray(record.uniqueKeys) || !Array.isArray(record.memberships)) invalid()
    const value = json(record.row, this.#limits, this.#signal),
      table = record.table,
      position = record.index,
      numberOfKeys = record.uniqueKeys.length + record.memberships.length
    if (numberOfKeys > 64) throw new SnapshotResourceLimitError('Private IndexedDB row has too many indexed keys')
    const unique = record.uniqueKeys.map(key => ({ namespace: key.namespace, key: key.key, unique: true })),
      memberships = record.memberships.map(key => ({ namespace: key.namespace, key: key.key, unique: false })),
      keys = [...unique, ...memberships]
    if (keys.length > 64) throw new SnapshotResourceLimitError('Private IndexedDB row has too many indexed keys')
    const binaryPayload = descriptors === undefined ? undefined : JSON.stringify(descriptors),
      structuredPayload = structured === undefined ? undefined : JSON.stringify(structured),
      textPayload = texts === undefined ? undefined : JSON.stringify(texts)
    let charge =
      512 +
      value.bytes +
      (binaryPayload === undefined ? 0 : 256 + toArray(binaryPayload, 'utf8').length) +
      (structuredPayload === undefined ? 0 : 256 + toArray(structuredPayload, 'utf8').length) +
      (textPayload === undefined ? 0 : 256 + toArray(textPayload, 'utf8').length)
    for (const key of keys) {
      if (
        typeof key.namespace !== 'string' ||
        key.namespace.length > 64 ||
        typeof key.key !== 'string' ||
        key.key.length > 65536
      )
        invalid()
      charge += 128 + toArray(key.namespace, 'utf8').length + toArray(key.key, 'utf8').length
    }
    if (!Number.isSafeInteger(charge) || 16 * charge > this.#limits.maximumRowAllocationBytes)
      throw new SnapshotResourceLimitError('Private IndexedDB row and key preparation exceed their allocation')
    const recordDigest = hash(
      JSON.stringify(
        textPayload !== undefined
          ? [table, position, value.payload, unique, memberships, binaryPayload, structuredPayload, textPayload]
          : structuredPayload !== undefined
            ? [table, position, value.payload, unique, memberships, binaryPayload, structuredPayload]
            : binaryPayload === undefined
              ? [table, position, value.payload, unique, memberships]
              : [table, position, value.payload, unique, memberships, binaryPayload]
      )
    )
    await this.#run('readwrite', async tx => {
      const meta = await this.#metadata(tx),
        rows = tx.objectStore('rows'),
        indexed = tx.objectStore('keys'),
        existing = await rows.get([table, position]),
        amount = await tx.objectStore('counts').get(table)
      if (typeof amount !== 'number') invalid()
      bound(amount, 0, this.#limits.maximumRows)
      if (existing !== undefined) {
        if (
          existing.recordDigest !== recordDigest ||
          existing.payload !== value.payload ||
          existing.digest !== value.digest ||
          existing.bytes !== value.bytes ||
          existing.binaryPayload !== binaryPayload ||
          existing.structuredPayload !== structuredPayload ||
          existing.textPayload !== textPayload
        )
          invalid()
        return
      }
      if (meta.state !== 'staging' || position !== amount || meta.rows >= this.#limits.maximumRows) invalid()
      if (charge > this.#limits.maximumLogicalBytes - meta.logicalBytes)
        throw new SnapshotResourceLimitError('Private IndexedDB staging logical reservation reached')
      const all: Record<string, PrivateFieldDescriptor> = { ...descriptors, ...structured, ...texts },
        names = Object.keys(all),
        fields = tx.objectStore('fields'),
        fieldCount = await fields.count(IDBKeyRange.bound([table, position, ''], [table, position, '\uffff']))
      if (fieldCount !== names.length) invalid()
      let references = 0
      for (const name of names) {
        const actual = await fields.get([table, position, name]),
          expected = all[name]
        if (
          actual === undefined ||
          actual.sha256 !== expected.sha256 ||
          actual.bytes !== expected.bytes ||
          actual.encoding !== expected.encoding ||
          actual.referenced
        )
          invalid()
        await fields.put({ ...actual, referenced: true }, [table, position, name])
        references++
      }
      let added = 0
      for (const key of keys) {
        const previous = await indexed.get([key.namespace, key.key])
        if (previous !== undefined) {
          if (key.unique) invalid()
          continue
        }
        if (
          ++added >
          this.#maximumKeys - meta.keys - meta.binaryFields - meta.binaryChunks - meta.jsonIndexes - meta.jsonMembers
        )
          throw new SnapshotResourceLimitError('Private IndexedDB indexed key reservation reached')
        await indexed.add({ table, position, unique: key.unique }, [key.namespace, key.key])
      }
      await rows.add(
        {
          ...value,
          recordDigest,
          ...(binaryPayload === undefined ? {} : { binaryPayload }),
          ...(structuredPayload === undefined ? {} : { structuredPayload }),
          ...(textPayload === undefined ? {} : { textPayload })
        },
        [table, position]
      )
      await tx.objectStore('counts').put(amount + 1, table)
      await tx.objectStore('metadata').put(
        {
          ...meta,
          rows: meta.rows + 1,
          keys: meta.keys + added,
          binaryReferences: meta.binaryReferences + references,
          logicalBytes: meta.logicalBytes + charge
        },
        1
      )
    })
  }
  async count(table: Brc38StageTable): Promise<number> {
    if (!brc38StageTables.includes(table)) invalid()
    return await this.#run('readonly', async tx => {
      const amount = await tx.objectStore('counts').get(table)
      if (typeof amount !== 'number') invalid()
      bound(amount, 0, this.#limits.maximumRows)
      return amount
    })
  }
  /** Fresh bounded staging metadata for restore preparation. A sealed marker,
   * returned header, binding or count is DATA, not envelope authentication or
   * a previous semantic verdict. The crypto/source owner remains mandatory. */
  async sealedMetadata(): Promise<
    Readonly<{
      header: Readonly<BRC38WalletData>
      counts: Readonly<Record<Brc38StageTable, number>>
      rows: number
      binding: Readonly<Brc38StagingBinding>
      bindingSha256: string
      originalLimitsJson: string
    }>
  > {
    this.#fieldIdle()
    return await this.#run('readonly', async tx => {
      const meta = await this.#metadata(tx)
      if (
        meta.state !== 'sealed' ||
        meta.header === null ||
        meta.binaryFields !== meta.binaryReferences ||
        meta.jsonIndexes !== 0 ||
        meta.jsonMembers !== 0
      )
        invalid()
      if (512 + 16 * meta.header.length > this.#limits.maximumRowAllocationBytes)
        throw new SnapshotResourceLimitError(
          'Private browser sealed header exceeds its original preparation allocation'
        )
      const bytes = toArray(meta.header, 'utf8').length
      if (512 + 16 * bytes > this.#limits.maximumRowAllocationBytes)
        throw new SnapshotResourceLimitError(
          'Private browser sealed header exceeds its original preparation allocation'
        )
      const counts = {} as Record<Brc38StageTable, number>
      let rows = 0
      for (const table of brc38StageTables) {
        const count = await tx.objectStore('counts').get(table)
        if (typeof count !== 'number') invalid()
        bound(count, 0, this.#limits.maximumRows)
        rows += count
        counts[table] = count
      }
      if (
        rows !== meta.rows ||
        (await tx.objectStore('counts').count()) !== brc38StageTables.length ||
        (await tx.objectStore('rows').count()) !== rows ||
        (await tx.objectStore('keys').count()) !== meta.keys ||
        (await tx.objectStore('fields').count()) !== meta.binaryFields ||
        (await tx.objectStore('chunks').count()) !== meta.binaryChunks ||
        (await tx.objectStore('jsonIndexes').count()) !== 0 ||
        (await tx.objectStore('jsonMembers').count()) !== 0
      )
        invalid()
      const header: Readonly<BRC38WalletData> = JSON.parse(meta.header)
      // This is the ordinary parser's original header contract. Full archive
      // row/field/graph semantics and GCM remain independently replayed owners.
      if (
        header.user?.identityKey !== this.#bound.binding.identityKey ||
        header.sourceStorage?.storageIdentityKey !== this.#bound.binding.sourceStorageIdentityKey ||
        header.sourceStorage?.chain !== this.#bound.binding.chain
      )
        invalid()
      return Object.freeze({
        header,
        counts: Object.freeze(counts),
        rows,
        binding: this.#bound.binding,
        bindingSha256: this.#bound.digest,
        originalLimitsJson: this.#bound.limitsJson
      })
    })
  }
  async row(table: Brc38StageTable, index: number): Promise<Readonly<PortableRow> | undefined> {
    if (!brc38StageTables.includes(table)) invalid()
    bound(index, 0, this.#limits.maximumRows - 1)
    return await this.#run('readonly', async tx => {
      const value = await tx.objectStore('rows').get([table, index])
      if (value === undefined) return undefined
      if (value.binaryPayload !== undefined || value.structuredPayload !== undefined || value.textPayload !== undefined)
        throw new Error('Field-aware browser row requires the explicit streamed reader')
      if (
        typeof value.payload !== 'string' ||
        value.payload.length > this.#limits.maximumRowBytes ||
        toArray(value.payload, 'utf8').length !== value.bytes ||
        value.bytes > this.#limits.maximumRowBytes ||
        512 + 16 * value.bytes > this.#limits.maximumRowAllocationBytes ||
        hash(value.payload) !== value.digest
      )
        invalid()
      return JSON.parse(value.payload) as PortableRow
    })
  }
  async has(namespace: string, key: string): Promise<boolean> {
    if (typeof namespace !== 'string' || namespace.length > 64 || typeof key !== 'string' || key.length > 65536)
      invalid()
    return await this.#run(
      'readonly',
      async tx => (await tx.objectStore('keys').getKey([namespace, key])) !== undefined
    )
  }
  async seal(header: Readonly<BRC38WalletData>, counts: Readonly<Record<Brc38StageTable, number>>): Promise<void> {
    this.#fieldIdle()
    await this.#seal(header, counts, false)
  }
  async #seal(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>,
    streamed: boolean
  ): Promise<void> {
    const value = json(header, this.#limits, this.#signal),
      expected = Object.freeze(
        Object.fromEntries(brc38StageTables.map(table => [table, counts[table]])) as Record<Brc38StageTable, number>
      )
    await this.#run('readwrite', async tx => {
      const meta = await this.#metadata(tx)
      let total = 0
      for (const table of brc38StageTables) {
        bound(expected[table], 0, this.#limits.maximumRows)
        if ((await tx.objectStore('counts').get(table)) !== expected[table]) invalid()
        total += expected[table]
      }
      if (
        total !== meta.rows ||
        (await tx.objectStore('rows').count()) !== total ||
        (await tx.objectStore('keys').count()) !== meta.keys
      )
        invalid()
      if (
        (!streamed && meta.binaryFields !== 0) ||
        meta.binaryFields !== meta.binaryReferences ||
        (await tx.objectStore('fields').count()) !== meta.binaryFields ||
        (await tx.objectStore('chunks').count()) !== meta.binaryChunks ||
        meta.jsonIndexes !== 0 ||
        meta.jsonMembers !== 0 ||
        (await tx.objectStore('jsonIndexes').count()) !== 0 ||
        (await tx.objectStore('jsonMembers').count()) !== 0
      )
        invalid()
      if (meta.state === 'sealed') {
        if (meta.header !== value.payload) invalid()
        return
      }
      const charge = 512 + value.bytes
      if (charge > this.#limits.maximumLogicalBytes - meta.logicalBytes)
        throw new SnapshotResourceLimitError('Private IndexedDB staging header reservation reached')
      await tx
        .objectStore('metadata')
        .put({ ...meta, state: 'sealed', header: value.payload, logicalBytes: meta.logicalBytes + charge }, 1)
    })
  }
  #fieldIdle(): void {
    if (this.#fieldBusy) throw new Error('Private browser field verification already owns a preparation')
  }
  async #fieldWork<T>(work: () => Promise<T>): Promise<T> {
    this.#check()
    this.#fieldIdle()
    this.#fieldBusy = true
    const operation = Promise.resolve().then(work)
    this.#fieldActive = operation
    try {
      return await operation
    } finally {
      this.#fieldBusy = false
    }
  }
  #coordinate(
    table: Brc38StageTable,
    index: number,
    field: string,
    encoding: PrivateFieldDescriptor['encoding']
  ): void {
    if (
      !brc38StageTables.includes(table) ||
      (encoding === 'utf8'
        ? !brc38JsonTextField(table, field)
        : encoding === 'utf8-json'
          ? !brc38JsonStructuredField(table, field)
          : !brc38JsonBinaryField(table, field) ||
            encoding !== (field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64'))
    )
      invalid()
    bound(index, 0, this.#limits.maximumRows - 1)
  }
  #field(value: BinaryField | undefined): BinaryField {
    if (
      value === undefined ||
      !['base64', 'number-array', 'utf8-json', 'utf8'].includes(value.encoding) ||
      typeof value.referenced !== 'boolean' ||
      (value.sha256 !== null && !/^[0-9a-f]{64}$/.test(value.sha256))
    )
      invalid()
    bound(value.maximumBytes, 0, this.#limits.maximumLogicalBytes)
    bound(value.bytes, 0, value.maximumBytes)
    bound(value.chunks, 0, this.#maximumKeys)
    return value
  }
  async beginBinaryField(
    table: Brc38StageTable,
    index: number,
    field: string,
    encoding: Brc38JsonStreamedField['encoding'],
    maximumBytes: number
  ): Promise<void> {
    if (!['base64', 'number-array'].includes(encoding)) invalid()
    await this.#beginField(table, index, field, encoding, maximumBytes)
  }
  async beginStructuredField(
    table: Brc38StageTable,
    index: number,
    field: string,
    maximumBytes: number
  ): Promise<void> {
    await this.#beginField(table, index, field, 'utf8-json', maximumBytes)
  }
  async beginTextField(table: Brc38StageTable, index: number, field: string, maximumBytes: number): Promise<void> {
    bound(maximumBytes, 0, Math.min(1000000000, this.#limits.maximumLogicalBytes))
    await this.#beginField(table, index, field, 'utf8', maximumBytes)
  }
  async #beginField(
    table: Brc38StageTable,
    index: number,
    field: string,
    encoding: PrivateFieldDescriptor['encoding'],
    maximumBytes: number
  ): Promise<void> {
    this.#fieldIdle()
    this.#coordinate(table, index, field, encoding)
    bound(maximumBytes, 0, this.#limits.maximumLogicalBytes)
    await this.#run('readwrite', async tx => {
      const meta = await this.#metadata(tx),
        fields = tx.objectStore('fields'),
        existing = await fields.get([table, index, field])
      if (existing !== undefined) {
        const actual = this.#field(existing)
        if (actual.encoding !== encoding || actual.maximumBytes !== maximumBytes) invalid()
        return
      }
      if (
        meta.state !== 'staging' ||
        (await tx.objectStore('rows').getKey([table, index])) !== undefined ||
        (await fields.count(IDBKeyRange.bound([table, index, ''], [table, index, '\uffff']))) >= 13
      )
        invalid()
      if (
        meta.keys + meta.binaryFields + meta.binaryChunks + meta.jsonIndexes + meta.jsonMembers >= this.#maximumKeys ||
        512 > this.#limits.maximumLogicalBytes - meta.logicalBytes
      )
        throw new SnapshotResourceLimitError('Private browser field reservation reached')
      await fields.add({ encoding, maximumBytes, bytes: 0, chunks: 0, sha256: null, referenced: false }, [
        table,
        index,
        field
      ])
      await tx
        .objectStore('metadata')
        .put({ ...meta, binaryFields: meta.binaryFields + 1, logicalBytes: meta.logicalBytes + 512 }, 1)
    })
  }
  async appendBinaryField(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number,
    input: Uint8Array
  ): Promise<void> {
    await this.#appendField(
      table,
      index,
      field,
      field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64',
      offset,
      input
    )
  }
  async appendStructuredField(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number,
    input: Uint8Array
  ): Promise<void> {
    await this.#appendField(table, index, field, 'utf8-json', offset, input)
  }
  async appendTextField(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number,
    input: Uint8Array
  ): Promise<void> {
    await this.#appendField(table, index, field, 'utf8', offset, input)
  }
  async #appendField(
    table: Brc38StageTable,
    index: number,
    field: string,
    encoding: PrivateFieldDescriptor['encoding'],
    offset: number,
    input: Uint8Array
  ): Promise<void> {
    this.#fieldIdle()
    this.#coordinate(table, index, field, encoding)
    bound(offset, 0, this.#limits.maximumLogicalBytes)
    const bytes = detachBrc38PrivateChunk(
      input,
      Math.min(encoding === 'utf8' ? 16384 : 65536, Math.floor((this.#limits.maximumRowAllocationBytes - 4096) / 32))
    )
    if (bytes.byteLength === 0) invalid()
    const sha256 = new SHA256().update(bytes).digestHex(),
      size = bytes.byteLength
    try {
      await this.#run('readwrite', async tx => {
        const meta = await this.#metadata(tx),
          fields = tx.objectStore('fields'),
          chunks = tx.objectStore('chunks'),
          actual = this.#field(await fields.get([table, index, field])),
          previous = await chunks.get([table, index, field, offset])
        if (actual.encoding !== encoding) invalid()
        if (previous !== undefined) {
          const replay = detachBrc38PrivateChunk(previous.bytes, size)
          if (
            previous.size !== size ||
            replay.byteLength !== size ||
            previous.sha256 !== sha256 ||
            replay.some((value, i) => value !== bytes[i])
          )
            invalid()
          return
        }
        if (
          meta.state !== 'staging' ||
          actual.sha256 !== null ||
          actual.referenced ||
          offset !== actual.bytes ||
          size > actual.maximumBytes - offset
        )
          invalid()
        if (
          meta.keys + meta.binaryFields + meta.binaryChunks + meta.jsonIndexes + meta.jsonMembers >=
            this.#maximumKeys ||
          size + 512 > this.#limits.maximumLogicalBytes - meta.logicalBytes
        )
          throw new SnapshotResourceLimitError('Private browser chunk reservation reached')
        await chunks.add({ bytes, size, sha256 }, [table, index, field, offset])
        await fields.put({ ...actual, bytes: offset + size, chunks: actual.chunks + 1 }, [table, index, field])
        await tx
          .objectStore('metadata')
          .put({ ...meta, binaryChunks: meta.binaryChunks + 1, logicalBytes: meta.logicalBytes + size + 512 }, 1)
      })
    } finally {
      bytes.fill(0)
    }
  }
  async *readBinaryFieldChunks(
    table: Brc38StageTable,
    index: number,
    descriptor: Brc38JsonStreamedField
  ): AsyncGenerator<Uint8Array> {
    if (!['base64', 'number-array'].includes(descriptor.encoding)) invalid()
    yield* this.#readFieldChunks(table, index, descriptor)
  }
  /** Small current field DATA without loading/decoding the complete row. The
   * source owner/controller must still compare the actual row descriptor and
   * replay authentication/semantics before destination effects can publish. */
  async binaryFieldDescriptor(
    table: Brc38StageTable,
    index: number,
    field: string
  ): Promise<Readonly<Brc38JsonStreamedField>> {
    const encoding = field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64'
    this.#coordinate(table, index, field, encoding)
    return await this.#run('readonly', async tx => {
      const meta = await this.#metadata(tx),
        value = this.#field(await tx.objectStore('fields').get([table, index, field]))
      if (
        meta.state !== 'sealed' ||
        value.encoding !== encoding ||
        !value.referenced ||
        value.sha256 === null ||
        (await tx.objectStore('rows').getKey([table, index])) === undefined
      )
        invalid()
      return Object.freeze({ field, encoding, bytes: value.bytes, sha256: value.sha256 })
    })
  }
  async *readStructuredFieldChunks(
    table: Brc38StageTable,
    index: number,
    descriptor: Brc38JsonStructuredField
  ): AsyncGenerator<Uint8Array> {
    if (descriptor.encoding !== 'utf8-json') invalid()
    yield* this.#readFieldChunks(table, index, descriptor)
  }
  /** Bounded actual scalar UTF-8 content; returned extents remain borrowed only
   * until generator advancement/close. No full string or semantic grant. */
  async *readTextFieldChunks(
    table: Brc38StageTable,
    index: number,
    descriptor: Brc38JsonTextField
  ): AsyncGenerator<Uint8Array> {
    if (descriptor.encoding !== 'utf8') invalid()
    yield* this.#readFieldChunks(table, index, descriptor)
  }
  async *#readFieldChunks(
    table: Brc38StageTable,
    index: number,
    descriptor: PrivateFieldDescriptor
  ): AsyncGenerator<Uint8Array> {
    const expected = Object.freeze({
      field: descriptor.field,
      encoding: descriptor.encoding,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256
    })
    this.#coordinate(table, index, expected.field, expected.encoding)
    bound(expected.bytes, 0, this.#limits.maximumLogicalBytes)
    if (!/^[0-9a-f]{64}$/.test(expected.sha256)) invalid()
    let offset = 0,
      count = 0
    const digest = new SHA256(),
      decoder = expected.encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined,
      maximum = Math.min(
        expected.encoding === 'utf8' ? 16384 : 65536,
        Math.floor((this.#limits.maximumRowAllocationBytes - 4096) / 32)
      )
    while (offset < expected.bytes) {
      const chunk = await this.#run('readonly', async tx => {
        const actual = this.#field(await tx.objectStore('fields').get([table, index, expected.field]))
        if (
          actual.encoding !== expected.encoding ||
          actual.bytes !== expected.bytes ||
          (actual.sha256 !== null && actual.sha256 !== expected.sha256)
        )
          invalid()
        const stored = await tx.objectStore('chunks').get([table, index, expected.field, offset])
        if (stored === undefined) invalid()
        const bytes = detachBrc38PrivateChunk(stored.bytes, maximum)
        try {
          if (
            stored.size !== bytes.byteLength ||
            bytes.byteLength === 0 ||
            bytes.byteLength > expected.bytes - offset ||
            stored.sha256 !== new SHA256().update(bytes).digestHex()
          )
            invalid()
          return bytes
        } catch (cause) {
          bytes.fill(0)
          throw cause
        } finally {
          stored.bytes.fill(0)
        }
      })
      try {
        digest.update(chunk)
        decoder?.decode(chunk, { stream: true })
        offset += chunk.byteLength
        count++
        yield chunk
        this.#check()
      } finally {
        if (expected.encoding === 'utf8') chunk.fill(0)
      }
    }
    decoder?.decode()
    await this.#run('readonly', async tx => {
      const actual = this.#field(await tx.objectStore('fields').get([table, index, expected.field]))
      if (
        actual.bytes !== offset ||
        actual.chunks !== count ||
        actual.encoding !== expected.encoding ||
        (actual.sha256 !== null && actual.sha256 !== expected.sha256) ||
        digest.digestHex() !== expected.sha256 ||
        (await tx
          .objectStore('chunks')
          .count(
            IDBKeyRange.bound(
              [table, index, expected.field, 0],
              [table, index, expected.field, this.#limits.maximumLogicalBytes]
            )
          )) !== count
      )
        invalid()
    })
  }
  async finishBinaryField(table: Brc38StageTable, index: number, descriptor: Brc38JsonStreamedField): Promise<void> {
    if (!['base64', 'number-array'].includes(descriptor.encoding)) invalid()
    await this.#finishField(table, index, descriptor)
  }
  async finishStructuredField(
    table: Brc38StageTable,
    index: number,
    descriptor: Brc38JsonStructuredField
  ): Promise<void> {
    if (descriptor.encoding !== 'utf8-json') invalid()
    bound(descriptor.bytes, 2, this.#limits.maximumLogicalBytes)
    await this.#finishField(table, index, descriptor)
  }
  async finishTextField(table: Brc38StageTable, index: number, descriptor: Brc38JsonTextField): Promise<void> {
    if (descriptor.encoding !== 'utf8') invalid()
    bound(descriptor.bytes, 0, Math.min(1000000000, this.#limits.maximumLogicalBytes))
    await this.#finishField(table, index, descriptor)
  }
  async validateTextFields(
    table: Brc38StageTable,
    index: number,
    selected: NonNullable<Brc38JsonStreamedRow['texts']>
  ): Promise<void> {
    const names = Object.keys(selected),
      descriptors: Brc38JsonTextField[] = []
    if (names.length > 7) invalid()
    for (const field of names) {
      const value = selected[field]
      this.#coordinate(table, index, field, value.encoding)
      if (value.field !== field || value.encoding !== 'utf8' || !/^[0-9a-f]{64}$/.test(value.sha256)) invalid()
      bound(value.bytes, 0, Math.min(1000000000, this.#limits.maximumLogicalBytes))
      descriptors.push(Object.freeze({ field, encoding: 'utf8', bytes: value.bytes, sha256: value.sha256 }))
    }
    await this.#fieldWork(async () => {
      for (const descriptor of descriptors)
        for await (const chunk of this.#readFieldChunks(table, index, descriptor)) chunk.fill(0)
    })
  }
  async #finishField(table: Brc38StageTable, index: number, descriptor: PrivateFieldDescriptor): Promise<void> {
    const expected = Object.freeze({
      field: descriptor.field,
      encoding: descriptor.encoding,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256
    })
    await this.#fieldWork(async () => {
      for await (const chunk of this.#readFieldChunks(table, index, expected)) chunk.fill(0)
      await this.#run('readwrite', async tx => {
        const actual = this.#field(await tx.objectStore('fields').get([table, index, expected.field]))
        if (
          actual.bytes !== expected.bytes ||
          actual.encoding !== expected.encoding ||
          (actual.sha256 !== null && actual.sha256 !== expected.sha256)
        )
          invalid()
        if (actual.sha256 === expected.sha256) return
        if ((await this.#metadata(tx)).state !== 'staging' || actual.referenced) invalid()
        await tx.objectStore('fields').put({ ...actual, sha256: expected.sha256 }, [table, index, expected.field])
      })
    })
  }
  async streamedRow(table: Brc38StageTable, index: number): Promise<Brc38JsonStreamedRow | undefined> {
    return (await this.#readStreamedRow(table, index)).row
  }
  /** A fresh row DATA read whose actual retained decoded result stays charged
   * until disposed. A previous row/size/hash is never reused as admission. */
  async ownedStreamedRow(
    table: Brc38StageTable,
    index: number,
    selected: Brc38WorkingAllocation
  ): Promise<Readonly<{ row: Brc38JsonStreamedRow | undefined; close(): void }>> {
    const working = brc38WorkingAllocation(selected)
    if (working === undefined || working.maximum > this.#limits.maximumRowAllocationBytes) invalid()
    return await this.#readStreamedRow(table, index, working)
  }
  async #readStreamedRow(
    table: Brc38StageTable,
    index: number,
    working?: Brc38WorkingAllocation
  ): Promise<Readonly<{ row: Brc38JsonStreamedRow | undefined; close(): void }>> {
    if (!brc38StageTables.includes(table)) invalid()
    bound(index, 0, this.#limits.maximumRows - 1)
    // Admit bounded native string/metadata clones before get(), then extend
    // using FRESH actual bytes before hash/parse allocation. This does not model
    // the native browser engine's RSS or persistence/quota implementation.
    const nativeBytes = 32768 + 4 * this.#limits.maximumRowBytes,
      allowance = working?.claim(nativeBytes)
    let retainedBytes = 0
    try {
      const row = await this.#run('readonly', async tx => {
        const value = await tx.objectStore('rows').get([table, index])
        if (value === undefined) return undefined
        if (
          typeof value.payload !== 'string' ||
          value.payload.length > this.#limits.maximumRowBytes ||
          value.bytes > this.#limits.maximumRowBytes ||
          (value.binaryPayload !== undefined &&
            (typeof value.binaryPayload !== 'string' || value.binaryPayload.length > 2048)) ||
          (value.structuredPayload !== undefined &&
            (typeof value.structuredPayload !== 'string' || value.structuredPayload.length > 2048)) ||
          (value.textPayload !== undefined &&
            (typeof value.textPayload !== 'string' || value.textPayload.length > 4096))
        )
          invalid()
        const binaryBytes =
          (value.binaryPayload === undefined ? 0 : brc38Utf8ByteLength(value.binaryPayload)) +
          (value.structuredPayload === undefined ? 0 : brc38Utf8ByteLength(value.structuredPayload)) +
          (value.textPayload === undefined ? 0 : brc38Utf8ByteLength(value.textPayload))
        if (
          brc38Utf8ByteLength(value.payload) !== value.bytes ||
          !Number.isSafeInteger(value.bytes) ||
          value.bytes < 0 ||
          512 + 16 * (value.bytes + binaryBytes) > this.#limits.maximumRowAllocationBytes
        )
          invalid()
        retainedBytes =
          8192 +
          brc38JsonDecodedAllocation(value.payload) +
          (value.binaryPayload === undefined ? 0 : brc38JsonDecodedAllocation(value.binaryPayload)) +
          (value.structuredPayload === undefined ? 0 : brc38JsonDecodedAllocation(value.structuredPayload)) +
          (value.textPayload === undefined ? 0 : brc38JsonDecodedAllocation(value.textPayload))
        // Hash and parse occur serially. Reserve their larger current allowance,
        // while native row/header string clones remain independently held.
        allowance?.resize(nativeBytes + Math.max(4096 + 12 * (value.bytes + binaryBytes), retainedBytes))
        if (hash(value.payload) !== value.digest) invalid()
        const fields: PortableRow = JSON.parse(value.payload),
          binaries: Record<string, Brc38JsonStreamedField> =
            value.binaryPayload === undefined ? {} : JSON.parse(value.binaryPayload),
          structured: Record<string, Brc38JsonStructuredField> =
            value.structuredPayload === undefined ? {} : JSON.parse(value.structuredPayload),
          texts: Record<string, Brc38JsonTextField> =
            value.textPayload === undefined ? {} : JSON.parse(value.textPayload),
          all: Record<string, PrivateFieldDescriptor> = { ...binaries, ...structured, ...texts },
          names = Object.keys(all)
        if (
          Object.keys(binaries).length > 3 ||
          Object.keys(structured).length > 3 ||
          Object.keys(texts).length > 7 ||
          (await tx.objectStore('fields').count(IDBKeyRange.bound([table, index, ''], [table, index, '\uffff']))) !==
            names.length
        )
          invalid()
        for (const name of Object.keys(binaries))
          if (
            !brc38JsonBinaryField(table, name) ||
            !['base64', 'number-array'].includes(binaries[name].encoding) ||
            Object.hasOwn(structured, name) ||
            Object.hasOwn(texts, name)
          )
            invalid()
        for (const name of Object.keys(structured))
          if (
            !brc38JsonStructuredField(table, name) ||
            structured[name].encoding !== 'utf8-json' ||
            Object.hasOwn(texts, name)
          )
            invalid()
        for (const name of Object.keys(texts))
          if (!brc38JsonTextField(table, name) || texts[name].encoding !== 'utf8') invalid()
        for (const name of names) {
          const expected = all[name]
          this.#coordinate(table, index, name, expected.encoding)
          const actual = this.#field(await tx.objectStore('fields').get([table, index, name]))
          if (
            expected.field !== name ||
            Object.hasOwn(fields, name) ||
            !actual.referenced ||
            actual.bytes !== expected.bytes ||
            actual.sha256 !== expected.sha256 ||
            actual.encoding !== expected.encoding
          )
            invalid()
        }
        return {
          fields,
          binaries,
          ...(value.structuredPayload === undefined ? {} : { structured }),
          ...(value.textPayload === undefined ? {} : { texts })
        }
      })
      allowance?.resize(retainedBytes)
      return Object.freeze({ row, close: () => allowance?.close() })
    } catch (cause) {
      allowance?.close()
      throw cause
    }
  }
  async sealStreamed(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>
  ): Promise<void> {
    const capturedHeader = json(header, this.#limits, this.#signal).payload,
      expected = Object.freeze(
        Object.fromEntries(brc38StageTables.map(table => [table, counts[table]])) as Record<Brc38StageTable, number>
      )
    await this.#fieldWork(async () => {
      let fields = 0,
        chunks = 0
      for (const table of brc38StageTables) {
        bound(expected[table], 0, this.#limits.maximumRows)
        if ((await this.count(table)) !== expected[table]) invalid()
        for (let index = 0; index < expected[table]; index++) {
          const row = await this.streamedRow(table, index)
          if (row === undefined) invalid()
          for (const descriptor of [
            ...Object.values(row.binaries),
            ...Object.values(row.structured ?? {}),
            ...Object.values(row.texts ?? {})
          ]) {
            fields++
            for await (const chunk of this.#readFieldChunks(table, index, descriptor)) {
              chunks++
              chunk.fill(0)
            }
          }
        }
      }
      await this.#run('readonly', async tx => {
        const actual = await this.#metadata(tx)
        if (actual.binaryFields !== fields || actual.binaryReferences !== fields || actual.binaryChunks !== chunks)
          invalid()
      })
      await this.#seal(JSON.parse(capturedHeader) as BRC38WalletData, expected, true)
    })
  }
  async #retireStaleJsonIndexes(): Promise<void> {
    const began = performance.now(),
      deadline = Date.now() + 30000
    let done = false
    while (!done) {
      if (Date.now() >= deadline || performance.now() - began >= 30000)
        throw new SnapshotResourceLimitError('Private browser stale-index retirement calendar reached')
      done = await this.#run('readwrite', async tx => {
        const meta = await this.#metadata(tx),
          cursor = await tx.objectStore('jsonIndexes').openCursor()
        if (cursor === null) {
          if (meta.jsonIndexes !== 0 || meta.jsonMembers !== 0 || (await tx.objectStore('jsonMembers').count()) !== 0)
            invalid()
          return true
        }
        const id = cursor.key,
          record = cursor.value
        if (!/^[0-9a-f]{32}$/.test(id) || !['pending', 'sealed', 'retiring'].includes(record.state)) invalid()
        this.#coordinate(record.table, record.position, record.field, 'utf8-json')
        const field = this.#field(await tx.objectStore('fields').get([record.table, record.position, record.field]))
        if (
          field.encoding !== 'utf8-json' ||
          field.bytes !== record.sourceBytes ||
          field.sha256 !== record.sha256 ||
          !/^[0-9a-f]{64}$/.test(record.sha256)
        )
          invalid()
        bound(record.maximumBytes, 1048576, this.#limits.maximumLogicalBytes)
        bound(record.maximumMembers, 1, this.#maximumKeys)
        bound(record.members, 0, record.maximumMembers)
        bound(record.bytes, 0, record.maximumBytes)
        let member = await tx.objectStore('jsonMembers').openCursor(IDBKeyRange.bound([id], [id, []])),
          removed = 0,
          bytes = 0
        while (member !== null && removed < 16) {
          const value = member.value,
            key = member.key
          if (
            key[0] !== id ||
            key[2] !== value.key ||
            typeof value.key !== 'string' ||
            value.key.length > 8192 ||
            value.charge !== 256 + 2 * value.key.length
          )
            invalid()
          for (const offset of [key[1], value.keyOffset, value.firstKeyOffset, value.start, value.end])
            bound(offset, 0, record.sourceBytes)
          if (
            value.firstKeyOffset > value.keyOffset ||
            value.keyOffset >= value.start ||
            value.start >= value.end ||
            key[1] >= value.firstKeyOffset
          )
            invalid()
          await member.delete()
          removed++
          bytes += value.charge
          member = await member.continue()
        }
        if (
          removed > record.members ||
          bytes > record.bytes ||
          removed > meta.jsonMembers ||
          bytes > meta.logicalBytes - 4096
        )
          invalid()
        if (member === null) {
          if (record.members !== removed || record.bytes !== bytes || meta.jsonIndexes < 1) invalid()
          await cursor.delete()
        } else
          await cursor.update({
            ...record,
            state: 'retiring',
            members: record.members - removed,
            bytes: record.bytes - bytes
          })
        await tx.objectStore('metadata').put(
          {
            ...meta,
            jsonIndexes: meta.jsonIndexes - (member === null ? 1 : 0),
            jsonMembers: meta.jsonMembers - removed,
            logicalBytes: meta.logicalBytes - bytes - (member === null ? 512 : 0)
          },
          1
        )
        return false
      })
    }
  }
  async validateIdbStructuredFields(
    table: Brc38StageTable,
    index: number,
    selected: NonNullable<Brc38JsonStreamedRow['structured']>,
    selectedPolicy: Brc38PrivateIdbStructuredPolicy
  ): Promise<void> {
    const policy = brc38PrivateIdbStructuredPolicy(selectedPolicy),
      names = Object.keys(selected),
      descriptors: Brc38JsonStructuredField[] = []
    if (
      policy.databaseName !== this.#databaseName ||
      policy.maximumTemporaryIndexBytes > this.#limits.maximumLogicalBytes ||
      policy.maximumIndexMembers > this.#maximumKeys ||
      policy.maximumStructuredBytes > this.#limits.maximumLogicalBytes ||
      (policy.signal !== undefined && policy.signal !== this.#signal) ||
      names.length > 3
    )
      invalid()
    for (const field of names) {
      const value = selected[field]
      this.#coordinate(table, index, field, value.encoding)
      if (value.field !== field || value.encoding !== 'utf8-json' || !/^[0-9a-f]{64}$/.test(value.sha256)) invalid()
      bound(value.bytes, 2, policy.maximumStructuredBytes)
      descriptors.push(Object.freeze({ field, encoding: 'utf8-json', bytes: value.bytes, sha256: value.sha256 }))
    }
    await this.#fieldWork(async () => {
      for (const descriptor of descriptors) {
        const source: Brc38StreamedStructured = {
          encoding: 'utf8',
          length: descriptor.bytes,
          sha256: descriptor.sha256,
          read: async (offset, length) => await this.#readStructuredExtent(table, index, descriptor, offset, length),
          openIndex: async () => await this.#openJsonIndex(table, index, descriptor, policy)
        }
        await validateBrc38StructuredWalletField(
          descriptor.field,
          source,
          {
            maximumInputBytes: policy.maximumStructuredBytes,
            maximumOutputBytes: policy.maximumCanonicalBytes,
            maximumChunkBytes: 4096,
            signal: this.#signal
          },
          `${table}[${index}]`
        )
      }
    })
  }
  /** A bounded current source reader for preparation outside the wallet writer.
   * Grammar and derived indexes use this actor's actual eight native stores;
   * none of the returned descriptors/spans authenticate an encrypted source.
   * Each read/index operation checks the original owner, schema, metadata and
   * field again. Reservations survive until actual I/O and indexes close. */
  async openStructuredField(
    table: Brc38StageTable,
    position: number,
    field: string,
    selected: Brc38PrivateIdbStructuredPolicy,
    selectedWorking: Brc38WorkingAllocation,
    expiresAt: number
  ): Promise<Brc38PrivateIdbStructuredRead> {
    const policy = brc38PrivateIdbStructuredPolicy(selected),
      working = brc38WorkingAllocation(selectedWorking)
    this.#coordinate(table, position, field, 'utf8-json')
    this.#check()
    if (
      working === undefined ||
      working.maximum > this.#limits.maximumRowAllocationBytes ||
      policy.databaseName !== this.#databaseName ||
      policy.maximumTemporaryIndexBytes > this.#limits.maximumLogicalBytes ||
      policy.maximumIndexMembers > this.#maximumKeys ||
      policy.maximumStructuredBytes > this.#limits.maximumLogicalBytes ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt > this.#limits.expiresAt
    )
      invalid()
    const deadline = Math.min(this.#monotonicDeadline, performance.now() + Math.max(0, expiresAt - Date.now())),
      // Only the bounded descriptor and owner sets survive acquisition. Native
      // metadata clones belong to the drained operation, not the reader's
      // entire lifetime; read/index operations reserve those independently.
      reservation = working.claim(8192),
      indexes = new Set<Brc38JsonMemberIndex>(),
      acquisitions = new Set<() => Promise<void>>()
    let closed = false,
      busy = false,
      active: Promise<unknown> = Promise.resolve(),
      closing: Promise<void> | undefined
    const check = (): void => {
      this.#check()
      policy.signal?.throwIfAborted()
      if (closed || Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Private browser structured reader is closed or expired')
    }
    const run = async <T>(work: () => Promise<T>): Promise<T> => {
      check()
      if (busy) throw new Error('Private browser structured reader already owns an operation')
      busy = true
      const operation = Promise.resolve().then(work)
      active = operation
      try {
        const value = await operation
        check()
        return value
      } finally {
        busy = false
      }
    }
    let descriptor: Readonly<Brc38JsonStructuredField>
    let acquisition: Brc38WorkingCharge | undefined
    try {
      acquisition = working.claim(8 * this.#limits.maximumRowBytes)
      descriptor = await run(
        async () =>
          await this.#run('readonly', async tx => {
            const meta = await this.#metadata(tx),
              actual = this.#field(await tx.objectStore('fields').get([table, position, field]))
            if (
              meta.state !== 'sealed' ||
              actual.encoding !== 'utf8-json' ||
              actual.sha256 === null ||
              !actual.referenced ||
              (await tx.objectStore('rows').getKey([table, position])) === undefined
            )
              invalid()
            bound(actual.bytes, 2, policy.maximumStructuredBytes)
            return Object.freeze({ field, encoding: 'utf8-json' as const, bytes: actual.bytes, sha256: actual.sha256 })
          })
      )
    } catch (cause) {
      reservation.close()
      throw cause
    } finally {
      acquisition?.close()
    }
    const openIndex = async (
      requested: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]
    ): Promise<Brc38JsonMemberIndex> => {
      const captured = Object.freeze({ ...requested })
      check()
      bound(captured.sourceBytes, descriptor.bytes, Math.max(32, descriptor.bytes))
      if (
        captured.workingAllocation !== working ||
        captured.expiresAt > expiresAt ||
        !Number.isSafeInteger(captured.expiresAt) ||
        captured.maximumTemporaryIndexBytes > policy.maximumTemporaryIndexBytes ||
        captured.maximumMembers > policy.maximumIndexMembers ||
        (captured.maximumAllocationBytes !== undefined && captured.maximumAllocationBytes > working.maximum)
      )
        invalid()
      const actualPolicy = brc38PrivateIdbStructuredPolicy({
        ...policy,
        maximumTemporaryIndexBytes: captured.maximumTemporaryIndexBytes,
        maximumIndexMembers: captured.maximumMembers
      })
      const maximumAllocation = captured.maximumAllocationBytes ?? working.maximum
      bound(maximumAllocation, 4096, working.maximum)
      if (4096 + 16 * 8192 + 8192 + 8 * this.#limits.maximumRowBytes + 32 * 8192 > maximumAllocation)
        throw new SnapshotResourceLimitError('Private browser index exceeds its original individual allocation')
      const retained = working.claim(4096 + 16 * 8192)
      let scratch: ReturnType<Brc38WorkingAllocation['claim']> | undefined
      let actual: Brc38JsonMemberIndex | undefined
      let acquisitionCleanup: Brc38StagingCleanupError | undefined
      const release = async (): Promise<void> => {
        if (acquisitionCleanup !== undefined) {
          await acquisitionCleanup.retryCleanup()
          acquisitionCleanup = undefined
        }
        if (actual !== undefined) await actual.close()
        retained.close()
        acquisitions.delete(release)
      }
      try {
        scratch = working.claim(8192 + 8 * this.#limits.maximumRowBytes + 32 * 8192)
        await run(async () => {
          actual = await this.#openJsonIndex(table, position, descriptor, actualPolicy)
        })
        const indexCheck = (): void => {
          check()
          captured.signal?.throwIfAborted()
          if (Date.now() >= captured.expiresAt)
            throw new SnapshotResourceLimitError('Private browser projection index expired')
        }
        let indexClosed = false,
          indexBusy = false,
          pending: Promise<unknown> = Promise.resolve(),
          indexClosing: Promise<void> | undefined
        const iterators = new Set<AsyncGenerator<Brc38JsonMember>>()
        const operation = async <T>(work: () => Promise<T>): Promise<T> => {
          indexCheck()
          if (indexClosed || indexBusy) throw new Error('Private browser projection index is closed or busy')
          const charge = working.claim(8192 + 8 * this.#limits.maximumRowBytes + 32 * 8192)
          indexBusy = true
          const task = Promise.resolve().then(work)
          pending = task
          try {
            const value = await task
            indexCheck()
            return value
          } finally {
            charge.close()
            indexBusy = false
          }
        }
        const owned: Brc38JsonMemberIndex = {
          put: async (offset, member) => {
            indexCheck()
            const copy = Object.freeze({
              key: member.key,
              keyOffset: member.keyOffset,
              start: member.start,
              end: member.end
            })
            await operation(async () => await actual!.put(offset, copy))
          },
          seal: async () => await operation(async () => await actual!.seal()),
          lookup: async (offset, key) => await operation(async () => await actual!.lookup!(offset, key)),
          nextEntry: async (offset, after) => {
            indexCheck()
            if (indexClosed || iterators.size !== 0)
              throw new Error('Private browser index already owns its retained member iterator')
            return await operation(async () => await actual!.nextEntry!(offset, after))
          },
          entries: offset => {
            indexCheck()
            if (indexClosed || iterators.size !== 0)
              throw new Error('Private browser index already owns its retained member iterator')
            const iterator = actual!.entries(offset)[Symbol.asyncIterator]()
            let iteratorClosed = false
            let output: AsyncGenerator<Brc38JsonMember> | undefined
            output = (async function* (): AsyncGenerator<Brc38JsonMember> {
              try {
                while (true) {
                  const result = await operation(async () => await iterator.next())
                  if (result.done) {
                    iteratorClosed = true
                    return
                  }
                  indexCheck()
                  yield result.value
                  indexCheck()
                }
              } finally {
                try {
                  if (!iteratorClosed) await iterator.return?.()
                } finally {
                  if (output !== undefined) iterators.delete(output)
                }
              }
            })()
            iterators.add(output)
            return output
          },
          close: () => {
            if (indexClosing !== undefined) return indexClosing
            indexClosed = true
            indexClosing = (async () => {
              await Promise.allSettled([pending])
              for (const iterator of iterators) await iterator.return(undefined)
              iterators.clear()
              await release()
              indexes.delete(owned)
            })()
            void indexClosing.catch(() => {
              indexClosing = undefined
            })
            return indexClosing
          }
        }
        indexes.add(owned)
        return owned
      } catch (cause) {
        if (cause instanceof Brc38StagingCleanupError) acquisitionCleanup = cause
        try {
          await release()
        } catch (error_) {
          acquisitions.add(release)
          throw new Brc38StagingCleanupError(
            [cause, error_],
            'Private structured reader retains acquired index and resource cleanup',
            release
          )
        }
        throw cause
      } finally {
        scratch?.close()
      }
    }
    const source: Brc38StreamedStructured = Object.freeze({
      encoding: 'utf8' as const,
      length: descriptor.bytes,
      sha256: descriptor.sha256,
      read: async (offset: number, length: number) => {
        bound(offset, 0, descriptor.bytes)
        bound(length, 0, Math.min(65536, descriptor.bytes - offset))
        const width = Math.min(65536, Math.floor((this.#limits.maximumRowAllocationBytes - 4096) / 32)),
          charge = working.claim(8192 + 8 * this.#limits.maximumRowBytes + 12 * width + 4 * length)
        let result: Uint8Array | undefined
        try {
          return await run(async () => {
            result = await this.#readStructuredExtent(table, position, descriptor, offset, length)
            return result
          })
        } catch (cause) {
          result?.fill(0)
          throw cause
        } finally {
          charge.close()
        }
      },
      openIndex: async () =>
        await openIndex({
          sourceBytes: descriptor.bytes,
          maximumTemporaryIndexBytes: policy.maximumTemporaryIndexBytes,
          maximumTemporaryPhysicalBytes: policy.maximumTemporaryIndexBytes,
          maximumMembers: policy.maximumIndexMembers,
          maximumAllocationBytes: working.maximum,
          workingAllocation: working,
          expiresAt,
          signal: policy.signal
        })
    })
    const reader: Brc38PrivateIdbStructuredRead = Object.freeze({
      source,
      check,
      openIndex,
      close: (): Promise<void> => {
        if (closing !== undefined) return closing
        closed = true
        closing = (async () => {
          await Promise.allSettled([active])
          const failures: unknown[] = []
          for (const release of acquisitions)
            try {
              await release()
            } catch (cause) {
              failures.push(cause)
            }
          for (const index of indexes)
            try {
              await index.close()
            } catch (cause) {
              failures.push(cause)
            }
          if (failures.length !== 0)
            throw new Brc38StagingCleanupError(
              failures,
              'Private browser structured reader retains native index cleanup',
              async () => await reader.close()
            )
          reservation.close()
          this.#structuredReaders.delete(reader)
        })()
        void closing.catch(() => {
          closing = undefined
        })
        return closing
      }
    })
    this.#structuredReaders.add(reader)
    return reader
  }
  async #readStructuredExtent(
    table: Brc38StageTable,
    index: number,
    descriptor: Brc38JsonStructuredField,
    offset: number,
    length: number
  ): Promise<Uint8Array> {
    bound(offset, 0, descriptor.bytes)
    bound(length, 0, Math.min(65536, descriptor.bytes - offset))
    if (4096 + 32 * length > this.#limits.maximumRowAllocationBytes)
      throw new SnapshotResourceLimitError('Private browser structured read allocation reached')
    return await this.#run('readonly', async tx => {
      const actual = this.#field(await tx.objectStore('fields').get([table, index, descriptor.field]))
      if (actual.encoding !== 'utf8-json' || actual.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256)
        invalid()
      const result = new Uint8Array(length),
        chunks = tx.objectStore('chunks')
      let used = 0,
        at = offset
      while (used < length) {
        const cursor = await chunks.openCursor(
          IDBKeyRange.bound([table, index, descriptor.field, 0], [table, index, descriptor.field, at]),
          'prev'
        )
        if (cursor === null) invalid()
        const start = cursor.key[3],
          stored = cursor.value,
          bytes = detachBrc38PrivateChunk(
            stored.bytes,
            Math.min(65536, Math.floor((this.#limits.maximumRowAllocationBytes - 4096) / 32))
          )
        try {
          if (
            start > at ||
            at >= start + bytes.length ||
            stored.size !== bytes.length ||
            stored.sha256 !== new SHA256().update(bytes).digestHex() ||
            4096 + 16 * (length + bytes.length) > this.#limits.maximumRowAllocationBytes
          )
            invalid()
          const amount = Math.min(length - used, start + bytes.length - at)
          result.set(bytes.subarray(at - start, at - start + amount), used)
          used += amount
          at += amount
        } finally {
          bytes.fill(0)
        }
      }
      return result
    })
  }
  async #openJsonIndex(
    table: Brc38StageTable,
    position: number,
    descriptor: Brc38JsonStructuredField,
    policy: Readonly<Brc38PrivateIdbStructuredPolicy>
  ): Promise<Brc38JsonMemberIndex> {
    const id = nonce()
    let closed = false,
      busy = false,
      active: Promise<unknown> = Promise.resolve(),
      closing: Promise<void> | undefined
    const fresh = async (tx: Transaction, state: JsonIndexRecord['state']): Promise<JsonIndexRecord> => {
      const actual = await tx.objectStore('jsonIndexes').get(id),
        field = this.#field(await tx.objectStore('fields').get([table, position, descriptor.field]))
      if (
        actual === undefined ||
        actual.state !== state ||
        actual.table !== table ||
        actual.position !== position ||
        actual.field !== descriptor.field ||
        actual.sourceBytes !== descriptor.bytes ||
        actual.sha256 !== descriptor.sha256 ||
        actual.maximumBytes !== policy.maximumTemporaryIndexBytes ||
        actual.maximumMembers !== policy.maximumIndexMembers ||
        field.encoding !== 'utf8-json' ||
        field.bytes !== descriptor.bytes ||
        field.sha256 !== descriptor.sha256
      )
        invalid()
      bound(actual.bytes, 0, actual.maximumBytes)
      bound(actual.members, 0, actual.maximumMembers)
      return actual
    }
    const member = (value: Brc38JsonMember): Brc38JsonMember => {
      const captured = { key: value.key, keyOffset: value.keyOffset, start: value.start, end: value.end }
      if (typeof captured.key !== 'string' || captured.key.length > 8192) invalid()
      for (const at of [captured.keyOffset, captured.start, captured.end]) bound(at, 0, descriptor.bytes)
      if (
        captured.start <= captured.keyOffset ||
        captured.end <= captured.start ||
        4096 + 16 * (256 + 2 * captured.key.length) > this.#limits.maximumRowAllocationBytes
      )
        invalid()
      return captured
    }
    const operation = async <T, Mode extends 'readonly' | 'readwrite'>(
      mode: Mode,
      state: JsonIndexRecord['state'],
      work: (tx: Transaction<Mode>, record: JsonIndexRecord) => Promise<T>
    ): Promise<T> => {
      if (closed || busy) throw new Error('Private browser JSON index is closed or already owns an operation')
      busy = true
      const run = this.#run(mode, async tx => {
        const record = await fresh(tx, state),
          result = await work(tx, record)
        if (closed) throw new Error('Private browser JSON index was revoked')
        return result
      })
      active = run
      try {
        return await run
      } finally {
        busy = false
      }
    }
    const index: Brc38JsonMemberIndex = {
      put: async (objectOffset, selected) => {
        const value = member(selected)
        bound(objectOffset, 0, value.keyOffset - 1)
        const charge = 256 + 2 * value.key.length
        await operation('readwrite', 'pending', async (tx, record) => {
          const meta = await this.#metadata(tx),
            members = tx.objectStore('jsonMembers'),
            key: [string, number, string] = [id, objectOffset, value.key],
            prior = await members.get(key),
            added = prior === undefined ? 1 : 0
          if (prior !== undefined) {
            member(prior)
            if (prior.charge !== charge || prior.firstKeyOffset > prior.keyOffset) invalid()
          }
          if (
            added &&
            (record.members >= record.maximumMembers ||
              charge > record.maximumBytes - record.bytes ||
              meta.keys + meta.binaryFields + meta.binaryChunks + meta.jsonIndexes + meta.jsonMembers >=
                this.#maximumKeys ||
              charge > this.#limits.maximumLogicalBytes - meta.logicalBytes)
          )
            throw new SnapshotResourceLimitError('Private browser JSON member reservation reached')
          await members.put(
            { ...value, firstKeyOffset: Math.min(prior?.firstKeyOffset ?? value.keyOffset, value.keyOffset), charge },
            key
          )
          await tx
            .objectStore('jsonIndexes')
            .put({ ...record, members: record.members + added, bytes: record.bytes + added * charge }, id)
          await tx
            .objectStore('metadata')
            .put(
              { ...meta, jsonMembers: meta.jsonMembers + added, logicalBytes: meta.logicalBytes + added * charge },
              1
            )
        })
      },
      seal: async () =>
        await operation('readwrite', 'pending', async (tx, record) => {
          if ((await tx.objectStore('jsonMembers').count(IDBKeyRange.bound([id], [id, []]))) !== record.members)
            invalid()
          await tx.objectStore('jsonIndexes').put({ ...record, state: 'sealed' }, id)
        }),
      nextEntry: async (objectOffset, after) => {
        bound(objectOffset, 0, descriptor.bytes - 1)
        if (after !== undefined && (typeof after !== 'string' || after.length > 8192)) invalid()
        return await operation('readonly', 'sealed', async tx => {
          const cursor = await tx
            .objectStore('jsonMembers')
            .openCursor(
              IDBKeyRange.bound(
                after === undefined ? [id, objectOffset] : [id, objectOffset, after],
                [id, objectOffset, []],
                after !== undefined
              )
            )
          if (cursor === null) return undefined
          const value = member(cursor.value)
          if (
            cursor.key[0] !== id ||
            cursor.key[1] !== objectOffset ||
            cursor.key[2] !== value.key ||
            cursor.value.charge !== 256 + 2 * value.key.length ||
            (after !== undefined && value.key <= after)
          )
            invalid()
          return value
        })
      },
      entries: async function* (objectOffset) {
        bound(objectOffset, 0, descriptor.bytes - 1)
        let after: string | undefined
        while (true) {
          const item = await operation('readonly', 'sealed', async tx => {
            const cursor = await tx
              .objectStore('jsonMembers')
              .openCursor(
                IDBKeyRange.bound(
                  after === undefined ? [id, objectOffset] : [id, objectOffset, after],
                  [id, objectOffset, []],
                  after !== undefined
                )
              )
            if (cursor === null) return undefined
            const value = member(cursor.value)
            if (
              cursor.key[0] !== id ||
              cursor.key[1] !== objectOffset ||
              cursor.key[2] !== value.key ||
              cursor.value.charge !== 256 + 2 * value.key.length ||
              (after !== undefined && value.key <= after)
            )
              invalid()
            return value
          })
          if (item === undefined) return
          after = item.key
          yield item
        }
      },
      lookup: async (objectOffset, key) => {
        bound(objectOffset, 0, descriptor.bytes - 1)
        if (typeof key !== 'string' || key.length > 8192) invalid()
        return await operation('readonly', 'sealed', async tx => {
          const stored = await tx.objectStore('jsonMembers').get([id, objectOffset, key])
          if (stored === undefined) return undefined
          const value = member(stored)
          bound(stored.firstKeyOffset, objectOffset + 1, value.keyOffset)
          if (stored.key !== key || stored.charge !== 256 + 2 * key.length) invalid()
          return { ...value, firstKeyOffset: stored.firstKeyOffset }
        })
      },
      close: () => {
        if (closing !== undefined) return closing
        closed = true
        closing = (async () => {
          await Promise.allSettled([active])
          const began = performance.now(),
            deadline = Date.now() + 30000
          let done = false
          while (!done) {
            if (Date.now() >= deadline || performance.now() - began >= 30000)
              throw new SnapshotResourceLimitError('Private browser JSON index cleanup calendar reached')
            done = await this.#run(
              'readwrite',
              async tx => {
                const record = await tx.objectStore('jsonIndexes').get(id)
                if (record === undefined) {
                  // Cleanup can have committed before a post-commit owner check
                  // fails. Retry proves actual absence and fresh global counters;
                  // it never restores a reader or supplies a live index verdict.
                  const meta = await this.#metadata(tx)
                  if (
                    (await tx.objectStore('jsonMembers').count(IDBKeyRange.bound([id], [id, []]))) !== 0 ||
                    (await tx.objectStore('jsonIndexes').count()) !== meta.jsonIndexes ||
                    (await tx.objectStore('jsonMembers').count()) !== meta.jsonMembers
                  )
                    invalid()
                  return true
                }
                const current = await fresh(tx, record.state),
                  meta = await this.#metadata(tx)
                let cursor = await tx.objectStore('jsonMembers').openCursor(IDBKeyRange.bound([id], [id, []])),
                  removed = 0,
                  bytes = 0
                while (cursor !== null && removed < 16) {
                  const value = member(cursor.value),
                    charge = 256 + 2 * value.key.length
                  if (cursor.value.charge !== charge || cursor.key[0] !== id) invalid()
                  await cursor.delete()
                  removed++
                  bytes += charge
                  cursor = await cursor.continue()
                }
                if (
                  removed > current.members ||
                  bytes > current.bytes ||
                  removed > meta.jsonMembers ||
                  bytes > meta.logicalBytes - 4096
                )
                  invalid()
                if (cursor === null) {
                  if (current.members !== removed || current.bytes !== bytes || meta.jsonIndexes < 1) invalid()
                  await tx.objectStore('jsonIndexes').delete(id)
                } else
                  await tx.objectStore('jsonIndexes').put(
                    {
                      ...current,
                      state: 'retiring',
                      members: current.members - removed,
                      bytes: current.bytes - bytes
                    },
                    id
                  )
                await tx.objectStore('metadata').put(
                  {
                    ...meta,
                    jsonIndexes: meta.jsonIndexes - (cursor === null ? 1 : 0),
                    jsonMembers: meta.jsonMembers - removed,
                    logicalBytes: meta.logicalBytes - bytes - (cursor === null ? 512 : 0)
                  },
                  1
                )
                return cursor === null
              },
              false,
              true
            )
          }
          this.#jsonCleanup.delete(index)
          this.#jsonFailedCleanup.delete(index)
        })().catch(cause => {
          closing = undefined
          this.#jsonFailedCleanup.add(index)
          throw new Brc38StagingCleanupError(
            [cause],
            'Private browser retains its actual structured index cleanup',
            async () => await index.close()
          )
        })
        return closing
      }
    }
    this.#jsonCleanup.add(index)
    try {
      await this.#run('readwrite', async tx => {
        const meta = await this.#metadata(tx),
          actual = this.#field(await tx.objectStore('fields').get([table, position, descriptor.field]))
        if (actual.encoding !== 'utf8-json' || actual.sha256 !== descriptor.sha256 || actual.bytes !== descriptor.bytes)
          invalid()
        if (
          meta.keys + meta.binaryFields + meta.binaryChunks + meta.jsonIndexes + meta.jsonMembers >=
            this.#maximumKeys ||
          512 > this.#limits.maximumLogicalBytes - meta.logicalBytes
        )
          throw new SnapshotResourceLimitError('Private browser JSON index reservation reached')
        await tx.objectStore('jsonIndexes').add(
          {
            table,
            position,
            field: descriptor.field,
            sourceBytes: descriptor.bytes,
            sha256: descriptor.sha256,
            maximumBytes: policy.maximumTemporaryIndexBytes,
            maximumMembers: policy.maximumIndexMembers,
            members: 0,
            bytes: 0,
            state: 'pending'
          },
          id
        )
        await tx
          .objectStore('metadata')
          .put({ ...meta, jsonIndexes: meta.jsonIndexes + 1, logicalBytes: meta.logicalBytes + 512 }, 1)
      })
      return index
    } catch (cause) {
      try {
        await index.close()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private browser JSON acquisition retains its actual index cleanup',
          async () => await index.close()
        )
      }
      throw cause
    }
  }
  /** Revokes before draining. Close does not silently renew, delete or activate
   * this private archive; the explicit release preserves restart metadata. */
  close(): Promise<void> {
    if (this.#deleting) return this.#awaitDelete()
    if (this.#released) return Promise.resolve()
    if (this.#closing !== undefined) return this.#closing
    this.#open = false
    this.#closing = (async () => {
      await Promise.allSettled([this.#active, this.#fieldActive])
      for (const reader of this.#structuredReaders) await reader.close()
      try {
        this.#ownership.assertOwned()
      } catch {
        // A revoked kernel owner cannot clear another actor's durable claim.
        // Its own connection and original lock request still require drainage.
        this.#closeNative()
        await this.#ownership.release()
        this.#released = true
        return
      }
      if (!this.#claimAcquired || this.#nativeClosed) {
        this.#closeNative()
        await this.#ownership.release()
        this.#released = true
        return
      }
      for (const index of this.#jsonCleanup) await index.close()
      const tx = wrap(
        this.#transaction.call(this.#native, [...stores], 'readwrite')
      ) as unknown as Transaction<'readwrite'>
      void tx.done.catch(() => undefined)
      const timer = setTimeout(() => {
        try {
          tx.abort()
        } catch {
          /* settled */
        }
      }, 30000)
      try {
        this.#ownership.assertOwned()
        this.#schema(tx)
        const meta = await tx.objectStore('metadata').get(1)
        if (meta !== undefined) {
          if (
            meta.owner !== this.#claim ||
            meta.bindingJson !== this.#bound.bindingJson ||
            meta.limitsJson !== this.#bound.limitsJson ||
            meta.bindingSha256 !== this.#bound.digest ||
            meta.state === 'deleting'
          )
            invalid()
          await tx.objectStore('metadata').put({ ...meta, owner: null }, 1)
        } else if (!this.#ownsCreation) invalid()
        await tx.done
      } catch (cause) {
        try {
          tx.abort()
        } catch {
          /* settled */
        }
        await tx.done.catch(() => undefined)
        throw cause
      } finally {
        clearTimeout(timer)
      }
      this.#closeNative()
      await this.#ownership.release()
      this.#released = true
    })()
    void this.#closing.catch(() => {
      this.#closing = undefined
    })
    return this.#closing
  }
  async #awaitDelete(): Promise<void> {
    if (this.#deleteSettled) {
      await this.#ownership.release()
      this.#released = true
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.#deleteFailed || this.#deleteCompletion === undefined) {
        this.#closeNative()
        await this.#restartDelete()
      }
      const completion = this.#deleteCompletion
      if (completion === undefined) invalid()
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Private IndexedDB disposal remains blocked')), 30000)
        })
      ])
      await this.#ownership.release()
      this.#released = true
    } catch (cause) {
      throw new Brc38StagingCleanupError([cause], 'Private IndexedDB retains its actual deletion request', () =>
        this.#awaitDelete()
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  #dispatchDelete(): void {
    this.#ownership.assertOwned()
    this.#deleteFailed = false
    let request: IDBOpenDBRequest
    try {
      request = this.#deleteDatabase.call(this.#factory, this.#databaseName)
    } catch (cause) {
      this.#deleteFailed = true
      this.#deleteCompletion = Promise.reject(cause)
      void this.#deleteCompletion.catch(() => undefined)
      return
    }
    this.#deleteCompletion = new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        this.#deleteSettled = true
        resolve()
      }
      request.onerror = () => {
        this.#deleteFailed = true
        reject(request.error ?? new Error('Private IndexedDB disposal failed'))
      }
    })
    void this.#deleteCompletion.catch(() => undefined)
  }
  #restartDelete(): Promise<void> {
    if (this.#deleteRetry !== undefined) return this.#deleteRetry
    this.#deleteRetry = (async () => {
      this.#ownership.assertOwned()
      for (const cleanup of this.#deleteOpenCleanup) {
        await cleanup.retryCleanup()
        this.#deleteOpenCleanup.delete(cleanup)
      }
      // Only cleanup may reopen this connection. Fresh persisted ownership and
      // deleting state must still match before another deletion request.
      let database: IDBPDatabase<Schema>
      try {
        database = await Brc38PrivateIdbStage.#openDatabase(
          this.#databaseName,
          this.#ownership,
          Date.now() + 30000,
          undefined,
          undefined,
          false
        )
      } catch (cause) {
        if (cause instanceof Brc38StagingCleanupError) this.#deleteOpenCleanup.add(cause)
        throw cause
      }
      const native = unwrap(database)
      if (native === undefined) {
        database.close()
        invalid()
      }
      try {
        if (native.version !== 1 || native.objectStoreNames.length !== stores.length) invalid()
        const tx = wrap(this.#transaction.call(native, [...stores], 'readonly')) as Transaction
        void tx.done.catch(() => undefined)
        const timer = setTimeout(() => {
          try {
            tx.abort()
          } catch {
            /* settled */
          }
        }, 30000)
        try {
          this.#schema(tx)
          const meta = await tx.objectStore('metadata').get(1)
          if (
            meta?.state !== 'deleting' ||
            meta.owner !== this.#claim ||
            meta.bindingSha256 !== this.#bound.digest ||
            meta.bindingJson !== this.#bound.bindingJson ||
            meta.limitsJson !== this.#bound.limitsJson
          )
            invalid()
          await tx.done
          this.#ownership.assertOwned()
        } catch (cause) {
          try {
            tx.abort()
          } catch {
            /* settled */
          }
          await tx.done.catch(() => undefined)
          throw cause
        } finally {
          clearTimeout(timer)
        }
      } finally {
        this.#nativeClose.call(native)
      }
      this.#dispatchDelete()
    })().finally(() => {
      this.#deleteRetry = undefined
    })
    return this.#deleteRetry
  }
  async discard(_cause: unknown): Promise<void> {
    if (this.#deleting) return await this.#awaitDelete()
    if (this.#needsReleasedDisposal) return await this.#disposeReleased()
    if (this.#released || this.#closing !== undefined)
      throw new Error('Released private IndexedDB stage must be explicitly re-admitted before disposal')
    this.#open = false
    await Promise.allSettled([this.#active, this.#fieldActive])
    let ownsKernel = true
    try {
      this.#ownership.assertOwned()
    } catch {
      ownsKernel = false
    }
    if (this.#nativeClosed || !ownsKernel) {
      this.#needsReleasedDisposal = true
      return await this.#disposeReleased()
    }
    const tx = wrap(
      this.#transaction.call(this.#native, [...stores], 'readwrite')
    ) as unknown as Transaction<'readwrite'>
    void tx.done.catch(() => undefined)
    const timer = setTimeout(() => {
      try {
        tx.abort()
      } catch {
        /* settled */
      }
    }, 30000)
    try {
      this.#ownership.assertOwned()
      this.#schema(tx)
      const meta = await tx.objectStore('metadata').get(1)
      if (meta === undefined) {
        if (
          !this.#ownsCreation ||
          (await tx.objectStore('rows').count()) !== 0 ||
          (await tx.objectStore('keys').count()) !== 0
        )
          invalid()
      } else {
        if (
          meta.owner !== this.#claim ||
          meta.bindingJson !== this.#bound.bindingJson ||
          meta.limitsJson !== this.#bound.limitsJson ||
          meta.bindingSha256 !== this.#bound.digest ||
          !['staging', 'sealed'].includes(meta.state)
        )
          invalid()
        // A durable deleting state forbids a successor's resume before the
        // actual origin deletion request is dispatched. No delete-by-digest.
        await tx.objectStore('metadata').put({ ...meta, state: 'deleting' }, 1)
      }
      await tx.done
      this.#deleting = true
    } catch (cause) {
      try {
        tx.abort()
      } catch {
        /* settled */
      }
      await tx.done.catch(() => undefined)
      throw cause
    } finally {
      clearTimeout(timer)
    }
    this.#closeNative()
    this.#dispatchDelete()
    await this.#awaitDelete()
  }
  #disposeReleased(): Promise<void> {
    if (this.#releasedDisposal !== undefined) return this.#releasedDisposal
    this.#releasedDisposal = (async () => {
      // Drain the original actual connection/lock before cleanup-only recovery.
      // A current successor's lock or changed binding still refuses disposal.
      await this.close()
      if (this.#releasedFactoryCleanup !== undefined) {
        await this.#releasedFactoryCleanup.retryCleanup()
        this.#releasedFactoryCleanup = undefined
      } else {
        try {
          await Brc38PrivateIdbStage.discardReleased(
            this.#databaseName,
            this.#limits,
            this.#bound.binding,
            this.#maximumKeys
          )
        } catch (cause) {
          if (cause instanceof Brc38StagingCleanupError) this.#releasedFactoryCleanup = cause
          throw cause
        }
      }
    })().catch(cause => {
      this.#releasedDisposal = undefined
      throw new Brc38StagingCleanupError(
        [cause],
        'Private browser disposal retains original drain and cleanup-only recovery',
        () => this.#disposeReleased()
      )
    })
    return this.#releasedDisposal
  }
}
