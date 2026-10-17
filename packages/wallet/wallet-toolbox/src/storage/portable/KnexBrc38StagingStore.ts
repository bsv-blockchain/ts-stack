import type { Brc38AuthenticatedImportReader, Brc38AuthenticatedStreamedImportReader } from './Brc38SemanticStage'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import { brc38StructuredRestoreResourceData } from './Brc38StructuredRestoreResourcesNode'
import {
  requirePrivatePath,
  createPrivateTemporaryDirectory,
  createPrivateDirectory,
  createPrivateFile,
  closePrivateDescriptor
} from './Brc38PrivateFilesystemNode'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { readBrc38SqlRowFieldContent, compareBrc38SqlRowFieldMetadata } from './Brc38SqlRowFieldRead'
import { readBrc38SqlSourceFieldContent, compareBrc38SqlSourceFieldCounts } from './Brc38SqlSourceFieldRead'
import { Brc38StreamedNotifyProjection } from './Brc38StreamedNotifyProjection'
import { Brc38StreamedSyncMapProjection } from './Brc38StreamedSyncMapProjection'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import { measureBrc38StructuredFilesystem } from './Brc38StructuredFilesystemNode'
import { Brc38StreamedSemanticStage, type Brc38StreamedStageStore } from './Brc38StreamedSemanticStage'
import {
  installBrc38AuthenticatedSourceSeal,
  verifyBrc38AuthenticatedSourceSeal
} from './Brc38AuthenticatedSourceSealNode'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import {
  beginBrc38SqlBinaryField,
  appendBrc38SqlBinaryField,
  completeBrc38SqlBinaryField,
  readBrc38SqlBinaryChunk,
  assertNoBrc38SqlBinaryFields,
  readBrc38SqlBinaryDescriptors
} from './Brc38SqlBinaryStaging'
import {
  beginBrc38SqlTextField,
  appendBrc38SqlTextField,
  completeBrc38SqlTextField,
  readBrc38SqlTextDescriptors,
  assertNoBrc38SqlTextFields
} from './Brc38SqlTextStaging'
import type { Brc38JsonTextField } from './Brc38JsonTextFields'
import type { Brc38JsonStreamedField, Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import {
  beginBrc38SqlStructuredField,
  appendBrc38SqlStructuredField,
  completeBrc38SqlStructuredField,
  readBrc38SqlStructuredChunk,
  readBrc38SqlStructuredRange,
  readBrc38SqlStructuredDescriptors,
  verifyAllBrc38SqlStructuredFields,
  assertNoBrc38SqlStructuredFields
} from './Brc38SqlStructuredStaging'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { Brc38NodeJsonIndex } from './Brc38NodeJsonIndex'
import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import {
  validatedCanonicalBrc38StructuredWalletField,
  canonicalBrc38ProjectedNotify,
  type Brc38JsonMemberIndex,
  type Brc38StreamedStructured
} from './Brc38StructuredJson'
import {
  beginBrc38SqlCanonicalStructuredField,
  appendBrc38SqlCanonicalStructuredField,
  completeBrc38SqlCanonicalStructuredField,
  verifyBrc38SqlCanonicalStructuredSource,
  verifyAllBrc38SqlCanonicalStructuredFields
} from './Brc38SqlCanonicalStructuredStaging'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
export { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import createKnex, { type Knex } from 'knex'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38NativeRecoveryScratchNode } from './Brc38NativeRecoveryScratchNode'
import { Brc39RecoveryAuthenticationNode } from './Brc39RecoveryAuthenticationNode'
import { opendir, readdir, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Brc38StagingOwnershipNode } from './Brc38StagingOwnershipNode'
import {
  Brc38PrivateNativeOwnershipNode,
  privateNativeWriterToken,
  privateNativeTransactionIdentity,
  privateNativeDatabaseIdentity
} from './Brc38PrivateNativeOwnershipNode'
import { brc38StagingBinding, type Brc38StagingBinding, type Brc38StagingBoundMetadata } from './Brc38StagingBinding'
import { join } from 'node:path'
import type { BRC38WalletData } from './index'
import type { PortableRow } from './Brc38PortableRows'
import {
  brc38StageTables,
  type Brc38StageKey,
  type Brc38StageRecord,
  type Brc38StageStore,
  type Brc38StageTable
} from './Brc38SemanticStage'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { copyBrc38OwnedDatabase } from './Brc38PrivatePublicationCopyNode'
import { Brc38PrivateNativeMergeNode } from './Brc38PrivateNativeMergeNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { inspectBrc38PrivateStreamedNativeInventory } from './Brc38StreamedNativeInventoryNode'
import { inspectBrc38PrivateStructuredNativeInventory } from './Brc38StructuredNativeInventoryNode'
import type { Brc38StructuredNativeFieldInventoryPolicy } from './Brc38StructuredNativeFieldInventoryNode'
import type { Brc38StreamedNotifyProjectionPolicy } from './Brc38StreamedNotifyProjectionNode'
import type { Brc38StreamedSyncMapProjectionPolicy } from './Brc38StreamedSyncMapProjectionNode'
import {
  beginBrc38SqlProjectedStructuredField,
  appendBrc38SqlProjectedStructuredField,
  completeBrc38SqlProjectedStructuredField,
  verifyBrc38SqlProjectedStructuredSource
} from './Brc38SqlProjectedStructuredStaging'
import { admissionCopy } from './Brc38ImportJournalCore'
import { brc38ImportTableOrder } from './Brc38ImportPage'

const privateNativeStores = new WeakMap<object, KnexBrc38StagingStore>()
const privateNativeDatabases = new WeakMap<object, KnexBrc38StagingStore>()
let privateNativeWriterMatches: ((store: KnexBrc38StagingStore, trx: Knex.Transaction) => boolean) | undefined
let privateNativeSqliteMatches: ((store: KnexBrc38StagingStore, database: Knex) => boolean) | undefined
/** Current physical writer AND actual authenticated private callback scope.
 * Actor identity alone, a descriptor, or a copied facade cannot grant this. */
export function isBrc38OwnedPrivateNativeWriter(trx: Knex.Transaction): boolean {
  const token = privateNativeWriterToken(trx),
    store = token === undefined ? undefined : privateNativeStores.get(token)
  return store !== undefined && privateNativeWriterMatches?.(store, trx) === true
}
/** Fresh actual physical producer membership under the authenticated callback,
 * never a backend/schema/source verdict. SQL schema/receipt checks still run. */
export function isBrc38OwnedPrivateNativeSqlite(database: Knex): boolean {
  const identity = database.isTransaction
      ? privateNativeTransactionIdentity(database as Knex.Transaction)
      : privateNativeDatabaseIdentity(database),
    store =
      privateNativeDatabases.get(database) ??
      (identity === undefined ? undefined : privateNativeStores.get(identity.token))
  return store !== undefined && privateNativeSqliteMatches?.(store, database) === true
}

export type { Brc38AuthenticatedImportReader, Brc38AuthenticatedStreamedImportReader } from './Brc38SemanticStage'
export type { KnexBrc38StagingLimits } from './Brc38StagingBinding'

interface Metadata {
  slot: number
  state: 'staging' | 'sealed'
  rows: number
  logicalBytes: number
  header: string | null
}
interface TableCount {
  tableName: Brc38StageTable
  rows: number
}
interface StoredRow {
  tableName: Brc38StageTable
  position: number
  payload: string
  bytes: number
  recordDigest: string
}
interface RowExtent {
  bytes: number | null
  payloadBytes: number
  payloadKind: string
  digestBytes: number
  digestKind: string
}
async function rowExtent(db: Knex, table: Brc38StageTable, index: number): Promise<RowExtent | undefined> {
  const values = (await db.raw(
    "SELECT CASE WHEN typeof(bytes) = 'integer' THEN bytes ELSE NULL END AS bytes, length(CAST(payload AS BLOB)) AS payloadBytes, typeof(payload) AS payloadKind, length(CAST(recordDigest AS BLOB)) AS digestBytes, typeof(recordDigest) AS digestKind FROM rows WHERE tableName = ? AND position = ? LIMIT 1",
    [table, index]
  )) as RowExtent[]
  return values.at(0)
}
async function tableCount(db: Knex, table: Brc38StageTable): Promise<TableCount | undefined> {
  return await db<TableCount>('table_counts')
    .where({ tableName: table })
    .whereRaw("typeof(rows) = 'integer'")
    .first('tableName', 'rows')
}
function integer(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid private BRC-38 staging limit')
}
export function validateBrc38StagingLimits(limits: KnexBrc38StagingLimits): void {
  integer(limits.maximumRows, 1, 1000000000)
  integer(limits.maximumLogicalBytes, 1, Number.MAX_SAFE_INTEGER)
  integer(limits.maximumPhysicalBytes, 1048576, Number.MAX_SAFE_INTEGER)
  integer(limits.maximumRowBytes, 1, 16777216)
  integer(limits.maximumRowAllocationBytes, 1, 16777216)
  integer(limits.expiresAt, Date.now() + 1, Number.MAX_SAFE_INTEGER)
}
function boundedJson(value: unknown, limits: KnexBrc38StagingLimits): { payload: string; bytes: number } {
  const pieces: string[] = [],
    decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  for (const chunk of canonicalPortableChunks(value, {
    maximumValueBytes: limits.maximumRowAllocationBytes,
    maximumChunkBytes: 4096
  })) {
    if (chunk.byteLength > limits.maximumRowBytes - bytes)
      throw new SnapshotResourceLimitError('Private BRC-38 row exceeds its serialized byte policy')
    bytes += chunk.byteLength
    pieces.push(decoder.decode(chunk, { stream: true }))
  }
  pieces.push(decoder.decode())
  return { payload: pieces.join(''), bytes }
}
async function ownedTransaction<T>(database: Knex, work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  let failed = false,
    original: unknown
  try {
    return await database.transaction(async trx => {
      try {
        return await work(trx)
      } catch (cause) {
        failed = true
        original = cause
        throw cause
      }
    })
  } catch (error_) {
    // SQLite may itself roll back on SQLITE_FULL. Preserve that first cause
    // when the driver's subsequent ROLLBACK reports no active transaction.
    if (failed && error_ !== original)
      throw new AggregateError([original, error_], 'Private BRC-38 transaction failed and driver rollback also failed')
    throw error_
  }
}
function maximumPages(limits: KnexBrc38StagingLimits): number {
  return Math.min(2147483646, Math.floor((limits.maximumPhysicalBytes - 65536) / (3 * 4096)))
}
function connectionPragmas(limits: KnexBrc38StagingLimits): string {
  // Apply to every pool connection, including one created after driver failure.
  return `PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000; PRAGMA max_page_count=${maximumPages(limits)};`
}
async function cleanupCreation(
  database: Knex | undefined,
  directory: string,
  owner: Brc38StagingOwnershipNode | undefined,
  cause: unknown,
  retirementDirectory?: string
): Promise<never> {
  let retired: string | undefined
  const cleanup = async () => {
    if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
    if (database !== undefined) await database.destroy()
    if (owner !== undefined) {
      if (retired === undefined) {
        const selected = retirementDirectory ?? directory + '-discarded-' + randomUUID()
        await rename(directory, selected)
        retired = selected
      }
      await owner.release()
      await rm(retired, { recursive: true, force: true })
    } else {
      // Failed ownership creation may have a published file: retain it for
      // an ownership-aware orphan collector rather than guessing it is unused.
      const entries = await readdir(directory)
      if (!entries.includes('brc38-owner.sqlite')) await rm(directory, { recursive: true })
    }
  }
  try {
    await cleanup()
  } catch (error_) {
    throw new Brc38StagingCleanupError(
      [cause, error_],
      'Private BRC-38 creation and physical cleanup both failed',
      cleanup
    )
  }
  throw cause
}
function openDatabase(filename: string, limits: KnexBrc38StagingLimits): Knex {
  return createKnex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    acquireConnectionTimeout: 1000,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (
        connection: { exec: (sql: string) => unknown },
        done: (error: Error | null, value?: unknown) => void
      ) => {
        try {
          connection.exec(connectionPragmas(limits))
          done(null, connection)
        } catch (cause) {
          done(cause instanceof Error ? cause : new Error('Private BRC-38 connection setup failed'), connection)
        }
      }
    }
  })
}
function recordDigest(record: Brc38StageRecord, payload: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        record.table,
        record.index,
        payload,
        record.uniqueKeys.map(entry => [entry.namespace, entry.key]),
        record.memberships.map(entry => [entry.namespace, entry.key])
      ])
    )
    .digest('hex')
}
function keyCharge(keys: readonly Brc38StageKey[]): number {
  let bytes = 0
  for (const entry of keys) {
    if (
      typeof entry.namespace !== 'string' ||
      typeof entry.key !== 'string' ||
      entry.namespace.length > 64 ||
      entry.key.length > 65536
    )
      throw new SnapshotResourceLimitError('Private BRC-38 indexed key exceeds its byte policy')
    bytes += Buffer.byteLength(entry.namespace, 'utf8') + Buffer.byteLength(entry.key, 'utf8') + 128
  }
  return Number(bytes)
}

async function privatePhysicalBytes(
  directory: string,
  limits: KnexBrc38StagingLimits,
  withOwner: boolean
): Promise<number> {
  const entries = await opendir(directory),
    names: string[] = []
  for await (const entry of entries) {
    const name = entry.name
    // Only the one owned database and its native rollback journal may exist.
    const ownerFile = withOwner && (name === 'brc38-owner.sqlite' || name === 'brc38-owner.sqlite-journal')
    if (name !== 'stage.sqlite' && name !== 'stage.sqlite-journal' && !ownerFile)
      throw new Error('Unexpected file in private BRC-38 staging directory')
    if (names.length >= (withOwner ? 4 : 2)) throw new Error('Unexpected file in private BRC-38 staging directory')
    names.push(name)
  }
  // Independent metadata reads have fixed width and physically settle before
  // validation returns. Keep the original first-error identity and quota check.
  const results = await Promise.allSettled(names.map(name => requirePrivatePath(join(directory, name), false)))
  let bytes = 0n
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
    const value = result.value
    const allocated = value.blocks * 512n
    if (value.size < 0n || value.blocks < 0n) throw new Error('Invalid private BRC-38 staging extent')
    bytes += value.size > allocated ? value.size : allocated
  }
  if (bytes > BigInt(limits.maximumPhysicalBytes))
    throw new SnapshotResourceLimitError('Private BRC-38 staging physical quota reached')
  return Number(bytes)
}

/** Node-only private SQLite owner. Uses a fresh 0700 directory/0600 DB, no
 * active wallet connection or tables. DELETE journaling and a hard page limit
 * reserve room for the DB, rollback journal and framing before any row write.
 * Native crash/restart and independent physical-cost qualification are still
 * required before this prospective component can be adopted. */
export class KnexBrc38StagingStore implements Brc38StageStore {
  #busy = false
  #closed = false
  #discarded = false
  #destroyed = false
  #ownerReleased = false
  #deletionDirectory: string | undefined
  #pendingDestinationCleanup?: Brc38StagingCleanupError
  #structuredIndexes = new Set<Brc38NodeJsonIndex>()
  #structuredAcquisitionCleanup = new Set<Brc38StagingCleanupError>()
  #nativeWriterScope = false
  #knex: Knex
  static {
    privateNativeSqliteMatches = (store, database) => {
      store.#available()
      if (!store.#busy || !store.#nativeWriterScope || !(store.owner instanceof Brc38PrivateNativeOwnershipNode))
        return false
      if (database.isTransaction) store.owner.assertTransaction(database as Knex.Transaction, true)
      else store.owner.assertDatabase(database, true)
      return true
    }
    privateNativeWriterMatches = (store, trx) => {
      store.#available()
      if (!store.#busy || !store.#nativeWriterScope || !(store.owner instanceof Brc38PrivateNativeOwnershipNode))
        return false
      store.owner.assertTransaction(trx)
      return true
    }
  }
  #recoveryWorking?: Brc38WorkingAllocation
  readonly #recoveryComparison: boolean
  readonly #recoveryPhysicalRelease = new Set<() => void>()
  readonly limits: KnexBrc38StagingLimits
  get knex(): Knex {
    return this.#knex
  }
  private constructor(
    knex: Knex,
    readonly directory: string,
    limits: KnexBrc38StagingLimits,
    private readonly owner?: Brc38StagingOwnershipNode | Brc38PrivateNativeOwnershipNode,
    readonly binding?: Brc38StagingBoundMetadata,
    private readonly retirementDirectory?: string
  ) {
    this.#knex = knex
    this.#recoveryComparison = owner instanceof Brc38PrivateNativeOwnershipNode && owner.recoveryComparisonOnly
    this.limits = Object.freeze({ ...limits })
  }
  static async create(parentDirectory: string, selected: KnexBrc38StagingLimits): Promise<KnexBrc38StagingStore> {
    return await this.#create(parentDirectory, selected)
  }
  static async createOwned(
    parentDirectory: string,
    selected: KnexBrc38StagingLimits,
    binding: Brc38StagingBinding
  ): Promise<KnexBrc38StagingStore> {
    return await this.#create(parentDirectory, selected, brc38StagingBinding(binding, selected))
  }
  /** Internal admission adapter: the catalog writer excludes creation/cleanup,
   * and reserves this exact path before it is created. */
  static async createOwnedAt(
    directory: string,
    selected: KnexBrc38StagingLimits,
    binding: Brc38StagingBinding,
    retirementDirectory: string
  ): Promise<KnexBrc38StagingStore> {
    return await this.#create('', selected, brc38StagingBinding(binding, selected), directory, retirementDirectory)
  }
  static async #create(
    parentDirectory: string,
    selected: KnexBrc38StagingLimits,
    binding?: Brc38StagingBoundMetadata,
    exactDirectory?: string,
    retirementDirectory?: string
  ): Promise<KnexBrc38StagingStore> {
    validateBrc38StagingLimits(selected)
    const limits = Object.freeze({ ...selected }),
      directory = exactDirectory ?? (await createPrivateTemporaryDirectory(join(parentDirectory, 'brc38-private-')))
    if (exactDirectory !== undefined) await createPrivateDirectory(exactDirectory)
    let database: Knex | undefined, owner: Brc38StagingOwnershipNode | undefined
    try {
      if (binding !== undefined)
        owner = await Brc38StagingOwnershipNode.create(directory, binding.digest, limits.expiresAt)
      const filename = join(directory, 'stage.sqlite'),
        file = await createPrivateFile(filename)
      await closePrivateDescriptor(file)
      database = openDatabase(filename, limits)
      const store = new KnexBrc38StagingStore(database, directory, limits, owner, binding, retirementDirectory)
      await store.#initialize()
      return store
    } catch (cause) {
      // Physical ownership is retained if driver teardown cannot complete.
      return await cleanupCreation(database, directory, owner, cause, retirementDirectory)
    }
  }
  static async reopenOwned(
    directory: string,
    selected: KnexBrc38StagingLimits,
    selectedBinding: Brc38StagingBinding,
    retirementDirectory?: string
  ): Promise<KnexBrc38StagingStore> {
    validateBrc38StagingLimits(selected)
    const limits = Object.freeze({ ...selected }),
      binding = brc38StagingBinding(selectedBinding, limits),
      owner = await Brc38StagingOwnershipNode.claimExisting(directory, binding.digest)
    let database: Knex | undefined
    try {
      if (owner.expiresAt !== limits.expiresAt) throw new Error('Private BRC-38 original expiry does not match')
      const filename = join(directory, 'stage.sqlite'),
        before = await requirePrivatePath(filename, false)
      await privatePhysicalBytes(directory, limits, true)
      database = openDatabase(filename, limits)
      const store = new KnexBrc38StagingStore(database, directory, limits, owner, binding, retirementDirectory)
      await store.#physicalBytes()
      await store.#verifyExisting()
      const after = await requirePrivatePath(filename, false)
      if (before.dev !== after.dev || before.ino !== after.ino)
        throw new Error('Private BRC-38 staging database was replaced during reopen')
      store.#available()
      return store
    } catch (cause) {
      const cleanup = async () => {
        if (database !== undefined) await database.destroy()
        await owner.release()
      }
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private BRC-38 reopen and physical cleanup both failed',
          cleanup
        )
      }
      throw cause
    }
  }
  /** Explicit internal backend handoff after the previous store is CLOSED.
   * The locked root catalog retains the same reservation; this independently
   * reacquires the actual kernel owner and verifies original source metadata.
   * No platform capability, receiver completion or activation is advertised. */
  static async reopenOwnedNative(
    directory: string,
    selected: KnexBrc38StagingLimits,
    selectedBinding: Brc38StagingBinding,
    executable: string,
    retirementDirectory?: string
  ): Promise<KnexBrc38StagingStore> {
    validateBrc38StagingLimits(selected)
    const limits = Object.freeze({ ...selected }),
      bound = brc38StagingBinding(selectedBinding, limits)
    await privatePhysicalBytes(directory, limits, true)
    const actual = await Brc38PrivateNativeOwnershipNode.claimExisting(directory, limits, bound, executable),
      store = new KnexBrc38StagingStore(actual.database, directory, limits, actual.owner, bound, retirementDirectory)
    let destroyed = false
    const cleanup = async (): Promise<void> => {
      if (!destroyed) {
        await actual.database.destroy()
        destroyed = true
      }
      await actual.owner.release()
    }
    try {
      await store.#physicalBytes()
      await store.#verifyExisting()
      const meta = await store.#metadata(store.knex),
        source = await store.#privateImport(store.knex)
      if (meta.state !== 'sealed' || source.archiveSha256 !== bound.binding.archiveSha256)
        throw new Error('Private native reopen requires actual authenticated source seal')
      store.#available()
      privateNativeStores.set(actual.owner.transactionToken, store)
      privateNativeDatabases.set(actual.database, store)
      return store
    } catch (cause) {
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError([cause, error_], 'Private native reopen retains physical cleanup', cleanup)
      }
      throw cause
    }
  }
  /** A NEW actual copied scratch may be inspected after its original import
   * expired. Its unchanged binding/limits are DATA. Both genuine outer scopes
   * remain held, and this owner is frozen before the first SQL request. This
   * factory cannot reopen the original reservation or grant activation. */
  static async withRecoveryComparison<T>(
    scratch: Brc38NativeRecoveryScratchNode,
    source: Brc39RecoveryAuthenticationNode,
    selected: KnexBrc38StagingLimits,
    executable: string,
    work: (store: KnexBrc38StagingStore) => Promise<T>
  ): Promise<T> {
    Brc38NativeRecoveryScratchNode.prototype.assertRetained.call(scratch)
    Brc39RecoveryAuthenticationNode.prototype.assertRetained.call(source)
    const limits = Object.freeze({ ...selected }),
      bound = brc38StagingBinding(source.original.binding, limits)
    validateBrc38StagingLimits({ ...limits, expiresAt: source.expiresAt })
    if (
      bound.digest !== source.original.digest ||
      !Number.isSafeInteger(limits.expiresAt) ||
      limits.expiresAt < 1 ||
      limits.expiresAt > Date.now() ||
      typeof work !== 'function'
    )
      throw new Error('Recovery comparison must retain the original expired binding DATA')
    const actual = await Brc38PrivateNativeOwnershipNode.claimRecovery(scratch, source, limits, bound, executable),
      store = new KnexBrc38StagingStore(actual.database, scratch.directory, limits, actual.owner, bound)
    store.#recoveryWorking = scratch.policy.workingAllocation
    privateNativeStores.set(actual.owner.transactionToken, store)
    privateNativeDatabases.set(actual.database, store)
    let earlierCleanup: Brc38StagingCleanupError | undefined
    const cleanup = async (): Promise<void> => {
      await earlierCleanup?.retryCleanup()
      await store.close()
    }
    try {
      await store.#physicalBytes()
      await store.#verifyExisting()
      const meta = await store.#metadata(store.knex),
        sealed = await store.#privateImport(store.knex)
      if (meta.state !== 'sealed' || sealed.archiveSha256 !== bound.binding.archiveSha256)
        throw new Error('Recovery scratch has no complete original authenticated-source framing')
      await store.requirePrivateNativeComparison()
      const value = await work(store)
      await store.requirePrivateNativeComparison()
      Brc38NativeRecoveryScratchNode.prototype.assertRetained.call(scratch)
      Brc39RecoveryAuthenticationNode.prototype.assertRetained.call(source)
      await cleanup()
      return value
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) earlierCleanup = cause
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Recovery comparison retains physical scratch owner cleanup',
          cleanup
        )
      }
      throw cause
    }
  }
  /** Operation deadline only. Original persisted limits remain unchanged. */
  get operationExpiresAt(): number {
    this.#available()
    return this.owner instanceof Brc38PrivateNativeOwnershipNode && this.owner.recoveryComparisonOnly
      ? this.owner.expiresAt
      : this.limits.expiresAt
  }
  get recoveryComparisonOnly(): boolean {
    this.#available()
    return this.owner instanceof Brc38PrivateNativeOwnershipNode && this.owner.recoveryComparisonOnly
  }
  /** Recovery scratch holds may be abandoned ONLY after actual kernel and SQL
   * owner drainage. No operation lease or database permission is granted here.
   * Deferred callbacks release bounded JS metadata, never run SQL or unlink. */
  deferRecoveryPhysicalRelease(work: () => void): boolean {
    if (!this.#recoveryComparison) return false
    return this.#deferPhysicalRelease(work)
  }
  /** An expired ORIGINAL native stage cannot run another cleanup writer.
   * Persisted holds/chunks stay in its charged private database; only bounded
   * JS metadata is released after its real SQL and kernel owners drain. */
  deferExpiredPrivatePhysicalRelease(work: () => void): boolean {
    if (
      !(this.owner instanceof Brc38PrivateNativeOwnershipNode) ||
      this.#recoveryComparison ||
      !this.owner.operationExpired
    )
      return false
    return this.#deferPhysicalRelease(work)
  }
  #deferPhysicalRelease(work: () => void): boolean {
    if (typeof work !== 'function' || this.#recoveryPhysicalRelease.size >= 256)
      throw new Error('Recovery physical cleanup observer bound reached')
    if (this.#ownerReleased && this.#destroyed) work()
    else this.#recoveryPhysicalRelease.add(work)
    return true
  }
  #releasePhysicalMetadata(): void {
    for (const work of this.#recoveryPhysicalRelease) {
      work()
      this.#recoveryPhysicalRelease.delete(work)
    }
  }
  assertRecoverySharedWorking(working: Brc38WorkingAllocation): void {
    this.#available()
    if (this.#recoveryComparison && this.#recoveryWorking !== working)
      throw new Error('Recovery comparison must retain its actual shared scratch working owner')
  }
  assertMutableImport(): void {
    this.#available()
    if (this.recoveryComparisonOnly) throw new Error('Expired candidate recovery permits comparison only')
  }
  async #verifyExisting(): Promise<void> {
    const extents = (await this.knex.raw(
        'SELECT length(CAST(bindingJson AS BLOB)) AS bindingBytes, length(CAST(limitsJson AS BLOB)) AS limitsBytes, length(CAST(protocol AS BLOB)) AS protocolBytes, length(CAST(digest AS BLOB)) AS digestBytes FROM private_binding WHERE slot = ? LIMIT 1',
        [1]
      )) as Array<{
        bindingBytes: number
        limitsBytes: number
        protocolBytes: number
        digestBytes: number
      }>,
      extent = extents.at(0)
    if (
      extent === undefined ||
      !Number.isSafeInteger(extent.bindingBytes) ||
      extent.bindingBytes < 1 ||
      extent.bindingBytes > 4096 ||
      !Number.isSafeInteger(extent.limitsBytes) ||
      extent.limitsBytes < 1 ||
      extent.limitsBytes > 256 ||
      extent.protocolBytes !== Buffer.byteLength('brc38-resumable-private/v1') ||
      extent.digestBytes !== 64
    )
      throw new Error('Private BRC-38 resume metadata exceeds its byte bounds')
    const bound = await this.knex<{
      slot: number
      protocol: string
      digest: string
      bindingJson: string
      limitsJson: string
    }>('private_binding')
      .where({ slot: 1 })
      .first()
    if (
      this.binding === undefined ||
      bound === undefined ||
      bound.protocol !== 'brc38-resumable-private/v1' ||
      bound.digest !== this.binding.digest ||
      bound.bindingJson !== this.binding.bindingJson ||
      bound.limitsJson !== this.binding.limitsJson
    )
      throw new Error('Private BRC-38 resume binding or limits are inconsistent')
    const effective = (await this.knex.raw('PRAGMA max_page_count')) as Array<{
      max_page_count: number
    }>
    if (effective[0]?.max_page_count !== maximumPages(this.limits))
      throw new Error('Private BRC-38 database page bound was not established')
    const meta = await this.#metadata(this.knex)
    let total = 0
    await runInSeries(brc38StageTables, async table => {
      total += await this.#readCount(table)
    })
    if (total !== meta.rows) throw new Error('Private BRC-38 resume counters are inconsistent')
  }
  async #initialize(): Promise<void> {
    const effective = (await this.knex.raw('PRAGMA max_page_count')) as Array<{
      max_page_count: number
    }>
    if (effective[0]?.max_page_count !== maximumPages(this.limits))
      throw new Error('Private BRC-38 database page bound was not established')
    // Publish the private schema, binding and all scalar counters in one durable commit.
    await ownedTransaction(this.knex, async trx => {
      await trx.schema.createTable('metadata', table => {
        table.integer('slot').primary()
        table.string('state').notNullable()
        table.integer('rows').notNullable()
        table.bigInteger('logicalBytes').notNullable()
        table.text('header').nullable()
      })
      await trx.schema.createTable('table_counts', table => {
        table.string('tableName').primary()
        table.integer('rows').notNullable()
      })
      await trx.schema.createTable('rows', table => {
        table.string('tableName').notNullable()
        table.integer('position').notNullable()
        table.integer('bytes').notNullable()
        table.text('payload').notNullable()
        table.string('recordDigest', 64).notNullable()
        table.primary(['tableName', 'position'])
      })
      await trx.schema.createTable('unique_keys', table => {
        table.string('namespace').notNullable()
        table.text('key').notNullable()
        table.primary(['namespace', 'key'])
      })
      await trx.schema.createTable('memberships', table => {
        table.string('namespace').notNullable()
        table.text('key').notNullable()
        table.primary(['namespace', 'key'])
      })
      if (this.binding !== undefined) {
        await trx.schema.createTable('private_binding', table => {
          table.integer('slot').primary()
          table.string('protocol').notNullable()
          table.string('digest', 64).notNullable()
          table.text('bindingJson').notNullable()
          table.text('limitsJson').notNullable()
        })
        await trx('private_binding').insert({
          slot: 1,
          protocol: 'brc38-resumable-private/v1',
          digest: this.binding.digest,
          bindingJson: this.binding.bindingJson,
          limitsJson: this.binding.limitsJson
        })
      }
      await trx('metadata').insert({
        slot: 1,
        state: 'staging',
        rows: 0,
        logicalBytes: 0,
        header: null
      })
      await trx('table_counts').insert(brc38StageTables.map(tableName => ({ tableName, rows: 0 })))
    })
    await this.#physicalBytes()
    this.#available()
  }
  #available(): void {
    if (this.#pendingDestinationCleanup !== undefined) throw this.#pendingDestinationCleanup
    if (this.#structuredAcquisitionCleanup.size !== 0 || (!this.#busy && this.#structuredIndexes.size !== 0))
      throw new Error('Private structured index acquisition cleanup is still owned')
    this.owner?.assertLive()
    if (
      this.#closed ||
      this.#discarded ||
      Date.now() >=
        (this.owner instanceof Brc38PrivateNativeOwnershipNode && this.owner.recoveryComparisonOnly
          ? this.owner.expiresAt
          : this.limits.expiresAt)
    )
      throw new Error('Private BRC-38 store is unavailable or expired')
  }
  async #physicalBytes(): Promise<number> {
    return await privatePhysicalBytes(this.directory, this.limits, this.owner !== undefined)
  }
  async #measureStructuredPhysical(reserved: number, signal?: AbortSignal): Promise<number> {
    try {
      return await measureBrc38StructuredFilesystem(
        this.directory,
        ['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal'],
        this.limits.maximumPhysicalBytes,
        reserved,
        signal
      )
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) this.#retainStructuredAcquisitionCleanup(cause)
      throw cause
    }
  }
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.#available()
    if (this.#busy) throw new Error('Private BRC-38 staging I/O is already owned')
    this.#busy = true
    try {
      const result = await work()
      this.#available()
      return result
    } finally {
      this.#busy = false
    }
  }
  async #metadata(trx: Knex): Promise<Metadata> {
    const extents = (await trx.raw(
        "SELECT length(CAST(header AS BLOB)) AS headerBytes, state IN ('staging','sealed') AS validState, typeof(rows) = 'integer' AS validRows, typeof(logicalBytes) = 'integer' AS validLogical FROM metadata WHERE slot = ? LIMIT 1",
        [1]
      )) as Array<{
        headerBytes: number | null
        validState: number
        validRows: number
        validLogical: number
      }>,
      extent = extents.at(0)
    if (extent === undefined) throw new Error('Private BRC-38 staging metadata is missing')
    if (extent.validState !== 1 || extent.validRows !== 1 || extent.validLogical !== 1)
      throw new Error('Private BRC-38 staging counters are invalid')
    if (
      extent.headerBytes !== null &&
      (!Number.isSafeInteger(extent.headerBytes) ||
        extent.headerBytes < 1 ||
        extent.headerBytes > this.limits.maximumRowBytes)
    )
      throw new Error('Private BRC-38 header byte bound is invalid')
    const value = await trx<Metadata>('metadata').where({ slot: 1 }).first()
    if (value === undefined) throw new Error('Private BRC-38 staging metadata is missing')
    if (
      !Number.isSafeInteger(value.rows) ||
      value.rows < 0 ||
      value.rows > this.limits.maximumRows ||
      !Number.isSafeInteger(value.logicalBytes) ||
      value.logicalBytes < 0 ||
      value.logicalBytes > this.limits.maximumLogicalBytes ||
      (value.state !== 'staging' && value.state !== 'sealed') ||
      (value.state === 'staging' && value.header !== null) ||
      (value.state === 'sealed' && typeof value.header !== 'string')
    )
      throw new Error('Private BRC-38 staging counters are invalid')
    return value
  }
  /** Internal field-aware private staging. Uses the SAME immutable reservation,
   * expiry, kernel owner, physical max_page_count and logical counters as rows.
   * No field operation seals authentication or authorizes native activation. */
  async beginBinaryField(
    table: Brc38StageTable,
    index: number,
    field: string,
    encoding: Brc38JsonStreamedField['encoding'],
    maximumBytes: number
  ): Promise<void> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
      throw new RangeError('Invalid private binary field maximum')
    await this.#exclusive(async () => {
      await ownedTransaction(this.knex, async trx => {
        await this.#metadata(trx)
        await beginBrc38SqlBinaryField(
          trx,
          table,
          index,
          field,
          encoding,
          Math.min(maximumBytes, this.limits.maximumLogicalBytes),
          this.limits.maximumLogicalBytes,
          this.limits.maximumRows
        )
        this.#available()
        await this.#physicalBytes()
      })
      await this.#physicalBytes()
    })
  }
  async appendBinaryField(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number,
    input: Uint8Array
  ): Promise<void> {
    // Intrinsic length/backing preflight occurs before any input copy or await.
    const bytes = detachBrc38PrivateChunk(input, 65536)
    try {
      await this.#exclusive(async () => {
        await ownedTransaction(this.knex, async trx => {
          await this.#metadata(trx)
          await appendBrc38SqlBinaryField(trx, table, index, field, offset, bytes, this.limits.maximumLogicalBytes)
          this.#available()
          await this.#physicalBytes()
        })
        await this.#physicalBytes()
      })
    } finally {
      bytes.fill(0)
    }
  }
  async finishBinaryField(table: Brc38StageTable, index: number, input: Brc38JsonStreamedField): Promise<void> {
    const expected = Object.freeze({
      field: input.field,
      encoding: input.encoding,
      bytes: input.bytes,
      sha256: input.sha256
    })
    await this.#exclusive(async () => {
      await completeBrc38SqlBinaryField(
        async operation => await this.#withProvisionalStructuredRead(operation, true),
        async operation =>
          await ownedTransaction(this.knex, async trx => {
            await this.#metadata(trx)
            const result = await operation(trx)
            await this.#physicalBytes()
            return result
          }),
        table,
        index,
        expected,
        () => this.#available(),
        this.#structuredCompletionReadBytes()
      )
      await this.#physicalBytes()
    })
  }
  async readBinaryFieldChunk(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number
  ): Promise<Awaited<ReturnType<typeof readBrc38SqlBinaryChunk>>> {
    return await this.#exclusive(
      async () =>
        await ownedTransaction(this.knex, async trx => {
          await this.#metadata(trx)
          const value = await readBrc38SqlBinaryChunk(trx, table, index, field, offset)
          this.#available()
          return value
        })
    )
  }
  /** Provisional raw JSON only. Actual owner/expiry/physical/logical admission
   * is shared with the binary and row store; completion verifies persisted
   * bytes and never substitutes for indexed semantic validation or import. */
  async beginStructuredField(
    table: Brc38StageTable,
    index: number,
    field: string,
    maximumBytes: number
  ): Promise<void> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > 1000000000)
      throw new RangeError('Invalid private structured field maximum')
    await this.#exclusive(async () => {
      await ownedTransaction(this.knex, async trx => {
        await this.#metadata(trx)
        await beginBrc38SqlStructuredField(
          trx,
          table,
          index,
          field,
          'utf8-json',
          Math.min(maximumBytes, this.limits.maximumLogicalBytes),
          this.limits.maximumLogicalBytes,
          this.limits.maximumRows
        )
        this.#available()
        await this.#physicalBytes()
      })
      await this.#physicalBytes()
    })
  }
  async appendStructuredField(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number,
    input: Uint8Array
  ): Promise<void> {
    const bytes = detachBrc38PrivateChunk(input, 65536)
    try {
      await this.#exclusive(async () => {
        await ownedTransaction(this.knex, async trx => {
          await this.#metadata(trx)
          await appendBrc38SqlStructuredField(trx, table, index, field, offset, bytes, this.limits.maximumLogicalBytes)
          this.#available()
          await this.#physicalBytes()
        })
        await this.#physicalBytes()
      })
    } finally {
      bytes.fill(0)
    }
  }
  async finishStructuredField(table: Brc38StageTable, index: number, input: Brc38JsonStructuredField): Promise<void> {
    const expected = Object.freeze({
      field: input.field,
      encoding: input.encoding,
      bytes: input.bytes,
      sha256: input.sha256
    })
    await this.#exclusive(async () => {
      await completeBrc38SqlStructuredField(
        async operation => await this.#withProvisionalStructuredRead(operation, true),
        async operation =>
          await ownedTransaction(this.knex, async trx => {
            await this.#metadata(trx)
            const result = await operation(trx)
            await this.#physicalBytes()
            return result
          }),
        table,
        index,
        expected,
        () => this.#available(),
        this.#structuredCompletionReadBytes()
      )
      await this.#physicalBytes()
    })
  }
  async beginTextField(table: Brc38StageTable, index: number, field: string, maximumBytes: number): Promise<void> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 1000000000)
      throw new RangeError('Invalid private scalar TEXT maximum')
    await this.#exclusive(async () => {
      await ownedTransaction(this.knex, async trx => {
        await this.#metadata(trx)
        await beginBrc38SqlTextField(
          trx,
          table,
          index,
          field,
          'utf8',
          Math.min(maximumBytes, this.limits.maximumLogicalBytes),
          this.limits.maximumLogicalBytes,
          this.limits.maximumRows
        )
        this.#available()
        await this.#physicalBytes()
      })
      await this.#physicalBytes()
    })
  }
  async appendTextField(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number,
    input: Uint8Array
  ): Promise<void> {
    const bytes = detachBrc38PrivateChunk(input, 16384)
    try {
      await this.#exclusive(async () => {
        await ownedTransaction(this.knex, async trx => {
          await this.#metadata(trx)
          await appendBrc38SqlTextField(trx, table, index, field, offset, bytes, this.limits.maximumLogicalBytes)
          this.#available()
          await this.#physicalBytes()
        })
        await this.#physicalBytes()
      })
    } finally {
      bytes.fill(0)
    }
  }
  async finishTextField(table: Brc38StageTable, index: number, input: Brc38JsonTextField): Promise<void> {
    const expected = Object.freeze({
      field: input.field,
      encoding: input.encoding,
      bytes: input.bytes,
      sha256: input.sha256
    })
    await this.#exclusive(async () => {
      await completeBrc38SqlTextField(
        async operation => await this.#withProvisionalStructuredRead(operation, true),
        async operation =>
          await ownedTransaction(this.knex, async trx => {
            await this.#metadata(trx)
            const result = await operation(trx)
            await this.#physicalBytes()
            return result
          }),
        table,
        index,
        expected,
        () => this.#available(),
        Math.min(16384, this.#structuredCompletionReadBytes())
      )
      await this.#physicalBytes()
    })
  }
  /** Fresh complete physical hashing and fatal UTF-8 decoding. Descriptors only
   * identify expected content; this actual owner and query-only view perform
   * the read before original string type/relationship validation. */
  async validateTextFields(
    table: Brc38StageTable,
    index: number,
    selected: NonNullable<Brc38JsonStreamedRow['texts']>
  ): Promise<void> {
    const names = Object.keys(selected)
    if (names.length > 7) throw new Error('Too many private scalar TEXT descriptors')
    const text = Object.freeze(
      Object.fromEntries(
        names.map(field => {
          const value = selected[field]
          return [
            field,
            Object.freeze({ field: value.field, encoding: value.encoding, bytes: value.bytes, sha256: value.sha256 })
          ]
        })
      )
    )
    await this.#exclusive(
      async () =>
        await this.#withProvisionalStructuredRead(async trx => {
          await this.#assertStructuredSemanticOwner(true, trx)
          await this.#metadata(trx)
          await readBrc38SqlRowFieldContent(
            trx,
            table,
            index,
            await readBrc38SqlBinaryDescriptors(trx, table, index),
            await readBrc38SqlStructuredDescriptors(trx, table, index),
            Math.min(16384, this.#structuredCompletionReadBytes()),
            () => this.#available(),
            text
          )
          await this.#assertStructuredSemanticOwner(true, trx)
          await this.#physicalBytes()
        }, true)
    )
  }
  #structuredCompletionReadBytes(): number {
    const bytes = Math.min(65536, Math.floor((this.limits.maximumRowAllocationBytes - 4096) / 16))
    if (bytes < 128)
      throw new SnapshotResourceLimitError('Private structured completion cannot fit its original allocation')
    return bytes
  }
  /** The original exclusive staging operation and physical owner remain live.
   * This borrowed transaction changes no data, and drains before the next
   * writer uses the single pool. A failed read-mode reset stays explicitly
   * owned and blocks further staging until its concrete cleanup is retried. */
  async #withProvisionalStructuredRead<T>(
    operation: (trx: Knex.Transaction) => Promise<T>,
    authenticatedNativeReplay = false
  ): Promise<T> {
    this.#available()
    if (!this.#busy || (this.owner instanceof Brc38PrivateNativeOwnershipNode && !authenticatedNativeReplay))
      throw new Error('Provisional structured completion requires its original staging operation')
    if (this.owner instanceof Brc38PrivateNativeOwnershipNode) {
      const owner = this.owner
      try {
        return await this.#withPrivateNativeReadDatabase(
          async database =>
            await ownedTransaction(database, async trx => {
              // This pre-callback validation has physical read membership only;
              // it does not enroll an authenticated writer or cache a verdict.
              owner.assertTransaction(trx, true)
              if (privateNativeTransactionIdentity(trx)?.slot !== 3)
                throw new Error('Native authenticated replay requires its actual read-only slot')
              const initial = await this.#metadata(trx),
                originalArchive = (await this.#privateImport(trx)).archiveSha256
              if (initial.state !== 'sealed' || originalArchive === null)
                throw new Error('Native row replay requires its actual sealed authenticated source')
              const value = await operation(trx),
                current = await this.#metadata(trx)
              this.#available()
              owner.assertTransaction(trx, true)
              if (
                current.state !== initial.state ||
                current.header !== initial.header ||
                current.rows !== initial.rows ||
                (await this.#privateImport(trx)).archiveSha256 !== originalArchive
              )
                throw new Error('Native row replay changed its actual authenticated source')
              return value
            })
        )
      } catch (cause) {
        if (cause instanceof Brc38StagingCleanupError) this.#retainStructuredAcquisitionCleanup(cause)
        throw cause
      }
    }
    return await ownedTransaction(this.knex, async trx => {
      let failed = false,
        original: unknown
      const cleanupScope1 = new Brc38CleanupScope(async () => {
        try {
          await trx.raw('PRAGMA query_only=OFF')
          const mode = (await trx.raw('PRAGMA query_only')) as Array<{ query_only: number }>
          if (mode.length !== 1 || mode[0].query_only !== 0)
            throw new Error('Private structured read mode did not drain')
        } catch (error_) {
          this.#retainStructuredAcquisitionCleanup(
            new Brc38StagingCleanupError(
              [...(failed ? [original] : []), error_],
              'Private structured completion retains read-mode cleanup',
              async () => {
                await this.knex.raw('PRAGMA query_only=OFF')
                const mode = (await this.knex.raw('PRAGMA query_only')) as Array<{ query_only: number }>
                if (mode.length !== 1 || mode[0].query_only !== 0)
                  throw new Error('Private structured read cleanup remains incomplete')
              }
            )
          )
        }
      })
      try {
        await trx.raw('PRAGMA query_only=ON')
        const mode = (await trx.raw('PRAGMA query_only')) as Array<{ query_only: number }>
        if (mode.length !== 1 || mode[0].query_only !== 1) throw new Error('Private structured read mode differs')
        await this.#metadata(trx)
        const value = await operation(trx)
        await this.#metadata(trx)
        this.#available()
        return value
      } catch (cause) {
        failed = true
        original = cause
        {
          await cleanupScope1.close()
          throw cause
        }
      } finally {
        await cleanupScope1.close()
      }
    })
  }
  async readStructuredFieldChunk(
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number
  ): Promise<Awaited<ReturnType<typeof readBrc38SqlStructuredChunk>>> {
    return await this.#exclusive(
      async () =>
        await ownedTransaction(this.knex, async trx => {
          await this.#metadata(trx)
          const value = await readBrc38SqlStructuredChunk(trx, table, index, field, offset)
          this.#available()
          return value
        })
    )
  }
  #retainStructuredAcquisitionCleanup(cause: Brc38StagingCleanupError): never {
    const retained = new Brc38StagingCleanupError(
      [cause],
      'Private structured source retains failed index acquisition',
      async () => {
        await cause.retryCleanup()
        this.#structuredAcquisitionCleanup.delete(retained)
      }
    )
    this.#structuredAcquisitionCleanup.add(retained)
    throw retained
  }
  /** Fresh validation of the actual provisional store. No supplied callback,
   * hash, descriptor, earlier validation or copied facade admits a source.
   * Filesystem sorting happens outside SQL callbacks; each bounded source read
   * gets a short actual private transaction under the original fixed lease. */
  async validateStructuredFields(
    table: Brc38StageTable,
    index: number,
    selected: Readonly<Record<string, Brc38JsonStructuredField>>,
    selectedPolicy: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    return await this.#validateStructuredFields(table, index, selected, selectedPolicy, false)
  }
  /** Original owned source only: raw archive parsing/semantic staging precedes
   * authenticated native handoff. This cannot enroll a native receiver actor. */
  async validateOwnedSourceStructuredFields(
    table: Brc38StageTable,
    index: number,
    selected: Readonly<Record<string, Brc38JsonStructuredField>>,
    policy: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    return await this.#validateStructuredFields(table, index, selected, policy, true)
  }
  async #assertStructuredSemanticOwner(sourceOnly: boolean, trx?: Knex.Transaction): Promise<void> {
    this.#available()
    if (this.owner instanceof Brc38PrivateNativeOwnershipNode) {
      if (trx === undefined) this.owner.assertDatabase(this.knex)
      else this.owner.assertTransaction(trx, sourceOnly)
      return
    }
    if (!sourceOnly || !(this.owner instanceof Brc38StagingOwnershipNode) || this.binding === undefined)
      throw new Error('Structured semantic staging requires the actual private native owner or explicit owned source')
    await this.owner.assertCurrentSource(this.directory, this.binding.digest, this.limits.expiresAt)
    // Use the currently borrowed transaction when one exists. Asking the root
    // pool for another connection here would wait on its own single writer.
    const database = trx ?? this.knex,
      bound = await database('private_binding')
        .where({ slot: 1 })
        .first(
          'protocol',
          'digest',
          database.raw(
            'CASE WHEN length(CAST(bindingJson AS BLOB))<=4096 THEN bindingJson ELSE NULL END AS bindingJson'
          ),
          database.raw('CASE WHEN length(CAST(limitsJson AS BLOB))<=256 THEN limitsJson ELSE NULL END AS limitsJson')
        ),
      pages = (await database.raw('PRAGMA max_page_count')) as Array<{ max_page_count: number }>
    if (
      bound?.protocol !== 'brc38-resumable-private/v1' ||
      bound.digest !== this.binding.digest ||
      bound.bindingJson !== this.binding.bindingJson ||
      bound.limitsJson !== this.binding.limitsJson ||
      pages.length !== 1 ||
      pages[0].max_page_count !== maximumPages(this.limits)
    )
      throw new Error('Structured source current binding or physical page allowance differs')
    const meta = await this.#metadata(database)
    // Read all fixed counters from the current borrowed database in one bounded
    // statement. This is fresh comparison data, never a retained owner verdict.
    const values: TableCount[] = await database<TableCount>('table_counts')
      .whereIn('tableName', [...brc38StageTables])
      .whereRaw("typeof(rows) = 'integer'")
      .select('tableName', 'rows')
      .limit(brc38StageTables.length + 1)
    const counts = new Map(values.map(value => [value.tableName, value]))
    if (counts.size !== values.length) throw new Error('Structured source current table count is absent')
    let total = 0
    for (const table of brc38StageTables) {
      const value = counts.get(table)
      if (value === undefined) throw new Error('Structured source current table count is absent')
      integer(value.rows, 0, this.limits.maximumRows)
      total += value.rows
      if (total > this.limits.maximumRows)
        throw new Error('Structured source current table count exceeds its original limit')
    }
    if (total !== meta.rows) throw new Error('Structured source current row counters differ')
    await this.#physicalBytes()
    this.#available()
  }
  async #validateStructuredFields(
    table: Brc38StageTable,
    index: number,
    selected: Readonly<Record<string, Brc38JsonStructuredField>>,
    selectedPolicy: Brc38PrivateStructuredPolicy,
    sourceOnly: boolean
  ): Promise<void> {
    const policy = brc38PrivateStructuredPolicy(selectedPolicy, this.directory),
      descriptors: Record<string, Brc38JsonStructuredField> = Object.create(null),
      names = Object.keys(selected)
    if (names.length > 3) throw new Error('Too many private structured field descriptors')
    for (const field of names) {
      const value = selected[field]
      if (
        !brc38JsonStructuredField(table, field) ||
        value.field !== field ||
        value.encoding !== 'utf8-json' ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 2 ||
        value.bytes > policy.maximumStructuredBytes ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        throw new Error('Invalid private structured field descriptor')
      descriptors[field] = Object.freeze({ field, encoding: value.encoding, bytes: value.bytes, sha256: value.sha256 })
    }
    await this.#exclusive(async () => {
      await this.#assertStructuredSemanticOwner(sourceOnly)
      const current = async () => {
        this.#available()
        policy.signal?.throwIfAborted()
        await this.#assertStructuredSemanticOwner(sourceOnly)
        const physical = await this.#measureStructuredPhysical(policy.maximumTemporaryIndexBytes, policy.signal)
        // Reserve the entire index file ceiling alongside actual DB/journal
        // allocation. The readonly source cannot grow while #exclusive owns it.
        if (policy.maximumTemporaryIndexBytes > this.limits.maximumPhysicalBytes - physical)
          throw new SnapshotResourceLimitError(
            'Private source and external index exceed their aggregate byte reservation'
          )
        await ownedTransaction(this.knex, async trx => {
          await this.#assertStructuredSemanticOwner(sourceOnly, trx)
          await this.#metadata(trx)
          const actual = await readBrc38SqlStructuredDescriptors(trx, table, index)
          if (
            Object.keys(actual).length !== names.length ||
            names.some(field => {
              const value = actual[field],
                expected = descriptors[field]
              return (
                value === undefined ||
                value.encoding !== expected.encoding ||
                value.bytes !== expected.bytes ||
                value.sha256 !== expected.sha256
              )
            })
          )
            throw new Error('Actual private structured source descriptors differ')
          this.#available()
          await this.#assertStructuredSemanticOwner(sourceOnly, trx)
        })
        this.#available()
        policy.signal?.throwIfAborted()
      }
      await current()
      for (const field of names) {
        const expected = descriptors[field]
        let issued = false
        const source: Brc38StreamedStructured = Object.freeze({
          encoding: 'utf8',
          length: expected.bytes,
          sha256: expected.sha256,
          read: async (offset: number, length: number) => {
            if (
              policy.maximumReadBytes !== undefined &&
              (!Number.isSafeInteger(length) || length > policy.maximumReadBytes)
            )
              throw new SnapshotResourceLimitError('Structured source exceeds its original transfer window')
            await current()
            const provisional = this.owner instanceof Brc38StagingOwnershipNode,
              read = provisional
                ? this.#withProvisionalStructuredRead.bind(this)
                : (operation: (trx: Knex.Transaction) => Promise<Uint8Array>) => ownedTransaction(this.knex, operation),
              bytes = await read(async trx => {
                await this.#assertStructuredSemanticOwner(sourceOnly, trx)
                await this.#metadata(trx)
                const value = await readBrc38SqlStructuredRange(
                  trx,
                  table,
                  index,
                  field,
                  offset,
                  length,
                  expected,
                  policy.maximumReadBytes,
                  () => this.#available(),
                  provisional
                )
                this.#available()
                await this.#assertStructuredSemanticOwner(sourceOnly, trx)
                return value
              })
            await current()
            return bytes
          },
          openIndex: async (): Promise<Brc38JsonMemberIndex> => {
            if (issued) throw new Error('Private structured source index was already issued')
            issued = true
            await current()
            let actual: Brc38NodeJsonIndex
            try {
              actual = await Brc38NodeJsonIndex.open({
                privateParent: policy.privateIndexParent,
                sourceBytes: expected.bytes,
                maximumTemporaryFileBytes: policy.maximumTemporaryIndexBytes,
                maximumTemporaryPhysicalBytes: policy.maximumTemporaryIndexBytes,
                maximumMembers: policy.maximumIndexMembers,
                maximumAllocationBytes: policy.maximumIndexAllocationBytes,
                workingAllocation: policy.workingAllocation,
                expiresAt: this.operationExpiresAt,
                signal: policy.signal
              })
            } catch (cause) {
              if (cause instanceof Brc38StagingCleanupError) this.#retainStructuredAcquisitionCleanup(cause)
              throw cause
            }
            this.#structuredIndexes.add(actual)
            // The wrapper rechecks the actual private source around every index
            // call, not merely during its first bounded byte read.
            return Object.freeze({
              put: async (object, member) => {
                await current()
                await actual.put(object, member)
                await current()
              },
              seal: async () => {
                await current()
                await actual.seal()
                await current()
              },
              entries: async function* (object) {
                await current()
                for await (const member of actual.entries(object)) {
                  await current()
                  yield member
                  await current()
                }
                await current()
              },
              lookup: async (object, key) => {
                await current()
                const value = await actual.lookup(object, key)
                await current()
                return value
              },
              close: async () => {
                await actual.close()
                this.#structuredIndexes.delete(actual)
              }
            } satisfies Brc38JsonMemberIndex)
          }
        })
        // Retain raw spelling for exact authenticated-envelope replay. A second
        // private family contains the original portable projector's canonical
        // value, including last duplicate semantics and optional-null omission.
        await ownedTransaction(this.knex, async trx => {
          await this.#assertStructuredSemanticOwner(sourceOnly, trx)
          await this.#metadata(trx)
          await beginBrc38SqlCanonicalStructuredField(
            trx,
            table,
            index,
            field,
            'utf8-json',
            policy.maximumCanonicalBytes,
            this.limits.maximumLogicalBytes,
            this.limits.maximumRows,
            expected
          )
          this.#available()
          await this.#physicalBytes()
        })
        let offset = 0
        const digest = createHash('sha256')
        for await (const input of validatedCanonicalBrc38StructuredWalletField(
          field,
          source,
          {
            maximumInputBytes: policy.maximumStructuredBytes,
            maximumOutputBytes: policy.maximumCanonicalBytes,
            maximumChunkBytes: policy.maximumReadBytes ?? 65536,
            maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
            workingAllocation: policy.workingAllocation,
            signal: policy.signal
          },
          `${table}[${index}]`
        )) {
          const bytes = detachBrc38PrivateChunk(input, policy.maximumReadBytes ?? 65536)
          digest.update(bytes)
          await ownedTransaction(this.knex, async trx => {
            await this.#assertStructuredSemanticOwner(sourceOnly, trx)
            await this.#metadata(trx)
            await verifyBrc38SqlCanonicalStructuredSource(trx, table, index, expected)
            await appendBrc38SqlCanonicalStructuredField(
              trx,
              table,
              index,
              field,
              offset,
              bytes,
              this.limits.maximumLogicalBytes
            )
            this.#available()
            await this.#physicalBytes()
          })
          offset += bytes.byteLength
          await current()
        }
        // No complete derived field before validator EOF AND index close.
        await completeBrc38SqlCanonicalStructuredField(
          async operation =>
            // The original source may be a reopened authenticated native
            // reservation. Its existing read helper still proves the actual
            // sealed source, archive hash and read-only slot before borrowing.
            await this.#withProvisionalStructuredRead(async trx => {
              await this.#assertStructuredSemanticOwner(sourceOnly, trx)
              await verifyBrc38SqlCanonicalStructuredSource(trx, table, index, expected)
              return await operation(trx)
            }, sourceOnly),
          async operation =>
            await ownedTransaction(this.knex, async trx => {
              await this.#assertStructuredSemanticOwner(sourceOnly, trx)
              await this.#metadata(trx)
              await verifyBrc38SqlCanonicalStructuredSource(trx, table, index, expected)
              const result = await operation(trx)
              this.#available()
              await this.#physicalBytes()
              return result
            }),
          table,
          index,
          { field, encoding: 'utf8-json', bytes: offset, sha256: digest.digest('hex') },
          () => {
            this.#available()
            policy.signal?.throwIfAborted()
          },
          Math.min(this.#structuredCompletionReadBytes(), policy.maximumReadBytes ?? 65536)
        )
        await current()
      }
    })
  }
  async append(record: Brc38StageRecord): Promise<void> {
    await this.#appendRecord(record)
  }
  async appendStreamed(
    record: Brc38StageRecord,
    descriptors: Brc38JsonStreamedRow['binaries'],
    structured: NonNullable<Brc38JsonStreamedRow['structured']> = {},
    texts: NonNullable<Brc38JsonStreamedRow['texts']> = {}
  ): Promise<void> {
    const detached: Record<string, Brc38JsonStreamedField> = Object.create(null)
    const json: Record<string, Brc38JsonStructuredField> = Object.create(null)
    const text: Record<string, Brc38JsonTextField> = Object.create(null)
    const names = Object.keys(descriptors)
    if (names.length > 3) throw new Error('Too many private binary field descriptors')
    for (const field of names) {
      const value = descriptors[field]
      if (Object.hasOwn(record.row, field)) throw new Error('Private row metadata overlaps its binary field')
      detached[field] = Object.freeze({
        field: value.field,
        encoding: value.encoding,
        bytes: value.bytes,
        sha256: value.sha256
      })
    }
    const jsonNames = Object.keys(structured)
    if (jsonNames.length > 3) throw new Error('Too many private structured field descriptors')
    for (const field of jsonNames) {
      const value = structured[field]
      if (Object.hasOwn(record.row, field) || Object.hasOwn(detached, field))
        throw new Error('Private row metadata or binary fields overlap a structured field')
      json[field] = Object.freeze({
        field: value.field,
        encoding: value.encoding,
        bytes: value.bytes,
        sha256: value.sha256
      })
    }
    const textNames = Object.keys(texts)
    if (textNames.length > 7) throw new Error('Too many private scalar TEXT descriptors')
    for (const field of textNames) {
      const value = texts[field]
      if (Object.hasOwn(record.row, field) || Object.hasOwn(detached, field) || Object.hasOwn(json, field))
        throw new Error('Private row or fields overlap a scalar TEXT field')
      text[field] = Object.freeze({
        field: value.field,
        encoding: value.encoding,
        bytes: value.bytes,
        sha256: value.sha256
      })
    }
    await this.#appendRecord(record, Object.freeze(detached), Object.freeze(json), Object.freeze(text))
  }
  async #appendRecord(
    record: Brc38StageRecord,
    descriptors?: Brc38JsonStreamedRow['binaries'],
    structured: NonNullable<Brc38JsonStreamedRow['structured']> = {},
    texts: NonNullable<Brc38JsonStreamedRow['texts']> = {}
  ): Promise<void> {
    await this.#exclusive(async () => {
      if (!brc38StageTables.includes(record.table) || !Number.isSafeInteger(record.index) || record.index < 0)
        throw new Error('Invalid private BRC-38 row coordinate')
      if (record.uniqueKeys.length > 2 || record.memberships.length > 2)
        throw new SnapshotResourceLimitError('Private BRC-38 indexed key count exceeds its row policy')
      // Capture row coordinates and indexed key DATA before the new read phase
      // yields. The encoded payload below is the only later use of row values.
      record = Object.freeze({
        table: record.table,
        index: record.index,
        row: record.row,
        uniqueKeys: Object.freeze(
          record.uniqueKeys.map(entry => Object.freeze({ namespace: entry.namespace, key: entry.key }))
        ),
        memberships: Object.freeze(
          record.memberships.map(entry => Object.freeze({ namespace: entry.namespace, key: entry.key }))
        )
      })
      const encoded = boundedJson(record.row, this.limits),
        charge = encoded.bytes + keyCharge(record.uniqueKeys) + keyCharge(record.memberships) + 128
      const fieldNames =
          Object.keys(descriptors ?? {}).length + Object.keys(structured).length + Object.keys(texts).length,
        readBytes =
          fieldNames === 0
            ? 128
            : Math.min(
                this.#structuredCompletionReadBytes(),
                Math.floor((this.limits.maximumRowAllocationBytes - 8192 - 8 * charge) / 16)
              )
      if (fieldNames !== 0 && readBytes < 128)
        throw new SnapshotResourceLimitError(
          'Private row and field content read exceed their original combined allocation'
        )
      const fieldMetadata = await this.#withProvisionalStructuredRead(
        async trx =>
          await readBrc38SqlRowFieldContent(
            trx,
            record.table,
            record.index,
            descriptors ?? {},
            structured,
            fieldNames === 0 ? 128 : readBytes,
            () => this.#available(),
            texts
          ),
        true
      )
      await ownedTransaction(this.knex, async trx => {
        const meta = await this.#metadata(trx),
          count = await tableCount(trx, record.table)
        await compareBrc38SqlRowFieldMetadata(trx, fieldMetadata, () => this.#available())
        if (this.owner !== undefined && count !== undefined && record.index < count.rows) {
          await this.#verifyReplay(trx, record, encoded)
          return
        }
        if (meta.state !== 'staging' || count?.rows !== record.index)
          throw new Error('Private BRC-38 stage is sealed or its row order is invalid')
        if (meta.rows >= this.limits.maximumRows || charge > this.limits.maximumLogicalBytes - meta.logicalBytes)
          throw new SnapshotResourceLimitError('Private BRC-38 staging logical quota reached')
        await trx('rows').insert({
          tableName: record.table,
          position: record.index,
          ...encoded,
          recordDigest: recordDigest(record, encoded.payload)
        })
        await runInSeries(record.uniqueKeys, entry =>
          trx('unique_keys')
            .insert(entry)
            .then(() => undefined)
        )
        await runInSeries(record.memberships, entry =>
          trx('memberships')
            .insert(entry)
            .onConflict(['namespace', 'key'])
            .ignore()
            .then(() => undefined)
        )
        await trx('table_counts')
          .where({ tableName: record.table })
          .update({ rows: record.index + 1 })
        await trx('metadata')
          .where({ slot: 1 })
          .update({
            rows: meta.rows + 1,
            logicalBytes: meta.logicalBytes + charge
          })
        this.#available()
        await this.#physicalBytes()
      })
      await this.#physicalBytes()
    })
  }
  async #verifyReplay(
    trx: Knex.Transaction,
    record: Brc38StageRecord,
    encoded: { payload: string; bytes: number }
  ): Promise<void> {
    const coordinate = { tableName: record.table, position: record.index },
      extent = await rowExtent(trx, record.table, record.index)
    if (
      extent === undefined ||
      extent.bytes !== encoded.bytes ||
      extent.payloadBytes !== encoded.bytes ||
      extent.bytes > this.limits.maximumRowBytes ||
      extent.payloadKind !== 'text' ||
      extent.digestBytes !== 64 ||
      extent.digestKind !== 'text'
    )
      throw new Error('Private BRC-38 replay row byte extent differs')
    const stored = await trx<StoredRow>('rows').where(coordinate).first()
    if (
      stored === undefined ||
      stored.payload !== encoded.payload ||
      stored.recordDigest !== recordDigest(record, encoded.payload)
    )
      throw new Error('Private BRC-38 replay does not match its committed prefix')
    await runInSeries(record.uniqueKeys, async entry => {
      if ((await trx('unique_keys').where(entry).first('namespace')) === undefined)
        throw new Error('Private BRC-38 replay unique index is missing')
    })
    await runInSeries(record.memberships, async entry => {
      if ((await trx('memberships').where(entry).first('namespace')) === undefined)
        throw new Error('Private BRC-38 replay membership index is missing')
    })
  }
  async #readCount(table: Brc38StageTable): Promise<number> {
    const value = await tableCount(this.knex, table)
    if (
      value === undefined ||
      !Number.isSafeInteger(value.rows) ||
      value.rows < 0 ||
      value.rows > this.limits.maximumRows
    )
      throw new Error('Invalid private BRC-38 table count')
    return value.rows
  }
  async count(table: Brc38StageTable): Promise<number> {
    return await this.#exclusive(async () => await this.#readCount(table))
  }
  async #readRow(
    table: Brc38StageTable,
    index: number,
    k: Knex = this.knex
  ): Promise<Readonly<PortableRow> | undefined> {
    // Do not fetch a payload until its persisted byte bound is checked.
    const coordinate = { tableName: table, position: index },
      meta = await rowExtent(k, table, index)
    if (meta === undefined) return undefined
    if (
      meta.bytes === null ||
      !Number.isSafeInteger(meta.bytes) ||
      meta.bytes < 1 ||
      meta.bytes > this.limits.maximumRowBytes ||
      meta.digestBytes !== 64 ||
      meta.digestKind !== 'text'
    )
      throw new Error('Invalid private BRC-38 row byte bound')
    if (meta.payloadKind !== 'text' || meta.payloadBytes !== meta.bytes)
      throw new Error('Private BRC-38 staged payload length is inconsistent')
    const value = await k<StoredRow>('rows').where(coordinate).first('payload')
    if (value === undefined || Buffer.byteLength(value.payload, 'utf8') !== meta.bytes)
      throw new Error('Private BRC-38 staged payload length is inconsistent')
    return JSON.parse(value.payload) as PortableRow
  }
  async row(table: Brc38StageTable, index: number): Promise<Readonly<PortableRow> | undefined> {
    return await this.#exclusive(async () => await this.#readRow(table, index))
  }
  async streamedRow(table: Brc38StageTable, index: number): Promise<Brc38JsonStreamedRow | undefined> {
    return await this.#exclusive(
      async () =>
        await ownedTransaction(this.knex, async trx => {
          await this.#metadata(trx)
          const fields = await this.#readRow(table, index, trx)
          if (fields === undefined) return undefined
          const binaries = await readBrc38SqlBinaryDescriptors(trx, table, index)
          const structured = await readBrc38SqlStructuredDescriptors(trx, table, index),
            texts = await readBrc38SqlTextDescriptors(trx, table, index)
          if (
            Object.keys(binaries).some(field => Object.hasOwn(fields, field)) ||
            Object.keys(structured).some(field => Object.hasOwn(fields, field) || Object.hasOwn(binaries, field)) ||
            Object.keys(texts).some(
              field =>
                Object.hasOwn(fields, field) || Object.hasOwn(binaries, field) || Object.hasOwn(structured, field)
            )
          )
            throw new Error('Private row metadata overlaps its persisted field')
          this.#available()
          return Object.freeze({
            fields,
            binaries,
            ...(Object.keys(structured).length === 0 ? {} : { structured }),
            ...(Object.keys(texts).length === 0 ? {} : { texts })
          })
        })
    )
  }
  async has(namespace: string, key: string): Promise<boolean> {
    return await this.#exclusive(async () => {
      if ((await this.knex('unique_keys').where({ namespace, key }).first('namespace')) !== undefined) return true
      return (await this.knex('memberships').where({ namespace, key }).first('namespace')) !== undefined
    })
  }
  async seal(header: Readonly<BRC38WalletData>, counts: Readonly<Record<Brc38StageTable, number>>): Promise<void> {
    await this.#seal(header, counts, false)
  }
  async sealStreamed(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>
  ): Promise<void> {
    await this.#seal(header, counts, true)
  }
  /** Complete fresh original semantic/relationship replay. No semantic result
   * is persisted or reused: every raw value, original record/index membership
   * and canonical output is re-read using this actual private source owner.
   * Replay appends verify existing immutable prefixes and do not reinsert rows.
   * The final replay seal is deliberately local/no-op, never an admission. */
  async verifyPrivateStructuredSemantics(
    header: Readonly<BRC38WalletData>,
    selectedCounts: Readonly<Record<Brc38StageTable, number>>,
    selectedPolicy: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    return await this.#verifyStructuredSemantics(header, selectedCounts, selectedPolicy, false)
  }
  async verifyOwnedSourceStructuredSemantics(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>,
    policy: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    return await this.#verifyStructuredSemantics(header, counts, policy, true)
  }
  async #verifyStructuredSemantics(
    header: Readonly<BRC38WalletData>,
    selectedCounts: Readonly<Record<Brc38StageTable, number>>,
    selectedPolicy: Brc38PrivateStructuredPolicy,
    sourceOnly: boolean
  ): Promise<void> {
    const policy = brc38PrivateStructuredPolicy(selectedPolicy, this.directory),
      bound = this.binding,
      captured = JSON.parse(boundedJson(header, this.limits).payload) as BRC38WalletData,
      counts = Object.freeze(
        Object.fromEntries(brc38StageTables.map(table => [table, selectedCounts[table]]))
      ) as Readonly<Record<Brc38StageTable, number>>
    this.#available()
    policy.signal?.throwIfAborted()
    if (bound === undefined || (!sourceOnly && !(this.owner instanceof Brc38PrivateNativeOwnershipNode)))
      throw new Error('Structured semantic replay requires this actual private native source')
    await this.#assertStructuredSemanticOwner(sourceOnly)
    let total = 0
    for (const table of brc38StageTables) {
      integer(counts[table], 0, this.limits.maximumRows)
      total += counts[table]
      if (total > this.limits.maximumRows)
        throw new SnapshotResourceLimitError('Structured replay exceeds its original row limit')
    }
    const bridge: Brc38StreamedStageStore = {
      append: record => this.append(record),
      appendStreamed: (record, binary, json, text) => this.appendStreamed(record, binary, json, text),
      count: table => this.count(table),
      row: (table, index) => this.row(table, index),
      streamedRow: (table, index) => this.streamedRow(table, index),
      has: (namespace, key) => this.has(namespace, key),
      validateTextFields: (table, index, descriptors) => this.validateTextFields(table, index, descriptors),
      validateStructuredFields: (table, index, descriptors, selected) =>
        this.#validateStructuredFields(table, index, descriptors, selected, sourceOnly),
      seal: async () => {},
      sealStreamed: async () => {},
      discard: async () => {
        throw new Error('Semantic source replay cannot dispose its caller-owned source')
      }
    }
    const semantic = new Brc38StreamedSemanticStage(
      bridge,
      {
        expectedIdentityKey: bound.binding.identityKey,
        expectedChain: bound.binding.chain,
        expectedSourceStorageIdentityKey: bound.binding.sourceStorageIdentityKey,
        maximumRows: this.limits.maximumRows,
        signal: policy.signal
      },
      policy
    )
    for (const table of brc38StageTables) {
      if ((await this.count(table)) !== counts[table]) throw new Error('Structured replay source count differs')
      for (let index = 0; index < counts[table]; index++) {
        policy.signal?.throwIfAborted()
        this.#available()
        const row = await this.streamedRow(table, index)
        if (row === undefined) throw new Error('Structured replay actual source row is absent')
        await semantic.provisionalRow(table, index, row)
      }
    }
    await semantic.validateCompleted(captured, counts)
    const metadata = await this.#metadata(this.knex)
    if (
      metadata.rows !== total ||
      (metadata.state === 'sealed' && metadata.header !== boundedJson(captured, this.limits).payload)
    )
      throw new Error('Structured replay original source/header changed')
    await this.#assertStructuredSemanticOwner(sourceOnly)
    this.#available()
    await this.#physicalBytes()
  }
  /** Explicit structured source seal, separate from the unchanged binary-only
   * fence. Full fresh indexed original semantics settle before its short writer. */
  async sealStructuredStreamed(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>,
    policy: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    const capturedHeader = JSON.parse(boundedJson(header, this.limits).payload) as BRC38WalletData,
      capturedCounts = Object.freeze(
        Object.fromEntries(brc38StageTables.map(table => [table, counts[table]]))
      ) as Readonly<Record<Brc38StageTable, number>>,
      capturedPolicy = brc38PrivateStructuredPolicy(policy, this.directory)
    await this.verifyPrivateStructuredSemantics(capturedHeader, capturedCounts, capturedPolicy)
    await this.#seal(capturedHeader, capturedCounts, true, true)
  }
  async sealOwnedSourceStructuredStreamed(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>,
    policy: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    const capturedHeader = JSON.parse(boundedJson(header, this.limits).payload) as BRC38WalletData,
      capturedCounts = Object.freeze(
        Object.fromEntries(brc38StageTables.map(table => [table, counts[table]]))
      ) as Readonly<Record<Brc38StageTable, number>>,
      capturedPolicy = brc38PrivateStructuredPolicy(policy, this.directory)
    await this.#verifyStructuredSemantics(capturedHeader, capturedCounts, capturedPolicy, true)
    await this.#seal(capturedHeader, capturedCounts, true, true)
  }
  async #seal(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>,
    streamed: boolean,
    structured = false
  ): Promise<void> {
    await this.#exclusive(async () => {
      const encoded = boundedJson(header, this.limits),
        capturedCounts = Object.freeze(
          Object.fromEntries(
            brc38StageTables.map(table => {
              const count = counts[table]
              if (!Number.isSafeInteger(count) || count < 0 || count > this.limits.maximumRows)
                throw new Error('Private BRC-38 original seal count is invalid')
              return [table, count]
            })
          )
        ) as Readonly<Record<Brc38StageTable, number>>,
        original = await this.#readSourceFields(streamed, structured, encoded.bytes)
      await ownedTransaction(this.knex, async trx => {
        const meta = await this.#metadata(trx)
        this.#compareSourceMetadata(meta, original.metadata)
        await compareBrc38SqlSourceFieldCounts(trx, original.fields, streamed, structured, () => this.#available())
        if (meta.state === 'sealed' && this.owner !== undefined) {
          if (meta.header !== encoded.payload) throw new Error('Private BRC-38 replay sealed header differs')
          await this.#verifySealCounts(trx, capturedCounts)
          return
        }
        if (meta.state !== 'staging') throw new Error('Private BRC-38 stage is already sealed')
        if (encoded.bytes > this.limits.maximumLogicalBytes - meta.logicalBytes)
          throw new SnapshotResourceLimitError('Private BRC-38 staging header quota reached')
        await this.#verifySealCounts(trx, capturedCounts)
        await trx('metadata')
          .where({ slot: 1 })
          .update({
            state: 'sealed',
            header: encoded.payload,
            logicalBytes: meta.logicalBytes + encoded.bytes
          })
        this.#available()
        await this.#physicalBytes()
      })
      await this.#physicalBytes()
    })
  }
  #compareSourceMetadata(actual: Metadata, original: Metadata): void {
    if (
      actual.state !== original.state ||
      actual.rows !== original.rows ||
      actual.logicalBytes !== original.logicalBytes ||
      actual.header !== original.header
    )
      throw new Error('Private original source state/header/counters changed after its drained field read')
  }
  /** Field content hashes outside the writer, on the same exclusive physical
   * owner/single pool. Original metadata/header and window scratch share the
   * original numerical allocation. Only bounded comparison DATA survive. Core
   * row semantics and counts are still independently checked by their original
   * semantic preparation and final writer; this is no reusable source verdict. */
  async #readSourceFields(streamed: boolean, structured: boolean, retainedBytes = 0) {
    return await this.#withProvisionalStructuredRead(async trx => {
      const metadata = await this.#metadata(trx),
        readBytes = Math.min(
          65536,
          Math.floor(
            (this.limits.maximumRowAllocationBytes -
              16384 -
              16 * (retainedBytes + Buffer.byteLength(metadata.header ?? ''))) /
              16
          )
        )
      const fields = await readBrc38SqlSourceFieldContent(
        trx,
        this.limits.maximumRows,
        readBytes < 128 ? 0 : readBytes,
        streamed,
        structured,
        () => this.#available()
      )
      this.#compareSourceMetadata(await this.#metadata(trx), metadata)
      return Object.freeze({ metadata, fields })
    }, true)
  }
  async #verifySealCounts(trx: Knex.Transaction, counts: Readonly<Record<Brc38StageTable, number>>): Promise<void> {
    await runInSeries(brc38StageTables, async table => {
      const value = await tableCount(trx, table)
      if (value?.rows !== counts[table]) throw new Error('Private BRC-38 seal count mismatch')
    })
  }
  async #privateImport(trx: Knex): Promise<{
    archiveSha256: string | null
    previewJson: string | null
    previewSha256: string | null
    previewBytes: number
  }> {
    if (this.binding === undefined) throw new Error('Private import requires an owned archive binding')
    if (!(await trx.schema.hasTable('private_import')))
      return { archiveSha256: null, previewJson: null, previewSha256: null, previewBytes: 0 }
    const extent = (
      (await trx.raw(
        'SELECT length(CAST(archiveSha256 AS BLOB)) AS archiveBytes, length(CAST(previewJson AS BLOB)) AS previewBytes, length(CAST(previewSha256 AS BLOB)) AS digestBytes FROM private_import WHERE slot = 1 LIMIT 1'
      )) as Array<{
        archiveBytes: number | null
        previewBytes: number | null
        digestBytes: number | null
      }>
    ).at(0)
    if (extent === undefined || (extent.archiveBytes !== null && extent.archiveBytes !== 64))
      throw new Error('Private import authentication metadata is invalid')
    if (
      extent.previewBytes !== null &&
      (!Number.isSafeInteger(extent.previewBytes) ||
        extent.previewBytes < 1 ||
        extent.previewBytes > 8192 ||
        extent.digestBytes !== 64)
    )
      throw new Error('Private import preview exceeds its metadata bounds')
    const value = await trx<{
      slot: number
      archiveSha256: string | null
      previewJson: string | null
      previewSha256: string | null
    }>('private_import')
      .where({ slot: 1 })
      .first()
    if (
      value === undefined ||
      (value.archiveSha256 !== null && value.archiveSha256 !== this.binding.binding.archiveSha256)
    )
      throw new Error('Private import authentication binding is inconsistent')
    if (value.previewJson === null) {
      if (value.previewSha256 !== null) throw new Error('Private import preview digest has no receipt')
    } else if (
      typeof value.previewJson !== 'string' ||
      createHash('sha256').update(value.previewJson).digest('hex') !== value.previewSha256
    ) {
      throw new Error('Private import preview digest is inconsistent')
    }
    if (value.archiveSha256 !== null) await verifyBrc38AuthenticatedSourceSeal(trx)
    return { ...value, previewBytes: extent.previewBytes ?? 0 }
  }
  /** Internal native destination authority is restricted to this actual claimed
   * private database. It cannot bless an active provider or an unowned stage. */
  get privateNativeDestinationPageLimit(): number {
    return maximumPages(this.limits)
  }
  assertPrivateNativeDestination(database: Knex): void {
    this.#available()
    if (this.owner === undefined || this.binding === undefined || database !== this.knex)
      throw new Error('Native import destination requires the actual claimed private stage')
  }
  /** Internal irreversible phase of the actual private kernel, before complete
   * publication comparison. On source change/failure close and explicitly resume
   * the original reservation; this store cannot return to importing mutations. */
  async beginPrivateNativeComparison(): Promise<void> {
    this.assertPrivateNativeDestination(this.knex)
    if (!(this.owner instanceof Brc38PrivateNativeOwnershipNode) || this.#busy)
      throw new Error('Private comparison requires its actual idle native receiver owner')
    this.#busy = true
    try {
      await this.owner.beginComparison(this.knex)
      this.#available()
    } finally {
      this.#busy = false
    }
  }
  async requirePrivateNativeComparison(): Promise<void> {
    this.assertPrivateNativeDestination(this.knex)
    if (!(this.owner instanceof Brc38PrivateNativeOwnershipNode))
      throw new Error('Private comparison requires its actual native receiver owner')
    await this.owner.requireComparison(this.knex)
    this.#available()
  }
  /** Actual slot0 writer from this original private native receiver. This is
   * actor membership only; each caller still verifies source/schema/profile. */
  assertPrivateNativeWriteTransaction(trx: Knex.Transaction): void {
    this.#available()
    if (
      !(this.owner instanceof Brc38PrivateNativeOwnershipNode) ||
      this.binding === undefined ||
      privateNativeTransactionIdentity(trx)?.slot !== 0 ||
      !isBrc38OwnedPrivateNativeWriter(trx)
    )
      throw new Error('Private native writer requires its actual source owner')
    this.owner.assertTransaction(trx)
  }
  /** Current borrowed read-only lease must belong to this exact original
   * owner. It grants no source/schema/semantic verdict and cannot select a
   * copied transaction or another private import's genuine reader. */
  assertPrivateNativeReadTransaction(trx: Knex.Transaction): void {
    this.#available()
    if (
      !(this.owner instanceof Brc38PrivateNativeOwnershipNode) ||
      this.binding === undefined ||
      privateNativeTransactionIdentity(trx)?.slot !== 3 ||
      !isBrc38OwnedPrivateNativeSqlite(trx)
    )
      throw new Error('Private native read transaction requires its actual source owner')
    this.owner.assertTransaction(trx, true)
  }
  /** The actual enrolled receiver owner lends its root writer or a separate
   * physical read-only slot. Every lease is drained before this callback ends;
   * the writer root remains the store's responsibility, never an incidental pool. */
  async withPrivateNativeDatabase<T>(readOnly: boolean, work: (database: Knex) => Promise<T>): Promise<T> {
    if (!isBrc38OwnedPrivateNativeSqlite(this.knex) || !(this.owner instanceof Brc38PrivateNativeOwnershipNode))
      throw new Error('Private native destination requires its current authenticated receiver scope')
    if (!readOnly) return await work(this.knex)
    return await this.#withPrivateNativeReadDatabase(work)
  }
  /** Internal source validation can borrow the same physical read-only lease
   * before writer enrollment. Its caller owns the exclusive staging operation;
   * public native access still requires the authenticated callback above. */
  async #withPrivateNativeReadDatabase<T>(work: (database: Knex) => Promise<T>): Promise<T> {
    if (!(this.owner instanceof Brc38PrivateNativeOwnershipNode))
      throw new Error('Private native read lease requires its actual physical owner')
    const database = this.owner.createReadDatabase()
    privateNativeDatabases.set(database, this)
    let value!: T,
      failed = false,
      cause: unknown
    try {
      // The kernel establishes read-only/query-only mode before its authorizer.
      // Inspect it here; comparison/recovery never relax or rewrite settings.
      // Destruction below drains this fresh slot, including admission failures.
      this.owner.assertDatabase(database, true)
      const mode = (await database.raw('PRAGMA query_only')) as Array<{ query_only: number }>
      if (mode.length !== 1 || mode[0].query_only !== 1) throw new Error('Private native read-only query mode differs')
      value = await work(database)
      this.owner.assertDatabase(database, true)
      const after = (await database.raw('PRAGMA query_only')) as Array<{ query_only: number }>
      if (after.length !== 1 || after[0].query_only !== 1)
        throw new Error('Private native read-only query mode changed')
    } catch (error_) {
      failed = true
      cause = error_
    }
    const cleanup = async (): Promise<void> => {
      await database.destroy()
      privateNativeDatabases.delete(database)
    }
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [...(failed ? [cause] : []), error_],
        'Private native destination retains its read-only physical lease',
        cleanup
      )
    }
    this.#available()
    if (failed) throw cause
    return value
  }
  /** One retained authenticated raw structured field for projection preparation
   * on this owner's actual read-only destination lease. Filesystem work never
   * holds a SQL writer. No source facade or unfinished index survives callback
   * drainage, and cleanup failure remains owned by the enclosing receiver. */
  async withPrivateStructuredFieldSource<T>(
    trx: Knex.Transaction,
    table: Brc38StageTable,
    index: number,
    field: string,
    selected: Brc38PrivateStructuredPolicy,
    work: (source: Readonly<Brc38StreamedStructured>, descriptor: Readonly<Brc38JsonStructuredField>) => Promise<T>,
    additionalTemporaryFileBytes = 0
  ): Promise<T> {
    this.assertPrivateNativeReadTransaction(trx)
    return await this.withPrivateStructuredSourceActor(
      async operation => await operation(trx),
      table,
      index,
      field,
      selected,
      work,
      additionalTemporaryFileBytes
    )
  }
  /** Actual borrowed query-only facade, with a drained transaction for each
   * range/index operation. A caller cannot substitute arbitrary withRead
   * callbacks or a foreign database for this owner's enrolled native lease. */
  async withPrivateStructuredFieldDatabaseSource<T>(
    database: Knex,
    table: Brc38StageTable,
    index: number,
    field: string,
    selected: Brc38PrivateStructuredPolicy,
    work: (source: Readonly<Brc38StreamedStructured>, descriptor: Readonly<Brc38JsonStructuredField>) => Promise<T>,
    additionalTemporaryFileBytes = 0
  ): Promise<T> {
    if (
      !(this.owner instanceof Brc38PrivateNativeOwnershipNode) ||
      privateNativeDatabaseIdentity(database)?.slot !== 3 ||
      !isBrc38OwnedPrivateNativeSqlite(database)
    )
      throw new Error('Structured source requires this actual enrolled query-only facade')
    this.owner.assertDatabase(database, true)
    return await this.withPrivateStructuredSourceActor(
      async operation =>
        await database.transaction(async trx => {
          this.assertPrivateNativeReadTransaction(trx)
          const result = await operation(trx)
          this.assertPrivateNativeReadTransaction(trx)
          return result
        }),
      table,
      index,
      field,
      selected,
      work,
      additionalTemporaryFileBytes
    )
  }
  /** Original kernel ownership outlives each short native READ. No read
   * transaction is retained while the caller writes derived projection bytes
   * to the DELETE-mode private stage. No source verdict is cached. */
  private async withPrivateStructuredSourceActor<T>(
    withRead: <V>(operation: (trx: Knex.Transaction) => Promise<V>) => Promise<V>,
    table: Brc38StageTable,
    index: number,
    field: string,
    selected: Brc38PrivateStructuredPolicy,
    work: (source: Readonly<Brc38StreamedStructured>, descriptor: Readonly<Brc38JsonStructuredField>) => Promise<T>,
    additionalTemporaryFileBytes = 0
  ): Promise<T> {
    const policy = brc38PrivateStructuredPolicy(selected, this.directory),
      extra = additionalTemporaryFileBytes,
      scope = new Brc38OwnedImportReads(),
      owned = new Set<Brc38NodeJsonIndex>()
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.limits.maximumRows ||
      !brc38JsonStructuredField(table, field) ||
      !Number.isSafeInteger(extra) ||
      extra < 0 ||
      extra > 17179869184 ||
      !(this.owner instanceof Brc38PrivateNativeOwnershipNode) ||
      !isBrc38OwnedPrivateNativeSqlite(this.knex)
    )
      throw new Error('Structured projection requires this actual private read-only receiver view')
    const owner = this.owner,
      bound = this.binding
    if (bound === undefined) throw new Error('Authenticated structured source binding is unavailable')
    const current = async (expected?: Brc38JsonStructuredField): Promise<Brc38JsonStructuredField> =>
      await withRead(async trx => {
        this.#available()
        policy.signal?.throwIfAborted()
        owner.assertTransaction(trx, true)
        if (!isBrc38OwnedPrivateNativeSqlite(trx)) throw new Error('Structured source receiver scope ended')
        const physical = await this.#measureStructuredPhysical(policy.maximumTemporaryIndexBytes + extra, policy.signal)
        if (policy.maximumTemporaryIndexBytes + extra > this.limits.maximumPhysicalBytes - physical)
          throw new SnapshotResourceLimitError(
            'Structured source and projection indexes exceed their original aggregate reservation'
          )
        const working = policy.workingAllocation
        let scratch: import('./Brc38WorkingAllocation').Brc38WorkingCharge | undefined
        if (working !== undefined)
          scratch = working.claim(
            4096 + 8 * (Buffer.byteLength(bound.bindingJson) + Buffer.byteLength(bound.limitsJson))
          )
        try {
          if (working === undefined) {
            const meta = await this.#metadata(trx),
              authenticated = await this.#privateImport(trx),
              binding = await trx('private_binding')
                .where({ slot: 1 })
                .first(
                  'protocol',
                  'digest',
                  trx.raw(
                    'CASE WHEN length(CAST(bindingJson AS BLOB))<=4096 THEN bindingJson ELSE NULL END AS bindingJson'
                  ),
                  trx.raw('CASE WHEN length(CAST(limitsJson AS BLOB))<=256 THEN limitsJson ELSE NULL END AS limitsJson')
                )
            if (
              meta.state !== 'sealed' ||
              meta.header === null ||
              authenticated.archiveSha256 !== bound.binding.archiveSha256 ||
              binding?.protocol !== 'brc38-resumable-private/v1' ||
              binding.digest !== bound.digest ||
              binding.bindingJson !== bound.bindingJson ||
              binding.limitsJson !== bound.limitsJson ||
              (await rowExtent(trx, table, index)) === undefined
            )
              throw new Error('Authenticated structured source metadata or membership differs')
          } else {
            // The original source fence needs type/state/counters here, not another
            // materialized header. Its actual full semantics remain independently
            // verified by the enclosing all13 inventory in this same retained view.
            const metadata = await trx('metadata')
                .where({ slot: 1 })
                .first(
                  trx.raw(
                    "CASE WHEN state='sealed' AND typeof(header)='text' AND length(CAST(header AS BLOB)) BETWEEN 1 AND ? AND typeof(rows)='integer' AND rows BETWEEN 0 AND ? AND typeof(logicalBytes)='integer' AND logicalBytes BETWEEN 0 AND ? THEN 1 ELSE 0 END AS valid",
                    [this.limits.maximumRowBytes, this.limits.maximumRows, this.limits.maximumLogicalBytes]
                  )
                ),
              binding = await trx('private_binding')
                .where({ slot: 1 })
                .first(
                  trx.raw(
                    "CASE WHEN protocol='brc38-resumable-private/v1' AND digest=? AND bindingJson=? AND limitsJson=? THEN 1 ELSE 0 END AS valid",
                    [bound.digest, bound.bindingJson, bound.limitsJson]
                  )
                ),
              preview = (await trx('private_import')
                .where({ slot: 1 })
                .first(
                  trx.raw(
                    "CASE WHEN typeof(archiveSha256)='text' AND length(CAST(archiveSha256 AS BLOB))=64 AND archiveSha256=? THEN 1 ELSE 0 END AS authenticated",
                    [bound.binding.archiveSha256]
                  ),
                  trx.raw(
                    "CASE WHEN previewJson IS NULL THEN 0 WHEN typeof(previewJson)='text' AND length(CAST(previewJson AS BLOB)) BETWEEN 1 AND 8192 THEN length(CAST(previewJson AS BLOB)) ELSE NULL END AS bytes"
                  ),
                  trx.raw(
                    "CASE WHEN previewSha256 IS NULL THEN NULL WHEN typeof(previewSha256)='text' AND length(CAST(previewSha256 AS BLOB))=64 THEN previewSha256 ELSE '' END AS sha256"
                  )
                )) as { authenticated: number; bytes: number | null; sha256: string | null } | undefined
            if (
              metadata?.valid !== 1 ||
              binding?.valid !== 1 ||
              preview?.authenticated !== 1 ||
              preview.bytes === null ||
              !Number.isSafeInteger(preview.bytes) ||
              (preview.bytes === 0 && preview.sha256 !== null) ||
              (preview.bytes > 0 && (typeof preview.sha256 !== 'string' || preview.sha256.length !== 64)) ||
              (await rowExtent(trx, table, index)) === undefined
            )
              throw new Error('Authenticated structured source metadata or membership differs')
            if (preview.bytes !== 0) {
              const digest = createHash('sha256'),
                width = policy.maximumReadBytes ?? 65536
              for (let offset = 0; offset < preview.bytes;) {
                this.#available()
                owner.assertTransaction(trx, true)
                const amount = Math.min(width, preview.bytes - offset),
                  transfer = working.claim(2048 + 4 * amount)
                let bytes: Uint8Array | undefined, row: { payload: Uint8Array } | undefined
                try {
                  row = (await trx('private_import')
                    .where({ slot: 1 })
                    .first(trx.raw('substr(CAST(previewJson AS BLOB),?,?) AS payload', [offset + 1, amount]))) as
                    { payload: Uint8Array } | undefined
                  if (row === undefined) throw new Error('Private import preview is unavailable')
                  bytes = detachBrc38PrivateChunk(row.payload, amount)
                  if (bytes.byteLength !== amount) throw new Error('Private import preview range differs')
                  digest.update(bytes)
                  offset += amount
                  this.#available()
                  owner.assertTransaction(trx, true)
                } finally {
                  bytes?.fill(0)
                  if (row?.payload instanceof Uint8Array) Reflect.apply(Uint8Array.prototype.fill, row.payload, [0])
                  transfer.close()
                }
              }
              if (digest.digest('hex') !== preview.sha256)
                throw new Error('Private import preview digest is inconsistent')
            }
          }
          await verifyBrc38AuthenticatedSourceSeal(trx)
          const descriptor = (await readBrc38SqlStructuredDescriptors(trx, table, index))[field]
          if (
            descriptor === undefined ||
            descriptor.bytes > policy.maximumStructuredBytes ||
            (expected !== undefined && JSON.stringify(descriptor) !== JSON.stringify(expected))
          )
            throw new Error('Authenticated structured source descriptor differs')
          this.#available()
          owner.assertTransaction(trx, true)
          return descriptor
        } finally {
          scratch?.close()
        }
      })
    const expected = await current(),
      maximumOpenIndexes = policy.maximumOpenIndexes ?? 1,
      maximumIndexBytes = Math.floor(policy.maximumTemporaryIndexBytes / maximumOpenIndexes)
    let issued = false
    const source: Readonly<Brc38StreamedStructured> = Object.freeze({
      encoding: 'utf8',
      length: expected.bytes,
      sha256: expected.sha256,
      read: (offset: number, length: number) =>
        scope.run(async () => {
          if (
            policy.maximumReadBytes !== undefined &&
            (!Number.isSafeInteger(length) || length > policy.maximumReadBytes)
          )
            throw new SnapshotResourceLimitError('Structured source exceeds its original transfer window')
          const scratch = policy.workingAllocation?.claim(3072 + 8 * length)
          let bytes: Uint8Array | undefined
          try {
            await current(expected)
            bytes = await withRead(
              async trx =>
                await readBrc38SqlStructuredRange(
                  trx,
                  table,
                  index,
                  field,
                  offset,
                  length,
                  expected,
                  policy.maximumReadBytes,
                  () => this.#available()
                )
            )
            await current(expected)
            return bytes
          } catch (error) {
            bytes?.fill(0)
            throw error
          } finally {
            scratch?.close()
          }
        }),
      openIndex: () =>
        scope.run(async () => {
          if (maximumOpenIndexes === 1 && issued)
            throw new Error('Authenticated structured source index was already issued')
          if (owned.size >= maximumOpenIndexes)
            throw new Error('Authenticated structured source index allowance is already owned')
          issued = true
          await current(expected)
          let actual: Brc38NodeJsonIndex
          try {
            actual = await Brc38NodeJsonIndex.open({
              privateParent: policy.privateIndexParent,
              sourceBytes: expected.bytes,
              maximumTemporaryFileBytes: maximumIndexBytes,
              maximumTemporaryPhysicalBytes: maximumIndexBytes,
              maximumMembers: policy.maximumIndexMembers,
              maximumAllocationBytes: policy.maximumIndexAllocationBytes,
              workingAllocation: policy.workingAllocation,
              expiresAt: this.operationExpiresAt,
              signal: policy.signal
            })
          } catch (cause) {
            if (cause instanceof Brc38StagingCleanupError) this.#retainStructuredAcquisitionCleanup(cause)
            throw cause
          }
          owned.add(actual)
          this.#structuredIndexes.add(actual)
          return Object.freeze({
            put: (object, member) =>
              scope.run(async () => {
                await current(expected)
                await actual.put(object, member)
                await current(expected)
              }),
            seal: () =>
              scope.run(async () => {
                await current(expected)
                await actual.seal()
                await current(expected)
              }),
            entries: async function* (object) {
              const iterator = actual.entries(object)
              try {
                for (;;) {
                  const value = await scope.run(async () => {
                    await current(expected)
                    const value = await iterator.next()
                    await current(expected)
                    return value
                  })
                  if (value.done) return
                  yield value.value
                }
              } finally {
                await iterator.return(undefined)
              }
            },
            lookup: (object, key) =>
              scope.run(async () => {
                await current(expected)
                const value = await actual.lookup(object, key)
                await current(expected)
                return value
              }),
            close: async () => {
              await actual.close()
              owned.delete(actual)
              this.#structuredIndexes.delete(actual)
            }
          } satisfies Brc38JsonMemberIndex)
        })
    })
    const cleanup = async (): Promise<void> => {
      const failures: unknown[] = []
      for (const actual of owned) {
        try {
          await actual.close()
          owned.delete(actual)
          this.#structuredIndexes.delete(actual)
        } catch (cause) {
          failures.push(cause)
        }
      }
      if (failures.length !== 0)
        throw new Brc38StagingCleanupError(
          failures,
          'Authenticated structured source retains physical index cleanup',
          cleanup
        )
    }
    let result!: T,
      failed = false,
      original: unknown
    try {
      result = await scope.retain(async () => {
        const result = await work(source, expected)
        await current(expected)
        return result
      })
    } catch (cause) {
      failed = true
      original = cause
    }
    try {
      await cleanup()
    } catch (cause) {
      throw new Brc38StagingCleanupError(
        failed ? [original, cause] : [cause],
        'Private structured receiver callback retains physical cleanup',
        cleanup
      )
    }
    if (failed) throw original
    return result
  }
  async stagePrivateNotifyProjection(
    admission: Brc38ImportJournalAdmission,
    sourceIndex: number,
    fromRow: number,
    sourcePolicy: Brc38PrivateStructuredPolicy,
    projectionPolicy: Brc38StreamedNotifyProjectionPolicy
  ): Promise<Readonly<{ descriptor: Brc38JsonStructuredField; unmappedIds: number }>> {
    return await this.stagePrivateHistoryProjection(
      admission,
      sourceIndex,
      fromRow,
      sourcePolicy,
      projectionPolicy,
      'notify'
    )
  }
  async stagePrivateSyncMapProjection(
    admission: Brc38ImportJournalAdmission,
    sourceIndex: number,
    fromRow: number,
    sourcePolicy: Brc38PrivateStructuredPolicy,
    projectionPolicy: Brc38StreamedSyncMapProjectionPolicy
  ): Promise<Readonly<{ descriptor: Brc38JsonStructuredField; unmappedIds: number }>> {
    return await this.stagePrivateHistoryProjection(
      admission,
      sourceIndex,
      fromRow,
      sourcePolicy,
      projectionPolicy,
      'syncMap'
    )
  }
  /** Prepare complete inactive history fields outside the destination writer.
   * Short actual private writes retain bounded chunks; the source's read-only
   * view and external indexes stay owned until assembly and cleanup complete.
   * This creates derived DATA, not an import/cursor/publication grant. */
  private async stagePrivateHistoryProjection(
    selectedAdmission: Brc38ImportJournalAdmission,
    sourceIndex: number,
    fromRow: number,
    selectedSourcePolicy: Brc38PrivateStructuredPolicy,
    selectedProjectionPolicy: Brc38StreamedNotifyProjectionPolicy | Brc38StreamedSyncMapProjectionPolicy,
    selectedField: 'notify' | 'syncMap'
  ): Promise<Readonly<{ descriptor: Brc38JsonStructuredField; unmappedIds: number }>> {
    const admission = admissionCopy(selectedAdmission),
      sourcePolicy = brc38PrivateStructuredPolicy(selectedSourcePolicy, this.directory),
      projectionPolicy = Object.freeze({
        ...selectedProjectionPolicy,
        workingAllocation: sourcePolicy.workingAllocation ?? selectedProjectionPolicy.workingAllocation,
        maximumReadBytes: Math.min(
          sourcePolicy.maximumReadBytes ?? 65536,
          selectedProjectionPolicy.maximumReadBytes ?? 65536
        ),
        maximumGrammarAllocationBytes:
          sourcePolicy.maximumGrammarAllocationBytes === undefined
            ? selectedProjectionPolicy.maximumGrammarAllocationBytes
            : selectedProjectionPolicy.maximumGrammarAllocationBytes === undefined
              ? sourcePolicy.maximumGrammarAllocationBytes
              : Math.min(
                  sourcePolicy.maximumGrammarAllocationBytes,
                  selectedProjectionPolicy.maximumGrammarAllocationBytes
                )
      }),
      bound = this.binding,
      field = selectedField,
      table: Brc38StageTable = field === 'notify' ? 'provenTxReqs' : 'syncStates'
    if (
      bound === undefined ||
      admission.scope.bindingSha256 !== bound.digest ||
      admission.scope.archiveSha256 !== bound.binding.archiveSha256 ||
      admission.originalLimitsJson !== bound.limitsJson ||
      admission.expiresAt !== this.limits.expiresAt ||
      projectionPolicy.expiresAt !== this.operationExpiresAt ||
      projectionPolicy.privateParent !== sourcePolicy.privateIndexParent ||
      projectionPolicy.signal !== sourcePolicy.signal ||
      !Number.isSafeInteger(projectionPolicy.maximumTemporaryFileBytes) ||
      projectionPolicy.maximumTemporaryFileBytes < 2097152 ||
      projectionPolicy.maximumTemporaryFileBytes > 17179869184 ||
      !Number.isSafeInteger(projectionPolicy.maximumMembers) ||
      projectionPolicy.maximumMembers < 1 ||
      projectionPolicy.maximumMembers > 2000000000 ||
      !Number.isSafeInteger(projectionPolicy.maximumOutputBytes) ||
      projectionPolicy.maximumOutputBytes < 2 ||
      projectionPolicy.maximumOutputBytes > sourcePolicy.maximumCanonicalBytes ||
      (projectionPolicy.maximumReadBytes !== undefined &&
        (!Number.isSafeInteger(projectionPolicy.maximumReadBytes) ||
          projectionPolicy.maximumReadBytes < 64 ||
          projectionPolicy.maximumReadBytes > 65536)) ||
      (projectionPolicy.maximumIndexAllocationBytes !== undefined &&
        (!Number.isSafeInteger(projectionPolicy.maximumIndexAllocationBytes) ||
          projectionPolicy.maximumIndexAllocationBytes < 4096 ||
          projectionPolicy.maximumIndexAllocationBytes > this.limits.maximumRowAllocationBytes)) ||
      (projectionPolicy.maximumGrammarAllocationBytes !== undefined &&
        (!Number.isSafeInteger(projectionPolicy.maximumGrammarAllocationBytes) ||
          projectionPolicy.maximumGrammarAllocationBytes < 4096 ||
          projectionPolicy.maximumGrammarAllocationBytes > this.limits.maximumRowAllocationBytes)) ||
      (field === 'syncMap' &&
        (!('maximumScalarBytes' in projectionPolicy) ||
          typeof projectionPolicy.maximumScalarBytes !== 'number' ||
          !Number.isSafeInteger(projectionPolicy.maximumScalarBytes) ||
          projectionPolicy.maximumScalarBytes < 2 ||
          projectionPolicy.maximumScalarBytes >
            Math.min(admission.maximumStepBytes, this.limits.maximumRowAllocationBytes))) ||
      !Number.isSafeInteger(fromRow) ||
      fromRow < 1 ||
      !Number.isSafeInteger(sourceIndex) ||
      sourceIndex < 0
    )
      throw new Error('Private history projection differs from its original admission')
    return await this.withPrivateNativeDatabase(true, async database => {
      const withRead = async <V>(operation: (trx: Knex.Transaction) => Promise<V>): Promise<V> =>
        await database.transaction(async trx => {
          this.assertPrivateNativeReadTransaction(trx)
          sourcePolicy.signal?.throwIfAborted()
          const result = await operation(trx)
          this.assertPrivateNativeReadTransaction(trx)
          sourcePolicy.signal?.throwIfAborted()
          return result
        })
      const owners: Brc38StructuredProjectionOwners = Object.freeze({
        check: () => {
          this.#available()
          sourcePolicy.signal?.throwIfAborted()
          this.assertPrivateNativeDestination(this.knex)
        },
        openIndex: async (policy: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]) =>
          await Brc38NodeJsonIndex.open({
            ...policy,
            privateParent: sourcePolicy.privateIndexParent,
            maximumTemporaryFileBytes: policy.maximumTemporaryIndexBytes
          }),
        readMappings: async (
          entity: Parameters<Brc38StructuredProjectionOwners['readMappings']>[0],
          incoming: readonly number[]
        ) =>
          await withRead(async trx => {
            const loaded = await loadBrc38ImportIdMap(
              trx,
              admission.scope,
              incoming.map(incomingId => ({ entity, incomingId, required: false }))
            )
            return incoming.map(id =>
              Object.hasOwn(loaded.map[entity].idMap, id) ? loaded.map[entity].idMap[id] : undefined
            )
          })
      })
      return await this.withPrivateStructuredSourceActor(
        withRead,
        table,
        sourceIndex,
        field,
        sourcePolicy,
        async (source, original) => {
          const receipt = await withRead(async trx => {
            const receipt = await readBrc38ImportJournal(trx, admission)
            if (receipt.state === 'COMPLETE' || receipt.state === 'EXPIRED' || receipt.nextRow !== fromRow)
              throw new Error('History projection is outside the current admitted page')
            let absolute = 1,
              total = 1,
              found = false
            for (const sourceTable of brc38ImportTableOrder) {
              const count = await tableCount(trx, sourceTable)
              if (count === undefined || !Number.isSafeInteger(count.rows) || count.rows < 0)
                throw new Error('Private projection source counts differ')
              total += count.rows
              if (sourceTable === table) {
                if (sourceIndex >= count.rows) throw new Error('Private projection source position differs')
                found = true
              }
              if (!found) absolute += count.rows
            }
            absolute += sourceIndex
            if (total !== admission.totalRows || absolute < fromRow || absolute >= fromRow + admission.maximumStepRows)
              throw new Error('Private history projection is outside the admitted source page')
            const header = JSON.parse((await this.#metadata(trx)).header!) as BRC38WalletData
            if (header.user.userId !== admission.scope.userId) throw new Error('History projection user differs')
            return receipt
          })
          await ownedTransaction(this.knex, async writer => {
            await this.#metadata(writer)
            await beginBrc38SqlProjectedStructuredField(
              writer,
              table,
              sourceIndex,
              field,
              'utf8-json',
              sourcePolicy.maximumCanonicalBytes,
              this.limits.maximumLogicalBytes,
              this.limits.maximumRows,
              original
            )
            this.#available()
            await this.#physicalBytes()
          })
          const ids =
            field === 'notify'
              ? await Brc38StreamedNotifyProjection.prepare(owners, source, {
                  ...projectionPolicy,
                  maximumTemporaryIndexBytes: projectionPolicy.maximumTemporaryFileBytes
                })
              : await Brc38StreamedSyncMapProjection.prepare(owners, source, {
                  ...(projectionPolicy as Brc38StreamedSyncMapProjectionPolicy),
                  maximumTemporaryIndexBytes: projectionPolicy.maximumTemporaryFileBytes
                })
          let offset = 0,
            failed = false,
            originalFailure: unknown
          const width = projectionPolicy.maximumReadBytes,
            digest = createHash('sha256')
          const cleanupScope2 = new Brc38CleanupScope(async () => {
            try {
              await ids.close()
            } catch (error_) {
              throw new Brc38StagingCleanupError(
                failed ? [originalFailure, error_] : [error_],
                'Private history staging retains projection index cleanup',
                () => ids.close()
              )
            }
          })
          try {
            // A fresh grammar/index pass is needed for assembly after the first
            // visitor pass. Both sources retain the same immutable field/view.
            await this.withPrivateStructuredSourceActor(
              withRead,
              table,
              sourceIndex,
              field,
              sourcePolicy,
              async assembly => {
                const output =
                  field === 'notify'
                    ? canonicalBrc38ProjectedNotify(
                        assembly,
                        {
                          maximumInputBytes: sourcePolicy.maximumStructuredBytes,
                          maximumOutputBytes: sourcePolicy.maximumCanonicalBytes,
                          maximumChunkBytes: width,
                          maximumAllocationBytes: sourcePolicy.maximumGrammarAllocationBytes,
                          workingAllocation: sourcePolicy.workingAllocation,
                          signal: sourcePolicy.signal
                        },
                        `${table}[${sourceIndex}]`,
                        ids
                      )
                    : (ids as Brc38StreamedSyncMapProjection).chunks(width, assembly)
                for await (const supplied of output) {
                  const bytes = detachBrc38PrivateChunk(supplied, width)
                  try {
                    digest.update(bytes)
                    await ownedTransaction(this.knex, async writer => {
                      await this.#metadata(writer)
                      await verifyBrc38SqlProjectedStructuredSource(writer, table, sourceIndex, original)
                      await appendBrc38SqlProjectedStructuredField(
                        writer,
                        table,
                        sourceIndex,
                        field,
                        offset,
                        bytes,
                        this.limits.maximumLogicalBytes
                      )
                      this.#available()
                      await this.#physicalBytes()
                    })
                    offset += bytes.byteLength
                  } finally {
                    bytes.fill(0)
                    supplied.fill(0)
                  }
                }
              },
              projectionPolicy.maximumTemporaryFileBytes
            )
            const descriptor: Readonly<Brc38JsonStructuredField> = Object.freeze({
              field,
              encoding: 'utf8-json',
              bytes: offset,
              sha256: digest.digest('hex')
            })
            await completeBrc38SqlProjectedStructuredField(
              this,
              withRead,
              async operation =>
                await ownedTransaction(this.knex, async writer => {
                  await this.#metadata(writer)
                  await verifyBrc38SqlProjectedStructuredSource(writer, table, sourceIndex, original)
                  const result = await operation(writer)
                  this.#available()
                  await this.#physicalBytes()
                  return result
                }),
              table,
              sourceIndex,
              descriptor,
              () => {
                this.#available()
                sourcePolicy.signal?.throwIfAborted()
              },
              width
            )
            if (
              JSON.stringify(await withRead(async trx => await readBrc38ImportJournal(trx, admission))) !==
              JSON.stringify(receipt)
            )
              throw new Error('Private projection destination receipt changed during preparation')
            return Object.freeze({ descriptor, unmappedIds: ids.unmappedIds })
          } catch (cause) {
            failed = true
            originalFailure = cause
            {
              await cleanupScope2.close()
              throw cause
            }
          } finally {
            await cleanupScope2.close()
          }
        },
        projectionPolicy.maximumTemporaryFileBytes
      )
    })
  }
  /** Native schema installation follows complete archive authentication. The
   * same owner, original deadline and hard physical page bound cover both the
   * decoded source and the native destination; no public provider is returned. */
  async withAuthenticatedPrivateDestination<T>(
    work: (header: Readonly<BRC38WalletData>, metadata: Readonly<{ rows: number }>) => Promise<T>
  ): Promise<T> {
    return await this.#exclusive(async () => {
      this.assertPrivateNativeDestination(this.knex)
      await assertNoBrc38SqlBinaryFields(this.knex)
      await assertNoBrc38SqlTextFields(this.knex)
      await assertNoBrc38SqlStructuredFields(this.knex)
      const meta = await this.#metadata(this.knex),
        value = await this.#privateImport(this.knex)
      if (meta.state !== 'sealed' || meta.header === null || value.archiveSha256 === null)
        throw new Error('Private native destination requires actual authentication and semantic seal')
      const headerJson = meta.header
      this.#nativeWriterScope = this.owner instanceof Brc38PrivateNativeOwnershipNode
      try {
        const result = await this.#destinationWork(
          async () => await work(JSON.parse(headerJson) as BRC38WalletData, Object.freeze({ rows: meta.rows }))
        )
        this.assertPrivateNativeDestination(this.knex)
        await this.#physicalBytes()
        return result
      } finally {
        this.#nativeWriterScope = false
      }
    })
  }
  /** Explicit private native receiver scope. The source remains field-aware;
   * legacy activation/publication/read paths keep their missing-payload fence.
   * The receiver must still verify every selected source/native postimage and
   * commit journal/ID maps/cursor in its same actual transaction. */
  async withAuthenticatedPrivateStreamedDestination<T>(
    work: (header: Readonly<BRC38WalletData>, metadata: Readonly<{ rows: number }>) => Promise<T>
  ): Promise<T> {
    return await this.#withAuthenticatedPrivateFieldDestination(work, false)
  }
  /** Explicit structured receiver scope. It retains the genuine original
   * private owner and authentication, and verifies both physical field
   * families without admitting a legacy receiver or a published provider. */
  async withAuthenticatedPrivateStructuredDestination<T>(
    work: (header: Readonly<BRC38WalletData>, metadata: Readonly<{ rows: number }>) => Promise<T>
  ): Promise<T> {
    return await this.#withAuthenticatedPrivateFieldDestination(work, true)
  }
  async #withAuthenticatedPrivateFieldDestination<T>(
    work: (header: Readonly<BRC38WalletData>, metadata: Readonly<{ rows: number }>) => Promise<T>,
    structured: boolean
  ): Promise<T> {
    return await this.#exclusive(async () => {
      this.assertPrivateNativeDestination(this.knex)
      if (!(this.owner instanceof Brc38PrivateNativeOwnershipNode))
        throw new Error('Streamed destination requires the actual private native backend')
      if (structured) {
        await this.#withProvisionalStructuredRead(async trx => {
          await verifyAllBrc38SqlStructuredFields(trx, this.limits.maximumRows, () => this.#available())
          await verifyAllBrc38SqlCanonicalStructuredFields(trx, this.limits.maximumRows, () => this.#available())
        }, true)
      } else {
        await assertNoBrc38SqlStructuredFields(this.knex)
        await assertNoBrc38SqlTextFields(this.knex)
      }
      await this.#verifyExisting()
      const meta = await this.#metadata(this.knex),
        source = await this.#privateImport(this.knex)
      if (meta.state !== 'sealed' || meta.header === null || source.archiveSha256 === null)
        throw new Error('Streamed native destination requires actual authentication and semantic seal')
      this.#nativeWriterScope = true
      try {
        const result = await this.#destinationWork(
          async () => await work(JSON.parse(meta.header!) as BRC38WalletData, Object.freeze({ rows: meta.rows }))
        )
        this.assertPrivateNativeDestination(this.knex)
        await this.#verifyExisting()
        const current = await this.#metadata(this.knex),
          actual = await this.#privateImport(this.knex)
        if (
          current.state !== 'sealed' ||
          current.header !== meta.header ||
          current.rows !== meta.rows ||
          actual.archiveSha256 !== source.archiveSha256
        )
          throw new Error('Streamed native source changed during its owned receiver scope')
        await this.#physicalBytes()
        return result
      } finally {
        this.#nativeWriterScope = false
      }
    })
  }
  /** Called only after actual complete-envelope GCM/digest and private semantic seal. */
  async markAuthenticatedArchive(archiveSha256: string): Promise<void> {
    await this.#markAuthenticatedArchive(archiveSha256, false)
  }
  /** The actual complete-envelope crypto caller invokes this only after its
   * GCM/archive digest/EOF parser succeeds. Original closure is re-read; it
   * grants no destination, publication or provider activation. */
  async markAuthenticatedStructuredArchive(
    archiveSha256: string,
    selected: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    const policy = brc38PrivateStructuredPolicy(selected, this.directory),
      meta = await this.#metadata(this.knex)
    if (meta.state !== 'sealed' || meta.header === null)
      throw new Error('Structured authentication requires the original sealed header')
    const counts: Record<string, number> = {}
    for (const table of brc38StageTables) counts[table] = await this.count(table)
    await this.verifyPrivateStructuredSemantics(
      JSON.parse(meta.header) as BRC38WalletData,
      counts as Record<Brc38StageTable, number>,
      policy
    )
    await this.#markAuthenticatedArchive(archiveSha256, true)
  }
  async markAuthenticatedOwnedSourceStructuredArchive(
    archiveSha256: string,
    selected: Brc38PrivateStructuredPolicy
  ): Promise<void> {
    const policy = brc38PrivateStructuredPolicy(selected, this.directory),
      meta = await this.#metadata(this.knex)
    if (meta.state !== 'sealed' || meta.header === null)
      throw new Error('Structured source authentication requires its original seal')
    const counts: Record<string, number> = {}
    for (const table of brc38StageTables) counts[table] = await this.count(table)
    await this.#verifyStructuredSemantics(
      JSON.parse(meta.header) as BRC38WalletData,
      counts as Record<Brc38StageTable, number>,
      policy,
      true
    )
    await this.#markAuthenticatedArchive(archiveSha256, true)
  }
  async #markAuthenticatedArchive(archiveSha256: string, structured: boolean): Promise<void> {
    await this.#exclusive(async () => {
      if (this.binding === undefined || archiveSha256 !== this.binding.binding.archiveSha256)
        throw new Error('Private authenticated archive does not match its binding')
      const original = await this.#readSourceFields(true, structured)
      await ownedTransaction(this.knex, async trx => {
        const meta = await this.#metadata(trx),
          value = await this.#privateImport(trx)
        if (meta.state !== 'sealed') throw new Error('Private authentication requires a sealed semantic stage')
        this.#compareSourceMetadata(meta, original.metadata)
        await compareBrc38SqlSourceFieldCounts(trx, original.fields, true, structured, () => this.#available())
        if (value.archiveSha256 !== null) return
        if (64 > this.limits.maximumLogicalBytes - meta.logicalBytes)
          throw new SnapshotResourceLimitError('Private import authentication metadata quota reached')
        // Ordinary staging keeps its original schema and physical cost. Publish
        // the import metadata only after complete authentication, atomically
        // with its original bounded logical and physical charge.
        if (!(await trx.schema.hasTable('private_import'))) {
          await trx.schema.createTable('private_import', table => {
            table.integer('slot').primary()
            table.string('archiveSha256', 64).nullable()
            table.text('previewJson').nullable()
            table.string('previewSha256', 64).nullable()
          })
          await trx('private_import').insert({
            slot: 1,
            archiveSha256,
            previewJson: null,
            previewSha256: null
          })
        } else await trx('private_import').where({ slot: 1 }).update({ archiveSha256 })
        await installBrc38AuthenticatedSourceSeal(trx)
        await trx('metadata')
          .where({ slot: 1 })
          .update({ logicalBytes: meta.logicalBytes + 64 })
        this.#available()
        await this.#physicalBytes()
      })
    })
  }
  /** One bounded durable preview replaces the old receipt without renewing any limit. */
  async #saveImportPreview(previewJson: string): Promise<void> {
    if (typeof previewJson !== 'string' || Buffer.byteLength(previewJson) < 1 || Buffer.byteLength(previewJson) > 8192)
      throw new SnapshotResourceLimitError('Private import preview exceeds its metadata bounds')
    const bytes = Buffer.byteLength(previewJson),
      previewSha256 = createHash('sha256').update(previewJson).digest('hex')
    this.#available()
    await ownedTransaction(this.knex, async trx => {
      const meta = await this.#metadata(trx),
        value = await this.#privateImport(trx)
      if (meta.state !== 'sealed' || value.archiveSha256 === null)
        throw new Error('Private preview requires actual archive authentication and semantic seal')
      const charge = bytes + 64 - (value.previewJson === null ? 0 : value.previewBytes + 64)
      if (charge > this.limits.maximumLogicalBytes - meta.logicalBytes)
        throw new SnapshotResourceLimitError('Private import preview metadata quota reached')
      await trx('private_import').where({ slot: 1 }).update({ previewJson, previewSha256 })
      await trx('metadata')
        .where({ slot: 1 })
        .update({ logicalBytes: meta.logicalBytes + charge })
      this.#available()
      await this.#physicalBytes()
    })
  }
  async saveImportPreview(previewJson: string): Promise<void> {
    await this.#exclusive(async () => await this.#saveImportPreview(previewJson))
  }
  async #destinationWork<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        const retained = new Brc38StagingCleanupError(
          [cause],
          'Private import retains destination physical cleanup',
          async () => {
            await cause.retryCleanup()
            if (this.#pendingDestinationCleanup === retained) this.#pendingDestinationCleanup = undefined
          }
        )
        this.#pendingDestinationCleanup = retained
        throw retained
      }
      throw cause
    }
  }
  /** At most one target capture/pool per actual private import owner. */
  async prepareImportPreview(capture: () => Promise<string>): Promise<string> {
    return await this.#exclusive(async () => {
      const meta = await this.#metadata(this.knex),
        value = await this.#privateImport(this.knex)
      if (meta.state !== 'sealed' || value.archiveSha256 === null)
        throw new Error('Private preview requires actual archive authentication and semantic seal')
      this.#nativeWriterScope = this.owner instanceof Brc38PrivateNativeOwnershipNode
      try {
        const json = await this.#destinationWork(capture)
        await this.#saveImportPreview(json)
        return json
      } finally {
        this.#nativeWriterScope = false
      }
    })
  }
  async readImportPreview(): Promise<string | undefined> {
    return await this.#exclusive(async () => {
      const meta = await this.#metadata(this.knex),
        value = await this.#privateImport(this.knex)
      if (meta.state !== 'sealed' || value.archiveSha256 === null)
        throw new Error('Private preview requires actual archive authentication and semantic seal')
      return value.previewJson ?? undefined
    })
  }
  /** Retain this actual private owner through one destination fence/step. */
  async #withImportView<T>(
    work: (json: string, metadata: Readonly<{ rows: number }>) => Promise<T>,
    streamed = false,
    structured = false
  ): Promise<T> {
    return await this.#exclusive(async () => {
      if (!streamed) {
        await assertNoBrc38SqlBinaryFields(this.knex)
        await assertNoBrc38SqlTextFields(this.knex)
      }
      if (structured) {
        this.assertPrivateNativeDestination(this.knex)
        if (!(this.owner instanceof Brc38PrivateNativeOwnershipNode))
          throw new Error('Structured import view requires its actual private native backend')
        await this.#withProvisionalStructuredRead(async trx => {
          await verifyAllBrc38SqlStructuredFields(trx, this.limits.maximumRows, () => this.#available())
          await verifyAllBrc38SqlCanonicalStructuredFields(trx, this.limits.maximumRows, () => this.#available())
        }, true)
      } else {
        await assertNoBrc38SqlStructuredFields(this.knex)
        await assertNoBrc38SqlTextFields(this.knex)
      }
      const meta = await this.#metadata(this.knex),
        value = await this.#privateImport(this.knex)
      if (meta.state !== 'sealed' || value.archiveSha256 === null || value.previewJson === null)
        throw new Error('Private preview requires actual archive authentication and semantic seal')
      this.#nativeWriterScope = this.owner instanceof Brc38PrivateNativeOwnershipNode
      try {
        const result = await this.#destinationWork(
          async () => await work(value.previewJson!, Object.freeze({ rows: meta.rows }))
        )
        const current = await this.#metadata(this.knex),
          actual = await this.#privateImport(this.knex)
        if (
          current.state !== 'sealed' ||
          current.header !== meta.header ||
          current.rows !== meta.rows ||
          actual.archiveSha256 !== value.archiveSha256 ||
          actual.previewJson !== value.previewJson
        )
          throw new Error('Private authenticated import changed during its owned view')
        this.#available()
        return result
      } finally {
        this.#nativeWriterScope = false
      }
    })
  }
  /** Preserve the existing single-argument preview callback contract. */
  async withImportPreviewRead<T>(work: (json: string) => Promise<T>): Promise<T> {
    return await this.#withImportView(async json => await work(json))
  }
  /** Owned authenticated view adds authoritative constant-size row metadata. */
  async withAuthenticatedImportView<T>(
    work: (json: string, metadata: Readonly<{ rows: number }>) => Promise<T>
  ): Promise<T> {
    return await this.#withImportView(work)
  }
  async withAuthenticatedStreamedImportView<T>(
    work: (json: string, metadata: Readonly<{ rows: number }>) => Promise<T>
  ): Promise<T> {
    return await this.#withImportView(work, true)
  }
  async withAuthenticatedStructuredImportView<T>(
    work: (json: string, metadata: Readonly<{ rows: number }>) => Promise<T>
  ): Promise<T> {
    return await this.#withImportView(work, true, true)
  }
  /** Bounded authenticated source preparation; callers finish all reads before
   * destination writer acquisition. Retains the actual kernel owner through an
   * unawaited pending read and refuses facade use after callback completion. */
  async withAuthenticatedImportRead<T>(
    work: (
      json: string,
      metadata: Readonly<{ rows: number }>,
      reader: Readonly<Brc38AuthenticatedImportReader>
    ) => Promise<T>
  ): Promise<T> {
    return await this.#withImportView(async (json, metadata) => {
      const scope = new Brc38OwnedImportReads()
      const read = <V>(load: () => Promise<V>): Promise<V> =>
        scope.run(async () => {
          this.#available()
          const result = await load()
          this.#available()
          return result
        })
      const table = (value: Brc38StageTable): void => {
        if (!brc38StageTables.includes(value)) throw new Error('Invalid owned private import table')
      }
      const reader: Readonly<Brc38AuthenticatedImportReader> = Object.freeze({
        header: () =>
          read(async () => {
            const value = await this.#metadata(this.knex)
            if (value.state !== 'sealed' || value.header === null)
              throw new Error('Private import header is not sealed')
            return JSON.parse(value.header) as BRC38WalletData
          }),
        count: (value: Brc38StageTable) =>
          read(async () => {
            table(value)
            return await this.#readCount(value)
          }),
        row: (value: Brc38StageTable, index: number) =>
          read(async () => {
            table(value)
            if (!Number.isSafeInteger(index) || index < 0 || index >= this.limits.maximumRows)
              throw new Error('Invalid owned private import row coordinate')
            return await this.#readRow(value, index)
          })
      })
      return await scope.retain(async () => await work(json, metadata, reader))
    })
  }
  /** Explicit field-aware preparation. Every physical read uses this retained
   * actual owner and fresh authentication metadata; escaped/unawaited reads
   * follow the same one-operation drain discipline as the legacy reader.
   * Finish source preparation before acquiring a destination writer. */
  async withAuthenticatedStreamedImportRead<T>(
    work: (
      json: string,
      metadata: Readonly<{ rows: number }>,
      reader: Readonly<Brc38AuthenticatedStreamedImportReader>
    ) => Promise<T>
  ): Promise<T> {
    return await this.#withAuthenticatedFieldImportRead(work, false)
  }
  /** Structured descriptors retain the actual immutable raw source; they
   * never supply placeholder DTO values or a cached semantic admission. The
   * same actual owner drains all reads before returning its one-use facade. */
  async withAuthenticatedStructuredImportRead<T>(
    work: (
      json: string,
      metadata: Readonly<{ rows: number }>,
      reader: Readonly<Brc38AuthenticatedStreamedImportReader>
    ) => Promise<T>
  ): Promise<T> {
    return await this.#withAuthenticatedFieldImportRead(work, true)
  }
  async #withAuthenticatedFieldImportRead<T>(
    work: (
      json: string,
      metadata: Readonly<{ rows: number }>,
      reader: Readonly<Brc38AuthenticatedStreamedImportReader>
    ) => Promise<T>,
    structured: boolean
  ): Promise<T> {
    return await this.#withImportView(
      async (json, metadata) => {
        const scope = new Brc38OwnedImportReads()
        const actualView = async (k: Knex): Promise<Metadata> => {
          this.#available()
          const meta = await this.#metadata(k),
            authenticated = await this.#privateImport(k)
          if (
            meta.state !== 'sealed' ||
            meta.header === null ||
            meta.rows !== metadata.rows ||
            authenticated.archiveSha256 === null ||
            authenticated.previewJson !== json
          )
            throw new Error('Authenticated streamed source changed its owned view')
          this.#available()
          return meta
        }
        const read = <V>(load: (trx: Knex.Transaction) => Promise<V>): Promise<V> =>
          scope.run(
            async () =>
              await ownedTransaction(this.knex, async trx => {
                await actualView(trx)
                const result = await load(trx)
                await actualView(trx)
                return result
              })
          )
        const table = (value: Brc38StageTable): void => {
          if (!brc38StageTables.includes(value)) throw new Error('Invalid owned private import table')
        }
        const coordinate = (value: Brc38StageTable, index: number): void => {
          table(value)
          if (!Number.isSafeInteger(index) || index < 0 || index >= this.limits.maximumRows)
            throw new Error('Invalid owned private import row coordinate')
        }
        const reader: Readonly<Brc38AuthenticatedStreamedImportReader> = Object.freeze({
          header: () => read(async trx => JSON.parse((await actualView(trx)).header!) as BRC38WalletData),
          count: (value: Brc38StageTable) =>
            read(async trx => {
              table(value)
              const actual = await tableCount(trx, value)
              if (
                actual === undefined ||
                !Number.isSafeInteger(actual.rows) ||
                actual.rows < 0 ||
                actual.rows > this.limits.maximumRows
              )
                throw new Error('Invalid private BRC-38 table count')
              return actual.rows
            }),
          row: (value: Brc38StageTable, index: number) =>
            read(async trx => {
              coordinate(value, index)
              const fields = await this.#readRow(value, index, trx)
              if (fields === undefined) return undefined
              const binaries = await readBrc38SqlBinaryDescriptors(trx, value, index)
              const json = structured ? await readBrc38SqlStructuredDescriptors(trx, value, index) : undefined,
                texts = structured ? await readBrc38SqlTextDescriptors(trx, value, index) : undefined
              if (
                Object.keys(binaries).some(field => Object.hasOwn(fields, field)) ||
                Object.keys(json ?? {}).some(field => Object.hasOwn(fields, field) || Object.hasOwn(binaries, field)) ||
                Object.keys(texts ?? {}).some(
                  field =>
                    Object.hasOwn(fields, field) || Object.hasOwn(binaries, field) || Object.hasOwn(json ?? {}, field)
                )
              )
                throw new Error('Private row metadata overlaps its persisted binary field')
              return Object.freeze({
                fields: Object.freeze(fields),
                binaries,
                ...(json === undefined || Object.keys(json).length === 0 ? {} : { structured: json }),
                ...(texts === undefined || Object.keys(texts).length === 0 ? {} : { texts })
              })
            }),
          chunk: (value: Brc38StageTable, index: number, field: string, offset: number) =>
            read(async trx => {
              coordinate(value, index)
              // Require the admitted actual row as well as the exact field. A loose
              // orphan field cannot acquire authenticated source-row membership.
              if ((await rowExtent(trx, value, index)) === undefined)
                throw new Error('Authenticated binary field has no admitted source row')
              return await readBrc38SqlBinaryChunk(trx, value, index, field, offset)
            })
        })
        return await scope.retain(async () => await work(json, metadata, reader))
      },
      true,
      structured
    )
  }
  /** Physically close the private SQL pool, retaining its separate live kernel
   * owner while copying a verified COMPLETE native import. Capacity and the
   * original source deadline remain unchanged; the source facade stays closed. */
  async copyCompletedNativeRestore(
    targetName: string,
    admission: Brc38ImportJournalAdmission,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<Readonly<{ bytes: number; sha256: string }>> {
    return await this.#copyCompletedNativeRestore(targetName, admissionCopy(admission), maximumBytes, signal)
  }
  /** Internal composed-copy path. The genuine current merge actor runs a fresh
   * complete comparison under this SAME kernel's closed semantic admission.
   * This grants no READY receipt, receiving inspection or primary selection. */
  async copyComparedNativeMerge(
    targetName: string,
    maximumBytes: number,
    merge: Brc38PrivateNativeMergeNode,
    source: Brc38NativeLocalBaselineSource,
    signal?: AbortSignal
  ): Promise<Readonly<{ bytes: number; sha256: string }>> {
    Brc38PrivateNativeMergeNode.assertCopyScope(merge, this, source, targetName, signal)
    this.assertPrivateNativeDestination(this.knex)
    const owner = this.owner
    if (
      !(owner instanceof Brc38PrivateNativeOwnershipNode) ||
      this.#busy ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 4096 ||
      maximumBytes > this.limits.maximumPhysicalBytes
    )
      throw new Error('Composed copy requires its actual private owner and original physical bounds')
    this.#busy = true
    try {
      signal?.throwIfAborted()
      await owner.requireComparison(this.knex)
      await this.#physicalBytes()
      Brc38PrivateNativeMergeNode.assertCopyScope(merge, this, source, targetName, signal)
      // Semantic rows/pointers/custody cannot change in this actual kernel.
      // Drain scratch/read SQL facades too before descriptor-based file copy.
      this.#closed = true
      await this.#teardown()
      return await copyBrc38OwnedDatabase(
        join(this.directory, 'stage.sqlite'),
        targetName,
        maximumBytes,
        this.limits.expiresAt,
        () => {
          owner.assertLive()
          Brc38NativeLocalBaselineSource.assertOwned(source)
          signal?.throwIfAborted()
        },
        signal,
        async file => await owner.assertCopySource(file)
      )
    } finally {
      this.#busy = false
    }
  }
  /** Physical lifetime only, after the original compared-copy SQL drain.
   * This cannot reopen a facade, qualify bytes, publish or select a profile. */
  assertRetainedPrivateNativeCopyOwner(): void {
    if (
      !(this.owner instanceof Brc38PrivateNativeOwnershipNode) ||
      !this.#closed ||
      !this.#destroyed ||
      this.#busy ||
      this.#ownerReleased ||
      this.#discarded ||
      this.#structuredIndexes.size !== 0 ||
      this.#structuredAcquisitionCleanup.size !== 0
    )
      throw new Error('Compared copy requires its original physically drained private kernel')
    this.owner.assertLive()
  }
  /** Reopen SQL under the SAME retained authenticated kernel after all copy
   * scopes settle. Semantic admission stays irreversibly frozen; only the
   * existing comparison scratch operations are allowed by the kernel. This
   * store continues to own the original process and its eventual close. */
  async reopenComparedNativeSql(): Promise<void> {
    this.assertRetainedPrivateNativeCopyOwner()
    const owner = this.owner
    if (!(owner instanceof Brc38PrivateNativeOwnershipNode) || this.binding === undefined)
      throw new Error('Compared private SQL reopen requires its original authenticated owner')
    this.#busy = true
    try {
      const database = await owner.reopenComparedDatabase(this.knex)
      this.#knex = database
      this.#destroyed = false
      this.#closed = false
      privateNativeDatabases.set(database, this)
      privateNativeStores.set(owner.transactionToken, this)
      await this.#physicalBytes()
      await this.#verifyExisting()
      const meta = await this.#metadata(database),
        source = await this.#privateImport(database)
      if (meta.state !== 'sealed' || source.archiveSha256 !== this.binding.binding.archiveSha256)
        throw new Error('Compared private SQL reopen differs from the original authenticated source')
      await owner.requireComparison(database)
      this.#available()
    } catch (cause) {
      this.#closed = true
      if (cause instanceof Brc38StagingCleanupError) {
        const retained = new Brc38StagingCleanupError(
          [cause],
          'Compared private SQL acquisition retains physical cleanup',
          async () => {
            await cause.retryCleanup()
            if (this.#pendingDestinationCleanup === retained) this.#pendingDestinationCleanup = undefined
          }
        )
        this.#pendingDestinationCleanup = retained
      }
      try {
        await this.#teardown()
      } catch (error_) {
        const cleanup = new Brc38StagingCleanupError(
          [cause, error_],
          'Compared private stage retains reopened SQL cleanup',
          async () => await this.#teardown()
        )
        // Do not install this as destination cleanup: #teardown retries that
        // field itself. The concrete error owns retry; close also retries the
        // same original facade before releasing its retained kernel.
        throw cleanup
      }
      throw cause
    } finally {
      this.#busy = false
    }
  }
  /** Explicit v5 copy. The actual original owner lends a physical read-only
   * transaction for the complete independently regenerated inventory; no
   * previous inspect result can authorize the filesystem copy. */
  async copyCompletedStructuredNativeRestore(
    targetName: string,
    selectedAdmission: Brc38ImportJournalAdmission,
    maximumBytes: number,
    selected: Pick<
      Brc38StructuredNativeFieldInventoryPolicy,
      'sourcePolicy' | 'projectionPolicy' | 'maximumCombinedTemporaryBytes'
    >,
    signal?: AbortSignal
  ): Promise<Readonly<{ bytes: number; sha256: string }>> {
    const admission = admissionCopy(selectedAdmission),
      source = brc38PrivateStructuredPolicy(selected.sourcePolicy, this.directory),
      value = selected.projectionPolicy,
      operationSignal = signal ?? source.signal,
      structured = Object.freeze({
        sourcePolicy: Object.freeze({ ...source, signal: operationSignal }),
        projectionPolicy: Object.freeze({
          privateParent: value.privateParent,
          maximumTemporaryFileBytes: value.maximumTemporaryFileBytes,
          maximumMembers: value.maximumMembers,
          maximumOutputBytes: value.maximumOutputBytes,
          maximumScalarBytes: value.maximumScalarBytes,
          maximumIndexAllocationBytes: value.maximumIndexAllocationBytes,
          maximumGrammarAllocationBytes: value.maximumGrammarAllocationBytes,
          workingAllocation: value.workingAllocation,
          maximumReadBytes: value.maximumReadBytes,
          expiresAt: value.expiresAt,
          signal: operationSignal
        }),
        maximumCombinedTemporaryBytes: selected.maximumCombinedTemporaryBytes
      })
    if (
      (source.signal !== undefined && source.signal !== operationSignal) ||
      (value.signal !== undefined && value.signal !== operationSignal) ||
      !(this.owner instanceof Brc38PrivateNativeOwnershipNode)
    )
      throw new Error('Structured copy requires the original private native owner and cancellation scope')
    return await this.#copyCompletedNativeRestore(targetName, admission, maximumBytes, operationSignal, structured)
  }
  async #copyCompletedNativeRestore(
    targetName: string,
    admission: Brc38ImportJournalAdmission,
    maximumBytes: number,
    signal?: AbortSignal,
    structured?: Pick<
      Brc38StructuredNativeFieldInventoryPolicy,
      'sourcePolicy' | 'projectionPolicy' | 'maximumCombinedTemporaryBytes'
    >
  ): Promise<Readonly<{ bytes: number; sha256: string }>> {
    this.assertPrivateNativeDestination(this.knex)
    if (this.#busy) throw new Error('Private BRC-38 staging I/O is already owned')
    this.#busy = true
    try {
      signal?.throwIfAborted()
      const meta = await this.#metadata(this.knex),
        authenticated = await this.#privateImport(this.knex)
      if (meta.state !== 'sealed' || authenticated.archiveSha256 === null)
        throw new Error('Publication requires the actual authenticated private seal')
      this.#nativeWriterScope = this.owner instanceof Brc38PrivateNativeOwnershipNode
      const values: Array<{ json: string | null; protocol: string | null; policyJson: string | null }> =
        await this.knex('private_native_restore')
          .where({ slot: 1 })
          .select(
            this.knex.raw(
              'CASE WHEN length(CAST(admissionJson AS BLOB)) <= 4096 THEN admissionJson ELSE NULL END AS json'
            ),
            this.knex.raw('CASE WHEN length(CAST(protocol AS BLOB)) <= 64 THEN protocol ELSE NULL END AS protocol'),
            this.knex.raw(
              'CASE WHEN length(CAST(policyJson AS BLOB)) <= 4096 THEN policyJson ELSE NULL END AS policyJson'
            )
          )
          .limit(2)
      if (
        values.length !== 1 ||
        !(
          structured === undefined
            ? ['brc38-private-native-restore/v1', 'brc38-private-native-restore/v4']
            : ['brc38-private-native-restore/v5']
        ).includes(values[0]?.protocol ?? '') ||
        values[0]?.json !== JSON.stringify(admission) ||
        admission.scope.bindingSha256 !== this.binding!.digest ||
        admission.expiresAt !== this.limits.expiresAt
      )
        throw new Error('Publication admission differs from the actual native restore')
      if (structured !== undefined) {
        const policyJson = values[0].policyJson,
          captured = brc38StructuredRestoreResourceData(structured)
        if (
          typeof policyJson !== 'string' ||
          JSON.stringify((JSON.parse(policyJson) as { structuredResources?: unknown }).structuredResources) !==
            JSON.stringify(captured) ||
          structured.projectionPolicy.expiresAt !== admission.expiresAt ||
          structured.maximumCombinedTemporaryBytes > this.limits.maximumPhysicalBytes
        )
          throw new Error('Structured copy changed the original immutable resource policy')
      }
      // Inspect actual source content in one retained view before closing the
      // SQL facade. The layout label selects a contract; it grants no source,
      // schema, inventory, copy or eventual activation permission.
      const inspect = async (trx: Knex.Transaction): Promise<void> => {
        const native = isBrc38OwnedPrivateNativeSqlite(trx),
          packed = native ? await hasBrc38NativePackedSchema(trx) : false,
          streamed = values[0].protocol === 'brc38-private-native-restore/v4' || structured !== undefined
        if (!native && (await trx.schema.hasTable('brc38_native_binary_budget')))
          throw new Error('Publication packed layout requires its actual native owner')
        if (packed !== streamed) throw new Error('Publication restore layout differs')
        const receipt = await readBrc38ImportJournal(trx, admission)
        if (receipt.state !== 'COMPLETE' || receipt.nextRow !== admission.totalRows)
          throw new Error('Publication requires a complete native restore')
        if (structured !== undefined)
          await inspectBrc38PrivateStructuredNativeInventory(
            trx,
            admission,
            {
              ...structured,
              inspectionExpiresAt: admission.expiresAt,
              privateSource: this
            },
            signal
          )
        else if (streamed) await inspectBrc38PrivateStreamedNativeInventory(trx, admission, signal)
        else await assertNoBrc38SqlBinaryFields(trx)
        if (structured === undefined) {
          await assertNoBrc38SqlStructuredFields(trx)
          await assertNoBrc38SqlTextFields(trx)
        }
        signal?.throwIfAborted()
        this.#available()
      }
      if (structured === undefined) await this.knex.transaction(inspect)
      else await this.withPrivateNativeDatabase(true, async database => await database.transaction(inspect))
      this.#available()
      await this.#physicalBytes()
      // Keep the separate kernel owner across the entire filesystem copy. The
      // source SQL pool is physically gone and this facade stays closed even
      // on failure; an explicit new owner may resume its original admission.
      this.#closed = true
      await this.#teardown()
      const nativeOwner = this.owner instanceof Brc38PrivateNativeOwnershipNode ? this.owner : undefined
      return await copyBrc38OwnedDatabase(
        join(this.directory, 'stage.sqlite'),
        targetName,
        maximumBytes,
        this.limits.expiresAt,
        () => this.owner!.assertLive(),
        signal,
        nativeOwner === undefined ? undefined : async file => await nativeOwner.assertCopySource(file)
      )
    } finally {
      this.#nativeWriterScope = false
      this.#busy = false
    }
  }
  /** Retain private state for an explicit next owner, preserving original expiry. */
  async close(): Promise<void> {
    if (this.#busy) throw new Error('Wait for owned private BRC-38 SQL I/O before close')
    if (this.#discarded) {
      this.#releasePhysicalMetadata()
      return
    }
    if (this.#ownerReleased) {
      this.#releasePhysicalMetadata()
      return
    }
    this.#busy = true
    this.#closed = true
    try {
      await this.#teardown()
      await this.owner?.release()
      this.#ownerReleased = true
      this.#releasePhysicalMetadata()
    } finally {
      this.#busy = false
    }
  }
  /** Concrete closed owner only, for explicit catalog-owned disposal after a
   * failed handoff. This supplies no resume, expiry renewal or mutation grant;
   * the catalog must still acquire actual kernel cleanup exclusion itself. */
  static assertReleasedForDisposal(store: KnexBrc38StagingStore): void {
    if (
      !store.#closed ||
      !store.#destroyed ||
      !store.#ownerReleased ||
      store.#busy ||
      store.#discarded ||
      store.#deletionDirectory !== undefined ||
      store.binding === undefined
    )
      throw new Error('Released private disposal requires its actual physically closed store')
  }
  async #teardown(): Promise<void> {
    await this.#pendingDestinationCleanup?.retryCleanup()
    const failures: unknown[] = []
    // Snapshot the admitted cleanup cohort before awaiting its mutable owners.
    for (const actual of Array.from(this.#structuredIndexes)) {
      try {
        await actual.close()
        this.#structuredIndexes.delete(actual)
      } catch (cause) {
        failures.push(cause)
      }
    }
    for (const cleanup of Array.from(this.#structuredAcquisitionCleanup)) {
      try {
        await cleanup.retryCleanup()
        this.#structuredAcquisitionCleanup.delete(cleanup)
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Private structured source index cleanup remains owned')
    if (!this.#destroyed) {
      await this.knex.destroy()
      this.#destroyed = true
    }
  }
  async discard(_cause: unknown): Promise<void> {
    if (this.#discarded) {
      this.#releasePhysicalMetadata()
      return
    }
    if (this.#busy) throw new Error('Wait for owned private BRC-38 SQL I/O before disposal')
    if (this.#ownerReleased && this.#deletionDirectory === undefined)
      throw new Error('Private BRC-38 ownership was handed off; reclaim before disposal')
    this.#busy = true
    this.#closed = true
    try {
      await this.#teardown()
      if (this.#deletionDirectory === undefined) {
        if (this.owner !== undefined) {
          this.#deletionDirectory = this.retirementDirectory ?? this.directory + '-discarded-' + randomUUID()
          try {
            await rename(this.directory, this.#deletionDirectory)
          } catch (cause) {
            this.#deletionDirectory = undefined
            throw cause
          }
        } else this.#deletionDirectory = this.directory
      }
      await this.owner?.release()
      this.#ownerReleased = true
      await rm(this.#deletionDirectory, { recursive: true, force: true })
      this.#discarded = true
      this.#releasePhysicalMetadata()
    } finally {
      this.#busy = false
    }
  }
}
