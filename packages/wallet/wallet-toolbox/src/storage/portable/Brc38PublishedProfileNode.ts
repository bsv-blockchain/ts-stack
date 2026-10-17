import {
  requirePrivatePath,
  createPrivateDirectory,
  createPrivateTemporaryDirectory,
  createPrivateFile,
  closePrivateDescriptor,
  syncPrivateDirectory
} from './Brc38PrivateFilesystemNode'
import { Brc39RecoveryIncomingComparisonNode } from './Brc39RecoveryIncomingComparisonNode'
import { Brc38PendingComposedNativeTargetError } from './Brc38PendingComposedNativeTargetError'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { copyBrc38ComposedProfileReceipt, type Brc38ComposedProfileReceipt } from './Brc38ComposedProfileReceiptNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import {
  readBrc38NativeRetirement,
  writeBrc38NativeRetirement,
  type Brc38NativeRetirementRecord
} from './Brc38NativeRetirementNode'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { readBrc38ComposedNativeCommit, writeBrc38ComposedNativeCommit } from './Brc38ComposedNativeCommitNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38RetiredNativeReadNode } from './Brc38RetiredNativeReadNode'
import { verifySnapshotJournalDestinationSchema } from '../snapshot/journal/SnapshotJournalDestinationSchema'
import {
  hasBrc38NativeLocalBaselineGenerationSchema,
  readBrc38NativeLocalBaselineGeneration
} from './Brc38NativeLocalBaselineGenerationNode'
import { migrateBrc38NativeCatalog } from './Brc38NativeCatalogNode'
import { createHash, randomUUID } from 'node:crypto'
import {
  readRow,
  readOriginalProfileRow,
  readForwardOriginalProfileRow,
  fixedProfile,
  pages,
  type State,
  type FixedProfile,
  type Row
} from './Brc38PublishedProfileReceiptNode'
import type { Dir } from 'node:fs'
import { opendir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import createKnex, { type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager, type WalletStorageProviderTransition } from '../WalletStorageManager'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { runInSeries } from '../../utility/runInSeries'
import { Brc38ProfileInventoryNode, type Brc38NativeProfileReopenGrant } from './Brc38ProfileInventoryNode'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { admissionCopy } from './Brc38ImportJournalCore'
import { Brc38NativeRecoveryScratchNode, type Brc38NativeRecoveryScratchPolicy } from './Brc38NativeRecoveryScratchNode'
import { verifyBrc38PublishedWallet } from './Brc38PublishedWalletNode'
import { verifyBrc38PublishedWallet as verifyNativePublishedWallet } from './Brc38NativePublishedWalletNode'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import {
  inspectBrc38PublishedCopyStreamedInventory,
  inspectBrc38ReadyPublishedStreamedNativeInventory
} from './Brc38StreamedNativeInventoryNode'
import { inspectBrc38PublishedStructuredRestoreInventory } from './Brc38PublishedStructuredInventoryNode'
import type { Brc38PrivateStructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { Brc38PrivateNativeMergeNode } from './Brc38PrivateNativeMergeNode'
import {
  readBrc38ComposedDatabaseImage,
  type Brc38ComposedDatabaseImage,
  type Brc38ComposedDatabaseImagePolicy
} from './Brc38ComposedDatabaseImageNode'
import type { Brc38ProfilePhysicalIdentity } from './Brc38ProfilePhysicalIdentityNode'
import {
  assertNoBrc38NativeBackend,
  readBrc38NativeBackend,
  writeBrc38NativeBackend,
  type Brc38NativeBackendRecord
} from './Brc38NativeBackendNode'
import { hashBrc38PublishedDatabase } from './Brc38PrivatePublicationCopyNode'
import {
  assertBrc38ProfilePhysicalIdentity,
  assertBrc38RetiringProfilePhysicalIdentity,
  captureBrc38ProfilePhysicalIdentity
} from './Brc38ProfilePhysicalIdentityNode'
import {
  assertBrc38ProfileCreationGrant,
  assertBrc38ProfileRetirementGrant,
  assertBrc38ProfileWithdrawalGrant,
  assertBrc38InventoryActivation,
  type Brc38ProfileCreationGrant
} from './Brc38ProfileInventoryClaimNode'

export interface Brc38ProfileInventoryBinding {
  readonly rootId: string
  readonly profileId: string
  readonly policySha256: string
}
declare const composedInspectionBrand: unique symbol
declare const preparedNativeTargetBrand: unique symbol
/** Actual bounded forward factory membership, never ordinary selection. */
export interface Brc38PreparedNativeTarget {
  readonly [preparedNativeTargetBrand]: true
}
/** An actual retained read scope, never a writable activation grant. */
export interface Brc38ComposedTargetInspection {
  readonly [composedInspectionBrand]: true
}
export interface Brc38ComposedTargetInspectionFacts {
  readonly receipt: Readonly<Brc38ComposedProfileReceipt>
  readonly target: Brc38NativeRetirementRecord['target']
}
interface ComposedInspectionContext {
  readonly scope: Brc38ComposedTargetInspection
  readonly root: Brc38ProfileInventoryNode
  readonly inventory: Brc38ProfileInventoryBinding
  readonly merge: Brc38PrivateNativeMergeNode
  readonly store: KnexBrc38StagingStore
  readonly source: Brc38NativeLocalBaselineSource
  readonly mode: 'current' | 'retired'
  readonly receipt: Readonly<Brc38ComposedProfileReceipt>
  readonly row: Row
  readonly read: Knex.Transaction
  readonly io: Brc38OwnedImportReads
  readonly check: () => void
}
interface ComposedNativeForwardContext {
  readonly scope: Brc38PreparedNativeTarget
  readonly root: Brc38ProfileInventoryNode
  readonly merge: Brc38PrivateNativeMergeNode
  readonly store: KnexBrc38StagingStore
  readonly source: Brc38NativeLocalBaselineSource
  readonly receipt: Readonly<Brc38ComposedProfileReceipt>
  readonly policy: Readonly<Brc38ComposedDatabaseImagePolicy>
  readonly check: () => void
  readonly original: Brc38PublishedProfileNode
  readonly provider: StorageKnex
  readonly manager: WalletStorageManager
  readonly transition: WalletStorageProviderTransition
}
interface PendingComposedRecoveryContext {
  readonly incoming?: Brc39RecoveryIncomingComparisonNode
  readonly scope: Brc38PreparedNativeTarget
  readonly replacement?: Readonly<Brc38PendingNativeManagerRecovery>
  readonly root: Brc38ProfileInventoryNode
  readonly grant: Brc38NativeProfileReopenGrant
  readonly merge: Brc38PrivateNativeMergeNode
  readonly store: KnexBrc38StagingStore
  readonly source: Brc38NativeLocalBaselineSource
  readonly receipt: Readonly<Brc38ComposedProfileReceipt>
  readonly policy: Readonly<Brc38ComposedDatabaseImagePolicy>
  readonly check: () => void
}
interface UncommittedCurrentRecoveryContext {
  readonly scope: Brc38PreparedNativeTarget
  readonly root: Brc38ProfileInventoryNode
  readonly original: Readonly<Brc38PendingNativeManagerRecovery>
  readonly policy: Readonly<import('./Brc38RetiredNativeReadNode').Brc38RetiredNativeReadPolicy>
  readonly check: () => void
}
/** Concrete same-process owners. A new manager queue scope is required; this
 * record itself grants neither native recovery nor provider installation. */
export interface Brc38PendingNativeManagerRecovery {
  readonly original: Brc38PublishedProfileNode
  readonly provider: StorageKnex
  readonly manager: WalletStorageManager
  readonly transition: WalletStorageProviderTransition
}
const profileIssuer = Symbol('original published profile constructor')
const actualProfiles = new WeakSet<Brc38PublishedProfileNode>()
const nativeClaimBrand: unique symbol = Symbol('native transfer type')
export interface Brc38NativeProfileTransferClaim {
  readonly [nativeClaimBrand]: true
}
export interface Brc38NativeProfileTransferReceipt {
  readonly directory: string
  readonly bindingSha256: string
  readonly state: Exclude<State, 'RECEIVING'>
  readonly fixedJson: string
  readonly fixedSha256: string
  readonly copySha256: string
  readonly copyBytes: number
}
interface NativeClaim {
  readonly profile: Brc38PublishedProfileNode
  readonly root: Brc38ProfileInventoryNode
  readonly inventory: Brc38ProfileInventoryBinding
  readonly receipt: Brc38NativeProfileTransferReceipt
  readonly reopenGrant?: Brc38NativeProfileReopenGrant
  phase: 'offered' | 'draining' | 'released' | 'refused' | 'native-verifying' | 'native-owned' | 'native-draining'
}
const nativeClaims = new WeakMap<Brc38NativeProfileTransferClaim, NativeClaim>()
interface NativeSession {
  readonly identity?: object
}
type NativePhysicalDrain = Readonly<{
  terminal: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  failed: boolean
  failure?: unknown
}>
interface NativeDriver {
  readonly NativeProfileSqlite: {
    startForClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: NativeSession; failure?: unknown }>>
    startComposedForClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: NativeSession; failure?: unknown }>>
  }
  readonly componentBuild: Readonly<{
    platform: string
    architecture: string
    bytes: number
    sha256: string
  }>
  admitDeleteOwned(session: NativeSession): Promise<unknown>
  promoteWalOwned(session: NativeSession): Promise<unknown>
  requireRetirementOwned(session: NativeSession): Promise<void>
  freezeSourceRetirementOwned(session: NativeSession): Promise<void>
  requireSourceRetirementFrozenOwned(session: NativeSession): Promise<void>
  requireSourceRetirementProcessFrozenOwned(session: NativeSession): Promise<void>
  withOwnedNativeImmediateWriter<T>(root: Knex, work: (writer: Knex.Transaction) => Promise<T>): Promise<T>
  nativeKnex(knex: typeof createKnex, client: unknown, session: NativeSession, slot: number): Knex
  queryOwned(
    session: NativeSession,
    slot: number,
    sql: string,
    bindings: unknown[],
    safeIntegers: boolean
  ): Promise<Readonly<{ rows: Array<Record<string, unknown>> }>>
  nativeTransactionIdentity(transaction: Knex.Transaction): Readonly<{ token: object; slot: number }> | undefined
  nativeDatabaseIdentity(database: Knex): Readonly<{ token: object; slot: number }> | undefined
  isLiveNativeSession(session: NativeSession): boolean
  drainStartedNativeSession(session: NativeSession): Promise<NativePhysicalDrain>
}
interface NativeOwner {
  readonly session: NativeSession
  readonly claim: Brc38NativeProfileTransferClaim
  phase:
    | 'starting'
    | 'validating'
    | 'validated-delete'
    | 'delete-activating'
    | 'delete-active'
    | 'validated-reopen'
    | 'wal-pending'
    | 'wal'
    | 'closing'
  token?: object
  catalog?: Knex
  wallet?: Knex
}
let nativeDriver: NativeDriver | undefined
function driver(): NativeDriver {
  nativeDriver ??= require('./NativeProfileSqlite.cjs') as NativeDriver
  return nativeDriver
}
const nativeJournalOwners = new WeakMap<object, Brc38PublishedProfileNode>()
const copyInspectionOwners = new WeakMap<
  Knex.Transaction,
  {
    readonly profile: Brc38PublishedProfileNode
    readonly receivingDeadline?: number
    readonly receivingExpiresAt?: number
  }
>()
let copyInspectionMatches: ((profile: Brc38PublishedProfileNode) => boolean) | undefined
/** Membership in the private, read-only copy inspection callback only. This
 * grants no native producer, writer, READY, inventory or activation authority.
 * Exact schema/content/current filesystem and catalog checks remain separate. */
export function isBrc38PublishedCopyInspection(transaction: Knex.Transaction): boolean {
  const actual = copyInspectionOwners.get(transaction)
  return (
    actual !== undefined &&
    transaction.isTransaction === true &&
    !transaction.isCompleted() &&
    copyInspectionMatches?.(actual.profile) === true &&
    (actual.receivingDeadline === undefined ||
      (performance.now() < actual.receivingDeadline && Date.now() < actual.receivingExpiresAt!))
  )
}
export function requireBrc38PublishedCopyInspection(transaction: Knex.Transaction): void {
  if (!isBrc38PublishedCopyInspection(transaction))
    throw new Error('An actual retained published-copy inspection is required')
}
let nativeJournalMatches: ((profile: Brc38PublishedProfileNode, token: object) => boolean) | undefined
/** Node-only journal authority. Actual private producer identity is necessary
 * but insufficient: its exact profile must hold the real enrolled claim. */
export function requireBrc38NativeProfileTransaction(transaction: Knex.Transaction): void {
  const identity = nativeDriver?.nativeTransactionIdentity(transaction)
  const profile = identity === undefined ? undefined : nativeJournalOwners.get(identity.token)
  if (
    identity === undefined ||
    profile === undefined ||
    ![0, 3].includes(identity.slot) ||
    !nativeJournalMatches?.(profile, identity.token)
  )
    throw new Error('Native import journal requires an authenticated published-profile transaction')
}
/** Read membership only, including the inventory-owned retired slot3 view.
 * This must never replace published writer, provider or manager enrollment. */
export function requireBrc38NativeProfileReadTransaction(transaction: Knex.Transaction): void {
  const retired = require('./Brc38RetiredNativeReadNode') as {
    Brc38RetiredNativeReadNode: { isReadTransaction(read: Knex.Transaction): boolean }
  }
  if (!retired.Brc38RetiredNativeReadNode.isReadTransaction(transaction))
    requireBrc38NativeProfileTransaction(transaction)
}
/** Actual current published producer membership for schema/runtime adapters.
 * The original live claim and current physical session are evaluated afresh;
 * a cloned client/config/root function cannot enroll itself. This grants no
 * source/profile/schema/primary verdict or remote capability. */
export function isBrc38OwnedPublishedNativeSqlite(database: Knex): boolean {
  const identity = database.isTransaction
      ? nativeDriver?.nativeTransactionIdentity(database as Knex.Transaction)
      : nativeDriver?.nativeDatabaseIdentity(database),
    profile = identity === undefined ? undefined : nativeJournalOwners.get(identity.token)
  return (
    identity !== undefined &&
    profile !== undefined &&
    [0, 3].includes(identity.slot) &&
    nativeJournalMatches?.(profile, identity.token) === true
  )
}
function physicalFileMaximum(name: string, limits: Parameters<typeof pages>[0]): number {
  if (name === 'wallet.sqlite-shm') return 65536
  return name.startsWith('wallet') ? pages(limits) * 4096 * 2 : 65536
}
function reopenedOwnerPhase(
  phase: Brc38NativeBackendRecord['phase']
): 'delete-activating' | 'delete-active' | 'wal-pending' {
  if (phase === 'DELETE_ACTIVATING') return 'delete-activating'
  if (phase === 'DELETE_ACTIVE') return 'delete-active'
  return 'wal-pending'
}
const catalogPages = 8
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function database(directory: string, filename: string, maximumPages: number, readOnly = false): Knex {
  return createKnex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, filename), ...(readOnly ? { options: { readonly: true } } : {}) },
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
          connection.exec(
            readOnly
              ? 'PRAGMA busy_timeout=0; PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64; PRAGMA mmap_size=0;'
              : `PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=${maximumPages};`
          )
          done(null, connection)
        } catch (cause) {
          done(cause instanceof Error ? cause : new Error('Published profile connection failed'), connection)
        }
      }
    }
  })
}
async function privateDirectory(directory: string): Promise<void> {
  await requirePrivatePath(directory, true)
}
async function privateFile(filename: string, maximumBytes: number) {
  const stat = await requirePrivatePath(filename, false)
  if (stat.size > BigInt(maximumBytes)) throw new Error('Published profile file physical bound differs')
  return stat
}
async function newFile(filename: string): Promise<void> {
  const file = await createPrivateFile(filename)
  await closePrivateDescriptor(file)
}
async function syncDirectory(directory: string): Promise<void> {
  await syncPrivateDirectory(directory)
}
async function closeDirectory(directory: Dir, failed: boolean, original: unknown): Promise<void> {
  try {
    await directory.close()
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED')
      throw new AggregateError(failed ? [original, cause] : [cause], 'Published directory cleanup failed')
  }
}
/** Prospective single-profile publication component. A persistent receipt and
 * independent kernel writer own an actual copied native database. READY is an
 * explicit durable commit before the original import deadline; source admission
 * and its capacity remain unchanged. This fixed-capacity DELETE profile is not
 * a qualified multi-profile inventory or concurrent WAL production adapter. */
export class Brc38PublishedProfileNode {
  static {
    copyInspectionMatches = profile =>
      actualProfiles.has(profile) &&
      profile.#busy &&
      !profile.#closed &&
      !profile.#ownerReleased &&
      profile.#nativeOwner === undefined &&
      profile.#ownerDb !== undefined &&
      profile.#connection !== undefined &&
      !profile.#connectionReleased &&
      !profile.#copyInspectionCleanupRequired
    nativeJournalMatches = (profile, token) => {
      const owner = profile.#nativeOwner
      const actual = owner === undefined ? undefined : nativeClaims.get(owner.claim)
      return (
        actualProfiles.has(profile) &&
        owner !== undefined &&
        owner.token === token &&
        [
          'validating',
          'validated-delete',
          'validated-reopen',
          'delete-activating',
          'delete-active',
          'wal-pending',
          'wal'
        ].includes(owner.phase) &&
        actual?.profile === profile &&
        profile.#nativeClaim === owner.claim &&
        ['native-verifying', 'native-owned'].includes(actual.phase) &&
        !profile.#closed &&
        !profile.#ownerReleased
      )
    }
  }
  #nativeOwner?: NativeOwner
  #nativeAcquiring = false
  #busy = false
  #closed = false
  #ownerReleased = false
  #connectionReleased = false
  #copyInspection?: Knex
  #composedInspection?: ComposedInspectionContext
  #composedNativeForward?: ComposedNativeForwardContext
  #pendingComposedRecovery?: PendingComposedRecoveryContext
  #releasedPendingCopyGrant?: Brc38NativeProfileReopenGrant
  #retiredManagedCleanup?: Readonly<{
    provider: StorageKnex
    manager: WalletStorageManager
    root: Brc38ProfileInventoryNode
  }>
  #uncommittedCurrentRecovery?: UncommittedCurrentRecoveryContext
  #uncommittedCurrentCleanup?: Readonly<{
    provider: StorageKnex
    manager: WalletStorageManager
    root: Brc38ProfileInventoryNode
  }>
  #copyInspectionCleanupRequired = false
  #nativeReadInspection?: Knex
  #nativeReadInspectionCleanupRequired = false
  #structuredPhysicalCleanup = new Set<Brc38StagingCleanupError>()
  #retired?: string
  #wallet?: StorageKnex
  #manager?: WalletStorageManager
  #db: Knex
  readonly #ownerDb: Knex | undefined
  readonly #connection: object | undefined
  readonly #fixed: FixedProfile
  #nativeClaim?: Brc38NativeProfileTransferClaim
  private constructor(
    readonly directory: string,
    db: Knex,
    ownerDb: Knex | undefined,
    connection: object | undefined,
    fixed: FixedProfile,
    issuer: typeof profileIssuer
  ) {
    if (issuer !== profileIssuer) throw new Error('An actual published profile issuer is required')
    Object.defineProperty(this, 'directory', {
      value: directory,
      enumerable: true,
      writable: false,
      configurable: false
    })
    this.#db = db
    this.#ownerDb = ownerDb
    this.#connection = connection
    this.#fixed = fixed
  }

  static async publish(
    parent: string,
    store: KnexBrc38StagingStore,
    admission: Brc38ImportJournalAdmission,
    signal?: AbortSignal
  ): Promise<Brc38PublishedProfileNode> {
    await privateDirectory(parent)
    store.assertPrivateNativeDestination(store.knex)
    const directory = await createPrivateTemporaryDirectory(join(parent, 'profile-'))
    const profile = await this.#prepareAt(directory, store, admission)
    try {
      await profile.copyFromCompletedRestore(store, admission, signal)
      return profile
    } catch (cause) {
      try {
        await profile.close()
      } catch (error_) {
        throw new AggregateError([cause, error_], 'Publication retains physical cleanup')
      }
      await rm(directory, { recursive: true })
      await syncDirectory(parent)
      throw cause
    }
  }
  /** Inventory holds its actual catalog writer during this bounded file/schema
   * creation. The returned independent kernel claim survives catalog release;
   * no source data copy or foreground wallet ownership occurs in this phase. */
  static async prepareOwnedAt(
    grant: Brc38ProfileCreationGrant,
    store: KnexBrc38StagingStore,
    admission: Brc38ImportJournalAdmission
  ): Promise<Brc38PublishedProfileNode> {
    await assertBrc38ProfileCreationGrant(grant)
    const { directory, inventory } = grant
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    if (
      !uuid.test(inventory.rootId) ||
      !uuid.test(inventory.profileId) ||
      !/^[0-9a-f]{64}$/.test(inventory.policySha256)
    )
      throw new Error('Invalid fixed profile inventory binding')
    store.assertPrivateNativeDestination(store.knex)
    if (store.binding?.digest !== grant.bindingSha256) throw new Error('Inventory creation source binding differs')
    await createPrivateDirectory(directory)
    return await this.#prepareAt(directory, store, admission, inventory)
  }
  static async #prepareAt(
    directory: string,
    store: KnexBrc38StagingStore,
    admission: Brc38ImportJournalAdmission,
    inventory?: Brc38ProfileInventoryBinding
  ): Promise<Brc38PublishedProfileNode> {
    store.assertPrivateNativeDestination(store.knex)
    const bound = store.binding!
    const fixed: FixedProfile = {
      protocol: 'brc38-published-profile/v2',
      ...(inventory === undefined ? {} : { inventory: { ...inventory } }),
      binding: { ...bound.binding },
      bindingSha256: bound.digest,
      limits: { ...store.limits },
      admission: JSON.parse(JSON.stringify(admission)) as Brc38ImportJournalAdmission
    }
    const fixedJson = JSON.stringify(fixed)
    if (Buffer.byteLength(fixedJson) > 8192) throw new Error('Publication receipt exceeds its fixed metadata bound')
    await privateDirectory(directory)
    let profile: Brc38PublishedProfileNode | undefined
    let db: Knex | undefined, ownerDb: Knex | undefined
    try {
      await newFile(join(directory, 'profile.sqlite'))
      db = database(directory, 'profile.sqlite', catalogPages)
      await db.transaction(async trx => {
        await trx.schema.createTable('profile', table => {
          table.integer('slot').primary()
          table.string('state', 16).notNullable()
          table.text('fixedJson').notNullable()
          table.string('fixedSha256', 64).notNullable()
          table.string('copySha256', 64).nullable()
          table.bigInteger('copyBytes').nullable()
        })
        await trx('profile').insert({
          slot: 1,
          state: 'RECEIVING',
          fixedJson,
          fixedSha256: hash(fixedJson),
          copySha256: null,
          copyBytes: null
        })
      })
      await newFile(join(directory, 'owner.sqlite'))
      ownerDb = database(directory, 'owner.sqlite', 4)
      await ownerDb.schema.createTable('owner', table => {
        table.integer('slot').primary()
        table.string('binding', 64).notNullable()
      })
      await ownerDb('owner').insert({ slot: 1, binding: bound.digest })
      const connection = (await ownerDb.client.acquireConnection()) as object
      profile = new Brc38PublishedProfileNode(directory, db, ownerDb, connection, fixed, profileIssuer)
      await ownerDb.raw('BEGIN IMMEDIATE').connection(connection)
      await profile.#enrollReceivingPhysicalIdentity()
      await syncDirectory(directory)
      actualProfiles.add(profile)
      return profile
    } catch (cause) {
      const errors: unknown[] = []
      try {
        if (profile !== undefined) await profile.close()
        else {
          const results = await Promise.allSettled([db?.destroy(), ownerDb?.destroy()])
          errors.push(...results.flatMap(result => (result.status === 'rejected' ? [result.reason] : [])))
        }
      } catch (error_) {
        errors.push(error_)
      }
      // No deletion while a native owner may still hold an open connection.
      if (errors.length) throw new AggregateError([cause, ...errors], 'Publication retains physical cleanup')
      await rm(directory, { recursive: true })
      await syncDirectory(join(directory, '..'))
      throw cause
    }
  }
  /** Actual source copy and durable READY commit run after inventory writer
   * release, under only the source and destination kernel claims. */
  async copyFromCompletedRestore(
    store: KnexBrc38StagingStore,
    admission: Brc38ImportJournalAdmission,
    signal?: AbortSignal,
    structured?: Readonly<Brc38PrivateStructuredRestoreResources>
  ): Promise<void> {
    this.#available()
    if (this.#busy) throw new Error('Published profile work is already owned')
    if (
      store.binding?.digest !== this.#fixed.bindingSha256 ||
      JSON.stringify(admission) !== JSON.stringify(this.#fixed.admission)
    )
      throw new Error('Profile publication source or admission differs')
    if ((await this.#readCatalogRow()).state !== 'RECEIVING') throw new Error('Profile copy has already committed')
    const directory = this.directory,
      parent = join(directory, '..'),
      fixed = this.#fixed,
      publicationDeadline = performance.now() + Math.max(0, admission.expiresAt - Date.now())
    const assertPublicationCurrent = (): void => {
      signal?.throwIfAborted()
      this.#available()
      if (Date.now() >= admission.expiresAt || performance.now() >= publicationDeadline)
        throw new Error('Original private publication deadline expired')
    }
    this.#busy = true
    try {
      await this.#physical()
      const copy =
        structured === undefined
          ? await store.copyCompletedNativeRestore(
              join(directory, 'wallet.sqlite'),
              admission,
              pages(fixed.limits) * 4096,
              signal
            )
          : await store.copyCompletedStructuredNativeRestore(
              join(directory, 'wallet.sqlite'),
              admission,
              pages(fixed.limits) * 4096,
              structured,
              signal
            )
      signal?.throwIfAborted()
      if (Date.now() >= admission.expiresAt) throw new Error('Original private publication deadline expired')
      await syncDirectory(directory)
      await this.#physical()
      const publishedFixed: FixedProfile = {
        ...fixed,
        ...(fixed.protocol === 'brc38-published-profile/v2'
          ? { physicalIdentity: await captureBrc38ProfilePhysicalIdentity(directory, true) }
          : {})
      }
      const publishedJson = JSON.stringify(publishedFixed)
      if (Buffer.byteLength(publishedJson) > 8192)
        throw new Error('Publication receipt exceeds its fixed metadata bound')
      // The source SQL owner is now closed. Inspect the independently copied
      // bytes under this profile's retained kernel claim before durable READY.
      await this.#withCopyInspection(async trx => {
        if (await hasBrc38NativePackedSchema(trx)) {
          const inspected = await inspectBrc38PublishedStructuredRestoreInventory(
            trx,
            admission,
            'published-copy',
            Math.min(admission.expiresAt, Date.now() + 3600000),
            signal
          )
          if (structured !== undefined && !inspected)
            throw new Error('Structured publication copied a different receiver layout')
          if (!inspected) await inspectBrc38PublishedCopyStreamedInventory(trx, admission, signal)
        } else if (structured !== undefined)
          throw new Error('Structured publication requires the actual packed native layout')
      })
      if (
        (await hashBrc38PublishedDatabase(
          join(directory, 'wallet.sqlite'),
          pages(fixed.limits) * 4096,
          publishedFixed.physicalIdentity?.wallet,
          assertPublicationCurrent
        )) !== copy.sha256
      )
        throw new Error('Receiving profile changed during independent copy inspection')
      if (publishedFixed.physicalIdentity !== undefined)
        await assertBrc38ProfilePhysicalIdentity(directory, publishedFixed.physicalIdentity, true)
      await this.#db.transaction(async trx => {
        if (
          (await trx('profile')
            .where({ slot: 1, state: 'RECEIVING' })
            .update({
              state: 'READY',
              copySha256: copy.sha256,
              copyBytes: copy.bytes,
              fixedJson: publishedJson,
              fixedSha256: hash(publishedJson)
            })) !== 1
        )
          throw new Error('Publication state changed before durable commit')
        signal?.throwIfAborted()
        if (Date.now() >= admission.expiresAt) throw new Error('Original private publication deadline expired')
      })
      await syncDirectory(directory)
      await syncDirectory(parent)
      // Keep this original instance aligned with the complete durable receipt;
      // its receiving identity did not yet include the copied wallet.
      if (publishedFixed.physicalIdentity !== undefined) this.#fixed.physicalIdentity = publishedFixed.physicalIdentity
      await this.#verifyWallet()
    } finally {
      this.#busy = false
    }
  }
  /** Independent composed RECEIVING inspection under this genuine profile's
   * physical owner and the SAME original merge operation. The full semantic
   * comparison precedes the copy, and every copied SQL table/value is read
   * again here. The explicit composed receipt commits READY only after the
   * same-owner comparison and independent copied image agree. READY owns an
   * inactive target; forward cutover/recovery must still admit its writer. */
  static async receiveComparedComposition(
    profile: Brc38PublishedProfileNode,
    store: KnexBrc38StagingStore,
    selected: Brc38ImportJournalAdmission,
    merge: Brc38PrivateNativeMergeNode
  ): Promise<
    Readonly<{
      bytes: number
      sha256: string
      image: Readonly<Brc38ComposedDatabaseImage>
      physicalIdentity: Brc38ProfilePhysicalIdentity
    }>
  > {
    if (!actualProfiles.has(profile)) throw new Error('An actual receiving profile issuer is required')
    return await profile.#receiveComparedComposition(store, selected, merge)
  }
  /** Lost acknowledgement recovery registers this same inactive target only.
   * The original bounded catalog/copy/image are reread. This does not supply
   * retired-source semantics or permission to admit the target writer. */
  static async assertComposedReadyPublication(
    profile: Brc38PublishedProfileNode,
    selected: Brc38ImportJournalAdmission
  ): Promise<void> {
    const admission = admissionCopy(selected)
    if (!actualProfiles.has(profile)) throw new Error('Actual composed published profile required')
    profile.#available()
    if (profile.#busy || profile.#nativeClaim !== undefined || profile.#wallet !== undefined)
      throw new Error('Composed publication recovery requires its idle inactive owner')
    profile.#busy = true
    try {
      const row = await profile.#readCatalogRow(),
        fixed = fixedProfile(row, profile.#fixed.bindingSha256)
      if (
        row.state !== 'READY' ||
        fixed.protocol !== 'brc38-published-profile/v3' ||
        JSON.stringify(fixed.admission) !== JSON.stringify(admission)
      )
        throw new Error('Composed publication recovery differs from its original READY receipt')
      await profile.#verifyWallet()
    } finally {
      profile.#busy = false
    }
  }
  /** Current and retired paths are distinct genuine source factories. Both
   * reconstruct the full original candidate and independently inspect every
   * copied target table/cell while its actual readonly owner is retained. */
  static withCurrentComposedInspection<T>(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    work: (scope: Brc38ComposedTargetInspection, facts: Readonly<Brc38ComposedTargetInspectionFacts>) => Promise<T>
  ): Promise<T> {
    if (!actualProfiles.has(profile)) throw new Error('Actual composed target profile required')
    return profile.#withComposedInspection(root, merge, store, source, work, 'current')
  }
  static withRetiredComposedInspection<T>(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    work: (scope: Brc38ComposedTargetInspection, facts: Readonly<Brc38ComposedTargetInspectionFacts>) => Promise<T>
  ): Promise<T> {
    if (!actualProfiles.has(profile)) throw new Error('Actual composed target profile required')
    return profile.#withComposedInspection(root, merge, store, source, work, 'retired')
  }
  /** Separate complete forward factory. The retired source and original
   * authenticated candidate remain held while the stock target physically
   * drains and its independently validated native WAL owner is installed. */
  static admitAndReplaceRetiredComposedTarget(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    original: Brc38PublishedProfileNode,
    provider: StorageKnex,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition,
    executable: string,
    services: WalletServices
  ): Promise<StorageKnex> {
    if (!actualProfiles.has(profile) || !actualProfiles.has(original) || profile === original)
      throw new Error('Actual distinct source and composed target owners required')
    return profile.#withComposedInspection(
      root,
      merge,
      store,
      source,
      undefined,
      'retired',
      async (receipt, policy, check) => {
        const actual: ComposedNativeForwardContext = Object.freeze({
          scope: Object.freeze({}) as Brc38PreparedNativeTarget,
          root,
          merge,
          store,
          source,
          original,
          provider,
          manager,
          transition,
          receipt,
          policy,
          check
        })
        if (profile.#composedNativeForward !== undefined)
          throw new Error('Composed native forward owner already exists')
        profile.#composedNativeForward = actual
        try {
          await profile.#requireComposedNativeForward(root)
          return await profile.#admitComposedNativeForward(executable, services)
        } finally {
          profile.#composedNativeForward = undefined
        }
      }
    )
  }
  static assertComposedTargetInspection(
    profile: Brc38PublishedProfileNode,
    scope: Brc38ComposedTargetInspection
  ): void {
    if (!actualProfiles.has(profile)) throw new Error('Actual composed target profile required')
    const actual = profile.#composedInspection
    if (
      actual === undefined ||
      actual.scope !== scope ||
      !profile.#busy ||
      profile.#nativeOwner !== undefined ||
      profile.#wallet !== undefined ||
      profile.#nativeClaim !== undefined
    )
      throw new Error('Composed target inspection is not its actual retained read scope')
    actual.check()
    requireBrc38PublishedCopyInspection(actual.read)
    Brc38ProfileInventoryNode.assertComposedTargetOperation(
      actual.root,
      profile,
      actual.inventory,
      profile.#fixed.admission.scope.importId
    )
    if (actual.mode === 'current')
      Brc38PrivateNativeMergeNode.assertCurrentCompositionImageScope(
        actual.merge,
        actual.store,
        actual.source,
        actual.receipt
      )
    else
      Brc38PrivateNativeMergeNode.assertRetiredRecoveryImageScope(
        actual.merge,
        actual.store,
        actual.source,
        actual.receipt
      )
  }
  /** Fresh bounded target coordinates DATA. Unawaited reads are retained and
   * drained by this exact inspection scope before any physical owner releases. */
  static readComposedInspectionTarget(
    profile: Brc38PublishedProfileNode,
    scope: Brc38ComposedTargetInspection
  ): Promise<Readonly<Brc38ComposedTargetInspectionFacts>> {
    Brc38PublishedProfileNode.assertComposedTargetInspection(profile, scope)
    const actual = profile.#composedInspection!
    return actual.io.run(async () => await profile.#readComposedInspectionTarget(scope))
  }
  async #readComposedInspectionTarget(
    scope: Brc38ComposedTargetInspection
  ): Promise<Readonly<Brc38ComposedTargetInspectionFacts>> {
    Brc38PublishedProfileNode.assertComposedTargetInspection(this, scope)
    const actual = this.#composedInspection!,
      row = await this.#readCatalogRow()
    if (JSON.stringify(row) !== JSON.stringify(actual.row) || row.copySha256 === null || row.copyBytes === null)
      throw new Error('Composed target catalog changed during actual inspection')
    Brc38PublishedProfileNode.assertComposedTargetInspection(this, scope)
    return Object.freeze({
      receipt: actual.receipt,
      target: Object.freeze({
        rootId: actual.inventory.rootId,
        profileId: actual.inventory.profileId,
        fixedSha256: row.fixedSha256,
        copySha256: row.copySha256,
        copyBytes: row.copyBytes
      })
    })
  }
  /** ONE prepared forward decision, bound to the actual independently read
   * composed target and the exact final unchanged-data source writer. No
   * caller-supplied target coordinates or earlier comparison report enter it. */
  static retireNativeSourceFromComposedInspection(
    profile: Brc38PublishedProfileNode,
    scope: Brc38ComposedTargetInspection,
    source: Brc38NativeLocalBaselineSource,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition,
    writer: Knex.Transaction
  ): Promise<Readonly<Brc38NativeRetirementRecord>> {
    Brc38PublishedProfileNode.assertComposedTargetInspection(profile, scope)
    const actual = profile.#composedInspection!
    if (actual.mode !== 'current' || actual.source !== source)
      throw new Error("Source retirement requires this target's actual current composition")
    return actual.io.run(
      async () =>
        await Brc38NativeLocalBaselineSource.withFinalRetirementWriter(
          source,
          manager,
          transition,
          writer,
          async (storage, fence, generation) => {
            Brc38PublishedProfileNode.assertComposedTargetInspection(profile, scope)
            const target = await profile.#readComposedInspectionTarget(scope),
              identity = driver().nativeDatabaseIdentity(storage.knex),
              original = identity === undefined ? undefined : nativeJournalOwners.get(identity.token)
            if (
              original === undefined ||
              original === profile ||
              original.#nativeOwner === undefined ||
              !original.#busy
            )
              throw new Error('Retirement lost its actual separately owned source writer')
            await original.#physical()
            const row = await original.#readCatalogRow(),
              fixed = fixedProfile(row, original.#fixed.bindingSha256),
              managed = WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
                manager,
                transition,
                storage
              )
            if (
              row.state !== 'ACTIVE' ||
              fixed.inventory === undefined ||
              row.copySha256 === null ||
              row.copyBytes === null ||
              fence.userId === null ||
              fence.primaryEpoch === null ||
              fence.userId !== managed.userId ||
              fence.activeStorage !== managed.primary ||
              fence.activeStorage !== fence.targetStorageIdentityKey ||
              fixed.binding.identityKey !== profile.#fixed.binding.identityKey ||
              fixed.binding.chain !== profile.#fixed.binding.chain ||
              fixed.binding.targetStorageIdentityKey !== profile.#fixed.binding.targetStorageIdentityKey
            )
              throw new Error('Actual source profile, manager user or primary changed before retirement')
            const claim = original.#nativeClaim === undefined ? undefined : nativeClaims.get(original.#nativeClaim)
            if (claim?.profile !== original || claim.phase !== 'native-owned')
              throw new Error('Actual source lost its current native inventory claim')
            await Brc38ProfileInventoryNode.assertCurrentPublishedProfile(
              claim.root,
              original,
              fixed.inventory,
              fixed.bindingSha256
            )
            const origin: Brc38ComposedProfileReceipt['source'] = Object.freeze({
              inventory: fixed.inventory,
              fixedSha256: row.fixedSha256,
              copySha256: row.copySha256,
              copyBytes: row.copyBytes,
              epoch: generation.epoch,
              revision: generation.revision,
              primaryEpoch: fence.primaryEpoch,
              userId: fence.userId,
              activeStorage: fence.activeStorage
            })
            if (
              JSON.stringify(origin) !== JSON.stringify(actual.receipt.source) ||
              target.receipt !== actual.receipt ||
              (target.target.rootId === fixed.inventory.rootId && target.target.profileId === fixed.inventory.profileId)
            )
              throw new Error('Final source differs from the independently inspected composed target')
            const record: Readonly<Brc38NativeRetirementRecord> = Object.freeze({
              protocol: 'brc38-native-retirement/v1',
              decisionId: actual.receipt.decisionId,
              source: Object.freeze({
                fixedSha256: row.fixedSha256,
                copySha256: row.copySha256,
                copyBytes: row.copyBytes,
                epoch: generation.epoch,
                revision: generation.revision,
                primaryEpoch: fence.primaryEpoch
              }),
              target: target.target
            })
            Brc38PublishedProfileNode.assertComposedTargetInspection(profile, scope)
            // Any uncertainty from this point remains behind the actual manager
            // barrier. Never restore old-provider availability after a freeze.
            WalletStorageManager.prototype.blockRetiringProviderInTransition.call(manager, transition)
            await Brc38PublishedProfileNode.freezeNativeSourceRetirementWriter(storage, manager, writer, transition)
            await original.#db.transaction(async catalog => {
              Brc38PublishedProfileNode.assertComposedTargetInspection(profile, scope)
              await driver().requireSourceRetirementFrozenOwned(original.#nativeOwner!.session)
              await writeBrc38NativeRetirement(catalog, record)
              Brc38PublishedProfileNode.assertComposedTargetInspection(profile, scope)
            })
            await syncDirectory(original.directory)
            if (JSON.stringify(await readBrc38NativeRetirement(original.#db)) !== JSON.stringify(record))
              throw new Error('Durable source retirement readback differs from its actual target')
            await driver().requireSourceRetirementFrozenOwned(original.#nativeOwner!.session)
            await Brc38PrivateNativeMergeNode.retainForwardRetirementImage(
              actual.merge,
              actual.store,
              source,
              actual.receipt,
              manager,
              transition
            )
            Brc38PublishedProfileNode.assertComposedTargetInspection(profile, scope)
            return record
          }
        )
    )
  }
  async #withComposedInspection<T>(
    root: Brc38ProfileInventoryNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    selected:
      | ((scope: Brc38ComposedTargetInspection, facts: Readonly<Brc38ComposedTargetInspectionFacts>) => Promise<T>)
      | undefined,
    mode: 'current' | 'retired',
    afterRead?: (
      receipt: Readonly<Brc38ComposedProfileReceipt>,
      policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
      check: () => void
    ) => Promise<T>
  ): Promise<T> {
    const work = selected
    this.#available()
    if (
      !actualProfiles.has(this) ||
      (typeof work === 'function') === (typeof afterRead === 'function') ||
      (afterRead !== undefined && mode !== 'retired') ||
      this.#busy ||
      this.#composedInspection !== undefined ||
      this.#nativeOwner !== undefined ||
      this.#nativeClaim !== undefined ||
      this.#wallet !== undefined
    )
      throw new Error('Composed target needs its actual idle inactive owner')
    this.#busy = true
    try {
      const row = await this.#readCatalogRow(),
        fixed = fixedProfile(row, this.#fixed.bindingSha256),
        inventory = fixed.inventory
      if (
        row.state !== 'READY' ||
        fixed.protocol !== 'brc38-published-profile/v3' ||
        fixed.composition === undefined ||
        inventory === undefined ||
        row.copySha256 === null ||
        row.copyBytes === null
      )
        throw new Error('Actual original composed READY target required')
      await Brc38ProfileInventoryNode.assertNativeTransferInventory(root, this, inventory, fixed.bindingSha256)
      const inspect = async (
        image: Readonly<Brc38ComposedDatabaseImage>,
        receipt: Readonly<Brc38ComposedProfileReceipt>,
        policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
        retained: () => void
      ): Promise<T> => {
        const check = (): void => {
          retained()
          this.#available()
        }
        check()
        if (
          JSON.stringify(receipt) !== JSON.stringify(fixed.composition) ||
          JSON.stringify(image) !== JSON.stringify(receipt.image) ||
          policy.maximumPhysicalBytes !== fixed.limits.maximumPhysicalBytes ||
          policy.expiresAt !== fixed.limits.expiresAt ||
          policy.maximumReadBytes !== receipt.maximumReadBytes
        )
          throw new Error('Composed target differs from its original candidate or shared resources')
        Brc38NativeLocalBaselineSource.assertSharedWorking(source, policy.workingAllocation)
        if (mode === 'retired') {
          const original = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source),
            target = original.retirement.target
          if (
            original.retirement.decisionId !== receipt.decisionId ||
            target.rootId !== inventory.rootId ||
            target.profileId !== inventory.profileId ||
            target.fixedSha256 !== row.fixedSha256 ||
            target.copySha256 !== row.copySha256 ||
            target.copyBytes !== row.copyBytes
          )
            throw new Error('Retired source names a different actual composed target')
        }
        check()
        await this.#physical()
        const digest = async (): Promise<void> => {
          if (
            (await hashBrc38PublishedDatabase(
              join(this.directory, 'wallet.sqlite'),
              pages(fixed.limits) * 4096,
              fixed.physicalIdentity?.wallet,
              check
            )) !== row.copySha256
          )
            throw new Error('Composed target physical copied bytes changed')
        }
        await digest()
        const value = await this.#withCopyInspection(async read => {
          await verifyBrc38PublishedWallet(read, fixed, row.state)
          const actualImage = await readBrc38ComposedDatabaseImage(read, policy, () => {
            check()
            requireBrc38PublishedCopyInspection(read)
          })
          if (JSON.stringify(actualImage) !== JSON.stringify(image))
            throw new Error('Independent composed target full typed SQL image differs')
          const scope = Object.freeze({}) as Brc38ComposedTargetInspection,
            io = new Brc38OwnedImportReads()
          this.#composedInspection = {
            scope,
            root,
            inventory,
            merge,
            store,
            source,
            mode,
            receipt,
            row,
            read,
            io,
            check
          }
          try {
            Brc38PublishedProfileNode.assertComposedTargetInspection(this, scope)
            const facts = await Brc38PublishedProfileNode.readComposedInspectionTarget(this, scope)
            const result = await io.retain(async () => (work === undefined ? undefined : await work(scope, facts)))
            Brc38PublishedProfileNode.assertComposedTargetInspection(this, scope)
            return result
          } finally {
            this.#composedInspection = undefined
          }
        })
        check()
        await digest()
        await this.#physical()
        if (JSON.stringify(await this.#readCatalogRow()) !== JSON.stringify(row))
          throw new Error('Composed target READY catalog changed before inspection release')
        check()
        // The independent stock READ transaction and facade are physically
        // closed here, while the original merge/source/kernel scope remains.
        if (afterRead !== undefined) return await afterRead(receipt, policy, retained)
        return value as T
      }
      if (mode === 'current')
        return await Brc38PrivateNativeMergeNode.inspectCurrentCompositionImage(merge, fixed.composition, inspect)
      return await Brc38PrivateNativeMergeNode.inspectRetiredRecoveryImage(merge, fixed.composition, inspect)
    } finally {
      this.#busy = false
    }
  }
  async #requireComposedNativeForward(root: Brc38ProfileInventoryNode): Promise<ComposedNativeForwardContext> {
    const actual = this.#composedNativeForward
    if (
      actual === undefined ||
      actual.root !== root ||
      !this.#busy ||
      this.#composedInspection !== undefined ||
      !actualProfiles.has(actual.original) ||
      !actual.original.#closed ||
      !actual.original.#ownerReleased ||
      actual.original.#nativeOwner !== undefined ||
      actual.original.#wallet !== actual.provider ||
      actual.original.#manager !== actual.manager
    )
      throw new Error('Composed native admission needs its actual physically released original provider')
    actual.check()
    Brc38PrivateNativeMergeNode.assertRetiredRecoveryImageScope(
      actual.merge,
      actual.store,
      actual.source,
      actual.receipt
    )
    const managed = WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
        actual.manager,
        actual.transition,
        actual.provider
      ),
      source = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(actual.source),
      row = await this.#readCatalogRow(),
      fixed = fixedProfile(row, this.#fixed.bindingSha256),
      target = source.retirement.target
    if (
      fixed.protocol !== 'brc38-published-profile/v3' ||
      fixed.inventory === undefined ||
      fixed.composition === undefined ||
      row.state === 'RECEIVING' ||
      JSON.stringify(fixed.composition) !== JSON.stringify(actual.receipt) ||
      JSON.stringify(source.source) !== JSON.stringify(actual.receipt.source) ||
      source.retirement.decisionId !== actual.receipt.decisionId ||
      target.rootId !== fixed.inventory.rootId ||
      target.profileId !== fixed.inventory.profileId ||
      target.fixedSha256 !== row.fixedSha256 ||
      target.copySha256 !== row.copySha256 ||
      target.copyBytes !== row.copyBytes ||
      JSON.stringify(source.source.inventory) !== JSON.stringify(actual.original.#fixed.inventory) ||
      hash(JSON.stringify(actual.original.#fixed)) !== source.source.fixedSha256 ||
      managed.identityKey !== fixed.binding.identityKey ||
      managed.chain !== fixed.binding.chain ||
      managed.storageIdentityKey !== fixed.binding.targetStorageIdentityKey ||
      managed.userId !== source.source.userId ||
      managed.primary !== source.source.activeStorage ||
      actual.manager.isActiveEnabled
    )
      throw new Error('Composed native admission differs from its actual original forward decision or blocked manager')
    Brc38ProfileInventoryNode.assertComposedTargetOperation(root, this, fixed.inventory, fixed.admission.scope.importId)
    actual.check()
    if (this.#composedNativeForward !== actual) throw new Error('Composed native forward operation changed')
    return actual
  }
  /** Full native owner validation precedes every writable admission. Wallet
   * tables, primary and mutation clock are preserved through catalog/WAL
   * transitions; only the original manager installs the actual new provider. */
  async #admitComposedNativeForward(executable: string, services: WalletServices): Promise<StorageKnex> {
    const forward = await this.#requireComposedNativeForward(this.#composedNativeForward!.root),
      row = await this.#readCatalogRow(),
      inventory = this.#fixed.inventory!
    if (
      row.state !== 'READY' ||
      this.#nativeClaim !== undefined ||
      this.#nativeOwner !== undefined ||
      this.#wallet !== undefined ||
      this.#copyInspection !== undefined ||
      this.#nativeAcquiring
    )
      throw new Error('Composed native admission requires its original independently inspected inactive READY owner')
    const receipt: Brc38NativeProfileTransferReceipt = Object.freeze({
        directory: this.directory,
        bindingSha256: this.#fixed.bindingSha256,
        state: row.state,
        fixedJson: row.fixedJson,
        fixedSha256: row.fixedSha256,
        copySha256: row.copySha256!,
        copyBytes: row.copyBytes!
      }),
      claim = Object.freeze({}) as Brc38NativeProfileTransferClaim,
      actual: NativeClaim = { profile: this, root: forward.root, inventory, receipt, phase: 'draining' }
    nativeClaims.set(claim, actual)
    this.#nativeClaim = claim
    this.#nativeAcquiring = true
    try {
      await this.#closeOwnedConnections()
      if (!this.#ownerReleased) throw new Error('Composed stock target still owns physical cleanup')
      forward.check()
      Brc38PrivateNativeMergeNode.assertRetiredRecoveryImageScope(
        forward.merge,
        forward.store,
        forward.source,
        forward.receipt
      )
      WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
        forward.manager,
        forward.transition,
        forward.provider
      )
      actual.phase = 'native-verifying'
      const attempt = await driver().NativeProfileSqlite.startComposedForClaim(
          executable,
          this.directory,
          row.fixedJson,
          receipt.bindingSha256
        ),
        owner: NativeOwner = { session: attempt.session, claim, phase: 'starting' }
      this.#nativeOwner = owner
      this.#ownerReleased = false
      if (Object.prototype.hasOwnProperty.call(attempt, 'failure')) throw attempt.failure
      const bound = await driver().queryOwned(
        owner.session,
        1,
        'SELECT CASE WHEN length(CAST(binding AS BLOB))=64 THEN binding ELSE NULL END AS binding FROM owner WHERE slot=1 LIMIT 2',
        [],
        false
      )
      if (
        bound.rows.length !== 1 ||
        bound.rows[0].binding !== receipt.bindingSha256 ||
        owner.session.identity === undefined
      )
        throw new Error('Composed native kernel lost its actual physical owner binding')
      const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
      owner.catalog = driver().nativeKnex(createKnex, client, owner.session, 2)
      owner.wallet = driver().nativeKnex(createKnex, client, owner.session, 0)
      owner.token = owner.session.identity
      this.#db = owner.catalog
      this.#closed = false
      owner.phase = 'validating'
      nativeJournalOwners.set(owner.token, this)
      if (JSON.stringify(await this.#readCatalogRow()) !== JSON.stringify(row))
        throw new Error('Composed target catalog changed during physical native claim')
      await this.#requireComposedNativeForward(forward.root)
      await this.#verifyWallet(forward.policy, forward.check)
      owner.phase = 'validated-delete'
      actual.phase = 'native-owned'
      await this.#finishComposedNativeBackend(async () => {
        await this.#requireComposedNativeForward(forward.root)
      }, forward.check)
      await this.#requireComposedNativeForward(forward.root)
      await this.#verifyWallet(forward.policy, forward.check)
      const wallet = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions(this.#fixed.binding.chain),
        knex: owner.wallet,
        snapshotSync: false
      })
      wallet.setServices(services)
      this.#wallet = wallet
      this.#manager = forward.manager
      await wallet.enableOwnedNativeSnapshotSync(this, forward.scope)
      await this.#verifyWallet(forward.policy, forward.check)
      await this.#requireComposedNativeForward(forward.root)
      await WalletStorageManager.prototype.replaceProviderInTransition.call(
        forward.manager,
        forward.transition,
        wallet,
        async () => {
          await this.#requireComposedNativeForward(forward.root)
          await this.#verifyWallet(forward.policy, forward.check)
          await Brc38PublishedProfileNode.assertPreparedNativeSnapshotProvider(this, wallet, forward.scope)
          const origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(forward.source)
          await this.#db.transaction(async catalog => {
            forward.check()
            await writeBrc38ComposedNativeCommit(
              catalog,
              await readRow(catalog),
              driver().componentBuild,
              this.#fixed.bindingSha256,
              origin.retirement
            )
          })
          await syncDirectory(this.directory)
          await this.#requireComposedNativeForward(forward.root)
          await this.#verifyWallet(forward.policy, forward.check)
        }
      )
      return wallet
    } catch (cause) {
      actual.phase = 'native-draining'
      try {
        await this.#closeOwnedConnections()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Composed native target retains actual physical cleanup',
          async () => await this.close()
        )
      }
      actual.phase = 'released'
      throw cause
    } finally {
      this.#nativeAcquiring = false
    }
  }
  /** Complete or resume the four original durable backend phases. Each phase
   * is reread through the actual catalog under a freshly reconstructed source
   * and target. No previous phase observation admits a writer or renews a cap. */
  async #finishComposedNativeBackend(check: () => Promise<void>, retained: () => void): Promise<void> {
    const owner = this.#nativeOwner,
      actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (
      !this.#busy ||
      owner === undefined ||
      owner.wallet === undefined ||
      actual?.profile !== this ||
      actual.phase !== 'native-owned' ||
      (this.#composedNativeForward === undefined && this.#pendingComposedRecovery === undefined)
    )
      throw new Error('Composed backend completion requires its genuine reconstructed native target')
    await check()
    let row = await this.#readCatalogRow(),
      backend = await readBrc38NativeBackend(this.#db, row, driver().componentBuild)
    if (backend === undefined) {
      if (row.state !== 'READY') throw new Error('Composed initial backend lacks its original READY catalog')
      const record: Brc38NativeBackendRecord = {
        protocol: 'brc38-native-backend/v1',
        phase: 'DELETE_ACTIVATING',
        fixedSha256: row.fixedSha256,
        copySha256: row.copySha256!,
        copyBytes: row.copyBytes!,
        componentBuild: { ...driver().componentBuild }
      }
      await this.#db.transaction(async catalog => {
        retained()
        await migrateBrc38NativeCatalog(catalog, row)
        await writeBrc38NativeBackend(catalog, undefined, record)
      })
    }
    await check()
    owner.phase = 'delete-activating'
    await driver().admitDeleteOwned(owner.session)
    await check()
    row = await this.#readCatalogRow()
    backend = await readBrc38NativeBackend(this.#db, row, driver().componentBuild)
    if (backend?.phase === 'DELETE_ACTIVATING') {
      await this.#db.transaction(async catalog => {
        retained()
        const current = await readRow(catalog),
          previous = await readBrc38NativeBackend(catalog, current, driver().componentBuild)
        if (
          current.state !== 'ACTIVATING' ||
          previous?.phase !== 'DELETE_ACTIVATING' ||
          (await catalog('profile_native').where({ slot: 1, state: 'ACTIVATING' }).update({ state: 'ACTIVE' })) !== 1
        )
          throw new Error('Composed DELETE activation catalog changed')
        await writeBrc38NativeBackend(catalog, previous, { ...previous, phase: 'DELETE_ACTIVE' })
      })
    }
    await check()
    row = await this.#readCatalogRow()
    backend = await readBrc38NativeBackend(this.#db, row, driver().componentBuild)
    if (row.state !== 'ACTIVE' || backend === undefined)
      throw new Error('Composed backend lacks durable completed DELETE activation')
    if (backend.phase === 'DELETE_ACTIVE') {
      owner.phase = 'delete-active'
      await this.#db.transaction(async catalog => {
        retained()
        const current = await readRow(catalog),
          previous = await readBrc38NativeBackend(catalog, current, driver().componentBuild)
        if (previous?.phase !== 'DELETE_ACTIVE') throw new Error('Composed WAL preparation catalog changed')
        await writeBrc38NativeBackend(catalog, previous, { ...previous, phase: 'WAL_ACTIVATING' })
      })
    } else if (!['WAL_ACTIVATING', 'WAL'].includes(backend.phase))
      throw new Error('Composed backend phase did not advance')
    await check()
    owner.phase = 'wal-pending'
    await driver().promoteWalOwned(owner.session)
    if ((await owner.wallet.raw('PRAGMA journal_mode'))[0]?.journal_mode !== 'wal')
      throw new Error('Composed target actual WAL mode differs')
    await this.#db.transaction(async catalog => {
      retained()
      const previous = await readBrc38NativeBackend(catalog, await readRow(catalog), driver().componentBuild)
      if (previous === undefined || !['WAL_ACTIVATING', 'WAL'].includes(previous.phase))
        throw new Error('Composed target WAL transition catalog changed')
      if (previous.phase === 'WAL_ACTIVATING')
        await writeBrc38NativeBackend(catalog, previous, { ...previous, phase: 'WAL' })
    })
    owner.phase = 'wal'
    await check()
  }

  async #receiveComparedComposition(
    store: KnexBrc38StagingStore,
    selected: Brc38ImportJournalAdmission,
    merge: Brc38PrivateNativeMergeNode
  ): Promise<
    Readonly<{
      bytes: number
      sha256: string
      image: Readonly<Brc38ComposedDatabaseImage>
      physicalIdentity: Brc38ProfilePhysicalIdentity
    }>
  > {
    const admission = admissionCopy(selected),
      decisionId = randomUUID(),
      fixed = this.#fixed,
      target = join(this.directory, 'wallet.sqlite')
    this.#available()
    if (
      this.#busy ||
      this.#nativeClaim !== undefined ||
      this.#wallet !== undefined ||
      store.binding?.digest !== fixed.bindingSha256 ||
      JSON.stringify(admission) !== JSON.stringify(fixed.admission) ||
      (await this.#readCatalogRow()).state !== 'RECEIVING'
    )
      throw new Error('Composed receiving copy requires its original inactive profile and admission')
    this.#busy = true
    try {
      await this.#physical()
      return await Brc38PrivateNativeMergeNode.withReceivingCopy(
        merge,
        store,
        admission,
        target,
        pages(fixed.limits) * 4096,
        async (copy, policy, assertRetained, origin) => {
          const check = (): void => {
            assertRetained()
            this.#available()
          }
          check()
          await syncDirectory(this.directory)
          await this.#physical()
          const physicalIdentity = await captureBrc38ProfilePhysicalIdentity(this.directory, true)
          await this.#withCopyInspection(async k => {
            const image = await readBrc38ComposedDatabaseImage(k, policy, () => {
              check()
              requireBrc38PublishedCopyInspection(k)
            })
            if (JSON.stringify(image) !== JSON.stringify(copy.image))
              throw new Error('Independent composed receiving database image differs')
          })
          check()
          if (
            (await hashBrc38PublishedDatabase(target, pages(fixed.limits) * 4096, physicalIdentity.wallet, check)) !==
            copy.sha256
          )
            throw new Error('Composed receiving database changed during independent inspection')
          await assertBrc38ProfilePhysicalIdentity(this.directory, physicalIdentity, true)
          if ((await this.#readCatalogRow()).state !== 'RECEIVING')
            throw new Error('Composed receiving catalog changed during independent inspection')
          const composition = copyBrc38ComposedProfileReceipt({
              protocol: 'brc38-composed-profile/v1',
              decisionId,
              source: origin,
              image: copy.image,
              maximumReadBytes: policy.maximumReadBytes
            }),
            publishedFixed: FixedProfile = {
              ...fixed,
              protocol: 'brc38-published-profile/v3',
              physicalIdentity,
              composition
            },
            publishedJson = JSON.stringify(publishedFixed),
            publishedSha256 = hash(publishedJson)
          if (fixed.inventory === undefined || Buffer.byteLength(publishedJson) > 8192)
            throw new Error('Composed publication requires its original bounded inventory receipt')
          check()
          const receiving = await this.#readCatalogRow()
          if (receiving.state !== 'RECEIVING') throw new Error('Composed publication state changed before READY')
          fixedProfile(
            {
              state: 'READY',
              fixedJson: publishedJson,
              fixedSha256: publishedSha256,
              copySha256: copy.sha256,
              copyBytes: copy.bytes
            },
            fixed.bindingSha256
          )
          await this.#db.transaction(async trx => {
            if (
              (await trx('profile').where({ slot: 1, state: 'RECEIVING', fixedSha256: receiving.fixedSha256 }).update({
                state: 'READY',
                fixedJson: publishedJson,
                fixedSha256: publishedSha256,
                copySha256: copy.sha256,
                copyBytes: copy.bytes
              })) !== 1
            )
              throw new Error('Composed publication changed before durable READY commit')
            check()
          })
          // Lost acknowledgement resumes the same durable receipt. The old
          // source is still serving: READY does not retire it or select target.
          Object.assign(fixed, publishedFixed)
          await syncDirectory(this.directory)
          await syncDirectory(join(this.directory, '..'))
          await this.#verifyWallet(policy, check)
          check()
          return Object.freeze({ ...copy, physicalIdentity })
        }
      )
    } finally {
      this.#busy = false
    }
  }

  static async open(directory: string, expectedBindingSha256: string): Promise<Brc38PublishedProfileNode> {
    await privateDirectory(directory)
    const before = await privateFile(join(directory, 'owner.sqlite'), 16384)
    await privateFile(join(directory, 'profile.sqlite'), catalogPages * 4096)
    const ownerDb = database(directory, 'owner.sqlite', 4)
    let connection: object | undefined, db: Knex | undefined, profile: Brc38PublishedProfileNode | undefined
    try {
      connection = (await ownerDb.client.acquireConnection()) as object
      await ownerDb.raw('BEGIN IMMEDIATE').connection(connection)
      const after = await privateFile(join(directory, 'owner.sqlite'), 16384)
      if (before.dev !== after.dev || before.ino !== after.ino)
        throw new Error('Published profile owner file was replaced')
      const owners: Array<{ binding: string }> = await ownerDb('owner')
        .connection(connection)
        .where({ slot: 1 })
        .select(ownerDb.raw('CASE WHEN length(CAST(binding AS BLOB)) = 64 THEN binding ELSE NULL END AS binding'))
        .limit(2)
      if (owners.length !== 1 || owners[0]?.binding !== expectedBindingSha256)
        throw new Error('Published profile kernel binding differs')
      db = database(directory, 'profile.sqlite', catalogPages)
      await assertNoBrc38NativeBackend(db)
      const row = await readOriginalProfileRow(db),
        fixed = fixedProfile(row, expectedBindingSha256)
      profile = new Brc38PublishedProfileNode(directory, db, ownerDb, connection, fixed, profileIssuer)
      await profile.#enrollReceivingPhysicalIdentity()
      await profile.#physical()
      actualProfiles.add(profile)
      if (row.state !== 'RECEIVING') await profile.#verifyWallet()
      return profile
    } catch (cause) {
      let failure: unknown
      try {
        if (profile !== undefined) await profile.close()
        else {
          await db?.destroy()
          if (connection !== undefined) await ownerDb.client.releaseConnection(connection)
          await ownerDb.destroy()
        }
      } catch (error_) {
        failure = error_
      }
      if (failure !== undefined)
        throw new AggregateError([cause, failure], 'Published profile claim and cleanup failed')
      throw cause
    }
  }

  // Stock profiles retain their original single bounded receipt query. Forward
  // layout checks apply to the actual private native owner, not every legacy
  // publication read. This data selection grants no owner or write authority.
  async #readCatalogRow(): Promise<Awaited<ReturnType<typeof readRow>>> {
    return await (this.#nativeOwner === undefined ? readOriginalProfileRow(this.#db) : readRow(this.#db))
  }
  #available(): void {
    if (this.#structuredPhysicalCleanup.size !== 0)
      throw new Error('Published structured inspection still owns physical cleanup')
    if (this.#nativeReadInspectionCleanupRequired)
      throw new Error('Published native read inspection still requires physical cleanup')
    if (this.#copyInspectionCleanupRequired)
      throw new Error('Published copy inspection still requires physical cleanup')
    if (this.#closed) throw new Error('Published profile is closed')
    if (this.#nativeOwner !== undefined && !driver().isLiveNativeSession(this.#nativeOwner.session))
      throw new Error('Published profile native owner has stopped')
  }
  async #enrollReceivingPhysicalIdentity(): Promise<void> {
    if (this.#fixed.protocol !== 'brc38-published-profile/v2' || this.#fixed.physicalIdentity !== undefined) return
    const row = await this.#readCatalogRow()
    if (row.state !== 'RECEIVING') throw new Error('Only an incomplete publication can enroll its original files')
    const physical = await captureBrc38ProfilePhysicalIdentity(this.directory)
    const next = { ...this.#fixed, physicalIdentity: physical },
      json = JSON.stringify(next)
    if (Buffer.byteLength(json) > 8192) throw new Error('Publication receipt exceeds its fixed metadata bound')
    if (
      (await this.#db('profile')
        .where({ slot: 1, state: 'RECEIVING', fixedSha256: row.fixedSha256 })
        .update({ fixedJson: json, fixedSha256: hash(json) })) !== 1
    )
      throw new Error('Publication state changed before physical binding commit')
    this.#fixed.physicalIdentity = physical
    await assertBrc38ProfilePhysicalIdentity(this.directory, physical, false)
  }
  async assertInventoryBinding(inventory: Brc38ProfileInventoryBinding, bindingSha256: string): Promise<void> {
    if (this.#retired === undefined) this.#available()
    if (this.#retired === undefined) await this.#physical()
    const actual = this.#retired === undefined ? fixedProfile(await this.#readCatalogRow(), bindingSha256) : this.#fixed
    if (actual.bindingSha256 !== bindingSha256) throw new Error('Retained retirement binding differs')
    if (
      JSON.stringify(actual.inventory) !== JSON.stringify(inventory) ||
      JSON.stringify(this.#fixed.inventory) !== JSON.stringify(inventory)
    )
      throw new Error('Published profile inventory binding differs')
  }
  async #physical(transition?: WalletStorageProviderTransition): Promise<number> {
    const readPhysicalRow = async (): Promise<Row> => {
      if (transition === undefined) return await this.#readCatalogRow()
      if (this.#wallet === undefined || this.#manager === undefined || this.#nativeOwner === undefined)
        throw new Error('Forward physical inspection lacks its original actual source owner')
      Brc38PublishedProfileNode.assertNativeManagedProvider(this.#wallet, this.#manager, transition)
      await driver().requireSourceRetirementProcessFrozenOwned(this.#nativeOwner.session)
      const row = await readForwardOriginalProfileRow(this.#db),
        retirement = await readBrc38NativeRetirement(this.#db)
      if (
        retirement === undefined ||
        retirement.source.fixedSha256 !== row.fixedSha256 ||
        retirement.source.copySha256 !== row.copySha256 ||
        retirement.source.copyBytes !== row.copyBytes
      )
        throw new Error('Forward physical inspection lacks its fresh original retirement')
      Brc38PublishedProfileNode.assertNativeManagedProvider(this.#wallet, this.#manager, transition)
      // Retirement can only replace completed ACTIVE. The immutable stock
      // receipt may still say READY; this value checks the retained WAL record,
      // never restores an active catalog or supplies activation permission.
      return { ...row, state: 'ACTIVE' }
    }
    if (this.#fixed.protocol !== 'brc38-published-profile/v1') {
      if (this.#fixed.physicalIdentity === undefined)
        throw new Error('Published profile durable physical binding is incomplete')
      await assertBrc38ProfilePhysicalIdentity(this.directory, this.#fixed.physicalIdentity, false)
      const row = await readPhysicalRow(),
        recorded = fixedProfile(row, this.#fixed.bindingSha256).physicalIdentity
      if (recorded === undefined) throw new Error('Published profile durable physical binding is incomplete')
      await assertBrc38ProfilePhysicalIdentity(this.directory, recorded, row.state !== 'RECEIVING')
    }
    const allowed = new Set([
      'owner.sqlite',
      'owner.sqlite-journal',
      'profile.sqlite',
      'profile.sqlite-journal',
      'wallet.sqlite',
      'wallet.sqlite-journal'
    ])
    const backend =
      this.#nativeOwner === undefined
        ? undefined
        : await readBrc38NativeBackend(this.#db, await readPhysicalRow(), driver().componentBuild)
    if (transition !== undefined && backend?.phase !== 'WAL')
      throw new Error('Forward source lost its durable WAL record')
    const wal = backend !== undefined && ['WAL_ACTIVATING', 'WAL'].includes(backend.phase)
    if (wal) {
      allowed.add('wallet.sqlite-wal')
      allowed.add('wallet.sqlite-shm')
    }
    const maximumEntries = wal ? 8 : 6
    let bytes = 0,
      entries = 0
    const directory = await opendir(this.directory)
    let failed = false,
      original: unknown
    try {
      const names: string[] = []
      for await (const entry of directory) {
        entries++
        if (entries > maximumEntries || !allowed.has(entry.name)) throw new Error('Unexpected published profile file')
        names.push(entry.name)
      }
      if (
        !names.includes('owner.sqlite') ||
        !names.includes('profile.sqlite') ||
        ((await readPhysicalRow()).state !== 'RECEIVING' && !names.includes('wallet.sqlite'))
      )
        throw new Error('Published profile required file is absent')
      await runInSeries(names, async name => {
        const maximum = physicalFileMaximum(name, this.#fixed.limits)
        bytes += Number((await privateFile(join(this.directory, name), maximum)).size)
        if (bytes > this.#fixed.limits.maximumPhysicalBytes)
          throw new Error('Published profile physical quota exceeded')
      })
    } catch (cause) {
      failed = true
      original = cause
      throw cause
    } finally {
      await closeDirectory(directory, failed, original)
    }
    return bytes
  }
  async #verifyWallet(
    composedPolicy?: Readonly<Brc38ComposedDatabaseImagePolicy>,
    assertRetained?: () => void
  ): Promise<void> {
    const expiresAt = composedPolicy?.expiresAt ?? Date.now() + 3600000,
      deadline = performance.now() + Math.max(0, expiresAt - Date.now())
    let composed = composedPolicy !== undefined || this.#fixed.protocol === 'brc38-published-profile/v3'
    const check = (): void => {
      this.#available()
      assertRetained?.()
      if (composed) {
        composedPolicy?.signal?.throwIfAborted()
        if (Date.now() >= expiresAt || performance.now() >= deadline)
          throw new Error('Composed published inspection original deadline expired')
      }
    }
    check()
    await this.#physical()
    const row = await this.#readCatalogRow(),
      current = fixedProfile(row, this.#fixed.bindingSha256)
    composed ||= current.protocol === 'brc38-published-profile/v3'
    check()
    if (
      row.state === 'READY' &&
      (await hashBrc38PublishedDatabase(
        join(this.directory, 'wallet.sqlite'),
        pages(this.#fixed.limits) * 4096,
        current.physicalIdentity?.wallet,
        check
      )) !== row.copySha256
    )
      throw new Error('Published profile copy digest differs')
    if (
      current.protocol === 'brc38-published-profile/v3' &&
      this.#composedNativeForward === undefined &&
      this.#pendingComposedRecovery === undefined &&
      this.#nativeOwner !== undefined
    ) {
      const owner = this.#nativeOwner,
        actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim),
        committed = await readBrc38ComposedNativeCommit(this.#db, row, driver().componentBuild, current.bindingSha256)
      if (
        committed === undefined ||
        owner.wallet === undefined ||
        actual?.profile !== this ||
        owner.claim !== this.#nativeClaim ||
        !['native-verifying', 'native-owned'].includes(actual.phase) ||
        row.state !== 'ACTIVE'
      )
        throw new Error('Completed composed current profile requires its actual native owner and durable lifecycle')
      await verifyNativePublishedWallet(owner.wallet, current, row.state)
      const policy =
        composedPolicy ??
        Object.freeze({
          maximumPhysicalBytes: current.limits.maximumPhysicalBytes,
          maximumReadBytes: current.composition!.maximumReadBytes,
          expiresAt,
          workingAllocation: new Brc38WorkingAllocation(1048576)
        })
      if (
        policy.maximumPhysicalBytes !== current.limits.maximumPhysicalBytes ||
        policy.maximumReadBytes > current.composition!.maximumReadBytes
      )
        throw new Error('Completed composed current read exceeds its original physical or framing limits')
      await this.#withNativeReadInspection(async read => {
        requireBrc38NativeProfileTransaction(read)
        await verifySnapshotJournalDestinationSchema(read)
        // The source's all47 observation epoch is not archive payload and is
        // not transplanted as the target's new current epoch. A missing,
        // bootstrapping or exhausted observer prevents the separate merge
        // capture API, while current wallet operations retain their fallback.
        const generation = (await hasBrc38NativeLocalBaselineGenerationSchema(read))
          ? await readBrc38NativeLocalBaselineGeneration(read)
          : undefined
        // Customer writes legitimately change this image. Traverse every
        // bounded typed cell afresh; do not compare to an immutable READY image.
        await readBrc38ComposedDatabaseImage(read, policy, () => {
          check()
          requireBrc38NativeProfileTransaction(read)
        })
        const afterGeneration = (await hasBrc38NativeLocalBaselineGenerationSchema(read))
          ? await readBrc38NativeLocalBaselineGeneration(read)
          : undefined
        if (JSON.stringify(afterGeneration) !== JSON.stringify(generation))
          throw new Error('Completed composed current generation changed during its coherent read')
      })
      if (
        JSON.stringify(
          await readBrc38ComposedNativeCommit(this.#db, row, driver().componentBuild, current.bindingSha256)
        ) !== JSON.stringify(committed)
      )
        throw new Error('Completed composed lifecycle changed during current wallet verification')
    } else if (current.protocol === 'brc38-published-profile/v3') {
      const forward = this.#composedNativeForward,
        pending = this.#pendingComposedRecovery
      if (
        current.composition === undefined ||
        (forward === undefined && pending === undefined && (row.state !== 'READY' || this.#nativeOwner !== undefined))
      )
        throw new Error('Composed target requires its actual forward cutover reader before writable activation')
      if (forward !== undefined) await this.#requireComposedNativeForward(forward.root)
      else if (pending !== undefined) await this.#requirePendingComposedRecovery()
      const policy: Readonly<Brc38ComposedDatabaseImagePolicy> =
        composedPolicy ??
        Object.freeze({
          maximumPhysicalBytes: current.limits.maximumPhysicalBytes,
          maximumReadBytes: current.composition.maximumReadBytes,
          expiresAt,
          workingAllocation: new Brc38WorkingAllocation(1048576)
        })
      if (
        policy.maximumPhysicalBytes !== current.limits.maximumPhysicalBytes ||
        policy.maximumReadBytes !== current.composition.maximumReadBytes
      )
        throw new Error('Composed copied image inspection differs from the original resource limits')
      const inspect = async (trx: Knex.Transaction): Promise<void> => {
        if (this.#nativeOwner === undefined) await verifyBrc38PublishedWallet(trx, current, row.state)
        const image = await readBrc38ComposedDatabaseImage(trx, policy, () => {
          check()
          if (this.#nativeOwner === undefined) requireBrc38PublishedCopyInspection(trx)
          else requireBrc38NativeProfileTransaction(trx)
        })
        if (JSON.stringify(image) !== JSON.stringify(current.composition!.image))
          throw new Error('Composed published image differs from the complete original copied SQL image')
      }
      if (this.#nativeOwner === undefined) await this.#withCopyInspection(inspect)
      else {
        if (
          this.#nativeOwner.wallet === undefined ||
          (forward === undefined
            ? pending === undefined || composedPolicy !== pending.policy
            : composedPolicy !== forward.policy)
        )
          throw new Error('Composed native verification lacks its actual original full image scope')
        await verifyNativePublishedWallet(this.#nativeOwner.wallet, current, row.state)
        await this.#withNativeReadInspection(inspect)
        if (forward !== undefined) await this.#requireComposedNativeForward(forward.root)
        else await this.#requirePendingComposedRecovery()
      }
    } else if (this.#nativeOwner !== undefined) {
      if (this.#nativeOwner.wallet === undefined) throw new Error('Native wallet facade is not yet owned')
      await verifyNativePublishedWallet(this.#nativeOwner.wallet, this.#fixed, row.state)
      if (row.state === 'READY')
        await this.#withNativeReadInspection(async trx => {
          if (
            (await hasBrc38NativePackedSchema(trx)) &&
            !(await inspectBrc38PublishedStructuredRestoreInventory(
              trx,
              current.admission,
              'published-native',
              Date.now() + 3600000
            ))
          )
            await inspectBrc38ReadyPublishedStreamedNativeInventory(trx, current.admission)
        })
    } else {
      await this.#withCopyInspection(async trx => {
        const packed = await hasBrc38NativePackedSchema(trx)
        await verifyBrc38PublishedWallet(trx, this.#fixed, row.state)
        if (
          packed &&
          row.state === 'READY' &&
          !(await inspectBrc38PublishedStructuredRestoreInventory(
            trx,
            current.admission,
            'published-copy',
            Date.now() + 3600000
          ))
        )
          await inspectBrc38PublishedCopyStreamedInventory(trx, current.admission)
      })
    }
    await this.#physical()
    const after = await this.#readCatalogRow()
    if (JSON.stringify(after) !== JSON.stringify(row))
      throw new Error('Published profile catalog changed during wallet verification')
    if (
      row.state === 'READY' &&
      (await hashBrc38PublishedDatabase(
        join(this.directory, 'wallet.sqlite'),
        pages(this.#fixed.limits) * 4096,
        current.physicalIdentity?.wallet,
        check
      )) !== row.copySha256
    )
      throw new Error('Published profile copy changed during wallet verification')
    check()
  }
  /** Actual slot3 lease, independently drained before returning. Failed drain
   * remains owned by this profile and blocks subsequent work until close. */
  async #withNativeReadInspection<T>(run: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    this.#available()
    const owner = this.#nativeOwner
    if (owner === undefined || owner.token === undefined || this.#nativeReadInspection !== undefined)
      throw new Error('Published native inventory has no current read inspection owner')
    const client: unknown = require('knex/lib/dialects/sqlite3/index.js'),
      reader = driver().nativeKnex(createKnex, client, owner.session, 3)
    this.#nativeReadInspection = reader
    let failed = false,
      cause: unknown
    const cleanupScope1 = new Brc38CleanupScope(async () => {
      try {
        await reader.destroy()
        this.#nativeReadInspection = undefined
      } catch (error_) {
        this.#nativeReadInspectionCleanupRequired = true
        throw new AggregateError(
          failed ? [cause, error_] : [error_],
          'Published native read inspection retains physical cleanup'
        )
      }
    })
    try {
      await this.#physical()
      const row = await this.#readCatalogRow()
      return await reader.transaction(async trx => {
        requireBrc38NativeProfileTransaction(trx)
        if (driver().nativeTransactionIdentity(trx)?.slot !== 3 || this.#nativeOwner !== owner)
          throw new Error('Published native inventory read lease differs')
        const result = await run(trx)
        requireBrc38NativeProfileTransaction(trx)
        if (this.#nativeOwner !== owner || JSON.stringify(await this.#readCatalogRow()) !== JSON.stringify(row))
          throw new Error('Published native inventory catalog or owner changed')
        await this.#physical()
        return result
      })
    } catch (error_) {
      if (error_ instanceof Brc38StagingCleanupError) this.#structuredPhysicalCleanup.add(error_)
      failed = true
      cause = error_
      {
        await cleanupScope1.close()
        throw error_
      }
    } finally {
      await cleanupScope1.close()
    }
  }
  /** This concrete factory holds the independent kernel writer while a stock
   * SQLite connection inspects bounded physical chunks. It cannot publish a
   * provider or serve a packed wallet. The callback and SQL connection both
   * drain before returning; a failed drain retains the profile's ownership. */
  async #withCopyInspection<T>(run: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    if (
      this.#copyInspection !== undefined ||
      this.#nativeOwner !== undefined ||
      this.#ownerDb === undefined ||
      this.#connection === undefined ||
      this.#closed ||
      this.#ownerReleased
    )
      throw new Error('Published copy has no physical inspection owner')
    const previousBusy = this.#busy
    this.#busy = true
    let k: Knex | undefined, failure: { cause: unknown } | undefined
    const cleanupScope2 = new Brc38CleanupScope(async () => {
      try {
        await k?.destroy()
        this.#copyInspection = undefined
      } catch (error_) {
        this.#copyInspectionCleanupRequired = true
        throw new AggregateError(
          [...(failure === undefined ? [] : [failure.cause]), error_],
          'Published copy inspection retains physical cleanup'
        )
      } finally {
        this.#busy = previousBusy
      }
    })
    try {
      const reader = database(this.directory, 'wallet.sqlite', pages(this.#fixed.limits), true)
      k = reader
      this.#copyInspection = reader
      await this.#physical()
      const row = await this.#readCatalogRow(),
        current = fixedProfile(row, this.#fixed.bindingSha256),
        receiving =
          row.state === 'RECEIVING'
            ? {
                receivingExpiresAt: current.admission.expiresAt,
                receivingDeadline: performance.now() + Math.max(0, current.admission.expiresAt - Date.now())
              }
            : {}
      await reader.raw('PRAGMA query_only=ON')
      return await reader.transaction(async trx => {
        const flags = (await trx.raw('PRAGMA query_only')) as Array<{ query_only: number }>
        if (flags.length !== 1 || flags[0].query_only !== 1)
          throw new Error('Published copy inspection is not read-only')
        copyInspectionOwners.set(trx, { profile: this, ...receiving })
        try {
          requireBrc38PublishedCopyInspection(trx)
          const value = await run(trx)
          requireBrc38PublishedCopyInspection(trx)
          if (JSON.stringify(await this.#readCatalogRow()) !== JSON.stringify(row))
            throw new Error('Published copy catalog changed during retained inspection')
          return value
        } finally {
          copyInspectionOwners.delete(trx)
        }
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) this.#structuredPhysicalCleanup.add(cause)
      failure = { cause }
      {
        await cleanupScope2.close()
        throw cause
      }
    } finally {
      await cleanupScope2.close()
    }
  }
  async status(): Promise<
    Readonly<{
      state: State
      bindingSha256: string
      physicalBytes: number
      reservedPhysicalBytes: number
    }>
  > {
    if (this.#nativeAcquiring) throw new Error('Wait for actual native handoff before status')
    this.#available()
    const physicalBytes = await this.#physical()
    return Object.freeze({
      state: (await this.#readCatalogRow()).state,
      bindingSha256: this.#fixed.bindingSha256,
      physicalBytes,
      reservedPhysicalBytes: this.#fixed.limits.maximumPhysicalBytes
    })
  }
  /** Explicit selection affects only this published profile. The caller's
   * existing manager and all its providers are never registered or mutated. */
  async activate(services: WalletServices): Promise<WalletStorageManager> {
    this.#available()
    assertBrc38InventoryActivation(this, this.#fixed.inventory)
    if (this.#nativeClaim !== undefined) throw new Error('Published profile is reserved for native handoff')
    if (this.#busy) throw new Error('Published profile work is already owned')
    this.#busy = true
    try {
      const row = await this.#readCatalogRow()
      if (row.state === 'RECEIVING') throw new Error('Incomplete profile cannot be activated')
      if (this.#fixed.protocol === 'brc38-published-profile/v3')
        throw new Error('Composed target requires its actual durable forward cutover')
      await this.#verifyWallet()
      await this.#withCopyInspection(async trx => {
        if (await hasBrc38NativePackedSchema(trx)) throw new Error('Packed profiles require managed native activation')
      })
      if (this.#wallet === undefined) {
        this.#wallet = new StorageKnex({
          ...StorageProvider.createStorageBaseOptions(this.#fixed.binding.chain),
          knex: database(this.directory, 'wallet.sqlite', pages(this.#fixed.limits)),
          snapshotSync: false
        })
        this.#wallet.setServices(services)
        this.#manager = new WalletStorageManager(this.#fixed.binding.identityKey, this.#wallet)
      }
      const manager = this.#manager!
      await manager.makeAvailable()
      if (row.state !== 'ACTIVE') {
        await this.#db('profile').where({ slot: 1 }).update({ state: 'ACTIVATING' })
        await manager.setActive(this.#fixed.binding.targetStorageIdentityKey)
        await this.#db('profile').where({ slot: 1, state: 'ACTIVATING' }).update({ state: 'ACTIVE' })
      }
      if (!manager.isActiveEnabled) throw new Error('Published profile activation is unavailable')
      await this.#physical()
      return manager
    } finally {
      this.#busy = false
    }
  }
  /** Explicit native selection remains inside the actual managed inventory operation.
   * The source-owned forward record is durable before any wallet write is admitted. */
  async activateNative(services: WalletServices): Promise<WalletStorageManager> {
    if (this.#fixed.protocol === 'brc38-published-profile/v3')
      throw new Error('Composed target requires its actual durable forward cutover')
    const actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (actual === undefined || actual.profile !== this || actual.phase !== 'native-owned')
      throw new Error('An actual authenticated native profile is required')
    return await Brc38ProfileInventoryNode.activateNativeProfile(actual.root, this, services)
  }
  /** Distinct current-runtime entry point. Pending composition/activation can
   * never use it; the actual completed native reopen and fresh lifecycle record
   * are required before the managed selection is reconstructed. */
  async activateCompletedComposedNative(
    services: WalletServices,
    policy?: import('./Brc38RetiredNativeReadNode').Brc38RetiredNativeReadPolicy
  ): Promise<WalletStorageManager> {
    const actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (
      this.#fixed.protocol !== 'brc38-published-profile/v3' ||
      actual?.profile !== this ||
      actual.phase !== 'native-owned' ||
      actual.reopenGrant === undefined ||
      (await readBrc38ComposedNativeCommit(
        this.#db,
        await this.#readCatalogRow(),
        driver().componentBuild,
        this.#fixed.bindingSha256
      )) === undefined
    )
      throw new Error('Completed composed activation requires its actual current native reopen')
    return await Brc38ProfileInventoryNode.activateNativeProfile(actual.root, this, services, policy)
  }
  static async activateNativeWithinInventory(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    services: WalletServices,
    policy?: import('./Brc38RetiredNativeReadNode').Brc38RetiredNativeReadPolicy
  ): Promise<WalletStorageManager> {
    return await profile.#activateNative(root, services, policy)
  }
  async #activateNative(
    root: Brc38ProfileInventoryNode,
    services: WalletServices,
    selectedPolicy?: import('./Brc38RetiredNativeReadNode').Brc38RetiredNativeReadPolicy
  ): Promise<WalletStorageManager> {
    this.#available()
    const policy = selectedPolicy === undefined ? undefined : Brc38RetiredNativeReadNode.capturePolicy(selectedPolicy),
      deadline = policy === undefined ? undefined : performance.now() + policy.expiresAt - Date.now(),
      currentPolicy =
        policy === undefined
          ? undefined
          : Object.freeze({ ...policy, maximumPhysicalBytes: this.#fixed.limits.maximumPhysicalBytes }),
      check = (): void => {
        policy?.signal?.throwIfAborted()
        if (policy !== undefined && (Date.now() >= policy.expiresAt || performance.now() >= deadline!))
          throw new Error('Completed current activation exceeded its bounded read lifetime')
      }
    if (
      policy !== undefined &&
      (this.#fixed.protocol !== 'brc38-published-profile/v3' ||
        policy.maximumReadBytes !== this.#fixed.composition?.maximumReadBytes)
    )
      throw new Error('Completed current activation differs from its original read bound')
    check()
    const owner = this.#nativeOwner,
      actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (
      owner === undefined ||
      owner.wallet === undefined ||
      actual === undefined ||
      actual.root !== root ||
      actual.profile !== this ||
      actual.phase !== 'native-owned' ||
      owner.claim !== this.#nativeClaim ||
      !['validated-delete', 'delete-activating', 'delete-active', 'wal-pending', 'wal'].includes(owner.phase)
    )
      throw new Error('An actual authenticated native profile is required')
    if (this.#busy || this.#nativeAcquiring) throw new Error('Published profile work is already owned')
    this.#busy = true
    try {
      await Brc38ProfileInventoryNode.assertNativeTransferInventory(
        root,
        this,
        actual.inventory,
        actual.receipt.bindingSha256
      )
      const row = await this.#readCatalogRow()
      fixedProfile(row, actual.receipt.bindingSha256)
      const previous = await readBrc38NativeBackend(this.#db, row, driver().componentBuild)
      if (
        this.#fixed.protocol === 'brc38-published-profile/v3' &&
        (actual.reopenGrant === undefined ||
          previous?.phase !== 'WAL' ||
          (await readBrc38ComposedNativeCommit(this.#db, row, driver().componentBuild, this.#fixed.bindingSha256)) ===
            undefined)
      )
        throw new Error('Pending composed target cannot enter current-runtime activation')
      if (
        previous === undefined &&
        JSON.stringify(await this.#nativeTransferReceipt(root)) !== JSON.stringify(actual.receipt)
      )
        throw new Error('Original native activation receipt changed')
      await this.#verifyWallet(currentPolicy, check)
      const record: Brc38NativeBackendRecord = {
        protocol: 'brc38-native-backend/v1',
        phase: 'DELETE_ACTIVATING',
        fixedSha256: row.fixedSha256,
        copySha256: row.copySha256!,
        copyBytes: row.copyBytes!,
        componentBuild: { ...driver().componentBuild }
      }
      if (previous === undefined) {
        await this.#db.transaction(async trx => {
          await migrateBrc38NativeCatalog(trx, row)
          await writeBrc38NativeBackend(trx, undefined, record)
        })
      }
      // The record and ACTIVATING state are physically committed. This captured
      // module implementation admits DELETE writes without a callback or flag.
      owner.phase = 'delete-activating'
      await driver().admitDeleteOwned(owner.session)
      const reopeningWal = previous !== undefined && ['WAL_ACTIVATING', 'WAL'].includes(previous.phase)
      if (reopeningWal) {
        owner.phase = 'wal-pending'
        await driver().promoteWalOwned(owner.session)
      }
      if (this.#wallet === undefined) {
        this.#wallet = new StorageKnex({
          ...StorageProvider.createStorageBaseOptions(this.#fixed.binding.chain),
          knex: owner.wallet,
          snapshotSync: false
        })
        this.#wallet.setServices(services)
        this.#manager = new WalletStorageManager(this.#fixed.binding.identityKey, this.#wallet)
      }
      const manager = this.#manager!
      await manager.makeAvailable()
      check()
      await manager.setActive(this.#fixed.binding.targetStorageIdentityKey)
      check()
      if (!manager.isActiveEnabled) throw new Error('Native profile activation is unavailable')
      await this.#db.transaction(async trx => {
        const current = await readRow(trx)
        const backend = await readBrc38NativeBackend(trx, current, driver().componentBuild)
        if (backend === undefined) throw new Error('Native activation durable record is absent')
        if (
          current.state !== 'ACTIVE' &&
          (await trx('profile_native').where({ slot: 1, state: 'ACTIVATING' }).update({ state: 'ACTIVE' })) !== 1
        )
          throw new Error('Native activation state changed before ACTIVE commit')
        await writeBrc38NativeBackend(trx, backend, {
          ...backend,
          phase: reopeningWal ? 'WAL' : 'DELETE_ACTIVE'
        })
      })
      await this.#verifyWallet(currentPolicy, check)
      await Brc38ProfileInventoryNode.assertNativeTransferInventory(
        root,
        this,
        actual.inventory,
        actual.receipt.bindingSha256
      )
      owner.phase = reopeningWal ? 'wal' : 'delete-active'
      if (reopeningWal) await this.#wallet!.enableOwnedNativeSnapshotSync(this)
      return manager
    } finally {
      this.#busy = false
    }
  }
  /** Promote only an authenticated, completely validated committed ACTIVE
   * owner. The durable pending record permits recovery after a lost reply. */
  async promoteNativeWal(): Promise<void> {
    const actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (actual === undefined || actual.profile !== this || actual.phase !== 'native-owned')
      throw new Error('An actual authenticated native profile is required')
    await Brc38ProfileInventoryNode.promoteNativeProfileWal(actual.root, this)
  }
  static async promoteNativeWalWithinInventory(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode
  ): Promise<void> {
    await profile.#promoteNativeWal(root)
  }
  async #promoteNativeWal(root: Brc38ProfileInventoryNode): Promise<void> {
    this.#available()
    const owner = this.#nativeOwner,
      actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (
      owner === undefined ||
      actual?.root !== root ||
      actual.profile !== this ||
      actual.phase !== 'native-owned' ||
      !['delete-active', 'wal-pending', 'wal'].includes(owner.phase) ||
      this.#manager?.isActiveEnabled !== true
    )
      throw new Error('A committed authenticated native ACTIVE manager is required')
    if (this.#busy) throw new Error('Published profile work is already owned')
    this.#busy = true
    try {
      await Brc38ProfileInventoryNode.assertNativeTransferInventory(
        root,
        this,
        actual.inventory,
        actual.receipt.bindingSha256
      )
      await this.#verifyWallet()
      const row = await this.#readCatalogRow(),
        backend = await readBrc38NativeBackend(this.#db, row, driver().componentBuild)
      if (row.state !== 'ACTIVE' || backend === undefined || backend.phase === 'DELETE_ACTIVATING')
        throw new Error('Native WAL promotion requires durable completed DELETE activation')
      if (backend.phase === 'DELETE_ACTIVE')
        await this.#db.transaction(
          async trx => await writeBrc38NativeBackend(trx, backend, { ...backend, phase: 'WAL_ACTIVATING' })
        )
      owner.phase = 'wal-pending'
      await driver().promoteWalOwned(owner.session)
      if (owner.wallet === undefined || (await owner.wallet.raw('PRAGMA journal_mode'))[0]?.journal_mode !== 'wal')
        throw new Error('Native wallet WAL mode differs after promotion')
      await this.#db.transaction(async trx => {
        const current = await readBrc38NativeBackend(trx, await readRow(trx), driver().componentBuild)
        if (current === undefined || !['WAL_ACTIVATING', 'WAL'].includes(current.phase))
          throw new Error('Native WAL pending record changed')
        await writeBrc38NativeBackend(trx, current, { ...current, phase: 'WAL' })
      })
      await this.#verifyWallet()
      await Brc38ProfileInventoryNode.assertNativeTransferInventory(
        root,
        this,
        actual.inventory,
        actual.receipt.bindingSha256
      )
      owner.phase = 'wal'
      if (this.#wallet === undefined) throw new Error('Native WAL owner has no actual wallet provider')
      await this.#wallet.enableOwnedNativeSnapshotSync(this)
    } finally {
      this.#busy = false
    }
  }
  /** Fresh concrete lifecycle check for the ONE provider created during this
   * profile's actual activation. A copied receipt, root, class or configuration
   * cannot enable native sync, and an in-memory WAL phase alone is insufficient. */
  static async assertNativeSnapshotProvider(
    profile: Brc38PublishedProfileNode,
    storage: StorageKnex,
    transition?: WalletStorageProviderTransition
  ): Promise<void> {
    const check = (): NativeClaim => {
      const owner = profile.#nativeOwner,
        actual = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
      if (
        !actualProfiles.has(profile) ||
        profile.#closed ||
        profile.#wallet !== storage ||
        profile.#manager === undefined ||
        (transition === undefined && !profile.#manager.isActiveEnabled) ||
        owner?.phase !== 'wal' ||
        owner.wallet !== storage.knex ||
        owner.claim !== profile.#nativeClaim ||
        actual?.profile !== profile ||
        actual.phase !== 'native-owned' ||
        !driver().isLiveNativeSession(owner.session)
      )
        throw new Error('Native snapshots require the actual active WAL profile provider')
      if (transition !== undefined)
        Brc38PublishedProfileNode.assertNativeManagedProvider(storage, profile.#manager, transition)
      return actual
    }
    const actual = check(),
      row = await profile.#readCatalogRow(),
      backend = await readBrc38NativeBackend(profile.#db, row, driver().componentBuild)
    if (row.state !== 'ACTIVE' || backend?.phase !== 'WAL')
      throw new Error('Native snapshot provider lacks its durable completed WAL record')
    await Brc38ProfileInventoryNode.assertCurrentPublishedProfile(
      actual.root,
      profile,
      actual.inventory,
      actual.receipt.bindingSha256
    )
    if ((await storage.knex.raw('PRAGMA journal_mode'))[0]?.journal_mode !== 'wal')
      throw new Error('Native snapshot provider WAL mode changed')
    if (check() !== actual) throw new Error('Native snapshot provider changed during lifecycle admission')
  }
  static async assertNativeProviderInventory(
    profile: Brc38PublishedProfileNode,
    storage: StorageKnex,
    root: Brc38ProfileInventoryNode
  ): Promise<void> {
    if (!actualProfiles.has(profile)) throw new Error('Actual original native source profile required')
    const claim = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
    if (claim?.profile !== profile || claim.root !== root || claim.phase !== 'native-owned')
      throw new Error('Original source provider belongs to a different actual native inventory')
    await Brc38PublishedProfileNode.assertNativeSnapshotProvider(profile, storage)
    if (profile.#nativeClaim === undefined || nativeClaims.get(profile.#nativeClaim) !== claim)
      throw new Error('Original native source inventory changed during admission')
  }
  /** Current metadata maintenance uses the original profile's physical quota
   * and fresh inventory/kernel membership. It never renews import admission. */
  static async assertNativeObserverMaintenance(
    profile: Brc38PublishedProfileNode,
    storage: StorageKnex,
    manager: WalletStorageManager,
    root: Brc38ProfileInventoryNode
  ): Promise<void> {
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager)
    await Brc38PublishedProfileNode.assertNativeProviderInventory(profile, storage, root)
    profile.#available()
    await profile.#physical()
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager)
    await Brc38PublishedProfileNode.assertNativeProviderInventory(profile, storage, root)
  }
  /** Prepare snapshot support before the blocked original manager installs
   * this actual fully validated WAL target. The opaque scope cannot be copied,
   * escaped or used by an ordinary profile/provider. */
  static async assertPreparedNativeSnapshotProvider(
    profile: Brc38PublishedProfileNode,
    storage: StorageKnex,
    scope: Brc38PreparedNativeTarget
  ): Promise<void> {
    if (!actualProfiles.has(profile)) throw new Error('Actual prepared composed native target required')
    const forward = profile.#composedNativeForward,
      pending = profile.#pendingComposedRecovery,
      current = profile.#uncommittedCurrentRecovery,
      owner = profile.#nativeOwner,
      identity = driver().nativeDatabaseIdentity(storage.knex),
      claim = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
    const prepared = forward ?? (pending?.replacement === undefined ? undefined : pending) ?? current
    const manager = forward?.manager ?? pending?.replacement?.manager ?? current?.original.manager
    if (
      prepared === undefined ||
      prepared.scope !== scope ||
      profile.#wallet !== storage ||
      profile.#manager !== manager ||
      owner?.phase !== 'wal' ||
      owner.wallet !== storage.knex ||
      identity?.slot !== 0 ||
      identity.token !== owner.token ||
      claim?.profile !== profile ||
      claim.phase !== 'native-owned' ||
      !driver().isLiveNativeSession(owner.session)
    )
      throw new Error("Snapshot preparation is not this target's actual forward WAL scope")
    if (forward !== undefined) await profile.#requireComposedNativeForward(forward.root)
    else if (pending !== undefined) await profile.#requirePendingComposedRecovery()
    else await profile.#requireUncommittedCurrentRecovery()
    const row = await profile.#readCatalogRow(),
      backend = await readBrc38NativeBackend(profile.#db, row, driver().componentBuild)
    if (
      row.state !== 'ACTIVE' ||
      backend?.phase !== 'WAL' ||
      (await storage.knex.raw('PRAGMA journal_mode'))[0]?.journal_mode !== 'wal'
    )
      throw new Error('Prepared composed target lacks its durable actual WAL admission')
    if (forward !== undefined) await profile.#requireComposedNativeForward(forward.root)
    else if (pending !== undefined) await profile.#requirePendingComposedRecovery()
    else await profile.#requireUncommittedCurrentRecovery()
    if (
      profile.#composedNativeForward !== forward ||
      profile.#pendingComposedRecovery !== pending ||
      profile.#uncommittedCurrentRecovery !== current ||
      profile.#nativeOwner !== owner ||
      profile.#wallet !== storage
    )
      throw new Error('Prepared composed snapshot provider changed during admission')
  }
  /** Original source receipt DATA from the actual activated WAL provider.
   * Its real profile/kernel/manager and current inventory are checked afresh;
   * matching storage identities or a saved receipt cannot supply membership. */
  static async readNativeSourceLineage(
    storage: StorageKnex,
    transition?: WalletStorageProviderTransition
  ): Promise<
    Readonly<{
      inventory: Readonly<Brc38ProfileInventoryBinding>
      fixedSha256: string
      copySha256: string
      copyBytes: number
    }>
  > {
    const identity = nativeDriver?.nativeDatabaseIdentity(storage.knex),
      profile = identity === undefined ? undefined : nativeJournalOwners.get(identity.token)
    if (profile === undefined || profile.#manager === undefined)
      throw new Error('Actual native source profile required')
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, profile.#manager, transition)
    await Brc38PublishedProfileNode.assertNativeSnapshotProvider(profile, storage, transition)
    await profile.#physical()
    const row = await profile.#readCatalogRow(),
      fixed = fixedProfile(row, profile.#fixed.bindingSha256)
    if (row.state !== 'ACTIVE' || fixed.inventory === undefined || row.copySha256 === null || row.copyBytes === null)
      throw new Error('Original native source lineage is incomplete')
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, profile.#manager, transition)
    return Object.freeze({
      inventory: Object.freeze({ ...fixed.inventory }),
      fixedSha256: row.fixedSha256,
      copySha256: row.copySha256,
      copyBytes: row.copyBytes
    })
  }
  /** Fresh immutable forward decision while the original source's physical
   * kernel and manager transition are still owned. Never re-enables writers. */
  static async readNativeRetirementLineage(
    storage: StorageKnex,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition
  ): Promise<
    Readonly<{
      inventory: Readonly<Brc38ProfileInventoryBinding>
      fixedSha256: string
      copySha256: string
      copyBytes: number
      retirement: Readonly<Brc38NativeRetirementRecord>
    }>
  > {
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager, transition)
    const identity = driver().nativeDatabaseIdentity(storage.knex),
      profile = identity === undefined ? undefined : nativeJournalOwners.get(identity.token),
      owner = profile === undefined ? undefined : profile.#nativeOwner
    if (profile === undefined || owner === undefined) throw new Error('Actual retired source owner required')
    await driver().requireSourceRetirementProcessFrozenOwned(owner.session)
    await profile.#physical(transition)
    const row = await readForwardOriginalProfileRow(profile.#db),
      fixed = fixedProfile(row, profile.#fixed.bindingSha256),
      retirement = await readBrc38NativeRetirement(profile.#db)
    if (
      retirement === undefined ||
      fixed.inventory === undefined ||
      row.copySha256 === null ||
      row.copyBytes === null ||
      JSON.stringify(fixed) !== JSON.stringify(profile.#fixed)
    )
      throw new Error('Actual source forward retirement or original receipt differs')
    const claim = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
    if (claim?.profile !== profile || claim.phase !== 'native-owned')
      throw new Error('Actual source retirement inventory claim changed')
    await Brc38ProfileInventoryNode.assertCurrentPublishedProfile(
      claim.root,
      profile,
      fixed.inventory,
      fixed.bindingSha256
    )
    await driver().requireSourceRetirementProcessFrozenOwned(owner.session)
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager, transition)
    return Object.freeze({
      inventory: Object.freeze({ ...fixed.inventory }),
      fixedSha256: row.fixedSha256,
      copySha256: row.copySha256,
      copyBytes: row.copyBytes,
      retirement
    })
  }
  /** Synchronous concrete manager/provider ownership for a prepared short
   * source fence. The exact original activated manager is enrolled by this
   * profile, not supplied by a receipt or inferred from matching identities.
   * This performs no catalog, payload or queue I/O; fresh SQL generation and
   * primary checks belong to the actual source writer that follows it. */
  static assertNativeManagedProvider(
    storage: StorageKnex,
    manager: WalletStorageManager,
    transition?: WalletStorageProviderTransition
  ): void {
    const identity = nativeDriver?.nativeDatabaseIdentity(storage.knex),
      profile = identity === undefined ? undefined : nativeJournalOwners.get(identity.token),
      owner = profile === undefined ? undefined : profile.#nativeOwner
    if (
      profile === undefined ||
      identity === undefined ||
      identity.slot !== 0 ||
      !actualProfiles.has(profile) ||
      profile.#wallet !== storage ||
      profile.#manager !== manager ||
      profile.#closed ||
      profile.#ownerReleased ||
      owner?.phase !== 'wal' ||
      owner.wallet !== storage.knex ||
      owner.token !== identity.token ||
      !nativeJournalMatches?.(profile, identity.token) ||
      !driver().isLiveNativeSession(owner.session)
    )
      throw new Error('Current native source commit requires its original activated manager and WAL provider')
    if (transition === undefined) {
      if (
        !manager.isActiveEnabled ||
        WalletStorageManager.prototype.getActive.call(manager) !== storage ||
        WalletStorageManager.prototype.getActiveUser.call(manager).identityKey !== profile.#fixed.binding.identityKey ||
        WalletStorageManager.prototype.getActiveSettings.call(manager).chain !== profile.#fixed.binding.chain ||
        WalletStorageManager.prototype.getActiveStore.call(manager) !== profile.#fixed.binding.targetStorageIdentityKey
      )
        throw new Error('Current native source commit requires its original enabled manager selection')
    } else {
      const actual = WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
        manager,
        transition,
        storage
      )
      if (
        actual.identityKey !== profile.#fixed.binding.identityKey ||
        actual.chain !== profile.#fixed.binding.chain ||
        actual.storageIdentityKey !== profile.#fixed.binding.targetStorageIdentityKey ||
        actual.primary !== actual.storageIdentityKey
      )
        throw new Error('Native source differs from its original owned manager transition')
    }
  }
  /** Internal final-attempt negotiation on the actual retained source writer.
   * This void reply grants no durable handoff or target selection authority. */
  static async requireNativeRetirementWriter(
    storage: StorageKnex,
    manager: WalletStorageManager,
    writer: Knex.Transaction,
    transition?: WalletStorageProviderTransition
  ): Promise<void> {
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager, transition)
    const identity = driver().nativeDatabaseIdentity(storage.knex),
      transaction = driver().nativeTransactionIdentity(writer)
    if (
      identity === undefined ||
      transaction === undefined ||
      transaction.slot !== 0 ||
      transaction.token !== identity.token ||
      writer.isCompleted()
    )
      throw new Error('Native source retirement requires its actual original root writer')
    const profile = nativeJournalOwners.get(identity.token),
      owner = profile === undefined ? undefined : profile.#nativeOwner
    if (owner === undefined) throw new Error('Native source retirement lost its actual profile owner')
    requireBrc38NativeProfileTransaction(writer)
    await driver().requireRetirementOwned(owner.session)
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager, transition)
    requireBrc38NativeProfileTransaction(writer)
  }
  /** Actual Root0 writer exclusion without a same-value wallet/clock write.
   * This changes no durable source state and grants no retirement decision. */
  static async withNativeImmediateSourceWriter<T>(
    storage: StorageKnex,
    work: (writer: Knex.Transaction) => Promise<T>,
    transition?: WalletStorageProviderTransition
  ): Promise<T> {
    const identity = driver().nativeDatabaseIdentity(storage.knex),
      profile = identity === undefined ? undefined : nativeJournalOwners.get(identity.token)
    if (identity === undefined || identity.slot !== 0 || profile === undefined || profile.#manager === undefined)
      throw new Error('Immediate source writer needs its actual activated profile')
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, profile.#manager, transition)
    const owner = profile.#nativeOwner
    if (owner === undefined || profile.#busy)
      throw new Error('Immediate source writer lacks its idle actual kernel owner')
    profile.#busy = true
    try {
      return await driver().withOwnedNativeImmediateWriter(storage.knex, async writer => {
        const transaction = driver().nativeTransactionIdentity(writer)
        if (transaction?.slot !== 0 || transaction.token !== identity.token || profile.#nativeOwner !== owner)
          throw new Error('Immediate source writer lost its original physical transaction')
        requireBrc38NativeProfileTransaction(writer)
        const value = await work(writer)
        requireBrc38NativeProfileTransaction(writer)
        if (profile.#nativeOwner !== owner || storage.knex !== owner.wallet)
          throw new Error('Immediate source writer changed during its final operation')
        return value
      })
    } finally {
      profile.#busy = false
    }
  }
  /** Irreversible physical process fence only. The controller must arm its
   * manager barrier BEFORE this operation and independently validate the full
   * target before recording any retirement. A failed/ambiguous freeze cannot
   * reopen this kernel for ordinary wallet writes. */
  static async freezeNativeSourceRetirementWriter(
    storage: StorageKnex,
    manager: WalletStorageManager,
    writer: Knex.Transaction,
    transition?: WalletStorageProviderTransition
  ): Promise<void> {
    await Brc38PublishedProfileNode.requireNativeRetirementWriter(storage, manager, writer, transition)
    const identity = driver().nativeDatabaseIdentity(storage.knex),
      profile = identity === undefined ? undefined : nativeJournalOwners.get(identity.token),
      owner = profile === undefined ? undefined : profile.#nativeOwner
    if (profile === undefined || owner === undefined || !profile.#busy || owner.wallet !== storage.knex)
      throw new Error('Source retirement freeze requires its actual retained immediate writer')
    await driver().freezeSourceRetirementOwned(owner.session)
    Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager, transition)
    requireBrc38NativeProfileTransaction(writer)
    await driver().requireSourceRetirementFrozenOwned(owner.session)
  }
  static assertNativeReopenAttempt(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    profile: Brc38PublishedProfileNode,
    validated: boolean
  ): void {
    const owner = profile.#nativeOwner,
      actual = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
    if (
      !actualProfiles.has(profile) ||
      owner === undefined ||
      actual?.root !== root ||
      actual.profile !== profile ||
      actual.reopenGrant !== grant ||
      actual.phase !== 'native-verifying' ||
      owner.claim !== profile.#nativeClaim ||
      owner.phase !== (validated ? 'validated-reopen' : 'starting')
    )
      throw new Error('An actual issued native reopen attempt is required')
  }
  static async openNativeReopen(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    executable: string,
    completedSource?: Brc38NativeLocalBaselineSource
  ): Promise<Brc38PublishedProfileNode> {
    const bound = await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant)
    await privateDirectory(bound.directory)
    await privateFile(join(bound.directory, 'profile.sqlite'), catalogPages * 4096)
    const bootstrap = database(bound.directory, 'profile.sqlite', catalogPages)
    let row: Awaited<ReturnType<typeof readRow>>, fixed: FixedProfile, backend: Brc38NativeBackendRecord
    try {
      row = await readRow(bootstrap)
      fixed = fixedProfile(row, bound.bindingSha256)
      const original = JSON.parse(bound.originalFixedJson) as FixedProfile
      if (
        (completedSource === undefined
          ? fixed.protocol !== 'brc38-published-profile/v2'
          : fixed.protocol !== 'brc38-published-profile/v3') ||
        row.state === 'RECEIVING' ||
        JSON.stringify(fixed.inventory) !== JSON.stringify(bound.inventory) ||
        ['binding', 'bindingSha256', 'limits', 'admission'].some(
          key =>
            JSON.stringify(fixed[key as keyof FixedProfile]) !== JSON.stringify(original[key as keyof FixedProfile])
        )
      )
        throw new Error('Native reopen original inventory receipt differs')
      const recorded = await readBrc38NativeBackend(bootstrap, row, driver().componentBuild)
      if (recorded === undefined) throw new Error('Native reopen requires its durable forward backend record')
      backend = recorded
      if (
        completedSource !== undefined &&
        (row.state !== 'ACTIVE' ||
          backend.phase !== 'WAL' ||
          (await readBrc38ComposedNativeCommit(bootstrap, row, driver().componentBuild, bound.bindingSha256)) ===
            undefined)
      )
        throw new Error('Completed composed reopen refuses pending native activation')
    } finally {
      await bootstrap.destroy()
    }
    // The bootstrap is already physically closed. Read the committed DATA
    // again through the newly owned native catalog below; never reopen stock
    // catalog handles under the native process's actual owner claim.
    const initialOrigin =
      completedSource === undefined
        ? undefined
        : await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(completedSource)
    if (
      initialOrigin !== undefined &&
      JSON.stringify(initialOrigin.source) !== JSON.stringify(fixed.composition!.source)
    )
      throw new Error('Completed composed source lineage differs before native acquisition')
    await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant)
    const attempt =
      completedSource === undefined
        ? await driver().NativeProfileSqlite.startForClaim(
            executable,
            bound.directory,
            row.fixedJson,
            bound.bindingSha256
          )
        : await driver().NativeProfileSqlite.startComposedForClaim(
            executable,
            bound.directory,
            row.fixedJson,
            bound.bindingSha256
          )
    const profile = new Brc38PublishedProfileNode(
      bound.directory,
      bootstrap,
      undefined,
      undefined,
      fixed,
      profileIssuer
    )
    const claim = Object.freeze(Object.create(null)) as Brc38NativeProfileTransferClaim
    const receipt: Brc38NativeProfileTransferReceipt = Object.freeze({
      directory: bound.directory,
      bindingSha256: bound.bindingSha256,
      state: row.state as Exclude<State, 'RECEIVING'>,
      fixedJson: row.fixedJson,
      fixedSha256: row.fixedSha256,
      copySha256: row.copySha256!,
      copyBytes: row.copyBytes!
    })
    const actual: NativeClaim = {
      root,
      profile,
      inventory: bound.inventory,
      receipt,
      reopenGrant: grant,
      phase: 'native-verifying'
    }
    nativeClaims.set(claim, actual)
    profile.#nativeClaim = claim
    const owner: NativeOwner = { session: attempt.session, claim, phase: 'starting' }
    profile.#nativeOwner = owner
    actualProfiles.add(profile)
    profile.#busy = true
    try {
      Brc38ProfileInventoryNode.retainNativeReopenAttempt(root, grant, profile)
      if (Object.prototype.hasOwnProperty.call(attempt, 'failure')) throw attempt.failure
      const kernel = await driver().queryOwned(
        owner.session,
        1,
        'SELECT CASE WHEN length(CAST(binding AS BLOB)) = 64 THEN binding ELSE NULL END AS binding FROM owner WHERE slot=1 LIMIT 2',
        [],
        false
      )
      if (kernel.rows.length !== 1 || kernel.rows[0].binding !== bound.bindingSha256)
        throw new Error('Native reopen actual kernel binding differs')
      const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
      owner.catalog = driver().nativeKnex(createKnex, client, owner.session, 2)
      owner.wallet = driver().nativeKnex(createKnex, client, owner.session, 0)
      const fresh = await readRow(owner.catalog)
      if (
        JSON.stringify(fresh) !== JSON.stringify(row) ||
        JSON.stringify(await readBrc38NativeBackend(owner.catalog, fresh, driver().componentBuild)) !==
          JSON.stringify(backend)
      )
        throw new Error('Native reopen durable receipts changed after actual acquisition')
      if (owner.session.identity === undefined) throw new Error('Actual native producer identity is absent')
      owner.token = owner.session.identity
      profile.#db = owner.catalog
      owner.phase = 'validating'
      nativeJournalOwners.set(owner.token, profile)
      const completedPolicy =
          completedSource === undefined ? undefined : Brc38NativeLocalBaselineSource.readPolicy(completedSource),
        imagePolicy =
          completedPolicy === undefined
            ? undefined
            : Object.freeze({
                maximumPhysicalBytes: fixed.limits.maximumPhysicalBytes,
                maximumReadBytes: Math.min(completedPolicy.maximumReadBytes, fixed.composition!.maximumReadBytes),
                expiresAt: completedPolicy.expiresAt,
                workingAllocation: completedPolicy.workingAllocation,
                signal: completedPolicy.signal
              }),
        verifyOriginal = async (): Promise<void> => {
          if (completedSource === undefined) return
          const origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(completedSource),
            committed = await readBrc38ComposedNativeCommit(
              owner.catalog!,
              await profile.#readCatalogRow(),
              driver().componentBuild,
              bound.bindingSha256
            )
          if (
            committed === undefined ||
            JSON.stringify(origin.source) !== JSON.stringify(fixed.composition!.source) ||
            JSON.stringify(origin.retirement) !== JSON.stringify(committed.retirement) ||
            JSON.stringify(origin) !== JSON.stringify(initialOrigin)
          )
            throw new Error('Completed composed reopen differs from its freshly owned retired source')
        }
      await verifyOriginal()
      await profile.#verifyWallet(
        imagePolicy,
        completedSource === undefined ? undefined : () => Brc38NativeLocalBaselineSource.assertOwned(completedSource)
      )
      await verifyOriginal()
      owner.phase = 'validated-reopen'
      await Brc38ProfileInventoryNode.commitNativeReopen(root, grant, profile)
      owner.phase = reopenedOwnerPhase(backend.phase)
      actual.phase = 'native-owned'
      const verified =
        completedSource === undefined
          ? await profile.#nativeTransferReceipt(root)
          : await profile.#completedComposedNativeReceipt(root)
      if (JSON.stringify(verified) !== JSON.stringify(receipt))
        throw new Error('Native reopen original receipt changed')
      await verifyOriginal()
      return profile
    } catch (cause) {
      actual.phase = 'native-draining'
      try {
        await profile.#closeOwnedConnections()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Native reopen retains physical cleanup',
          async () => await profile.close()
        )
      }
      throw cause
    } finally {
      profile.#busy = false
    }
  }
  async #completedComposedNativeReceipt(root: Brc38ProfileInventoryNode): Promise<Brc38NativeProfileTransferReceipt> {
    const actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim),
      row = await this.#readCatalogRow(),
      fixed = fixedProfile(row, this.#fixed.bindingSha256)
    if (
      actual?.profile !== this ||
      actual.root !== root ||
      actual.phase !== 'native-owned' ||
      actual.reopenGrant === undefined ||
      fixed.protocol !== 'brc38-published-profile/v3' ||
      fixed.inventory === undefined ||
      row.state !== 'ACTIVE' ||
      (await readBrc38ComposedNativeCommit(this.#db, row, driver().componentBuild, fixed.bindingSha256)) === undefined
    )
      throw new Error('Completed composed receipt requires its actual current native reopen')
    await Brc38ProfileInventoryNode.assertNativeTransferInventory(root, this, fixed.inventory, fixed.bindingSha256)
    return Object.freeze({
      directory: this.directory,
      bindingSha256: fixed.bindingSha256,
      state: row.state,
      fixedJson: row.fixedJson,
      fixedSha256: row.fixedSha256,
      copySha256: row.copySha256!,
      copyBytes: row.copyBytes!
    })
  }
  async #requirePendingComposedRecovery(): Promise<void> {
    const pending = this.#pendingComposedRecovery,
      owner = this.#nativeOwner,
      actual = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (
      pending === undefined ||
      !this.#busy ||
      owner === undefined ||
      actual?.profile !== this ||
      actual.root !== pending.root ||
      actual.reopenGrant !== pending.grant ||
      !['native-verifying', 'native-owned'].includes(actual.phase)
    )
      throw new Error('Pending composed recovery lacks its actual native reconstruction scope')
    pending.check()
    if (pending.incoming !== undefined) {
      Brc39RecoveryIncomingComparisonNode.prototype.assertRetained.call(pending.incoming)
      if (pending.incoming.candidate !== pending.store || pending.policy.expiresAt !== pending.store.operationExpiresAt)
        throw new Error('Expired pending activation lost its actual fresh incoming comparison')
    } else if (pending.store.recoveryComparisonOnly)
      throw new Error('Expired candidate requires fresh full incoming comparison')
    Brc38PrivateNativeMergeNode.assertRetiredRecoveryImageScope(
      pending.merge,
      pending.store,
      pending.source,
      pending.receipt
    )
    await Brc38ProfileInventoryNode.readNativeReopenGrant(pending.root, pending.grant)
    const origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(pending.source),
      row = await this.#readCatalogRow(),
      fixed = fixedProfile(row, this.#fixed.bindingSha256),
      target = origin.retirement.target,
      fence = pending.source.fence
    if (
      fixed.protocol !== 'brc38-published-profile/v3' ||
      fixed.inventory === undefined ||
      fixed.composition === undefined ||
      JSON.stringify(fixed.composition) !== JSON.stringify(pending.receipt) ||
      JSON.stringify(origin.source) !== JSON.stringify(pending.receipt.source) ||
      origin.retirement.decisionId !== pending.receipt.decisionId ||
      target.rootId !== fixed.inventory.rootId ||
      target.profileId !== fixed.inventory.profileId ||
      target.fixedSha256 !== row.fixedSha256 ||
      target.copySha256 !== row.copySha256 ||
      target.copyBytes !== row.copyBytes ||
      pending.store.binding?.digest !== fixed.bindingSha256 ||
      JSON.stringify(pending.store.limits) !== JSON.stringify(fixed.limits) ||
      fence.identityKey !== fixed.binding.identityKey ||
      fence.chain !== fixed.binding.chain ||
      fence.targetStorageIdentityKey !== fixed.binding.targetStorageIdentityKey ||
      fence.userId !== pending.receipt.source.userId ||
      fence.activeStorage !== pending.receipt.source.activeStorage
    )
      throw new Error(
        'Pending native target differs from the actual retired source, authenticated stage or original decision'
      )
    await pending.store.requirePrivateNativeComparison()
    if (pending.replacement !== undefined)
      await Brc38PublishedProfileNode.#assertPendingOriginalManager(pending.replacement, pending.source)
    pending.check()
    if (this.#pendingComposedRecovery !== pending || this.#nativeOwner !== owner)
      throw new Error('Pending native reconstruction operation changed')
  }
  /** Fresh actual catalog classification before closing a frozen source. A
   * committed retirement is never converted back into an active wallet. */
  static async closeUncommittedNativeOriginal(
    profile: Brc38PublishedProfileNode,
    provider: StorageKnex,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition,
    root: Brc38ProfileInventoryNode
  ): Promise<Readonly<{ importId: string; bindingSha256: string; composed: boolean }>> {
    if (
      !actualProfiles.has(profile) ||
      profile.#wallet !== provider ||
      profile.#manager !== manager ||
      manager.isActiveEnabled ||
      profile.#busy
    )
      throw new Error('Uncommitted recovery requires its actual idle blocked original manager/profile')
    WalletStorageManager.prototype.requireOriginalProviderInTransition.call(manager, transition, provider)
    const fixed = profile.#fixed
    if (fixed.inventory === undefined) throw new Error('Uncommitted source lacks its original inventory')
    if (profile.#ownerReleased)
      await Brc38ProfileInventoryNode.assertReleasedProfileAddress(root, fixed.inventory, fixed.bindingSha256)
    else
      await Brc38ProfileInventoryNode.assertCurrentPublishedProfile(root, profile, fixed.inventory, fixed.bindingSha256)
    if (!profile.#ownerReleased) {
      const pending = profile.#uncommittedCurrentCleanup
      if (pending === undefined) {
        const owner = profile.#nativeOwner
        if (owner === undefined) throw new Error('Uncommitted recovery lost the actual original native owner')
        Brc38PublishedProfileNode.assertNativeManagedProvider(provider, manager, transition)
        await driver().requireSourceRetirementProcessFrozenOwned(owner.session)
        const row = await profile.#readCatalogRow(),
          backend = await readBrc38NativeBackend(profile.#db, row, driver().componentBuild)
        if (
          row.state !== 'ACTIVE' ||
          backend?.phase !== 'WAL' ||
          (await readBrc38NativeRetirement(profile.#db)) !== undefined ||
          JSON.stringify(fixedProfile(row, fixed.bindingSha256)) !== JSON.stringify(fixed)
        )
          throw new Error('Committed source retirement cannot enter uncommitted current recovery')
        await driver().requireSourceRetirementProcessFrozenOwned(owner.session)
        profile.#uncommittedCurrentCleanup = Object.freeze({ provider, manager, root })
      } else if (pending.provider !== provider || pending.manager !== manager || pending.root !== root)
        throw new Error('Uncommitted cleanup changed its actual physical owners')
      await profile.close()
    }
    if (!profile.#closed || !profile.#ownerReleased || profile.#nativeOwner !== undefined)
      throw new Error('Uncommitted original retains physical cleanup')
    WalletStorageManager.prototype.requireOriginalProviderInTransition.call(manager, transition, provider)
    profile.#uncommittedCurrentCleanup = undefined
    return Object.freeze({
      importId: fixed.admission.scope.importId,
      bindingSha256: fixed.bindingSha256,
      composed: fixed.protocol === 'brc38-published-profile/v3'
    })
  }
  async #requireUncommittedCurrentRecovery(): Promise<void> {
    const current = this.#uncommittedCurrentRecovery,
      owner = this.#nativeOwner,
      claim = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (
      current === undefined ||
      !this.#busy ||
      owner === undefined ||
      claim?.profile !== this ||
      claim.root !== current.root ||
      claim.reopenGrant === undefined ||
      claim.phase !== 'native-owned' ||
      !actualProfiles.has(current.original.original) ||
      !current.original.original.#closed ||
      !current.original.original.#ownerReleased ||
      current.original.original.#nativeOwner !== undefined ||
      current.original.original.#wallet !== current.original.provider ||
      current.original.original.#manager !== current.original.manager ||
      this.#manager !== current.original.manager ||
      current.original.manager.isActiveEnabled ||
      JSON.stringify(this.#fixed) !== JSON.stringify(current.original.original.#fixed)
    )
      throw new Error('Uncommitted current provider lacks its actual original released owner and fresh native reopen')
    current.check()
    const managed = WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
        current.original.manager,
        current.original.transition,
        current.original.provider
      ),
      row = await this.#readCatalogRow(),
      backend = await readBrc38NativeBackend(this.#db, row, driver().componentBuild)
    if (
      row.state !== 'ACTIVE' ||
      backend?.phase !== 'WAL' ||
      (await readBrc38NativeRetirement(this.#db)) !== undefined ||
      JSON.stringify(fixedProfile(row, this.#fixed.bindingSha256)) !== JSON.stringify(this.#fixed) ||
      managed.identityKey !== this.#fixed.binding.identityKey ||
      managed.chain !== this.#fixed.binding.chain ||
      managed.storageIdentityKey !== this.#fixed.binding.targetStorageIdentityKey ||
      managed.primary !== managed.storageIdentityKey
    )
      throw new Error('Uncommitted current reopen changed its original source or has committed retirement')
    await Brc38ProfileInventoryNode.assertCurrentPublishedProfile(
      current.root,
      this,
      claim.inventory,
      this.#fixed.bindingSha256
    )
    current.check()
    WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
      current.original.manager,
      current.original.transition,
      current.original.provider
    )
  }
  /** Install the SAME current wallet after a no-decision interruption. This
   * factory requires an actual new inventory/native reopen, unchanged original
   * profile binding and fresh absence of retirement; it imports no payload. */
  async installUncommittedCurrentRecovery(
    root: Brc38ProfileInventoryNode,
    selected: Brc38PendingNativeManagerRecovery,
    selectedPolicy: import('./Brc38RetiredNativeReadNode').Brc38RetiredNativeReadPolicy,
    services: WalletServices
  ): Promise<StorageKnex> {
    if (!actualProfiles.has(this) || this.#busy || this.#wallet !== undefined || this.#manager !== undefined)
      throw new Error('Uncommitted installation needs its actual idle newly reopened current profile')
    const policy = Brc38RetiredNativeReadNode.capturePolicy(selectedPolicy),
      deadline = performance.now() + policy.expiresAt - Date.now(),
      original = Object.freeze({
        original: selected.original,
        provider: selected.provider,
        manager: selected.manager,
        transition: selected.transition
      }),
      check = (): void => {
        policy.signal?.throwIfAborted()
        if (Date.now() >= policy.expiresAt || performance.now() >= deadline)
          throw new Error('Uncommitted current recovery read lifetime expired')
      },
      scope = Object.freeze({}) as Brc38PreparedNativeTarget,
      owner = this.#nativeOwner,
      claim = this.#nativeClaim === undefined ? undefined : nativeClaims.get(this.#nativeClaim)
    if (
      owner?.wallet === undefined ||
      claim?.profile !== this ||
      claim.root !== root ||
      claim.reopenGrant === undefined ||
      claim.phase !== 'native-owned' ||
      !['wal-pending', 'wal'].includes(owner.phase)
    )
      throw new Error('Uncommitted installation requires its actual completed current WAL reopen')
    this.#busy = true
    this.#manager = original.manager
    this.#uncommittedCurrentRecovery = Object.freeze({ scope, root, original, policy, check })
    try {
      await this.#requireUncommittedCurrentRecovery()
      await driver().admitDeleteOwned(owner.session)
      await driver().promoteWalOwned(owner.session)
      owner.phase = 'wal'
      const wallet = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions(this.#fixed.binding.chain),
        knex: owner.wallet,
        snapshotSync: false
      })
      wallet.setServices(services)
      this.#wallet = wallet
      const inspect = async (): Promise<void> => {
        await this.#requireUncommittedCurrentRecovery()
        await this.#verifyWallet({ ...policy, maximumPhysicalBytes: this.#fixed.limits.maximumPhysicalBytes }, check)
        await this.#withNativeReadInspection(
          async read =>
            await readBrc38ComposedDatabaseImage(
              read,
              { ...policy, maximumPhysicalBytes: this.#fixed.limits.maximumPhysicalBytes },
              check
            )
        )
        await this.#requireUncommittedCurrentRecovery()
      }
      await inspect()
      await wallet.enableOwnedNativeSnapshotSync(this, scope)
      await WalletStorageManager.prototype.replaceProviderInTransition.call(
        original.manager,
        original.transition,
        wallet,
        inspect
      )
      return wallet
    } catch (cause) {
      try {
        await this.#closeOwnedConnections()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Uncommitted current provider retains actual cleanup',
          async () => await this.close()
        )
      }
      throw cause
    } finally {
      this.#uncommittedCurrentRecovery = undefined
      this.#busy = false
    }
  }
  static async #assertPendingOriginalManager(
    original: Readonly<Brc38PendingNativeManagerRecovery>,
    source: Brc38NativeLocalBaselineSource
  ): Promise<void> {
    const profile = original.original
    if (
      !actualProfiles.has(profile) ||
      !profile.#closed ||
      !profile.#ownerReleased ||
      profile.#nativeOwner !== undefined ||
      profile.#wallet !== original.provider ||
      profile.#manager !== original.manager ||
      original.manager.isActiveEnabled
    )
      throw new Error('Pending manager recovery requires its actual released original profile and blocked manager')
    const managed = WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
        original.manager,
        original.transition,
        original.provider
      ),
      origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
    if (
      JSON.stringify(profile.#fixed.inventory) !== JSON.stringify(origin.source.inventory) ||
      hash(JSON.stringify(profile.#fixed)) !== origin.source.fixedSha256 ||
      managed.identityKey !== source.fence.identityKey ||
      managed.chain !== source.fence.chain ||
      managed.storageIdentityKey !== source.fence.targetStorageIdentityKey ||
      managed.userId !== source.fence.userId ||
      managed.primary !== source.fence.activeStorage
    )
      throw new Error('Pending manager recovery differs from its actual original retired source')
    WalletStorageManager.prototype.requireOriginalProviderInTransition.call(
      original.manager,
      original.transition,
      original.provider
    )
  }
  /** Genuine completed-target restart with independently reopened retired
   * source. The original import deadline remains unchanged; a fresh bounded
   * read lifetime inspects the current, already completed wallet only. */
  static async openCompletedNativeFromInventory(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    executable: string,
    sourceRoot: Brc38ProfileInventoryNode,
    selectedReceiptPolicy: import('../snapshot/journal/SnapshotJournalReceipt').SnapshotJournalReceiptPolicy,
    selectedPolicy: import('./Brc38RetiredNativeReadNode').Brc38RetiredNativeReadPolicy
  ): Promise<Brc38PublishedProfileNode> {
    const policy = Brc38RetiredNativeReadNode.capturePolicy(selectedPolicy),
      receiptPolicy = snapshotJournalReceiptPolicy(selectedReceiptPolicy),
      bound = await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant)
    const deadline = performance.now() + policy.expiresAt - Date.now(),
      check = (): void => {
        policy.signal?.throwIfAborted()
        if (Date.now() >= policy.expiresAt || performance.now() >= deadline)
          throw new Error('Current completed restart read lifetime expired')
      }
    check()
    await privateDirectory(bound.directory)
    await privateFile(join(bound.directory, 'profile.sqlite'), catalogPages * 4096)
    const bootstrap = database(bound.directory, 'profile.sqlite', catalogPages, true)
    let fixed: FixedProfile
    try {
      const row = await readRow(bootstrap)
      fixed = fixedProfile(row, bound.bindingSha256)
      const original = JSON.parse(bound.originalFixedJson) as FixedProfile
      if (
        fixed.protocol !== 'brc38-published-profile/v3' ||
        fixed.composition === undefined ||
        !['READY', 'ACTIVATING', 'ACTIVE'].includes(row.state) ||
        JSON.stringify(fixed.inventory) !== JSON.stringify(bound.inventory) ||
        ['binding', 'bindingSha256', 'limits', 'admission'].some(
          key =>
            JSON.stringify(fixed[key as keyof FixedProfile]) !== JSON.stringify(original[key as keyof FixedProfile])
        ) ||
        policy.maximumReadBytes !== fixed.composition.maximumReadBytes
      )
        throw new Error('Current completed restart has a changed original target or read bound')
      // A malformed backend/commit remains an error. Only an absent complete
      // commit in the exact original target selects independent pending recovery.
      await readBrc38NativeBackend(bootstrap, row, driver().componentBuild)
      const completed = await readBrc38ComposedNativeCommit(
        bootstrap,
        row,
        driver().componentBuild,
        bound.bindingSha256
      )
      check()
      await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant)
      if (completed === undefined)
        throw new Brc38PendingComposedNativeTargetError(fixed.admission.scope.importId, bound.bindingSha256)
      if (row.state !== 'ACTIVE') throw new Error('Current completed restart refuses pending target')
    } finally {
      await bootstrap.destroy()
    }
    let profile: Brc38PublishedProfileNode | undefined
    try {
      check()
      return await Brc38ProfileInventoryNode.withRetiredNativeInventoryRead(
        sourceRoot,
        fixed.composition!.source.inventory,
        executable,
        policy,
        async reader =>
          await Brc38NativeLocalBaselineSource.withRetired(
            reader,
            receiptPolicy,
            { ...policy, maximumMetadataBytes: 131072 },
            async source => {
              const origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
              if (
                JSON.stringify(origin.source) !== JSON.stringify(fixed.composition!.source) ||
                origin.retirement.decisionId !== fixed.composition!.decisionId
              )
                throw new Error('Current completed restart resolved a different retired source')
              check()
              profile = await Brc38PublishedProfileNode.openNativeReopen(root, grant, executable, source)
              return profile
            }
          )
      )
    } catch (cause) {
      if (profile !== undefined) {
        try {
          await profile.close()
        } catch (error_) {
          throw new Brc38StagingCleanupError(
            [cause, error_],
            'Completed restart retains its current native target cleanup',
            async () => await profile!.close()
          )
        }
      }
      throw cause
    }
  }
  /** Close only an actually frozen, durably retired original behind its owned
   * manager barrier. A failed pre-decision freeze cannot use this operation. */
  static async closeRetiredNativeManagedOriginal(
    profile: Brc38PublishedProfileNode,
    provider: StorageKnex,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition,
    root: Brc38ProfileInventoryNode
  ): Promise<void> {
    if (
      !actualProfiles.has(profile) ||
      profile.#wallet !== provider ||
      profile.#manager !== manager ||
      manager.isActiveEnabled
    )
      throw new Error('Retired cleanup requires its actual blocked original manager and profile')
    WalletStorageManager.prototype.requireOriginalProviderInTransition.call(manager, transition, provider)
    if (!profile.#closed || !profile.#ownerReleased) {
      const pending = profile.#retiredManagedCleanup
      if (pending === undefined) {
        const lineage = await Brc38PublishedProfileNode.readNativeRetirementLineage(provider, manager, transition)
        const claim = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
        if (claim?.root !== root || JSON.stringify(lineage.inventory) !== JSON.stringify(profile.#fixed.inventory))
          throw new Error('Retired cleanup belongs to another actual source inventory')
        // Concrete physical drainage only. Retaining this owner permits a
        // failed close to retry after SQL facades are already partly closed;
        // it supplies no target admission or retirement decision.
        profile.#retiredManagedCleanup = Object.freeze({ provider, manager, root })
      } else if (pending.provider !== provider || pending.manager !== manager || pending.root !== root)
        throw new Error('Retired original cleanup changed its actual physical owners')
      await profile.close()
    }
    if (!profile.#closed || !profile.#ownerReleased || profile.#nativeOwner !== undefined)
      throw new Error('Retired original still retains physical cleanup')
    WalletStorageManager.prototype.requireOriginalProviderInTransition.call(manager, transition, provider)
    profile.#retiredManagedCleanup = undefined
  }

  /** A genuine pending target can supply a NEW finite scratch copy even after
   * its old private reservation expires. Actual inventory/kernel/retired-source
   * membership and complete typed image inspection precede copying. No writer,
   * provider or manager is admitted; complete archive authentication and local
   * semantic reconstruction remain separate, required recovery operations. */
  static async withPendingComposedRecoveryCopy<T>(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    executable: string,
    source: Brc38NativeLocalBaselineSource,
    selected: Brc38NativeRecoveryScratchPolicy,
    work: (scratch: Brc38NativeRecoveryScratchNode) => Promise<T>,
    maximumMonotonicDeadline?: number
  ): Promise<T> {
    return await this.#withPendingRecoveryCopy(
      root,
      grant,
      executable,
      source,
      selected,
      work,
      maximumMonotonicDeadline,
      false
    )
  }
  /** New pending controller only: copy and physically close the actual target
   * before consumer reconstruction/reacquisition. The root operation remains
   * held; no copy/hash/statistics are accepted as activation authority. */
  static async withReleasedPendingComposedRecoveryCopy<T>(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    executable: string,
    source: Brc38NativeLocalBaselineSource,
    selected: Brc38NativeRecoveryScratchPolicy,
    work: (scratch: Brc38NativeRecoveryScratchNode) => Promise<T>,
    maximumMonotonicDeadline?: number
  ): Promise<T> {
    return await this.#withPendingRecoveryCopy(
      root,
      grant,
      executable,
      source,
      selected,
      work,
      maximumMonotonicDeadline,
      true
    )
  }
  /** Concrete target cleanup for a newly constructed recovery manager that
   * the enclosing controller could not return. Never selects an old source or
   * removes the durable forward commit; exact physical close is retryable. */
  static async closeNamedRecoveryManager(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    manager: WalletStorageManager
  ): Promise<void> {
    const actual = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
    if (
      !actualProfiles.has(profile) ||
      actual?.root !== root ||
      actual.profile !== profile ||
      profile.#manager !== manager ||
      profile.#wallet === undefined ||
      profile.#fixed.protocol !== 'brc38-published-profile/v3' ||
      !['native-owned', 'released'].includes(actual.phase) ||
      profile.#busy
    )
      throw new Error('Recovery manager cleanup requires its exact actual target owner')
    await profile.close()
  }
  static assertReleasedPendingRecoveryCopy(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    profile: Brc38PublishedProfileNode
  ): void {
    const actual = profile.#nativeClaim === undefined ? undefined : nativeClaims.get(profile.#nativeClaim)
    if (
      !actualProfiles.has(profile) ||
      profile.#releasedPendingCopyGrant !== grant ||
      actual?.root !== root ||
      actual.reopenGrant !== grant ||
      actual.profile !== profile ||
      actual.phase !== 'released' ||
      !profile.#closed ||
      !profile.#ownerReleased ||
      profile.#busy ||
      profile.#nativeOwner !== undefined ||
      profile.#nativeReadInspection !== undefined ||
      profile.#copyInspection !== undefined ||
      profile.#manager !== undefined ||
      profile.#wallet !== undefined
    )
      throw new Error('Pending recovery reissue requires its actual physically closed copy owner')
  }
  static async #withPendingRecoveryCopy<T>(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    executable: string,
    source: Brc38NativeLocalBaselineSource,
    selected: Brc38NativeRecoveryScratchPolicy,
    work: (scratch: Brc38NativeRecoveryScratchNode) => Promise<T>,
    maximumMonotonicDeadline: number | undefined,
    releaseBeforeConsumer: boolean
  ): Promise<T> {
    const policy = Object.freeze({ ...selected }),
      consumer = work,
      ownDeadline = performance.now() + Math.max(0, policy.expiresAt - Date.now()),
      deadline = maximumMonotonicDeadline === undefined ? ownDeadline : Math.min(ownDeadline, maximumMonotonicDeadline)
    if (
      !Number.isSafeInteger(policy.expiresAt) ||
      policy.expiresAt <= Date.now() ||
      policy.expiresAt > Date.now() + 3600000 ||
      !Number.isFinite(deadline) ||
      typeof consumer !== 'function'
    )
      throw new Error('Pending recovery copy requires a new bounded read lifetime')
    const check = (): void => {
      policy.signal?.throwIfAborted()
      if (Date.now() >= policy.expiresAt || performance.now() >= deadline)
        throw new Error('Pending recovery copy read lifetime expired')
    }
    check()
    Brc38NativeLocalBaselineSource.assertSharedWorking(source, policy.workingAllocation)
    const bound = await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant),
      origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
    await privateDirectory(bound.directory)
    await privateFile(join(bound.directory, 'profile.sqlite'), catalogPages * 4096)
    const bootstrap = database(bound.directory, 'profile.sqlite', catalogPages)
    let row: Row, fixed: FixedProfile, backend: Brc38NativeBackendRecord | undefined
    try {
      row = await readRow(bootstrap)
      fixed = fixedProfile(row, bound.bindingSha256)
      const original = JSON.parse(bound.originalFixedJson) as FixedProfile,
        target = origin.retirement.target
      if (
        fixed.protocol !== 'brc38-published-profile/v3' ||
        fixed.composition === undefined ||
        fixed.inventory === undefined ||
        row.state === 'RECEIVING' ||
        JSON.stringify(fixed.inventory) !== JSON.stringify(bound.inventory) ||
        JSON.stringify(origin.source) !== JSON.stringify(fixed.composition.source) ||
        origin.retirement.decisionId !== fixed.composition.decisionId ||
        target.rootId !== fixed.inventory.rootId ||
        target.profileId !== fixed.inventory.profileId ||
        target.fixedSha256 !== row.fixedSha256 ||
        target.copySha256 !== row.copySha256 ||
        target.copyBytes !== row.copyBytes ||
        ['binding', 'bindingSha256', 'limits', 'admission'].some(
          key =>
            JSON.stringify(fixed[key as keyof FixedProfile]) !== JSON.stringify(original[key as keyof FixedProfile])
        ) ||
        policy.maximumPhysicalBytes > fixed.limits.maximumPhysicalBytes ||
        policy.workingAllocation.maximum > fixed.limits.maximumRowAllocationBytes
      )
        throw new Error('Pending recovery copy differs from its original target and actual retired source')
      backend = await readBrc38NativeBackend(bootstrap, row, driver().componentBuild)
      if (
        (backend === undefined && row.state !== 'READY') ||
        (await readBrc38ComposedNativeCommit(bootstrap, row, driver().componentBuild, bound.bindingSha256)) !==
          undefined
      )
        throw new Error('Completed current profile cannot supply pending recovery scratch')
    } finally {
      await bootstrap.destroy()
    }
    check()
    const attempt = await driver().NativeProfileSqlite.startComposedForClaim(
        executable,
        bound.directory,
        row.fixedJson,
        bound.bindingSha256
      ),
      profile = new Brc38PublishedProfileNode(bound.directory, bootstrap, undefined, undefined, fixed, profileIssuer),
      claim = Object.freeze({}) as Brc38NativeProfileTransferClaim,
      actual: NativeClaim = {
        root,
        profile,
        inventory: bound.inventory,
        reopenGrant: grant,
        phase: 'native-verifying',
        receipt: Object.freeze({
          directory: bound.directory,
          bindingSha256: bound.bindingSha256,
          state: row.state as Exclude<State, 'RECEIVING'>,
          fixedJson: row.fixedJson,
          fixedSha256: row.fixedSha256,
          copySha256: row.copySha256!,
          copyBytes: row.copyBytes!
        })
      },
      owner: NativeOwner = { session: attempt.session, claim, phase: 'starting' }
    actualProfiles.add(profile)
    nativeClaims.set(claim, actual)
    profile.#nativeClaim = claim
    profile.#nativeOwner = owner
    profile.#busy = true
    let failed = false,
      cause: unknown,
      value!: T
    try {
      Brc38ProfileInventoryNode.retainNativeReopenAttempt(root, grant, profile)
      if (Object.hasOwn(attempt, 'failure')) throw attempt.failure
      const kernel = await driver().queryOwned(
        owner.session,
        1,
        'SELECT CASE WHEN length(CAST(binding AS BLOB))=64 THEN binding ELSE NULL END AS binding FROM owner WHERE slot=1 LIMIT 2',
        [],
        false
      )
      if (
        kernel.rows.length !== 1 ||
        kernel.rows[0].binding !== bound.bindingSha256 ||
        owner.session.identity === undefined
      )
        throw new Error('Pending recovery copy lost its actual target native owner')
      const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
      owner.catalog = driver().nativeKnex(createKnex, client, owner.session, 2)
      owner.wallet = driver().nativeKnex(createKnex, client, owner.session, 0)
      owner.token = owner.session.identity
      owner.phase = 'validating'
      profile.#db = owner.catalog
      nativeJournalOwners.set(owner.token, profile)
      const fresh = async (): Promise<void> => {
        check()
        await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant)
        if (
          profile.#nativeOwner !== owner ||
          profile.#nativeClaim !== claim ||
          actual.phase !== 'native-verifying' ||
          JSON.stringify(await profile.#readCatalogRow()) !== JSON.stringify(row) ||
          JSON.stringify(await readBrc38NativeBackend(owner.catalog!, row, driver().componentBuild)) !==
            JSON.stringify(backend) ||
          JSON.stringify(await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)) !==
            JSON.stringify(origin) ||
          (await readBrc38ComposedNativeCommit(owner.catalog!, row, driver().componentBuild, bound.bindingSha256)) !==
            undefined
        )
          throw new Error('Pending recovery copy changed its actual target/source or catalog')
        await profile.#physical()
        check()
      }
      await fresh()
      const imagePolicy = Object.freeze({
        maximumPhysicalBytes: fixed.limits.maximumPhysicalBytes,
        maximumReadBytes: fixed.composition!.maximumReadBytes,
        expiresAt: policy.expiresAt,
        workingAllocation: policy.workingAllocation,
        signal: policy.signal
      })
      const inspect = async (): Promise<void> => {
        await profile.#withNativeReadInspection(async read => {
          const image = await readBrc38ComposedDatabaseImage(read, imagePolicy, () => {
            check()
            requireBrc38NativeProfileReadTransaction(read)
          })
          if (JSON.stringify(image) !== JSON.stringify(fixed.composition!.image))
            throw new Error('Pending recovery permanent target typed image differs')
        })
      }
      await inspect()
      value = await Brc38NativeRecoveryScratchNode.withCopiedDatabase(
        owner.wallet,
        policy,
        async scratch => {
          if (releaseBeforeConsumer) {
            await inspect()
            await fresh()
            profile.#releasedPendingCopyGrant = grant
            profile.#busy = false
            await profile.close()
            await Brc38ProfileInventoryNode.reissueReleasedPendingCopyGrant(root, grant, profile)
            check()
          }
          return await consumer(scratch)
        },
        deadline
      )
      if (!releaseBeforeConsumer) {
        await inspect()
        await fresh()
      }
    } catch (error_) {
      failed = true
      cause = error_
    }
    profile.#busy = false
    try {
      await profile.close()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [...(failed ? [cause] : []), error_],
        'Pending recovery copy retains its actual target cleanup',
        async () => await profile.close()
      )
    }
    if (failed) throw cause
    check()
    return value
  }

  /** Process-restart target recovery: full independently authenticated candidate
   * and genuinely retired coherent source remain held across the NEW native
   * target owner. Interrupted backend phases are finished before a new manager
   * is constructed. Completed current targets cannot enter this path. */
  static async recoverPendingComposedNative(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    executable: string,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    services: WalletServices,
    selectedReplacement?: Brc38PendingNativeManagerRecovery,
    incoming?: Brc39RecoveryIncomingComparisonNode
  ): Promise<WalletStorageManager> {
    if (incoming !== undefined) {
      Brc39RecoveryIncomingComparisonNode.prototype.assertRetained.call(incoming)
      if (incoming.candidate !== store || !store.recoveryComparisonOnly)
        throw new Error('Expired pending recovery requires its actual compared candidate')
    } else if (store.recoveryComparisonOnly)
      throw new Error('Expired candidate requires a fresh complete incoming comparison')
    const replacement =
      selectedReplacement === undefined
        ? undefined
        : Object.freeze({
            original: selectedReplacement.original,
            provider: selectedReplacement.provider,
            manager: selectedReplacement.manager,
            transition: selectedReplacement.transition
          })
    if (replacement !== undefined) await Brc38PublishedProfileNode.#assertPendingOriginalManager(replacement, source)
    const bound = await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant),
      initialOrigin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
    store.assertPrivateNativeDestination(store.knex)
    await privateDirectory(bound.directory)
    await privateFile(join(bound.directory, 'profile.sqlite'), catalogPages * 4096)
    const bootstrap = database(bound.directory, 'profile.sqlite', catalogPages)
    let row: Row, fixed: FixedProfile, backend: Brc38NativeBackendRecord | undefined
    try {
      row = await readRow(bootstrap)
      fixed = fixedProfile(row, bound.bindingSha256)
      const original = JSON.parse(bound.originalFixedJson) as FixedProfile
      if (
        fixed.protocol !== 'brc38-published-profile/v3' ||
        fixed.composition === undefined ||
        row.state === 'RECEIVING' ||
        JSON.stringify(fixed.inventory) !== JSON.stringify(bound.inventory) ||
        JSON.stringify(initialOrigin.source) !== JSON.stringify(fixed.composition.source) ||
        ['binding', 'bindingSha256', 'limits', 'admission'].some(
          key =>
            JSON.stringify(fixed[key as keyof FixedProfile]) !== JSON.stringify(original[key as keyof FixedProfile])
        )
      )
        throw new Error('Pending composed original inventory or retired source receipt differs')
      backend = await readBrc38NativeBackend(bootstrap, row, driver().componentBuild)
      if (
        (backend === undefined && row.state !== 'READY') ||
        (replacement === undefined &&
          (await readBrc38ComposedNativeCommit(bootstrap, row, driver().componentBuild, bound.bindingSha256)) !==
            undefined)
      )
        throw new Error('Completed current native profile cannot enter pending composition recovery')
    } finally {
      await bootstrap.destroy()
    }
    return await Brc38PrivateNativeMergeNode.inspectRetiredRecoveryImage(
      merge,
      fixed.composition!,
      async (image, receipt, policy, retained) => {
        if (
          JSON.stringify(image) !== JSON.stringify(receipt.image) ||
          JSON.stringify(receipt) !== JSON.stringify(fixed.composition) ||
          policy.maximumPhysicalBytes !== fixed.limits.maximumPhysicalBytes ||
          policy.expiresAt !== (incoming === undefined ? fixed.limits.expiresAt : store.operationExpiresAt) ||
          policy.maximumReadBytes !== receipt.maximumReadBytes
        )
          throw new Error('Pending native reconstruction differs from original shared resources or copied image')
        Brc38NativeLocalBaselineSource.assertSharedWorking(source, policy.workingAllocation)
        retained()
        const attempt = await driver().NativeProfileSqlite.startComposedForClaim(
            executable,
            bound.directory,
            row.fixedJson,
            bound.bindingSha256
          ),
          profile = new Brc38PublishedProfileNode(
            bound.directory,
            bootstrap,
            undefined,
            undefined,
            fixed,
            profileIssuer
          ),
          claim = Object.freeze({}) as Brc38NativeProfileTransferClaim,
          actual: NativeClaim = {
            root,
            profile,
            inventory: bound.inventory,
            reopenGrant: grant,
            phase: 'native-verifying',
            receipt: Object.freeze({
              directory: bound.directory,
              bindingSha256: bound.bindingSha256,
              state: row.state as Exclude<State, 'RECEIVING'>,
              fixedJson: row.fixedJson,
              fixedSha256: row.fixedSha256,
              copySha256: row.copySha256!,
              copyBytes: row.copyBytes!
            })
          },
          owner: NativeOwner = { session: attempt.session, claim, phase: 'starting' }
        actualProfiles.add(profile)
        nativeClaims.set(claim, actual)
        profile.#nativeClaim = claim
        profile.#nativeOwner = owner
        profile.#busy = true
        const pending: PendingComposedRecoveryContext = Object.freeze({
          root,
          grant,
          merge,
          store,
          source,
          receipt,
          policy,
          scope: Object.freeze({}) as Brc38PreparedNativeTarget,
          replacement,
          incoming,
          check: (): void => {
            retained()
            if (incoming !== undefined) Brc39RecoveryIncomingComparisonNode.prototype.assertRetained.call(incoming)
          }
        })
        profile.#pendingComposedRecovery = pending
        try {
          Brc38ProfileInventoryNode.retainNativeReopenAttempt(root, grant, profile)
          if (Object.hasOwn(attempt, 'failure')) throw attempt.failure
          const kernel = await driver().queryOwned(
            owner.session,
            1,
            'SELECT CASE WHEN length(CAST(binding AS BLOB))=64 THEN binding ELSE NULL END AS binding FROM owner WHERE slot=1 LIMIT 2',
            [],
            false
          )
          if (
            kernel.rows.length !== 1 ||
            kernel.rows[0].binding !== bound.bindingSha256 ||
            owner.session.identity === undefined
          )
            throw new Error('Pending target lost its actual new native kernel binding')
          const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
          owner.catalog = driver().nativeKnex(createKnex, client, owner.session, 2)
          owner.wallet = driver().nativeKnex(createKnex, client, owner.session, 0)
          owner.token = owner.session.identity
          profile.#db = owner.catalog
          owner.phase = 'validating'
          nativeJournalOwners.set(owner.token, profile)
          const fresh = await profile.#readCatalogRow()
          if (
            JSON.stringify(fresh) !== JSON.stringify(row) ||
            JSON.stringify(await readBrc38NativeBackend(owner.catalog, fresh, driver().componentBuild)) !==
              JSON.stringify(backend)
          )
            throw new Error('Pending native catalog changed during its actual physical acquisition')
          await profile.#requirePendingComposedRecovery()
          await profile.#verifyWallet(policy, retained)
          owner.phase = 'validated-reopen'
          await Brc38ProfileInventoryNode.commitNativeReopen(root, grant, profile)
          owner.phase = 'validated-delete'
          actual.phase = 'native-owned'
          await profile.#finishComposedNativeBackend(
            async () => await profile.#requirePendingComposedRecovery(),
            retained
          )
          await profile.#verifyWallet(policy, retained)
          const wallet = new StorageKnex({
              ...StorageProvider.createStorageBaseOptions(fixed.binding.chain),
              knex: owner.wallet,
              snapshotSync: false
            }),
            manager = replacement?.manager ?? new WalletStorageManager(fixed.binding.identityKey, wallet)
          wallet.setServices(services)
          profile.#wallet = wallet
          profile.#manager = manager
          const complete = async (): Promise<void> => {
            await profile.#requirePendingComposedRecovery()
            await profile.#verifyWallet(policy, retained)
            const origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
            await profile.#db.transaction(async catalog => {
              retained()
              await writeBrc38ComposedNativeCommit(
                catalog,
                await readRow(catalog),
                driver().componentBuild,
                fixed.bindingSha256,
                origin.retirement
              )
            })
            await syncDirectory(bound.directory)
            await profile.#requirePendingComposedRecovery()
            await profile.#verifyWallet(policy, retained)
          }
          if (replacement !== undefined) {
            await wallet.enableOwnedNativeSnapshotSync(profile, pending.scope)
            await WalletStorageManager.prototype.replaceProviderInTransition.call(
              manager,
              replacement.transition,
              wallet,
              complete
            )
            // No asynchronous fallible operation follows installed selection.
            // The current manager, authentication and backups are preserved.
            profile.#pendingComposedRecovery = undefined
            return manager
          }
          await complete()
          // The durable target lifecycle is committed. Manager availability
          // and later customer writes now use current-runtime verification.
          profile.#pendingComposedRecovery = undefined
          await manager.makeAvailable()
          await manager.setActive(fixed.binding.targetStorageIdentityKey)
          if (!manager.isActiveEnabled) throw new Error('Recovered composed current manager is unavailable')
          await profile.#verifyWallet(policy, retained)
          await wallet.enableOwnedNativeSnapshotSync(profile)
          await profile.#verifyWallet(policy, retained)
          if (
            JSON.stringify(await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)) !==
            JSON.stringify(initialOrigin)
          )
            throw new Error('Original retired source changed during recovered current manager preparation')
          retained()
          await Brc38ProfileInventoryNode.readNativeReopenGrant(root, grant)
          return manager
        } catch (cause) {
          actual.phase = 'native-draining'
          try {
            await profile.#closeOwnedConnections()
          } catch (error_) {
            throw new Brc38StagingCleanupError(
              [cause, error_],
              'Pending composed recovery retains its actual target cleanup',
              async () => await profile.close()
            )
          }
          actual.phase = 'released'
          throw cause
        } finally {
          profile.#pendingComposedRecovery = undefined
          profile.#busy = false
        }
      }
    )
  }
  /** READY/ACTIVE profiles require a separate inventory retirement policy.
   * Only incomplete publication can be discarded by this component. */
  async discardIncomplete(): Promise<void> {
    this.#available()
    await this.#physical()
    if (this.#busy || (await this.#readCatalogRow()).state !== 'RECEIVING')
      throw new Error('Only an owned incomplete profile may be discarded')
    if (this.#fixed.inventory !== undefined) throw new Error('Managed profile requires actual inventory retirement')
    await this.#discardIncomplete(this.directory + '-discarded-' + randomUUID())
  }
  async #discardIncomplete(retired: string, withdrawal = false): Promise<void> {
    if (this.#retired === undefined) {
      this.#available()
      await this.#physical()
      if (this.#busy || (await this.#readCatalogRow()).state !== (withdrawal ? 'READY' : 'RECEIVING'))
        throw new Error('Only an owned incomplete profile may be discarded')
      await this.#wallet?.destroy()
      await this.#db.destroy()
      await rename(this.directory, retired)
      this.#retired = retired
    }
    if (this.#retired !== retired) throw new Error('Profile retirement path differs')
    if (this.#fixed.protocol !== 'brc38-published-profile/v1') {
      if (this.#fixed.physicalIdentity === undefined)
        throw new Error('Published profile durable physical binding is incomplete')
      await assertBrc38RetiringProfilePhysicalIdentity(retired, this.#fixed.physicalIdentity)
    }
    // Keep the native kernel claim until every owned physical file is gone.
    await rm(retired, { recursive: true, force: true })
    await this.close()
    await syncDirectory(join(this.directory, '..'))
  }
  get retirementStarted(): boolean {
    return this.#retired !== undefined
  }
  get ownershipReleased(): boolean {
    return this.#ownerReleased
  }
  async discardIncompleteOwned(grant: Brc38ProfileCreationGrant): Promise<void> {
    await assertBrc38ProfileRetirementGrant(grant)
    if (this.directory !== grant.directory && this.directory !== grant.directory + '.retired')
      throw new Error('Profile retirement directory differs')
    if (this.#retired === undefined) await this.assertInventoryBinding(grant.inventory, grant.bindingSha256)
    if (this.directory.endsWith('.retired')) {
      if ((await this.status()).state !== 'RECEIVING') throw new Error('Only incomplete retirement can be recovered')
      await this.#db.destroy()
      this.#retired = this.directory
    }
    await this.#discardIncomplete(grant.directory + '.retired')
  }
  /** Only the genuine root's durable withdrawal can remove an inactive v3
   * READY copy. ACTIVE, a native backend/claim, or an exposed provider refuses. */
  async discardInactiveComposedOwned(grant: Brc38ProfileCreationGrant): Promise<void> {
    await assertBrc38ProfileWithdrawalGrant(grant)
    if (
      !actualProfiles.has(this) ||
      this.#fixed.protocol !== 'brc38-published-profile/v3' ||
      this.#nativeOwner !== undefined ||
      this.#nativeClaim !== undefined ||
      this.#wallet !== undefined ||
      this.#manager !== undefined ||
      (this.directory !== grant.directory && this.directory !== grant.directory + '.retired')
    )
      throw new Error('Inactive withdrawal requires its actual unexposed composed stock owner')
    if (this.#retired === undefined) {
      await this.assertInventoryBinding(grant.inventory, grant.bindingSha256)
      if ((await this.#readCatalogRow()).state !== 'READY')
        throw new Error('Only inactive READY composition may be withdrawn')
      await assertNoBrc38NativeBackend(this.#db)
    }
    if (this.directory.endsWith('.retired')) {
      await this.#db.destroy()
      this.#retired = this.directory
    }
    await this.#discardIncomplete(grant.directory + '.retired', true)
  }
  static async assertInactiveComposedWithdrawal(
    profile: Brc38PublishedProfileNode,
    sourceProfile: Brc38PublishedProfileNode,
    provider: StorageKnex,
    manager: WalletStorageManager,
    sourceRoot: Brc38ProfileInventoryNode
  ): Promise<void> {
    await Brc38PublishedProfileNode.assertNativeObserverMaintenance(sourceProfile, provider, manager, sourceRoot)
    if (
      !actualProfiles.has(profile) ||
      profile === sourceProfile ||
      profile.#busy ||
      profile.#closed ||
      profile.#ownerReleased ||
      profile.#fixed.protocol !== 'brc38-published-profile/v3' ||
      profile.#nativeOwner !== undefined ||
      profile.#nativeClaim !== undefined ||
      profile.#wallet !== undefined ||
      profile.#manager !== undefined ||
      profile.#composedInspection !== undefined
    )
      throw new Error('Withdrawal requires its actual idle inactive composed target')
    await profile.#physical()
    const row = await profile.#readCatalogRow(),
      fixed = fixedProfile(row, profile.#fixed.bindingSha256),
      source = await Brc38PublishedProfileNode.readNativeSourceLineage(provider),
      original = fixed.composition?.source
    if (
      row.state !== 'READY' ||
      original === undefined ||
      JSON.stringify(source.inventory) !== JSON.stringify(original.inventory) ||
      source.fixedSha256 !== original.fixedSha256 ||
      source.copySha256 !== original.copySha256 ||
      source.copyBytes !== original.copyBytes ||
      sourceProfile.#fixed.binding.identityKey !== fixed.binding.identityKey ||
      sourceProfile.#fixed.binding.chain !== fixed.binding.chain ||
      sourceProfile.#fixed.binding.targetStorageIdentityKey !== fixed.binding.targetStorageIdentityKey
    )
      throw new Error('Inactive target withdrawal differs from the actual current original source')
    await assertNoBrc38NativeBackend(profile.#db)
    await Brc38PublishedProfileNode.assertNativeObserverMaintenance(sourceProfile, provider, manager, sourceRoot)
  }
  /** Internal handoff preparation. The real root holds its original per-import
   * operation while issuing the opaque certificate; no fields on the returned
   * object are activation or native journal authority. */
  async prepareNativeClaim(root: Brc38ProfileInventoryNode): Promise<Brc38NativeProfileTransferClaim> {
    if (!actualProfiles.has(this)) throw new Error('An actual published profile issuer is required')
    return await Brc38ProfileInventoryNode.prepareNativeProfileClaim(root, this)
  }
  static async issueNativeClaim(
    profile: Brc38PublishedProfileNode,
    root: Brc38ProfileInventoryNode
  ): Promise<Brc38NativeProfileTransferClaim> {
    if (!actualProfiles.has(profile)) throw new Error('An actual published profile issuer is required')
    if (profile.#fixed.protocol === 'brc38-published-profile/v3')
      throw new Error('Composed target requires its actual durable forward cutover')
    return await profile.#issueNativeClaim(root)
  }
  async #nativeTransferReceipt(root: Brc38ProfileInventoryNode): Promise<Brc38NativeProfileTransferReceipt> {
    const row = await this.#readCatalogRow(),
      current = fixedProfile(row, this.#fixed.bindingSha256)
    if (
      row.state === 'RECEIVING' ||
      current.protocol !== 'brc38-published-profile/v2' ||
      current.inventory === undefined
    )
      throw new Error('Native handoff requires an original managed completed profile')
    assertBrc38InventoryActivation(this, current.inventory)
    await Brc38ProfileInventoryNode.assertNativeTransferInventory(root, this, current.inventory, current.bindingSha256)
    await this.#verifyWallet()
    const after = await this.#readCatalogRow()
    if (JSON.stringify(after) !== JSON.stringify(row))
      throw new Error('Original profile receipt changed during handoff')
    await Brc38ProfileInventoryNode.assertNativeTransferInventory(root, this, current.inventory, current.bindingSha256)
    return Object.freeze({
      directory: this.directory,
      bindingSha256: current.bindingSha256,
      state: row.state,
      fixedJson: row.fixedJson,
      fixedSha256: row.fixedSha256,
      copySha256: row.copySha256!,
      copyBytes: row.copyBytes!
    })
  }
  async #issueNativeClaim(root: Brc38ProfileInventoryNode): Promise<Brc38NativeProfileTransferClaim> {
    this.#available()
    if (this.#busy || this.#nativeClaim !== undefined)
      throw new Error('Published profile native handoff is already owned')
    if (this.#wallet !== undefined || this.#manager !== undefined)
      throw new Error('An exposed wallet cannot change native owners')
    this.#busy = true
    try {
      const receipt = await this.#nativeTransferReceipt(root)
      const inventory = fixedProfile(await this.#readCatalogRow(), receipt.bindingSha256).inventory!
      const claim = Object.freeze(Object.create(null)) as Brc38NativeProfileTransferClaim
      nativeClaims.set(claim, {
        profile: this,
        root,
        inventory: Object.freeze({ ...inventory }),
        receipt,
        phase: 'offered'
      })
      this.#nativeClaim = claim
      return claim
    } finally {
      this.#busy = false
    }
  }
  static cancelNativeClaim(claim: Brc38NativeProfileTransferClaim): void {
    const actual = nativeClaims.get(claim)
    if (
      actual === undefined ||
      actual.phase !== 'offered' ||
      actual.profile.#nativeClaim !== claim ||
      actual.profile.#busy
    )
      throw new Error('Only an actual idle offered native claim can be cancelled')
    actual.phase = 'refused'
    actual.profile.#nativeClaim = undefined
  }
  static async releaseNativeClaim(claim: Brc38NativeProfileTransferClaim): Promise<Brc38NativeProfileTransferReceipt> {
    const actual = nativeClaims.get(claim)
    if (actual === undefined || !['offered', 'draining'].includes(actual.phase))
      throw new Error('An actual pending native transfer claim is required')
    return await Brc38ProfileInventoryNode.releaseNativeProfileClaim(actual.root, actual.profile, claim)
  }
  static async drainNativeClaim(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    claim: Brc38NativeProfileTransferClaim
  ): Promise<Brc38NativeProfileTransferReceipt> {
    const actual = nativeClaims.get(claim)
    if (
      actual === undefined ||
      actual.root !== root ||
      actual.profile !== profile ||
      profile.#nativeClaim !== claim ||
      !['offered', 'draining'].includes(actual.phase) ||
      profile.#busy
    )
      throw new Error('An actual pending native transfer claim is required')
    profile.#busy = true
    try {
      await Brc38ProfileInventoryNode.assertNativeTransferInventory(
        root,
        profile,
        actual.inventory,
        actual.receipt.bindingSha256
      )
      if (actual.phase === 'offered') {
        profile.#available()
        if (profile.#wallet !== undefined || profile.#manager !== undefined)
          throw new Error('An exposed wallet cannot change native owners')
        const current = await profile.#nativeTransferReceipt(root)
        if (JSON.stringify(current) !== JSON.stringify(actual.receipt))
          throw new Error('Original native transfer receipt changed')
        actual.phase = 'draining'
      }
      // A failed physical close retains the draining certificate for a retry;
      // neither a callback nor an early flag claims that the kernel is gone.
      await profile.#closeOwnedConnections()
      if (!profile.#ownerReleased) throw new Error('Original native owner cleanup remains required')
      await Brc38ProfileInventoryNode.assertNativeTransferInventory(
        root,
        profile,
        actual.inventory,
        actual.receipt.bindingSha256
      )
      actual.phase = 'released'
      return actual.receipt
    } finally {
      profile.#busy = false
    }
  }

  /** Reacquire and validate a read-only native owner under the SAME original
   * root operation as physical stock drain. This internal foundation does not
   * activate a manager or admit DELETE writes/WAL. */
  static async acquireNativeClaim(
    claim: Brc38NativeProfileTransferClaim,
    executable: string
  ): Promise<Brc38PublishedProfileNode> {
    const actual = nativeClaims.get(claim)
    if (actual === undefined || !['offered', 'draining'].includes(actual.phase))
      throw new Error('An actual pending native transfer claim is required')
    return await Brc38ProfileInventoryNode.acquireNativeProfileClaim(actual.root, actual.profile, claim, executable)
  }
  static async reacquireNativeClaim(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    claim: Brc38NativeProfileTransferClaim,
    executable: string
  ): Promise<Brc38PublishedProfileNode> {
    const actual = nativeClaims.get(claim)
    if (
      actual === undefined ||
      actual.root !== root ||
      actual.profile !== profile ||
      !actualProfiles.has(profile) ||
      profile.#nativeOwner !== undefined
    )
      throw new Error('An actual original published-profile handoff is required')
    // This call must update the private claim phase and prove physical release;
    // a caller-replaced callback/returned receipt cannot substitute for it.
    if (profile.#nativeAcquiring) throw new Error('Native handoff is already owned')
    profile.#nativeAcquiring = true
    try {
      const receipt = await this.drainNativeClaim(root, profile, claim)
      if (
        actual.phase !== 'released' ||
        !profile.#ownerReleased ||
        profile.#busy ||
        JSON.stringify(receipt) !== JSON.stringify(actual.receipt)
      )
        throw new Error('Original profile physical release is not complete')
      profile.#busy = true
      try {
        await Brc38ProfileInventoryNode.assertNativeTransferInventory(
          root,
          profile,
          actual.inventory,
          receipt.bindingSha256
        )
        actual.phase = 'native-verifying'
        const attempt = await driver().NativeProfileSqlite.startForClaim(
          executable,
          receipt.directory,
          receipt.fixedJson,
          receipt.bindingSha256
        )
        const owner: NativeOwner = { session: attempt.session, claim, phase: 'starting' }
        // Retain even a failed start until real child/descriptor cleanup settles.
        profile.#nativeOwner = owner
        profile.#ownerReleased = false
        if (Object.prototype.hasOwnProperty.call(attempt, 'failure')) throw attempt.failure
        const bound = await driver().queryOwned(
          owner.session,
          1,
          'SELECT CASE WHEN length(CAST(binding AS BLOB)) = 64 THEN binding ELSE NULL END AS binding FROM owner WHERE slot=1 LIMIT 2',
          [],
          false
        )
        if (bound.rows.length !== 1 || bound.rows[0].binding !== receipt.bindingSha256)
          throw new Error('Reacquired native owner binding differs')
        const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
        owner.catalog = driver().nativeKnex(createKnex, client, owner.session, 2)
        owner.wallet = driver().nativeKnex(createKnex, client, owner.session, 0)
        const row = await readRow(owner.catalog)
        if (
          row.state !== receipt.state ||
          row.fixedJson !== receipt.fixedJson ||
          row.fixedSha256 !== receipt.fixedSha256 ||
          row.copySha256 !== receipt.copySha256 ||
          row.copyBytes !== receipt.copyBytes
        )
          throw new Error('Reacquired native catalog receipt differs')
        fixedProfile(row, receipt.bindingSha256)
        await Brc38ProfileInventoryNode.assertNativeTransferInventory(
          root,
          profile,
          actual.inventory,
          receipt.bindingSha256
        )
        if (owner.session.identity === undefined) throw new Error('Actual native producer identity is absent')
        owner.token = owner.session.identity
        profile.#db = owner.catalog
        profile.#closed = false
        owner.phase = 'validating'
        nativeJournalOwners.set(owner.token, profile)
        // Full original copy/schema/journal/user/settings/primary/physical and
        // fresh actual inventory validation, now through the new native owner.
        const current = await profile.#nativeTransferReceipt(root)
        if (JSON.stringify(current) !== JSON.stringify(receipt))
          throw new Error('Authenticated native handoff receipt changed')
        owner.phase = 'validated-delete'
        actual.phase = 'native-owned'
        return profile
      } catch (cause) {
        actual.phase = 'native-draining'
        try {
          await profile.#closeOwnedConnections()
        } catch (error_) {
          throw new AggregateError([cause, error_], 'Native handoff and physical cleanup failed')
        }
        actual.phase = 'released'
        throw cause
      } finally {
        profile.#busy = false
      }
    } finally {
      profile.#nativeAcquiring = false
    }
  }

  async close(): Promise<void> {
    if (this.#nativeAcquiring) throw new Error('Wait for actual native handoff before close')
    if (this.#ownerReleased) return
    if (this.#busy) throw new Error('Wait for published profile I/O before close')
    if (this.#nativeClaim !== undefined) {
      const actual = nativeClaims.get(this.#nativeClaim)
      if (actual?.phase === 'offered') {
        actual.phase = 'refused'
        this.#nativeClaim = undefined
      }
    }
    await this.#closeOwnedConnections()
  }
  async #closeOwnedConnections(): Promise<void> {
    if (this.#ownerReleased) return
    this.#closed = true
    for (const cleanup of this.#structuredPhysicalCleanup) {
      await cleanup.retryCleanup()
      this.#structuredPhysicalCleanup.delete(cleanup)
    }
    if (this.#nativeReadInspection !== undefined) {
      await this.#nativeReadInspection.destroy()
      this.#nativeReadInspection = undefined
      this.#nativeReadInspectionCleanupRequired = false
    }
    if (this.#copyInspection !== undefined) {
      await this.#copyInspection.destroy()
      this.#copyInspection = undefined
      this.#copyInspectionCleanupRequired = false
    }
    await this.#wallet?.destroy()
    if (this.#nativeOwner !== undefined) {
      const owner = this.#nativeOwner
      owner.phase = 'closing'
      await owner.wallet?.destroy()
      await owner.catalog?.destroy()
      const result = await driver().drainStartedNativeSession(owner.session)
      if (owner.token !== undefined) nativeJournalOwners.delete(owner.token)
      this.#nativeOwner = undefined
      this.#ownerReleased = true
      const actual = nativeClaims.get(owner.claim)
      if (actual !== undefined) actual.phase = 'released'
      if (result.failed) throw result.failure
      return
    }
    await this.#db.destroy()
    if (this.#ownerDb === undefined || this.#connection === undefined)
      throw new Error('Published profile requires its actual physical owner cleanup')
    if (!this.#connectionReleased) {
      await this.#ownerDb.client.releaseConnection(this.#connection)
      this.#connectionReleased = true
    }
    await this.#ownerDb.destroy()
    this.#ownerReleased = true
  }
}
