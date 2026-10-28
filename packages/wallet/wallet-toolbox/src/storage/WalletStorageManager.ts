import { promiseFromSync, awaitFromSync, awaitVoidFromSync, mapAwaitFromSync } from '../utility/promiseFromSync'
import type { StoragePreparedWalletWriter, StorageWriterAdmission } from './StorageActiveWrite'
import { runPrimaryHandoffProgram, type PrimaryHandoffParticipant } from './PrimaryHandoffProgram'
import type { PrimaryHandoffControl, PrimaryHandoffPlan, PrimaryHandoffControlOptions } from './PrimaryHandoffControl'
import { Random, Utils } from '@bsv/sdk'
import {
  snapshotJournalDataProvider,
  snapshotJournalDataContentProvider,
  snapshotJournalPrimaryContentProvider,
  snapshotJournalArchiveProvider,
  snapshotJournalFieldArchiveProvider,
  snapshotJournalFieldProvider,
  snapshotJournalFieldProvenanceProvider,
  snapshotJournalFieldArchiveRecoveryProvider,
  snapshotJournalFieldRecoveryProvider,
  snapshotJournalFieldWindowRecoveryProvider
} from './snapshot/journal/SnapshotJournalDataProvider'
import { snapshotJournalDataSourceBinding } from './snapshot/journal/snapshotJournalDataSourceBinding'
import {
  isSnapshotJournalDataBootstrapRequiredError,
  type SnapshotJournalDataBootstrapRequiredError
} from './snapshot/journal/SnapshotJournalDataBootstrapRequiredError'
import {
  runSnapshotJournalArchiveReconciliation,
  runSnapshotJournalFieldArchiveReconciliation,
  type SnapshotJournalFieldDestination,
  type SnapshotJournalDataDestination
} from './snapshot/journal/runSnapshotJournalArchiveReconciliation'
import { runSnapshotJournalSourceDataReconciliation } from './snapshot/journal/runSnapshotJournalSourceDataReconciliation'
import type { RemoteSnapshotJournalArchive } from './snapshot/journal/openRemoteSnapshotJournalArchive'
import {
  parseSnapshotSyncContentRevision,
  snapshotSyncContentPosition,
  snapshotSyncContentConfirms
} from './snapshot/SnapshotSyncContentRevision'
import { Brc38CleanupScope } from './portable/Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'
import type { StorageIdb } from './StorageIdb'
import type { Brc38IdbProfileSelectionOptions } from './portable/Brc38IdbProfileSelection'
import { SnapshotCancelledError } from './snapshot/SnapshotCancelledError'
import { copySnapshotCursor } from './snapshot/SnapshotCursor'
import { runSnapshotSyncSession } from './snapshot/runSnapshotSyncSession'
import type { SnapshotSyncStorage } from './snapshot/SnapshotSync'
import type { WalletReadSnapshot } from './snapshot/WalletReadSnapshot'
import type { RetainedReadSnapshotOptions } from './snapshot/RetainedReadSnapshot'
import type {
  SnapshotJournalProvider,
  SnapshotJournalWriterAdmission,
  SnapshotJournalReceiver,
  SnapshotJournalReconciliationSource,
  SnapshotJournalDestinationLimits,
  SnapshotJournalCutoverSource
} from './snapshot/journal/SnapshotJournalProvider'
import type { SnapshotJournalDestinationCheckpoint } from './snapshot/journal/SnapshotJournalTypes'
import {
  runSnapshotJournalReconciliation,
  type SnapshotJournalReconciliationOptions,
  type SnapshotJournalReconciliationProgress
} from './snapshot/journal/runSnapshotJournalReconciliation'
import { snapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'
import { journalCopyLimits } from './snapshot/journal/SnapshotJournalCopyLimits'
import { closeSnapshotJournalSource } from './snapshot/journal/closeSnapshotJournalSource'
import { runInSeries } from '../utility/runInSeries'
import {
  BRC197_INTERNALIZATION_PROFILE,
  assertBrc197Recipient,
  brc197ChildPublicKey,
  ownBrc197InternalizeActionArgs,
  type Brc197InternalizeActionArgs,
  type Brc197InternalizationCapabilities
} from '../sdk/Brc197Internalization'
import {
  type ValidCreateActionArgs,
  type ValidListActionsArgs,
  type ValidListCertificatesArgs,
  type ValidListOutputsArgs,
  validateAbortActionArgs,
  validateInternalizeActionArgs,
  validateRelinquishCertificateArgs,
  validateRelinquishOutputArgs
} from '@bsv/sdk/wallet/validationHelpers'
import { SyncPageBudget } from './sync/SyncPageBudget'
import { StorageAccessQueue } from './sync/StorageAccessQueue'
import { StorageAccessCancelledError } from './sync/StorageAccessCancelledError'
import { commitSyncAdmission } from './sync/commitSyncAdmission'
import { Brc38OwnedImportReads } from './portable/Brc38OwnedImportReads'
import {
  runPullSession,
  type SyncSessionOptions,
  type SyncSessionProgress,
  type SyncSessionResult
} from './sync/syncSession'
import { validateSyncCheckpoint } from './sync/syncCheckpoint'
import { assertSyncNetwork, assertSyncProgress, throwSyncResultError } from './sync/syncFailure'
import {
  AbortActionArgs,
  AbortActionResult,
  Beef,
  InternalizeActionArgs,
  ListActionsResult,
  ListCertificatesResult,
  ListOutputsResult,
  RelinquishCertificateArgs,
  RelinquishOutputArgs
} from '@bsv/sdk'
import { EntitySyncState } from '../storage/schema/entities'
import type * as sdk from '../sdk'
import {
  WERR_INTERNAL,
  WERR_INVALID_OPERATION,
  WERR_INVALID_PARAMETER,
  WERR_NOT_ACTIVE,
  WERR_NOT_IMPLEMENTED,
  WERR_UNAUTHORIZED
} from '../sdk/WERR_errors'
import {
  TableCertificate,
  TableCertificateX,
  TableOutput,
  TableOutputBasket,
  TableProvenTx,
  TableProvenTxReq,
  TableSettings,
  TableUser
} from '../storage/schema/tables'
import { StorageProvider } from './StorageProvider'
import { refreshSyncProof } from './methods/refreshSyncProof'
import { recoveredProofUpdate, sameSyncProof } from './methods/validateSyncProof'
import { mapProofWork } from './methods/proofWork'

interface PreparedBeefInvalidationExtension {
  invalidatePreparedBeefs: (trx?: sdk.TrxToken) => Promise<number>
  suspendPreparedBeefReads: () => () => void
}

type JournalSourceProvider = sdk.WalletStorageSyncReader &
  Pick<SnapshotJournalProvider, 'supportsSnapshotJournalSync' | 'openCurrentSnapshotJournalSource'>
type JournalDestinationProvider = sdk.WalletStorageProvider &
  Pick<SnapshotJournalProvider, 'supportsSnapshotJournalSync' | 'openSnapshotJournalDestination'>
interface JournalCopyCustody {
  reader: JournalSourceProvider
  source: SnapshotJournalReconciliationSource
  destination: SnapshotJournalReceiver
  checkpoint: SnapshotJournalDestinationCheckpoint
}
function copyJournalCheckpoint(
  value?: SnapshotJournalDestinationCheckpoint
): SnapshotJournalDestinationCheckpoint | undefined {
  return value === undefined
    ? undefined
    : { ...value, ...(value.after === undefined ? {} : { after: { ...value.after } }) }
}
function journalSource(provider: sdk.WalletStorageSyncReader): provider is JournalSourceProvider {
  const extension = provider as Partial<JournalSourceProvider>
  return (
    typeof extension.supportsSnapshotJournalSync === 'function' &&
    typeof extension.openCurrentSnapshotJournalSource === 'function'
  )
}
function journalDestination(provider: sdk.WalletStorageProvider): provider is JournalDestinationProvider {
  const extension = provider as Partial<JournalDestinationProvider>
  return (
    typeof extension.supportsSnapshotJournalSync === 'function' &&
    typeof extension.openSnapshotJournalDestination === 'function'
  )
}

async function invalidatePreparedBeefs(storage: StorageProvider, trx: sdk.TrxToken): Promise<void> {
  const extension = storage as unknown as Partial<PreparedBeefInvalidationExtension>
  if (typeof extension.invalidatePreparedBeefs === 'function') {
    await extension.invalidatePreparedBeefs.call(storage, trx)
  }
}

class ManagedStorage {
  isAvailable: boolean
  isStorageProvider: boolean
  settings?: TableSettings
  access: sdk.StorageCapabilities['storageAccess']
  user?: TableUser

  constructor(public storage: sdk.WalletStorageProvider) {
    this.isStorageProvider = storage.isStorageProvider()
    this.isAvailable = false
  }
}

declare const providerTransitionBrand: unique symbol
/** Internal queue lifetime only. This handle does not validate a native
 * profile, source generation, retirement decision or composed wallet. */
export interface WalletStorageProviderTransition {
  readonly [providerTransitionBrand]: true
}
export interface WalletStorageProviderTransitionPolicy {
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
interface ProviderReplacementState {
  readonly original: ManagedStorage
  readonly stores: readonly ManagedStorage[]
  readonly backups: readonly ManagedStorage[]
  readonly conflicts: readonly ManagedStorage[]
  readonly generation: number
  readonly identityKey: string
  readonly storageIdentityKey: string
  readonly chain: TableSettings['chain']
  readonly userId: number
  readonly primary: string
}
interface ProviderTransitionState {
  readonly scope: WalletStorageProviderTransition
  readonly replacement: ProviderReplacementState
  readonly io: Brc38OwnedImportReads
  readonly controller: Brc38OwnedImportReads
  readonly expiresAt: number
  readonly deadline: number
  readonly signal?: AbortSignal
  installed: boolean
}

/**
 * The `WalletStorageManager` class delivers authentication checking storage access to the wallet.
 *
 * If manages multiple `StorageBase` derived storage services: one actice, the rest as backups.
 *
 * Of the storage services, one is 'active' at any one time.
 * On startup, and whenever triggered by the wallet, `WalletStorageManager` runs a syncrhonization sequence:
 *
 * 1. While synchronizing, all other access to storage is blocked waiting.
 * 2. The active service is confirmed, potentially triggering a resolution process if there is disagreement.
 * 3. Changes are pushed from the active storage service to each inactive, backup service.
 *
 * Some storage services do not support multiple writers. `WalletStorageManager` manages wait-blocking write requests
 * for these services.
 */
export class WalletStorageManager implements sdk.WalletStorage {
  /**
   * All configured stores including current active, backups, and conflicting actives.
   */
  _stores: ManagedStorage[] = []
  /**
   * True if makeAvailable has been run and access to managed stores (active) is allowed
   */
  _isAvailable: boolean = false
  /**
   * The current active store which is only enabled if the store's user record activeStorage property matches its settings record storageIdentityKey property
   */
  _active?: ManagedStorage
  /**
   * Stores to which state is pushed by updateBackups.
   */
  _backups?: ManagedStorage[]
  /**
   * Stores whose user record activeStorage property disagrees with the active store's user record activeStorage property.
   */
  _conflictingActives?: ManagedStorage[]
  /**
   * identityKey is always valid, userId and isActive are valid only if _isAvailable
   */
  _authId: sdk.AuthId
  /**
   * Configured services if any. If valid, shared with stores (which may ignore it).
   */
  _services?: sdk.WalletServices
  private availability?: Promise<TableSettings>
  private generation = 0
  private readonly accessQueue = new StorageAccessQueue()
  /** Serializes transitions without reserving foreground storage during copying. */
  private readonly primaryTransitions = new StorageAccessQueue()
  #providerReplacementPending?: ProviderReplacementState
  #providerTransition?: ProviderTransitionState

  /**
   * Creates a new WalletStorageManager with the given identityKey and optional active and backup storage providers.
   *
   * @param identityKey The identity key of the user for whom this wallet is being managed.
   * @param active An optional active storage provider. If not provided, no active storage will be set.
   * @param backups An optional array of backup storage providers. If not provided, no backups will be set.
   */
  constructor(identityKey: string, active?: sdk.WalletStorageProvider, backups?: sdk.WalletStorageProvider[]) {
    const stores = [...(backups ?? [])]
    if (active != null) stores.unshift(active)
    this._stores = stores.map(s => new ManagedStorage(s))
    this._authId = { identityKey }
  }

  isStorageProvider(): boolean {
    return false
  }

  isAvailable(): boolean {
    return this._isAvailable
  }

  /**
   * The active storage is "enabled" only if its `storageIdentityKey` matches the user's currently selected `activeStorage`,
   * and only if there are no stores with conflicting `activeStorage` selections.
   *
   * A wallet may be created without including the user's currently selected active storage. This allows readonly access to their wallet data.
   *
   * In addition, if there are conflicting `activeStorage` selections among backup storage providers then the active remains disabled.
   */
  get isActiveEnabled(): boolean {
    return (
      this.#providerReplacementPending === undefined &&
      this.#primaryHandoffPending === undefined &&
      this._active !== undefined &&
      (this._active.settings as TableSettings).storageIdentityKey === (this._active.user as TableUser).activeStorage &&
      this._conflictingActives?.length === 0
    )
  }

  /**
   * @returns true if at least one WalletStorageProvider has been added.
   */
  canMakeAvailable(): boolean {
    return this._stores.length > 0
  }

  /**
   * This async function must be called after construction and before
   * any other async function can proceed.
   *
   * Runs through `_stores` validating all properties and partitioning across `_active`, `_backups`, `_conflictingActives`.
   *
   * @throws WERR_INVALID_PARAMETER if canMakeAvailable returns false.
   *
   * @returns {TableSettings} from the active storage.
   */
  private async ensureStoreAvailable(store: ManagedStorage): Promise<void> {
    if (store.isAvailable && store.settings != null && store.user != null) return
    store.settings ??= await store.storage.makeAvailable()
    const r = await store.storage.findOrInsertUser(this._authId.identityKey)
    store.user = r.user
    // A failed capability lookup changes only scheduling: old or unavailable
    // capability endpoints keep the compatible serialized path.
    try {
      const access = (await store.storage.getCapabilities?.())?.storageAccess
      store.access = access?.version === 1 ? access : undefined
    } catch {
      store.access = undefined
    }
    store.isAvailable = true
  }

  private async preflightManagedNetworks(peer?: TableSettings): Promise<void> {
    let reference = peer
    // The first available store establishes the network for each later store.
    await runInSeries(this._stores, async store => {
      store.settings ??= await store.storage.makeAvailable()
      if (reference != null) assertSyncNetwork(reference, store.settings)
      reference ??= store.settings
    })
  }

  private selectActiveFromStore(store: ManagedStorage, backups: ManagedStorage[]): void {
    if (this._active == null) {
      // _stores[0] becomes the default active store.
      this._active = store
      return
    }
    const ua = (store.user as TableUser).activeStorage
    const si = (store.settings as TableSettings).storageIdentityKey
    if (ua === si && !this.isActiveEnabled) {
      // This store's user record selects it as the enabled active storage — swap.
      backups.push(this._active)
      this._active = store
    } else {
      backups.push(store)
    }
  }

  async makeAvailable(): Promise<TableSettings> {
    if (this.#providerReplacementPending !== undefined)
      throw new WERR_INVALID_OPERATION('Provider replacement requires forward recovery before wallet access')
    if (this._isAvailable) return this.getActiveSettings()
    this.availability ??= this.initializeAvailable()
    const pending = this.availability
    try {
      return await pending
    } finally {
      if (this.availability === pending) this.availability = undefined
    }
  }

  private async initializeAvailable(): Promise<TableSettings> {
    if (this._isAvailable) return (this._active as ManagedStorage).settings as TableSettings

    this._active = undefined
    this._backups = []
    this._conflictingActives = []

    if (this._stores.length < 1) {
      throw new WERR_INVALID_PARAMETER('active', 'valid. Must add active storage provider to wallet.')
    }

    const backups: ManagedStorage[] = []
    // Read all network settings before registering users on any managed store.
    await this.preflightManagedNetworks()
    for (const store of this._stores) {
      await this.ensureStoreAvailable(store)
      this.selectActiveFromStore(store, backups)
    }

    // Partition backups into proper backups vs conflicting actives.
    const si = (this._active as unknown as ManagedStorage).settings?.storageIdentityKey
    for (const store of backups) {
      if ((store.user as TableUser).activeStorage !== si) this._conflictingActives.push(store)
      else this._backups.push(store)
    }

    this._isAvailable = true
    this.generation++
    this._authId.userId = (this._active as unknown as ManagedStorage).user?.userId
    this._authId.isActive = this.isActiveEnabled

    return (this._active as unknown as ManagedStorage).settings as TableSettings
  }

  private verifyActive(): ManagedStorage {
    if (this._active == null || !this._isAvailable) {
      throw new WERR_INVALID_OPERATION(
        'An active WalletStorageProvider must be added to this WalletStorageManager and makeAvailable must be called.'
      )
    }
    return this._active
  }

  async getAuth(mustBeActive?: boolean): Promise<sdk.AuthId> {
    if (!this.isAvailable()) await this.makeAvailable()
    if (mustBeActive === true && this._authId.isActive !== true) throw new WERR_NOT_ACTIVE()
    return this._authId
  }

  async getUserId(): Promise<number> {
    return (await this.getAuth()).userId as number
  }

  getActive(): sdk.WalletStorageProvider {
    return this.verifyActive().storage
  }

  getActiveSettings(): TableSettings {
    return this.verifyActive().settings as TableSettings
  }

  getActiveUser(): TableUser {
    return this.verifyActive().user as TableUser
  }

  getActiveStore(): string {
    return (this.verifyActive().settings as TableSettings).storageIdentityKey
  }

  getActiveStoreName(): string {
    return (this.verifyActive().settings as TableSettings).storageName
  }

  getBackupStores(): string[] {
    this.verifyActive()
    return (this._backups as ManagedStorage[]).map(b => (b.settings as TableSettings).storageIdentityKey)
  }

  getConflictingStores(): string[] {
    this.verifyActive()
    return (this._conflictingActives as ManagedStorage[]).map(b => (b.settings as TableSettings).storageIdentityKey)
  }

  getAllStores(): string[] {
    this.verifyActive()
    return this._stores.map(b => (b.settings as TableSettings).storageIdentityKey)
  }

  #primaryHandoffPending?: { target: string; stores: readonly ManagedStorage[]; identityKey: string }
  private readonly primaryCopyAdmissions = new WeakMap<object, SnapshotJournalWriterAdmission>()
  private assertPrimaryHandoffGraph(stores: readonly ManagedStorage[], identityKey: string): void {
    if (
      identityKey !== this._authId.identityKey ||
      stores.length !== this._stores.length ||
      stores.some((store, index) => store !== this._stores[index])
    )
      throw new WERR_INVALID_OPERATION(
        'Managed participants changed during primary handoff; recover the original handoff'
      )
  }

  private async withAccess<R>(
    operation: (active: sdk.WalletStorageProvider) => Promise<R>,
    read = false,
    background = false,
    signal?: AbortSignal
  ): Promise<R> {
    if (signal?.aborted) throw new StorageAccessCancelledError(signal)
    if (this.#primaryHandoffPending !== undefined)
      throw new WERR_INVALID_OPERATION('Primary handoff requires forward recovery before ordinary wallet access')
    const leave = this.accessQueue.admit()
    try {
      for (;;) {
        // An actual transition already owns this queue through physical drain
        // and installation. Join behind it before checking availability, then
        // observe the replacement or the retained recovery barrier under ownership.
        if (this.#providerTransition === undefined) await this.makeAvailable()
        const concurrent =
          read && this.#providerTransition === undefined && this._active?.access?.concurrentReads === true
        const release = await this.accessQueue.acquire(
          concurrent ? 'read' : 'exclusive',
          background ? 'background' : 'foreground',
          signal
        )
        try {
          if (this.#primaryHandoffPending !== undefined)
            throw new WERR_INVALID_OPERATION('Primary handoff requires forward recovery before ordinary wallet access')
          // A preceding transition can fail after updating a managed store.
          // Reload persisted selection under actual ownership before use.
          if (!this._isAvailable) await this.makeAvailable()
          // Keep the same original request admission if primary replacement
          // removes read sharing; release this slot before rejoining as writer.
          if (concurrent && this._active?.access?.concurrentReads !== true) continue
          if (signal?.aborted) throw new StorageAccessCancelledError(signal)
          return await operation(this.getActive())
        } finally {
          release()
        }
      }
    } finally {
      leave()
    }
  }

  runAsWriter<R>(writer: (active: sdk.WalletStorageWriter) => Promise<R>): Promise<R> {
    return this.withAccess(writer)
  }

  /** The native controller prepares its complete target outside this queue.
   * This short scope then retains the original manager through the final
   * source fence, durable retirement, physical cleanup and provider install.
   * A failed or ambiguous retirement must block access before releasing it.
   * Recovery uses a NEW scope and independently rereads native state. */
  async withOwnedProviderTransition<R>(
    expected: sdk.WalletStorageProvider,
    policy: WalletStorageProviderTransitionPolicy,
    work: (scope: WalletStorageProviderTransition) => Promise<R>
  ): Promise<R> {
    const expiresAt = policy.expiresAt,
      signal = policy.signal,
      lifetime = expiresAt - Date.now(),
      deadline = performance.now() + lifetime
    if (!Number.isSafeInteger(expiresAt) || lifetime <= 0 || lifetime > 3600000 || typeof work !== 'function')
      throw new WERR_INVALID_PARAMETER('policy', 'a live bounded provider transition')
    const checkTime = (): void => {
      signal?.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new WERR_INVALID_OPERATION('Provider transition expired')
    }
    checkTime()
    const transition = await this.primaryTransitions.acquire('exclusive')
    let release: (() => void) | undefined, owned: ProviderTransitionState | undefined
    try {
      checkTime()
      if (this.#providerReplacementPending === undefined) await this.makeAvailable()
      release = await this.accessQueue.acquire('exclusive', 'foreground')
      checkTime()
      if (this.#providerTransition !== undefined)
        throw new WERR_INVALID_OPERATION('Provider transition is already owned')
      let replacement = this.#providerReplacementPending
      if (replacement === undefined) {
        const original = this.verifyActive(),
          settings = original.settings,
          user = original.user
        if (
          original.storage !== expected ||
          !this.isActiveEnabled ||
          settings === undefined ||
          user === undefined ||
          user.identityKey !== this._authId.identityKey ||
          user.userId !== this._authId.userId ||
          user.activeStorage !== settings.storageIdentityKey
        )
          throw new WERR_INVALID_OPERATION("Provider transition needs this manager's current enabled provider")
        replacement = Object.freeze({
          original,
          stores: Object.freeze([...this._stores]),
          backups: Object.freeze([...(this._backups ?? [])]),
          conflicts: Object.freeze([...(this._conflictingActives ?? [])]),
          generation: this.generation,
          identityKey: this._authId.identityKey,
          storageIdentityKey: settings.storageIdentityKey,
          chain: settings.chain,
          userId: user.userId,
          primary: user.activeStorage
        })
      }
      if (replacement.original.storage !== expected)
        throw new WERR_INVALID_OPERATION('Recovery belongs to another original provider')
      const scope = Object.freeze({}) as WalletStorageProviderTransition
      owned = {
        scope,
        replacement,
        io: new Brc38OwnedImportReads(),
        controller: new Brc38OwnedImportReads(),
        expiresAt,
        deadline,
        signal,
        installed: false
      }
      this.#providerTransition = owned
      this.#requireProviderTransition(scope)
      return await owned.io.retain(() =>
        awaitFromSync(() => owned!.controller.retain(() => awaitFromSync(() => work(scope))))
      )
    } finally {
      if (owned !== undefined && this.#providerTransition === owned) this.#providerTransition = undefined
      release?.()
      transition()
    }
  }

  #requireProviderTransition(scope: WalletStorageProviderTransition): ProviderTransitionState {
    const owned = this.#providerTransition
    if (owned === undefined || owned.scope !== scope || owned.installed)
      throw new WERR_INVALID_OPERATION("Provider transition handle is not this manager's live queue scope")
    owned.signal?.throwIfAborted()
    if (Date.now() >= owned.expiresAt || performance.now() >= owned.deadline)
      throw new WERR_INVALID_OPERATION('Provider transition expired')
    const original = owned.replacement
    const same = (actual: readonly ManagedStorage[] | undefined, captured: readonly ManagedStorage[]): boolean =>
      actual !== undefined &&
      actual.length === captured.length &&
      actual.every((store, index) => store === captured[index])
    if (
      this.generation !== original.generation ||
      this._authId.identityKey !== original.identityKey ||
      this._authId.userId !== original.userId ||
      this._active !== original.original ||
      !same(this._stores, original.stores) ||
      !same(this._backups, original.backups) ||
      !same(this._conflictingActives, original.conflicts) ||
      original.original.settings?.storageIdentityKey !== original.storageIdentityKey ||
      original.original.settings.chain !== original.chain ||
      original.original.user?.identityKey !== original.identityKey ||
      original.original.user.userId !== original.userId ||
      original.original.user.activeStorage !== original.primary ||
      (this.#providerReplacementPending !== undefined && this.#providerReplacementPending !== original)
    )
      throw new WERR_INVALID_OPERATION('Managed provider selection changed during replacement')
    return owned
  }

  /** Arm before a potentially durable retirement. Any ambiguous result keeps
   * ordinary access blocked. This is a manager lifecycle barrier only; the
   * controller still needs its actual source writer and native catalog. */
  blockRetiringProviderInTransition(scope: WalletStorageProviderTransition): void {
    const owned = this.#requireProviderTransition(scope)
    this.#providerReplacementPending = owned.replacement
    this._isAvailable = false
    this._authId.isActive = false
  }

  /** Actual queue membership for the native controller even after availability
   * is blocked. Returned coordinates are DATA; its profile factory must
   * independently verify physical writer and retirement membership. */
  requireOriginalProviderInTransition(
    scope: WalletStorageProviderTransition,
    expected: sdk.WalletStorageProvider
  ): Readonly<{
    identityKey: string
    storageIdentityKey: string
    chain: TableSettings['chain']
    userId: number
    primary: string
  }> {
    const owned = this.#requireProviderTransition(scope)
    if (owned.replacement.original.storage !== expected)
      throw new WERR_INVALID_OPERATION('Provider is not the original member of this transition')
    const original = owned.replacement
    return Object.freeze({
      identityKey: original.identityKey,
      storageIdentityKey: original.storageIdentityKey,
      chain: original.chain,
      userId: original.userId,
      primary: original.primary
    })
  }

  /** Retain a whole concrete forward controller before installation I/O can
   * close. Unawaited controller work still drains under both actual queues. */
  retainOriginalProviderTransition<T>(
    scope: WalletStorageProviderTransition,
    expected: sdk.WalletStorageProvider,
    work: () => Promise<T>
  ): Promise<T> {
    const owned = this.#requireProviderTransition(scope)
    this.requireOriginalProviderInTransition(scope, expected)
    if (typeof work !== 'function') throw new WERR_INVALID_PARAMETER('work', 'a bounded provider transition controller')
    return owned.controller.run(async () => {
      this.requireOriginalProviderInTransition(scope, expected)
      const value = await work()
      if (this.#providerTransition !== owned)
        throw new WERR_INVALID_OPERATION('Provider controller lost its actual queue scope')
      return value
    })
  }

  /** Install a separately admitted actual provider, preserving this manager,
   * backups and identity. No profile receipt or semantic boolean is accepted.
   * The native controller must have physically drained the retired provider
   * before this call. Outstanding install I/O drains before queue release. */
  replaceProviderInTransition(
    scope: WalletStorageProviderTransition,
    provider: sdk.WalletStorageProvider,
    beforeInstall?: () => Promise<void>
  ): Promise<void> {
    const owned = this.#requireProviderTransition(scope)
    if (beforeInstall !== undefined && typeof beforeInstall !== 'function')
      throw new WERR_INVALID_PARAMETER('beforeInstall', 'a retained provider preparation check')
    return owned.io.run(async () => {
      const original = this.#requireProviderTransition(scope).replacement
      if (
        this.#providerReplacementPending !== original ||
        provider === original.original.storage ||
        original.stores.some(store => store.storage === provider)
      )
        throw new WERR_INVALID_OPERATION('Replacement needs a blocked original and a distinct admitted provider')
      const store = new ManagedStorage(provider),
        settings = await provider.makeAvailable()
      this.#requireProviderTransition(scope)
      if (settings.storageIdentityKey !== original.storageIdentityKey || settings.chain !== original.chain)
        throw new WERR_INVALID_OPERATION('Replacement changed storage identity or network')
      const result = await provider.findOrInsertUser(original.identityKey)
      this.#requireProviderTransition(scope)
      if (
        result.isNew ||
        result.user.identityKey !== original.identityKey ||
        result.user.userId !== original.userId ||
        result.user.activeStorage !== original.primary
      )
        throw new WERR_INVALID_OPERATION('Replacement lacks the preserved user and primary')
      let access: sdk.StorageCapabilities['storageAccess']
      try {
        const caps = (await provider.getCapabilities()).storageAccess
        access = caps?.version === 1 ? caps : undefined
      } catch {
        access = undefined
      }
      this.#requireProviderTransition(scope)
      if (this._services !== undefined) provider.setServices(this._services)
      // A concrete native controller rechecks its actual target after provider
      // availability/user/capability I/O, before any managed selection changes.
      // This callback itself supplies no storage or native admission authority.
      await beforeInstall?.()
      this.#requireProviderTransition(scope)
      store.settings = settings
      store.user = result.user
      store.access = access
      store.isAvailable = true
      // No await after changing the actual managed selection. Every waiting
      // request observes this provider or the retained recovery barrier.
      this._stores = original.stores.map(value => (value === original.original ? store : value))
      this._active = store
      this._backups = [...original.backups]
      this._conflictingActives = [...original.conflicts]
      this.generation++
      this.#providerReplacementPending = undefined
      this._isAvailable = true
      this._authId.userId = result.user.userId
      this._authId.isActive = this.isActiveEnabled
      owned.installed = true
    })
  }

  /** Capture the actual selected writer briefly; rejoin ownership at its financial commits. */
  private async runAsAuthorizedWriter<R>(
    operation: (writer: sdk.WalletStorageWriter, auth: sdk.AuthId) => Promise<R>
  ): Promise<R> {
    const selected = await this.runAsWriter(async writer => ({
      writer,
      auth: { ...(await this.getAuth(true)) },
      generation: this.generation
    }))
    const prepared = selected.writer as sdk.WalletStorageWriter & Partial<StoragePreparedWalletWriter>
    // Probe outside ownership: a remote capability lookup cannot hold the
    // global queue. Unsupported/older providers retain the exact old dispatch.
    if (
      typeof prepared.supportsPreparedWalletWrites !== 'function' ||
      typeof prepared.withPreparedWalletWrite !== 'function' ||
      !(await prepared.supportsPreparedWalletWrites())
    )
      return await this.runAsWriter(async writer => await operation(writer, await this.getAuth(true)))
    const admission: StorageWriterAdmission = async <T>(work: () => Promise<T>): Promise<T> =>
      await this.withAccess(active =>
        awaitFromSync(() => {
          if (
            active !== selected.writer ||
            this.generation !== selected.generation ||
            this._authId.identityKey !== selected.auth.identityKey
          )
            throw new WERR_INVALID_OPERATION('Wallet preparation belongs to an obsolete manager provider or generation')
          return work()
        })
      )
    return await prepared.withPreparedWalletWrite(selected.auth, admission, () =>
      awaitFromSync(() => operation(selected.writer, selected.auth))
    )
  }

  runAsReader<R>(reader: (active: sdk.WalletStorageReader) => Promise<R>): Promise<R> {
    return this.withAccess(reader, true)
  }

  /** Preserve the legacy reader contract: obtain caller auth before joining the ownership queue. */
  private runAsAuthorizedReader<R>(
    operation: (reader: sdk.WalletStorageReader, auth: sdk.AuthId) => Promise<R>
  ): Promise<R> {
    return mapAwaitFromSync(
      () => this.getAuth(),
      auth => {
        return this.runAsReader(reader => operation(reader, auth))
      }
    )
  }

  /** Borrowed activeSync is the legacy explicit reentrancy contract for an already-held exclusive operation. */
  async runAsSync<R>(
    sync: (active: sdk.WalletStorageSync) => Promise<R>,
    activeSync?: sdk.WalletStorageSync
  ): Promise<R> {
    return activeSync == null ? await this.withAccess(sync) : await sync(activeSync)
  }

  private runAsSyncCancellable<R>(
    sync: (active: sdk.WalletStorageSync) => Promise<R>,
    signal?: AbortSignal
  ): Promise<R | undefined> {
    return commitSyncAdmission(
      operation => this.withAccess(() => operation(), false, true, signal),
      () => sync(this.getActive()),
      signal
    )
  }

  private captureSyncSelection(signal?: AbortSignal): Promise<
    | {
        active: sdk.WalletStorageProvider
        generation: number
      }
    | undefined
  > {
    return commitSyncAdmission(
      operation => this.withAccess(() => operation(), false, false, signal),
      () => promiseFromSync(() => ({ active: this.getActive(), generation: this.generation })),
      signal
    )
  }

  runAsStorageProvider<R>(sync: (active: StorageProvider) => Promise<R>, background = false): Promise<R> {
    return this.withAccess(
      active => {
        if (!active.isStorageProvider()) {
          throw new WERR_INVALID_OPERATION(
            'Active "WalletStorageProvider" does not support "StorageProvider" interface.'
          )
        }
        return sync(active as unknown as StorageProvider)
      },
      false,
      background
    )
  }

  /**
   * Reorg notifications call this before aging or replacement-proof I/O. The
   * active Knex store closes its in-process prepared-read gate synchronously,
   * then advances the shared database epoch and stales artifacts. A failed
   * invalidation deliberately leaves reads suspended so canonical BEEF remains
   * the safe path until a later invalidation succeeds or the process restarts.
   */
  invalidatePreparedBeefsForReorg(): Promise<void> {
    const active = this.getActive()
    const extension = active as unknown as Partial<PreparedBeefInvalidationExtension>
    const release =
      typeof extension.suspendPreparedBeefReads === 'function'
        ? extension.suspendPreparedBeefReads.call(active)
        : undefined
    return this.runAsStorageProvider(async storage => {
      await storage.transaction(trx => awaitVoidFromSync(() => invalidatePreparedBeefs(storage, trx)))
    }).then(() => {
      release?.()
    })
  }

  /**
   *
   * @returns true if the active `WalletStorageProvider` also implements `StorageProvider`
   */
  isActiveStorageProvider(): boolean {
    return this.getActive().isStorageProvider()
  }

  async addWalletStorageProvider(provider: sdk.WalletStorageProvider): Promise<void> {
    const settings = await provider.makeAvailable()
    const add = async (): Promise<void> => {
      await this.preflightManagedNetworks(settings)
      if (this._services != null) provider.setServices(this._services)
      const store = new ManagedStorage(provider)
      store.settings = settings
      this._stores.push(store)
      this._isAvailable = false
      await this.makeAvailable()
    }
    if (this._stores.length === 0) await add()
    else await this.withAccess(add)
  }

  /** Restart registration of an explicitly selected, durably activated browser
   * profile. Actual native metadata is read under the manager's current queue;
   * a publication receipt supplied by the caller is never admitted. This is
   * an empty-manager/profile recovery path. Existing different providers need
   * normal source reconciliation and primary cutover, not a restore overwrite. */
  async addRestoredBrowserStorageProvider(
    provider: StorageIdb,
    options: Brc38IdbProfileSelectionOptions
  ): Promise<void> {
    const captured = Object.freeze({
        workingAllocation: options.workingAllocation,
        expiresAt: options.expiresAt,
        signal: options.signal
      }),
      identityKey = this._authId.identityKey
    const transition = await this.primaryTransitions.acquire('exclusive')
    let release: (() => void) | undefined,
      registered = false
    try {
      release = await this.accessQueue.acquire('exclusive', 'foreground')
      captured.signal?.throwIfAborted()
      if (
        this._authId.identityKey !== identityKey ||
        this._stores.length > 1 ||
        (this._stores.length === 1 && this._stores[0].storage !== provider)
      )
        throw new WERR_INVALID_OPERATION(
          'Restored profile registration needs an empty manager or its same current provider'
        )
      const selection = await provider.readRestoredProfileSelection(captured)
      if (selection.publication.state !== 'ACTIVATED' || selection.publication.identityKey !== identityKey)
        throw new WERR_INVALID_OPERATION('Restored profile is not the native activated selection for this identity')
      const settings = await provider.readSettings(),
        fresh = await provider.readRestoredProfileSelection(captured)
      if (
        fresh.epoch !== selection.epoch ||
        fresh.revision !== selection.revision ||
        JSON.stringify(fresh.publication) !== JSON.stringify(selection.publication) ||
        settings.chain !== fresh.publication.chain ||
        settings.storageIdentityKey !== fresh.publication.targetStorageIdentityKey
      )
        throw new WERR_INVALID_OPERATION('Restored profile selection changed before manager registration')
      if (this._services != null) provider.setServices(this._services)
      if (this._stores.length === 0) {
        const store = new ManagedStorage(provider)
        store.settings = settings
        this._stores.push(store)
      }
      registered = true
      this.invalidatePrimarySelection()
      await this.makeAvailable()
      if (
        this.getActive() !== provider ||
        this.getActiveUser().userId !== selection.userId ||
        this.getActiveStore() !== fresh.publication.targetStorageIdentityKey ||
        !this.isActiveEnabled
      )
        throw new WERR_INVALID_OPERATION('Restored native primary did not become this manager selection')
    } catch (cause) {
      if (registered) this.invalidatePrimarySelection()
      throw cause
    } finally {
      release?.()
      transition()
    }
  }

  setServices(v: sdk.WalletServices): void {
    this._services = v
    for (const store of this._stores) store.storage.setServices(v)
  }

  getServices(): sdk.WalletServices {
    if (this._services == null) throw new WERR_INVALID_OPERATION('Must setServices first.')
    return this._services
  }

  getSettings(): TableSettings {
    return this.getActive().getSettings()
  }

  migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    return this.runAsWriter(writer => writer.migrate(storageName, storageIdentityKey))
  }

  async destroy(): Promise<void> {
    if (this._stores.length < 1) return
    if (this.#primaryHandoffPending !== undefined) {
      const leave = this.accessQueue.admit(),
        release = await this.accessQueue.acquire('exclusive')
      try {
        this.generation++
        for (const store of this._stores) await store.storage.destroy()
      } finally {
        release()
        leave()
      }
      return
    }
    return await this.runAsWriter(async _writer => {
      this.generation++
      for (const store of this._stores) await store.storage.destroy()
    })
  }

  async findOrInsertUser(identityKey: string): Promise<{ user: TableUser; isNew: boolean }> {
    const auth = await this.getAuth()
    if (identityKey !== auth.identityKey) throw new WERR_UNAUTHORIZED()

    return await this.runAsWriter(writer =>
      mapAwaitFromSync(
        () => writer.findOrInsertUser(identityKey),
        r => {
          if (auth.userId != null && auth.userId !== 0 && auth.userId !== r.user.userId) {
            throw new WERR_INTERNAL('userId may not change for given identityKey')
          }
          this._authId.userId = r.user.userId
          return r
        }
      )
    )
  }

  abortAction(args: AbortActionArgs): Promise<AbortActionResult> {
    return awaitFromSync(() => {
      validateAbortActionArgs(args)
      return this.runAsAuthorizedWriter((writer, auth) => writer.abortAction(auth, args))
    })
  }

  createAction(vargs: ValidCreateActionArgs): Promise<sdk.StorageCreateActionResult> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.createAction(auth, vargs))
  }

  internalizeAction(args: InternalizeActionArgs): Promise<sdk.StorageInternalizeActionResult> {
    return awaitFromSync(() => {
      validateInternalizeActionArgs(args)
      return this.runAsAuthorizedWriter((writer, auth) => writer.internalizeAction(auth, args))
    })
  }

  /** Capability of the actual authorized writer, not a remote BRC-100 assumption. */
  async getBrc197InternalizationCapabilities(): Promise<Brc197InternalizationCapabilities> {
    return await this.runAsWriter(async writer => {
      if (typeof writer.internalizeBrc197Action !== 'function') {
        throw new WERR_NOT_IMPLEMENTED(
          'The active provider does not support local BRC-197 fixed-child internalization.'
        )
      }
      const auth = await this.getAuth(true)
      return {
        profile: BRC197_INTERNALIZATION_PROFILE,
        recipientIdentityKey: auth.identityKey,
        childPublicKey: brc197ChildPublicKey(auth.identityKey)
      }
    })
  }

  async internalizeBrc197Action(args: Brc197InternalizeActionArgs): Promise<sdk.StorageInternalizeActionResult> {
    const owned = ownBrc197InternalizeActionArgs(args)
    return await this.runAsWriter(async writer => {
      const internalize = writer.internalizeBrc197Action
      if (typeof internalize !== 'function') {
        throw new WERR_NOT_IMPLEMENTED(
          'The active provider does not support local BRC-197 fixed-child internalization.'
        )
      }
      const auth = await this.getAuth(true)
      assertBrc197Recipient(owned, auth.identityKey)
      return await internalize.call(writer, auth, owned)
    })
  }

  relinquishCertificate(args: RelinquishCertificateArgs): Promise<number> {
    return awaitFromSync(() => {
      validateRelinquishCertificateArgs(args)
      return this.runAsAuthorizedWriter((writer, auth) => writer.relinquishCertificate(auth, args))
    })
  }

  relinquishOutput(args: RelinquishOutputArgs): Promise<number> {
    return awaitFromSync(() => {
      validateRelinquishOutputArgs(args)
      return this.runAsAuthorizedWriter((writer, auth) => writer.relinquishOutput(auth, args))
    })
  }

  processAction(args: sdk.StorageProcessActionArgs): Promise<sdk.StorageProcessActionResults> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.processAction(auth, args))
  }

  prepareNoSendExpiry(args: ValidCreateActionArgs): Promise<sdk.StoragePrepareNoSendExpiryResult> {
    return this.runAsAuthorizedWriter((writer, auth) =>
      awaitFromSync(() => {
        if (writer.prepareNoSendExpiry == null) {
          throw new WERR_INVALID_OPERATION('Active storage does not support BRC-177 noSend expiry')
        }
        return writer.prepareNoSendExpiry(auth, args)
      })
    )
  }

  activateNoSendExpiry(args: sdk.StorageActivateNoSendExpiryArgs): Promise<sdk.StorageActivateNoSendExpiryResult> {
    return this.runAsAuthorizedWriter((writer, auth) =>
      awaitFromSync(() => {
        if (writer.activateNoSendExpiry == null) {
          throw new WERR_INVALID_OPERATION('Active storage does not support BRC-177 noSend expiry')
        }
        return writer.activateNoSendExpiry(auth, args)
      })
    )
  }

  async armNoSendExpiry(args: sdk.StorageArmNoSendExpiryArgs): Promise<void> {
    await this.runAsAuthorizedWriter(async (writer, auth) => {
      if (writer.armNoSendExpiry == null) {
        throw new WERR_INVALID_OPERATION('Active storage does not support BRC-177 noSend expiry')
      }
      await writer.armNoSendExpiry(auth, args)
    })
  }

  getCapabilities(): Promise<sdk.StorageCapabilities> {
    return this.runAsReader(() => this.getActive().getCapabilities())
  }

  beginActionBatch(args: sdk.BeginActionBatchArgs): Promise<sdk.BeginActionBatchResult> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.beginActionBatch(auth, args))
  }

  extendActionBatch(args: sdk.ExtendActionBatchArgs): Promise<sdk.ExtendActionBatchResult> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.extendActionBatch(auth, args))
  }

  renewActionBatch(batchId: string): Promise<sdk.RenewActionBatchResult> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.renewActionBatch(auth, batchId))
  }

  resumeActionBatch(args: sdk.ResumeActionBatchArgs): Promise<sdk.ResumeActionBatchResult> {
    return this.runAsAuthorizedWriter((writer, auth) =>
      awaitFromSync(() => {
        if (writer.resumeActionBatch == null) {
          throw new WERR_NOT_IMPLEMENTED('action batch resume is not available')
        }
        return writer.resumeActionBatch(auth, args)
      })
    )
  }

  prepareActionBatchCommit(manifest: sdk.ActionBatchManifest): Promise<sdk.PrepareActionBatchCommitResult> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.prepareActionBatchCommit(auth, manifest))
  }

  putActionBatchBlob(args: sdk.PutActionBatchBlobArgs): Promise<void> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.putActionBatchBlob(auth, args))
  }

  putActionBatchPack(args: sdk.PutActionBatchPackArgs): Promise<void> {
    return this.runAsAuthorizedWriter(async (writer, auth) => {
      if (writer.putActionBatchPack == null) {
        throw new WERR_NOT_IMPLEMENTED('packed action batch uploads are not available')
      }
      await writer.putActionBatchPack(auth, args)
    })
  }

  commitActionBatch(manifest: sdk.ActionBatchManifest): Promise<sdk.CommitActionBatchResult> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.commitActionBatch(auth, manifest))
  }

  commitActionBatchByDigest(args: sdk.CommitActionBatchByDigestArgs): Promise<sdk.CommitActionBatchResult> {
    return this.runAsAuthorizedWriter((writer, auth) =>
      awaitFromSync(() => {
        if (writer.commitActionBatchByDigest == null) {
          throw new WERR_NOT_IMPLEMENTED('digest-only action batch commit is not available')
        }
        return writer.commitActionBatchByDigest(auth, args)
      })
    )
  }

  abortActionBatch(batchId: string): Promise<sdk.AbortActionBatchResult> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.abortActionBatch(auth, batchId))
  }

  insertCertificate(certificate: TableCertificate): Promise<number> {
    return this.runAsAuthorizedWriter((writer, auth) => writer.insertCertificateAuth(auth, certificate))
  }

  listActions(vargs: ValidListActionsArgs): Promise<ListActionsResult> {
    return this.runAsAuthorizedReader((reader, auth) => reader.listActions(auth, vargs))
  }

  listCertificates(args: ValidListCertificatesArgs): Promise<ListCertificatesResult> {
    return this.runAsAuthorizedReader((reader, auth) => reader.listCertificates(auth, args))
  }

  listOutputs(vargs: ValidListOutputsArgs): Promise<ListOutputsResult> {
    return this.runAsAuthorizedReader((reader, auth) => reader.listOutputs(auth, vargs))
  }

  findCertificates(args: sdk.FindCertificatesArgs): Promise<TableCertificateX[]> {
    return this.runAsAuthorizedReader((reader, auth) => reader.findCertificatesAuth(auth, args))
  }

  findOutputBaskets(args: sdk.FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    return this.runAsAuthorizedReader((reader, auth) => reader.findOutputBasketsAuth(auth, args))
  }

  findOutputs(args: sdk.FindOutputsArgs): Promise<TableOutput[]> {
    return this.runAsAuthorizedReader((reader, auth) => reader.findOutputsAuth(auth, args))
  }

  findProvenTxReqs(args: sdk.FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    return this.runAsReader(reader => reader.findProvenTxReqs(args))
  }

  /**
   * For each proven_txs record currently sourcing its transaction merkle proof from the given deactivated header,
   * attempt to reprove the transaction against the current chain,
   * updating the proven_txs record if a new valid proof is found.
   *
   * @param deactivatedHash An orphaned header than may have served as a proof source for proven_txs records.
   * @returns
   */
  reproveHeader(deactivatedHash: string): Promise<sdk.ReproveHeaderResult> {
    return awaitFromSync(() =>
      this.reproveMatching({ blockHash: deactivatedHash }, `block ${deactivatedHash} orphaned`)
    )
  }

  /** Audit a stale root against the same canonical evidence as reorg recovery. */
  reproveHeightMerkleRoot(height: number, staleMerkleRoot: string): Promise<sdk.ReproveHeaderResult> {
    return awaitFromSync(() =>
      this.reproveMatching(
        { height, merkleRoot: staleMerkleRoot },
        `height ${height} stale merkleRoot ${staleMerkleRoot}`
      )
    )
  }

  private assertProofDestination(storage: StorageProvider, generation: number): void {
    if (this.getActive() !== storage || this.generation !== generation) {
      throw new WERR_INVALID_OPERATION(
        'Proof destination changed during recovery; retry on the selected storage provider.'
      )
    }
  }

  private async prepareReproof(
    storage: StorageProvider,
    ptx: TableProvenTx
  ): Promise<{
    result: sdk.ReproveProvenResult
    replacement?: TableProvenTx
  }> {
    const result: sdk.ReproveProvenResult = { log: '', updated: undefined, unchanged: false, unavailable: false }
    try {
      const replacement = await refreshSyncProof(storage, ptx)
      if (sameSyncProof(ptx, replacement)) {
        result.unchanged = true
        result.log = `    txid ${ptx.txid} canonical proof unchanged\n`
        return { result }
      }
      result.updated = {
        update: recoveredProofUpdate(ptx, replacement),
        logUpdate: `      height ${ptx.height} -> ${replacement.height}\n`
      }
      return { result, replacement }
    } catch {
      result.unavailable = true
      result.log = `    txid ${ptx.txid} canonical proof unavailable\n`
      return { result }
    }
  }

  private async reproveMatching(partial: Partial<TableProvenTx>, label: string): Promise<sdk.ReproveHeaderResult> {
    const { storage, generation, ptxs } = await this.runAsStorageProvider(async storage => ({
      storage,
      generation: this.generation,
      ptxs: await storage.findProvenTxs({ partial })
    }))
    // Bound external work and leave foreground storage access available while
    // providers fetch proofs/headers. Every replacement is validated before SQL/IDB.
    const prepared = await mapProofWork(ptxs, ptx => this.prepareReproof(storage, ptx))
    const result: sdk.ReproveHeaderResult = {
      log: `  ${label} with ${ptxs.length} impacted transactions\n`,
      updated: [],
      unchanged: [],
      unavailable: []
    }
    await this.runAsStorageProvider(async active => {
      this.assertProofDestination(storage, generation)
      if (ptxs.length === 0) return
      await active.transaction(async trx => {
        // Keep proof writes and their result log in source order within this transaction.
        await runInSeries(ptxs.entries(), async ([index, ptx]) => {
          const { result: proof, replacement } = prepared[index]
          result.log += proof.log
          if (replacement !== undefined && proof.updated !== undefined) {
            if (await active.compareAndSetProvenTxProof(ptx, replacement, trx)) {
              result.updated.push({ was: ptx, ...proof.updated })
              result.log += `    txid ${ptx.txid} proof data updated\n` + proof.updated.logUpdate
            } else {
              result.unavailable.push(ptx)
              result.log += `    txid ${ptx.txid} proof changed concurrently or provider cannot commit safely; retry\n`
            }
          } else if (proof.unchanged) result.unchanged.push(ptx)
          else result.unavailable.push(ptx)
        })
        // Even unavailable replacements invalidate material built from the
        // orphaned header. Proof rows and the prepared epoch commit atomically.
        await invalidatePreparedBeefs(active, trx)
      })
    })
    return result
  }

  /** Validate current-chain evidence; noUpdate returns a proposal without persisting it. */
  async reproveProven(ptx: TableProvenTx, noUpdate?: boolean): Promise<sdk.ReproveProvenResult> {
    // The caller retains its input while proof I/O runs outside queue ownership.
    ptx = {
      ...ptx,
      rawTx: ptx.rawTx.slice(),
      merklePath: ptx.merklePath.slice(),
      created_at: new Date(ptx.created_at),
      updated_at: new Date(ptx.updated_at)
    }
    const { storage, generation } = await this.runAsStorageProvider(storage =>
      Promise.resolve({ storage, generation: this.generation })
    )
    const { result, replacement } = await this.prepareReproof(storage, ptx)
    await this.runAsStorageProvider(async active => {
      this.assertProofDestination(storage, generation)
      if (replacement === undefined || result.updated === undefined || noUpdate === true) return
      const updated = result.updated
      await active.transaction(async trx => {
        if (await active.compareAndSetProvenTxProof(ptx, replacement, trx)) {
          await invalidatePreparedBeefs(active, trx)
          result.log += `    txid ${ptx.txid} proof data updated\n` + updated.logUpdate
        } else {
          result.updated = undefined
          result.unavailable = true
          result.log += `    txid ${ptx.txid} proof changed concurrently or provider cannot commit safely; retry\n`
        }
      })
    })
    return result
  }

  private async loadSyncRequest(
    auth: sdk.AuthId,
    writer: sdk.WalletStorageSync,
    readerSettings: TableSettings,
    toStorageIdentityKey: string
  ): Promise<sdk.RequestSyncChunkArgs> {
    const compact = await writer.getSyncCheckpoint?.(
      auth,
      readerSettings.storageIdentityKey,
      readerSettings.storageName
    )
    if (compact != null) {
      return {
        ...validateSyncCheckpoint(compact),
        identityKey: auth.identityKey,
        fromStorageIdentityKey: readerSettings.storageIdentityKey,
        toStorageIdentityKey,
        maxItems: 1000,
        maxRoughSize: 10000000
      }
    }
    const ss = await EntitySyncState.fromStorage(writer, auth.identityKey, readerSettings)
    return ss.makeRequestSyncChunkArgs(auth.identityKey, toStorageIdentityKey)
  }

  private snapshotCommit(
    destination: SnapshotSyncStorage,
    options: SyncSessionOptions,
    generation: number,
    active: sdk.WalletStorageProvider
  ): <T>(operation: () => Promise<T>) => Promise<T> {
    const assertCurrent = (): void => {
      if (generation !== this.generation || active !== this.getActive())
        throw new WERR_INVALID_OPERATION('Snapshot sync primary generation changed; resume on the selected storage')
    }
    return async <T>(operation: () => Promise<T>): Promise<T> => {
      if (destination.commitOutsideManager === true) {
        // Dispatch starts only inside current queue admission. Returning the
        // wrapper releases it immediately, without awaiting the remote promise.
        // The actual server owns SQL serialization and the current primary
        // epoch. In-flight replies cannot revive a replaced manager generation.
        const dispatched = await this.withAccess(
          () => {
            assertCurrent()
            const result = operation()
            void result.catch(() => undefined)
            return Promise.resolve({ result })
          },
          false,
          true,
          options.signal
        )
        const result = await dispatched.result
        assertCurrent()
        return result
      }
      return await this.withAccess(
        () => {
          assertCurrent()
          return operation()
        },
        false,
        true,
        options.signal
      )
    }
  }

  private runSnapshotCopy(
    view: WalletReadSnapshot,
    destination: SnapshotSyncStorage,
    direction: 'push' | 'pull',
    options: SyncSessionOptions,
    generation: number,
    active: sdk.WalletStorageProvider
  ): Promise<SyncSessionResult> {
    return awaitFromSync(() => {
      if (view.user.identityKey !== this._authId.identityKey) throw new WERR_UNAUTHORIZED()
      const commit = this.snapshotCommit(destination, options, generation, active)
      return runSnapshotSyncSession(
        {
          view,
          destination,
          activeStorage: direction === 'push' ? view.user.activeStorage : this.getActiveUser().activeStorage,
          commit
        },
        options
      )
    })
  }

  private committedPageLog(progress: SyncSessionProgress, logger: (message: string) => string): string {
    if (progress.state !== 'committed') return ''
    return logger(
      `chunk ${progress.pages - 1} committed: ${progress.inserts} total inserts, ${progress.updates} total updates\n`
    )
  }

  private async runLegacySnapshotFallback(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    direction: 'push' | 'pull',
    options: SyncSessionOptions,
    selected: { generation: number; active: sdk.WalletStorageProvider }
  ): Promise<SyncSessionResult> {
    const readerSettings = await reader.makeAvailable()
    const writerSettings = await writer.makeAvailable()
    assertSyncNetwork(readerSettings, writerSettings)
    return (
      (await this.runAsSyncCancellable(() => {
        if (selected.generation !== this.generation || selected.active !== this.getActive()) {
          throw new WERR_INVALID_OPERATION('Snapshot sync primary generation changed; resume on the selected storage')
        }
        return runPullSession(
          {
            reader,
            writer,
            mode: 'exclusive',
            atomicCheckpoint: false,
            activeStorage: direction === 'pull' ? this.getActiveUser().activeStorage : undefined,
            loadRequest: () =>
              this.loadSyncRequest(this._authId, writer, readerSettings, writerSettings.storageIdentityKey),
            commit: operation => operation()
          },
          options
        )
      }, options.signal)) ?? { status: 'cancelled', mode: 'exclusive', pages: 0, inserts: 0, updates: 0 }
    )
  }

  private async trySnapshotCopy(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    direction: 'push' | 'pull',
    options: SyncSessionOptions = {},
    selection?: { generation: number; active: sdk.WalletStorageProvider }
  ): Promise<SyncSessionResult | undefined> {
    const selected = selection ?? { generation: this.generation, active: this.getActive() }
    const source = reader.getSnapshotSync?.()
    const destination = writer.getSnapshotSync?.()
    if (source === undefined || destination === undefined || reader === writer) return undefined
    if (!(await destination.supportsDestination())) return undefined
    const cancelled = (): boolean => options.signal?.aborted === true
    if (cancelled()) return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
    let observerFailure: { error: unknown } | undefined
    let view: WalletReadSnapshot | undefined
    let partial: Pick<SyncSessionResult, 'pages' | 'inserts' | 'updates' | 'snapshotCheckpoint'> = {
      pages: 0,
      inserts: 0,
      updates: 0
    }
    try {
      const content =
        source.observeContentRevision !== undefined &&
        destination.supportsContentDestination !== undefined &&
        destination.beginContent !== undefined &&
        destination.previousContentReceipt !== undefined &&
        destination.confirmContentReceipt !== undefined &&
        (await destination.supportsContentDestination())
      if (content) {
        const identityKey = this._authId.identityKey,
          sourceIdentity = (await reader.makeAvailable()).storageIdentityKey,
          previous = await destination.previousContentReceipt!(identityKey, sourceIdentity)
        if (cancelled()) return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
        if (previous !== undefined) {
          const prior = { ...previous.checkpoint, cursor: copySnapshotCursor(previous.checkpoint.cursor) }
          const observed = await source.observeContentRevision!(
            identityKey,
            snapshotSyncContentPosition(previous.source),
            { lifetimeMs: options.snapshotLifetimeMs, signal: options.signal }
          )
          if (cancelled()) return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
          if (observed !== undefined) {
            const revision = parseSnapshotSyncContentRevision(observed)
            const confirmed = await this.snapshotCommit(
              destination,
              options,
              selected.generation,
              selected.active
            )(() => destination.confirmContentReceipt!(identityKey, sourceIdentity, revision))
            if (confirmed !== undefined) {
              if (
                !prior.done ||
                !confirmed.done ||
                prior.cursor !== undefined ||
                confirmed.cursor !== undefined ||
                [
                  'version',
                  'sessionId',
                  'identityKey',
                  'sourceStorageIdentityKey',
                  'destinationStorageIdentityKey',
                  'snapshotId',
                  'sequence',
                  'tableIndex',
                  'done'
                ].some(key => prior[key as keyof typeof prior] !== confirmed[key as keyof typeof confirmed])
              )
                throw new WERR_INVALID_OPERATION('Content confirmation changed the previous durable copy ACK')
              const result: SyncSessionResult = {
                status: cancelled() ? 'cancelled' : 'completed',
                mode: 'paged',
                pages: 0,
                inserts: 0,
                updates: 0,
                noChangeReceipt: { checkpoint: { ...confirmed }, source: revision }
              }
              try {
                options.onProgress?.({
                  ...result,
                  noChangeReceipt: { checkpoint: { ...confirmed }, source: revision },
                  state: result.status
                })
              } catch (error) {
                observerFailure = { error }
                throw error
              }
              return result
            }
          }
        }
      }
      const sourceOptions = { lifetimeMs: options.snapshotLifetimeMs, signal: options.signal }
      view =
        content && source.openContentSource !== undefined
          ? await source.openContentSource(this._authId.identityKey, sourceOptions)
          : undefined
      if (view === undefined) view = await source.openSource(this._authId.identityKey, sourceOptions)
      if (view === undefined) return undefined
      let failed = false
      try {
        return await this.runSnapshotCopy(
          view,
          destination,
          direction,
          {
            ...options,
            onProgress: progress => {
              partial = {
                pages: progress.pages,
                inserts: progress.inserts,
                updates: progress.updates,
                snapshotCheckpoint:
                  progress.snapshotCheckpoint === undefined
                    ? undefined
                    : {
                        ...progress.snapshotCheckpoint,
                        cursor: copySnapshotCursor(progress.snapshotCheckpoint.cursor)
                      }
              }
              try {
                options.onProgress?.(progress)
              } catch (error) {
                observerFailure = { error }
                throw error
              }
            }
          },
          selected.generation,
          selected.active
        )
      } catch (error) {
        failed = true
        throw error
      } finally {
        await view.close().catch(error => {
          // A simultaneous expiry must not replace a malformed-row/session error.
          // A physical cleanup failure, however, cannot be hidden by fallback.
          if (source.fallbackOnResourceError === false || !failed || !(error instanceof SnapshotResourceLimitError))
            throw error
        })
      }
    } catch (error) {
      if (observerFailure !== undefined && error === observerFailure.error) throw error
      if (cancelled() && (error instanceof SnapshotCancelledError || error === options.signal?.reason))
        return { status: 'cancelled', mode: 'paged', ...partial }
      // Existing ordinary backups must continue to accept large records and long
      // copies. Only explicit resource limits select the established serialized
      // fallback; corrupt rows, changed sessions and I/O failures still reject.
      if (source.fallbackOnResourceError === false || !(error instanceof SnapshotResourceLimitError)) throw error
    }
    const result = await this.runLegacySnapshotFallback(
      reader,
      writer,
      direction,
      {
        ...options,
        onProgress: progress => {
          options.onProgress?.({
            ...progress,
            pages: partial.pages + progress.pages,
            inserts: partial.inserts + progress.inserts,
            updates: partial.updates + progress.updates
          })
        }
      },
      selected
    )
    return {
      ...result,
      pages: partial.pages + result.pages,
      inserts: partial.inserts + result.inserts,
      updates: partial.updates + result.updates
    }
  }

  private journalCopyAdmission(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    selected: { generation: number; active: sdk.WalletStorageProvider },
    identityKey: string,
    signal?: AbortSignal
  ) {
    const handoff = this.primaryCopyAdmissions.get(selected)
    if (handoff !== undefined) return handoff
    const managedReader = this._stores.some(store => Object.is(store.storage, reader))
    const managedWriter = this._stores.some(store => store.storage === writer)
    return <T>(operation: () => Promise<T>, observe?: 'observe'): Promise<T> =>
      this.withAccess(
        async active => {
          if (
            (observe !== 'observe' && (active !== selected.active || selected.generation !== this.generation)) ||
            identityKey !== this._authId.identityKey ||
            (managedReader && !this._stores.some(store => Object.is(store.storage, reader))) ||
            (managedWriter && !this._stores.some(store => store.storage === writer))
          )
            throw new WERR_INVALID_OPERATION('Journal copy selection changed; open a fresh source')
          if ((await this.getAuth()).identityKey !== identityKey) throw new WERR_UNAUTHORIZED()
          return await operation()
        },
        false,
        true,
        observe === 'observe' ? undefined : signal
      )
  }

  private journalCopyProgress(
    options: SyncSessionOptions,
    onDurableProgress?: (value: SnapshotJournalReconciliationProgress) => void
  ) {
    return (progress: SnapshotJournalReconciliationProgress): void => {
      onDurableProgress?.(progress)
      options.onProgress?.({
        state:
          progress.state === 'complete'
            ? 'completed'
            : progress.state === 'stopped'
              ? 'cancelled'
              : progress.state === 'cancelRequested'
                ? 'cancelling'
                : 'committed',
        mode: 'paged',
        ...progress.progress,
        journalCheckpoint: {
          ...progress.checkpoint,
          ...(progress.checkpoint.after === undefined ? {} : { after: { ...progress.checkpoint.after } })
        }
      })
      options.onJournalProgress?.(progress)
    }
  }

  /** Confirm only comparison DATA. No source SQL actor is reconstructed and
   * the returned checkpoint is the prior actual completed financial ACK. */
  private async confirmJournalContentCopy(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    sourceStorageIdentity: string,
    identityKey: string,
    admission: SnapshotJournalWriterAdmission,
    options: SyncSessionOptions,
    fields = false,
    forceCurrentCopy = false
  ): Promise<{ forceBootstrap: boolean; result?: SyncSessionResult }> {
    // A handoff needs an actual warm capture before retirement, even when an
    // older content receipt could optimize an ordinary unchanged backup.
    if (forceCurrentCopy) return { forceBootstrap: false }
    const outside = snapshotJournalDataProvider(writer) && writer.journalDataCommitOutsideManager === true
    const dispatch = async (observe = false): Promise<void> => {
      if (outside) await admission(() => awaitFromSync(() => this.getAuth()), observe ? 'observe' : undefined)
    }
    let forceBootstrap = false
    const observer = reader.getSnapshotSync?.()
    if (
      snapshotJournalDataContentProvider(writer) &&
      (fields
        ? snapshotJournalFieldProvider(writer) && (await writer.supportsSnapshotJournalFieldSync())
        : await writer.supportsSnapshotJournalDataContent()) &&
      observer?.observeContentRevision !== undefined
    ) {
      await dispatch(true)
      const prior =
        fields && snapshotJournalFieldProvider(writer)
          ? await writer.getSnapshotJournalFieldContentReceipt(identityKey, sourceStorageIdentity, { admission })
          : await writer.getSnapshotJournalDataContentReceipt(identityKey, sourceStorageIdentity, { admission })
      if (options.signal?.aborted)
        return {
          forceBootstrap: false,
          result: { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
        }
      if (prior !== undefined) {
        const observed = await observer.observeContentRevision(identityKey, snapshotSyncContentPosition(prior.source), {
          lifetimeMs: options.snapshotLifetimeMs,
          signal: options.signal
        })
        if (options.signal?.aborted)
          return {
            forceBootstrap: false,
            result: { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
          }
        if (observed !== undefined && snapshotSyncContentConfirms(prior.source, observed)) {
          await dispatch()
          const confirmed =
            fields && snapshotJournalFieldProvider(writer)
              ? await writer.confirmSnapshotJournalFieldContentReceipt(identityKey, sourceStorageIdentity, observed, {
                  admission
                })
              : await writer.confirmSnapshotJournalDataContentReceipt(identityKey, sourceStorageIdentity, observed, {
                  admission
                })
          if (confirmed !== undefined) {
            if (
              JSON.stringify(confirmed.checkpoint) !== JSON.stringify(prior.checkpoint) ||
              !snapshotSyncContentConfirms(prior.source, confirmed.source)
            )
              throw new WERR_INVALID_OPERATION('Journal content confirmation changed its previous real ACK')
            const result: SyncSessionResult = {
              status: options.signal?.aborted ? 'cancelled' : 'completed',
              mode: 'paged',
              pages: 0,
              inserts: 0,
              updates: 0,
              journalCheckpoint: copyJournalCheckpoint(confirmed.checkpoint),
              noChangeJournalReceipt: confirmed
            }
            options.onProgress?.({
              ...result,
              state: result.status,
              journalCheckpoint: copyJournalCheckpoint(confirmed.checkpoint)
            })
            return { forceBootstrap: false, result }
          }
          // Source is unchanged but the actual destination cannot confirm its
          // postimage. Seek a new complete source, not an empty incremental ACK.
          forceBootstrap = true
        }
      }
    }
    return { forceBootstrap }
  }

  /** Recover the previous exact immutable window first. A new invocation still
   * observes/captures a fresh source afterwards, so an old ACK cannot silently
   * substitute for changes made since the interrupted copy. */
  private async recoverJournalFieldWindow(
    reader: sdk.WalletStorageSyncReader &
      import('./snapshot/journal/SnapshotJournalDataProvider').SnapshotJournalFieldArchiveRecoveryProvider,
    writer: sdk.WalletStorageProvider &
      import('./snapshot/journal/SnapshotJournalDataProvider').SnapshotJournalFieldProvider,
    previous: import('./snapshot/journal/SnapshotJournalDataProvider').SnapshotJournalFieldStatus,
    options: SyncSessionOptions,
    admission: SnapshotJournalWriterAdmission,
    dispatch: (observe?: boolean) => Promise<void>,
    onDurableProgress?: (value: SnapshotJournalReconciliationProgress) => void
  ): Promise<{ bootstrap: boolean; recovered?: SnapshotJournalReconciliationProgress }> {
    const reference = { source: previous.binding.source, receipt: previous.binding.receipt },
      identityKey = this._authId.identityKey,
      acknowledged = previous.checkpoint.phase === 'acknowledged',
      remoteRecovery =
        snapshotJournalFieldRecoveryProvider(writer) && (await writer.supportsSnapshotJournalFieldRecovery())
    // Older remote field peers retain their own existing contract. Presence of
    // modern client methods alone is not proof that their endpoint can recover.
    if (writer.journalDataCommitOutsideManager === true && !remoteRecovery) return { bootstrap: false }
    let archive:
        | import('./snapshot/journal/openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive
        | undefined,
      destination: SnapshotJournalFieldDestination | undefined,
      failure: { cause: unknown } | undefined
    const cleanup = new Brc38CleanupScope(async () => {
      const results = await Promise.allSettled([
          Promise.resolve().then(() => awaitFromSync(() => destination?.close?.())),
          Promise.resolve().then(async () => {
            if (archive !== undefined) await closeSnapshotJournalSource(archive, options.signal)
          })
        ]),
        causes = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
      try {
        await reader.retireSnapshotJournalFieldArchive(identityKey, reference)
      } catch (cause) {
        causes.push(cause)
      }
      if (causes.length === 0) return
      const all = [...(failure === undefined ? [] : [failure.cause]), ...causes]
      if (all.length === 1) throw all[0]
      throw new AggregateError(all, 'Field recovery and actual source/upload cleanup failed', { cause: all[0] })
    })
    const observer = this.journalCopyProgress(options, onDurableProgress),
      observe = (value: SnapshotJournalReconciliationProgress) => {
        if (acknowledged && value.state === 'complete') return
        // A recovered window is committed; the complete newly requested sync
        // still needs a fresh source observation/window below.
        observer(value.state === 'complete' ? { ...value, state: 'committed' } : value)
      }
    try {
      await dispatch(true)
      const upload =
        remoteRecovery && snapshotJournalFieldRecoveryProvider(writer)
          ? await writer.findSnapshotJournalFieldUpload(identityKey, reference.source.storageIdentity, {
              admission,
              signal: options.signal
            })
          : undefined
      let iterator:
        AsyncGenerator<SnapshotJournalReconciliationProgress, SnapshotJournalReconciliationProgress, void> | undefined
      if (upload !== undefined && snapshotJournalFieldRecoveryProvider(writer)) {
        if (
          JSON.stringify(upload.source.journal.source) !== JSON.stringify(reference.source) ||
          JSON.stringify(upload.source.journal.receipt) !== JSON.stringify(reference.receipt)
        )
          throw new WERR_INVALID_OPERATION('Recovered upload differs from the previous actual financial window')
        await dispatch()
        const actual = await writer.resumeSnapshotJournalFieldDestination(identityKey, upload, {
          admission,
          signal: options.signal,
          limits: journalCopyLimits(options.maxItems, options.maxRoughSize)
        })
        destination = actual
        if (actual.isUploadReady) iterator = actual.reconcileUploaded({ signal: options.signal, onProgress: observe })
      }
      if (iterator === undefined && !acknowledged) {
        if (destination === undefined && snapshotJournalFieldWindowRecoveryProvider(writer))
          destination = await writer.resumeSnapshotJournalFieldWindow(identityKey, reference, {
            admission,
            signal: options.signal,
            limits: journalCopyLimits(options.maxItems, options.maxRoughSize)
          })
        if (destination === undefined) return { bootstrap: true }
        archive = await reader.resumeSnapshotJournalFieldArchive(identityKey, reference, {
          lifetimeMs: options.snapshotLifetimeMs,
          signal: options.signal
        })
        if (archive === undefined) return { bootstrap: true }
        const actual = destination
        iterator = runSnapshotJournalFieldArchiveReconciliation(
          archive,
          () =>
            promiseFromSync(() => ({
              status: async () => {
                await dispatch(true)
                return await actual.status()
              },
              stageArchiveFrame: async (expected, source) => {
                await dispatch()
                return await actual.stageArchiveFrame(expected, source)
              },
              promote: async (expected, source) => {
                await dispatch()
                return await actual.promote(expected, source)
              },
              ...(actual.close === undefined ? {} : { close: () => actual.close!() })
            })),
          { signal: options.signal, onProgress: observe }
        )
      }
      if (iterator === undefined) return { bootstrap: false }
      let last: SnapshotJournalReconciliationProgress | undefined
      for await (const progress of iterator) last = progress
      if (last === undefined || (last.state !== 'complete' && last.state !== 'stopped'))
        throw new WERR_INVALID_OPERATION('Recovered field window did not physically drain')
      return { bootstrap: false, ...(acknowledged && last.state === 'complete' ? {} : { recovered: last }) }
    } catch (cause) {
      failure = { cause }
      throw cause
    } finally {
      await cleanup.close()
    }
  }

  /** Ordinary pulls keep network preparation outside the manager queue. Only
   * concrete target operations obtain the short, current writer admission. */
  private async copyJournalFieldWindow(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    options: SyncSessionOptions,
    selection?: { generation: number; active: sdk.WalletStorageProvider },
    onDurableProgress?: (value: SnapshotJournalReconciliationProgress) => void,
    skipRecovery = false,
    onRecoveredWindow?: (value: SnapshotJournalReconciliationProgress) => void
  ): Promise<SyncSessionResult | undefined> {
    if (
      !snapshotJournalFieldArchiveProvider(reader) ||
      !snapshotJournalFieldProvider(writer) ||
      !(await reader.supportsSnapshotJournalFieldArchive()) ||
      !(await writer.supportsSnapshotJournalFieldSync())
    )
      return undefined
    const selected = selection ?? (await this.captureSyncSelection(options.signal))
    if (selected === undefined || options.signal?.aborted)
      return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
    const identityKey = this._authId.identityKey,
      readerSettings = await reader.makeAvailable(),
      writerSettings = await writer.makeAvailable()
    assertSyncNetwork(readerSettings, writerSettings)
    const admission = this.journalCopyAdmission(reader, writer, selected, identityKey, options.signal)
    const dispatch = async (observe = false): Promise<void> => {
      if (writer.journalDataCommitOutsideManager === true)
        await admission(() => awaitFromSync(() => this.getAuth()), observe ? 'observe' : undefined)
    }
    await dispatch(true)
    const previous = await writer.getSnapshotJournalFieldStatus(identityKey, readerSettings.storageIdentityKey, {
      admission
    })
    let recoveredBootstrap = false
    if (
      !skipRecovery &&
      previous !== undefined &&
      snapshotJournalFieldArchiveRecoveryProvider(reader) &&
      (await reader.supportsSnapshotJournalFieldArchiveRecovery())
    ) {
      const recovery = await this.recoverJournalFieldWindow(
        reader,
        writer,
        previous,
        options,
        admission,
        dispatch,
        onDurableProgress
      )
      recoveredBootstrap = recovery.bootstrap
      if (recovery.recovered !== undefined) {
        const recovered = recovery.recovered
        if (recovered.state === 'stopped')
          return {
            status: 'cancelled',
            mode: 'paged',
            pages: recovered.progress.pages,
            inserts: recovered.progress.inserts,
            updates: recovered.progress.updates,
            journalCheckpoint: copyJournalCheckpoint(recovered.checkpoint)
          }
        onRecoveredWindow?.(recovered)
        const next = await this.copyJournalFieldWindow(
          reader,
          writer,
          {
            ...options,
            onProgress: value =>
              options.onProgress?.({
                ...value,
                pages: recovered.progress.pages + value.pages,
                inserts: recovered.progress.inserts + value.inserts,
                updates: recovered.progress.updates + value.updates
              })
          },
          selected,
          onDurableProgress,
          true,
          onRecoveredWindow
        )
        if (next === undefined)
          throw new WERR_INVALID_OPERATION('Field capability changed after recovery; start a fresh sync')
        return {
          ...next,
          pages: recovered.progress.pages + next.pages,
          inserts: recovered.progress.inserts + next.inserts,
          updates: recovered.progress.updates + next.updates
        }
      }
    }
    const confirmation = await this.confirmJournalContentCopy(
      reader,
      writer,
      readerSettings.storageIdentityKey,
      identityKey,
      admission,
      options,
      true,
      this.primaryCopyAdmissions.has(selected)
    )
    if (confirmation.result !== undefined) return confirmation.result
    let forceBootstrap = confirmation.forceBootstrap || recoveredBootstrap
    for (let attempt = 0; attempt < 2; attempt++) {
      let archive:
        import('./snapshot/journal/openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive | undefined
      let admissionRefusal: SnapshotJournalDataBootstrapRequiredError | undefined
      let failure: { error: unknown } | undefined
      const cleanup = new Brc38CleanupScope(async () => {
        if (archive === undefined) return
        try {
          await closeSnapshotJournalSource(archive, options.signal)
        } catch (error) {
          if (failure !== undefined && failure.error !== error)
            throw new AggregateError([failure.error, error], 'Journal fields and actual archive cleanup failed', {
              cause: failure.error
            })
          throw error
        }
      })
      try {
        const position =
          !forceBootstrap && previous?.checkpoint.phase === 'acknowledged'
            ? { binding: previous.binding.receipt.binding, highWater: previous.binding.receipt.highWater }
            : undefined
        archive = await reader.openSnapshotJournalFieldArchive(identityKey, position, {
          lifetimeMs: options.snapshotLifetimeMs,
          signal: options.signal
        })
        if (archive === undefined)
          throw new SnapshotResourceLimitError('Negotiated field source archive capacity is unavailable')
        const source = archive
        if (
          source.manifest.binding.user.identityKey !== identityKey ||
          source.manifest.binding.sourceStorage.storageIdentityKey !== readerSettings.storageIdentityKey ||
          source.manifest.binding.sourceStorage.chain !== readerSettings.chain
        )
          throw new WERR_UNAUTHORIZED()
        const open = async (): Promise<SnapshotJournalFieldDestination> => {
          await dispatch()
          try {
            const destination = await writer.openSnapshotJournalFieldDestination(identityKey, source.manifest.binding, {
              admission,
              signal: options.signal,
              limits: journalCopyLimits(options.maxItems, options.maxRoughSize)
            })
            if (destination === undefined) throw new WERR_INVALID_OPERATION('Negotiated field destination disappeared')
            const actual = destination
            return {
              status: async () => {
                await dispatch(true)
                return await actual.status()
              },
              stageArchiveFrame: async (expected, archive) => {
                await dispatch()
                return await actual.stageArchiveFrame(expected, archive)
              },
              promote: async (expected, archive) => {
                await dispatch()
                return await actual.promote(expected, archive)
              },
              ...(actual.close === undefined ? {} : { close: () => awaitFromSync(() => actual.close!()) })
            }
          } catch (error) {
            if (isSnapshotJournalDataBootstrapRequiredError(error)) admissionRefusal = error
            throw error
          }
        }
        let last: SnapshotJournalReconciliationProgress | undefined
        for await (const progress of runSnapshotJournalFieldArchiveReconciliation(source, open, {
          signal: options.signal,
          onProgress: this.journalCopyProgress(options, onDurableProgress)
        }))
          last = progress
        if (last === undefined || (last.state !== 'complete' && last.state !== 'stopped'))
          throw new WERR_INVALID_OPERATION('Journal fields did not reach a physically drained terminal state')
        return {
          status: last.state === 'complete' ? 'completed' : 'cancelled',
          mode: 'paged',
          pages: last.progress.pages,
          inserts: last.progress.inserts,
          updates: last.progress.updates,
          journalCheckpoint: copyJournalCheckpoint(last.checkpoint)
        }
      } catch (error) {
        failure = { error }
        if (attempt === 0 && admissionRefusal !== undefined && error === admissionRefusal) {
          forceBootstrap = true
          continue
        }
        throw error
      } finally {
        await cleanup.close()
      }
    }
    throw new WERR_INVALID_OPERATION('Journal field bootstrap retry was exhausted')
  }

  /** Original source operational history, separately labelled and bound to an
   * actual acknowledged local field copy. It is never a replica sync cursor. */
  async readJournalFieldProvenance(
    sourceStorageIdentity: string,
    options: import('./snapshot/journal/SnapshotJournalDataProvider').SnapshotJournalFieldReadOptions = {}
  ) {
    const selected = await this.captureSyncSelection(options.signal)
    if (selected === undefined) throw new SnapshotCancelledError()
    const active = selected.active
    if (!snapshotJournalFieldProvenanceProvider(active))
      throw new WERR_INVALID_OPERATION('The active provider does not expose acknowledged field provenance')
    const admission = this.journalCopyAdmission(active, active, selected, this._authId.identityKey, options.signal)
    return await active.readSnapshotJournalFieldProvenance(this._authId.identityKey, sourceStorageIdentity, {
      ...options,
      admission
    })
  }
  async openJournalProvenanceField(
    sourceStorageIdentity: string,
    incomingId: number,
    fieldName: string,
    options: import('./snapshot/journal/SnapshotJournalDataProvider').SnapshotJournalFieldReadOptions = {}
  ) {
    const selected = await this.captureSyncSelection(options.signal)
    if (selected === undefined) throw new SnapshotCancelledError()
    const active = selected.active
    if (!snapshotJournalFieldProvenanceProvider(active))
      throw new WERR_INVALID_OPERATION('The active provider does not expose acknowledged field provenance')
    const admission = this.journalCopyAdmission(active, active, selected, this._authId.identityKey, options.signal)
    return await active.openSnapshotJournalProvenanceField(
      this._authId.identityKey,
      sourceStorageIdentity,
      incomingId,
      fieldName,
      { ...options, admission }
    )
  }

  /** Explicit DATA peers keep their actual endpoint/SQL source owners. A remote
   * operation is admitted briefly, then runs outside the manager queue. */
  private async copyJournalDataWindow(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    options: SyncSessionOptions = {},
    selection?: { generation: number; active: sdk.WalletStorageProvider },
    onCustody?: (value: JournalCopyCustody) => void,
    onDurableProgress?: (value: SnapshotJournalReconciliationProgress) => void
  ): Promise<SyncSessionResult | undefined> {
    // Legacy borrowed source custody cannot be replaced with DATA. Durable
    // primary control uses its own endpoint/status/final-ACK protocol and the
    // actual selected-provider admission, without this old custody callback.
    if (
      onCustody !== undefined ||
      !snapshotJournalDataProvider(writer) ||
      !(await writer.supportsSnapshotJournalDataSync())
    )
      return undefined
    const local = journalSource(reader) && (await reader.supportsSnapshotJournalSync())
    const remote = !local && snapshotJournalArchiveProvider(reader) && (await reader.supportsSnapshotJournalArchive())
    if (!local && !remote) return undefined
    const selected = selection ?? (await this.captureSyncSelection(options.signal))
    if (selected === undefined || options.signal?.aborted)
      return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
    const identityKey = this._authId.identityKey,
      readerSettings = await reader.makeAvailable(),
      writerSettings = await writer.makeAvailable()
    assertSyncNetwork(readerSettings, writerSettings)
    const admission = this.journalCopyAdmission(reader, writer, selected, identityKey, options.signal)
    const outside = writer.journalDataCommitOutsideManager === true
    const dispatch = async (observe = false): Promise<void> => {
      if (outside) await admission(() => awaitFromSync(() => this.getAuth()), observe ? 'observe' : undefined)
    }
    const confirmation = await this.confirmJournalContentCopy(
      reader,
      writer,
      readerSettings.storageIdentityKey,
      identityKey,
      admission,
      options,
      false,
      this.primaryCopyAdmissions.has(selected)
    )
    if (confirmation.result !== undefined) return confirmation.result
    let forceBootstrap = confirmation.forceBootstrap
    await dispatch(true)
    const previous = await writer.getSnapshotJournalDataStatus(identityKey, readerSettings.storageIdentityKey, {
      admission
    })
    const limits = journalCopyLimits(options.maxItems, options.maxRoughSize)
    for (let attempt = 0; attempt < 2; attempt++) {
      let source: SnapshotJournalReconciliationSource | RemoteSnapshotJournalArchive | undefined
      let admissionRefusal: SnapshotJournalDataBootstrapRequiredError | undefined
      let failure: { error: unknown } | undefined
      const cleanupScope = new Brc38CleanupScope(async () => {
        if (source === undefined) return
        try {
          await closeSnapshotJournalSource(source, options.signal)
        } catch (cleanup) {
          if (failure !== undefined && cleanup !== failure.error)
            throw new AggregateError([failure.error, cleanup], 'Journal DATA and actual source cleanup failed', {
              cause: failure.error
            })
          throw cleanup
        }
      })
      try {
        if (local && journalSource(reader))
          source = await reader.openCurrentSnapshotJournalSource(identityKey, {
            lifetimeMs: options.snapshotLifetimeMs,
            signal: options.signal
          })
        else if (remote && snapshotJournalArchiveProvider(reader)) {
          const position =
            !forceBootstrap && previous?.checkpoint.phase === 'acknowledged'
              ? { binding: previous.binding.receipt.binding, highWater: previous.binding.receipt.highWater }
              : undefined
          source = await reader.openSnapshotJournalArchive(identityKey, position, {
            lifetimeMs: options.snapshotLifetimeMs,
            signal: options.signal
          })
          if (source === undefined) return undefined
        }
        if (source === undefined) throw new WERR_INVALID_OPERATION('Journal DATA actual source is unavailable')
        const sourceBinding =
          'manifest' in source
            ? source.manifest.binding
            : snapshotJournalDataSourceBinding(source, previous, forceBootstrap, await source.readContentRevision?.())
        const open = async (): Promise<SnapshotJournalDataDestination> => {
          await dispatch()
          let destination: SnapshotJournalDataDestination | undefined
          try {
            destination = await writer.openSnapshotJournalDataDestination(identityKey, sourceBinding, {
              admission,
              signal: options.signal
            })
          } catch (error) {
            if (isSnapshotJournalDataBootstrapRequiredError(error)) admissionRefusal = error
            throw error
          }
          if (destination === undefined)
            throw new WERR_INVALID_OPERATION('Negotiated journal DATA destination disappeared')
          const admitted = destination
          return {
            status: async () => {
              await dispatch(true)
              return await admitted.status()
            },
            stagePacket: async (expected, bytes) => {
              await dispatch()
              return await admitted.stagePacket(expected, bytes)
            },
            promote: async expected => {
              await dispatch()
              return await admitted.promote(expected)
            }
          }
        }
        const callbacks = { signal: options.signal, onProgress: this.journalCopyProgress(options, onDurableProgress) }
        const run =
          'manifest' in source
            ? runSnapshotJournalArchiveReconciliation(source, open, callbacks)
            : runSnapshotJournalSourceDataReconciliation(source, sourceBinding, open, limits, callbacks)
        let last: SnapshotJournalReconciliationProgress | undefined
        for await (const progress of run) last = progress
        if (last === undefined || (last.state !== 'complete' && last.state !== 'stopped'))
          throw new WERR_INVALID_OPERATION('Journal DATA did not reach a physically drained terminal state')
        return {
          status: last.state === 'complete' ? 'completed' : 'cancelled',
          mode: 'paged',
          pages: last.progress.pages,
          inserts: last.progress.inserts,
          updates: last.progress.updates,
          journalCheckpoint: copyJournalCheckpoint(last.checkpoint)
        }
      } catch (error) {
        failure = { error }
        if (attempt === 0 && admissionRefusal !== undefined && error === admissionRefusal) {
          forceBootstrap = true
          continue
        }
        throw error
      } finally {
        await cleanupScope.close()
      }
    }
    throw new WERR_INVALID_OPERATION('Journal DATA bootstrap retry was exhausted')
  }

  /** Negotiate afresh for every ordinary copy. A provider's method presence
   * chooses an adapter; the source and each physical destination transaction
   * independently establish actual current authority. No result is cached. */
  private async tryJournalCopy(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    options: SyncSessionOptions = {},
    selection?: { generation: number; active: sdk.WalletStorageProvider },
    onCustody?: (value: JournalCopyCustody) => void,
    allowResourceFallback = true,
    fallbackDirection: 'push' | 'pull' = 'pull'
  ): Promise<SyncSessionResult | undefined> {
    const selected = selection ?? (await this.captureSyncSelection(options.signal))
    if (selected === undefined) return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
    let partial: Pick<SyncSessionResult, 'pages' | 'inserts' | 'updates' | 'journalCheckpoint'> = {
      pages: 0,
      inserts: 0,
      updates: 0
    }
    const recoveredTotals = { pages: 0, inserts: 0, updates: 0 }
    let observerFailure: { error: unknown } | undefined
    const observe = <T>(callback: ((value: T) => void) | undefined, value: T): void => {
      try {
        callback?.(value)
      } catch (error) {
        observerFailure = { error }
        throw error
      }
    }
    const retain = (value: SnapshotJournalReconciliationProgress): void => {
      partial = {
        pages: recoveredTotals.pages + value.progress.pages,
        inserts: recoveredTotals.inserts + value.progress.inserts,
        updates: recoveredTotals.updates + value.progress.updates,
        journalCheckpoint: {
          ...value.checkpoint,
          ...(value.checkpoint.after === undefined ? {} : { after: { ...value.checkpoint.after } })
        }
      }
    }
    try {
      return await this.copyJournalWindow(
        reader,
        writer,
        {
          ...options,
          onProgress: value => observe(options.onProgress, value),
          onJournalProgress: value => observe(options.onJournalProgress, value)
        },
        selected,
        onCustody,
        retain,
        value => {
          if (value.state !== 'complete' || value.checkpoint.phase !== 'acknowledged')
            throw new WERR_INVALID_OPERATION('Recovered totals require an actual completed window')
          recoveredTotals.pages += value.progress.pages
          recoveredTotals.inserts += value.progress.inserts
          recoveredTotals.updates += value.progress.updates
          // Keep real aggregate counters separately from the last actual
          // checkpoint. No cumulative UI counter becomes a financial ACK.
          partial = {
            pages: recoveredTotals.pages,
            inserts: recoveredTotals.inserts,
            updates: recoveredTotals.updates,
            journalCheckpoint: copyJournalCheckpoint(value.checkpoint)
          }
        }
      )
    } catch (error) {
      // A callback's typed exception is still an observer failure. It cannot
      // select transport fallback or erase an already acknowledged prefix.
      if (observerFailure !== undefined && error === observerFailure.error) throw error
      // The concrete source's finally/closed path has already physically drained.
      // Cleanup/authority/schema/corruption errors never select fallback.
      if (error instanceof SnapshotCancelledError && options.signal?.aborted) {
        const cancelled: SyncSessionResult = { status: 'cancelled', mode: 'paged', ...partial }
        options.onProgress?.({
          ...cancelled,
          state: 'cancelled',
          journalCheckpoint: copyJournalCheckpoint(partial.journalCheckpoint)
        })
        return cancelled
      }
      if (!allowResourceFallback || !(error instanceof SnapshotResourceLimitError)) throw error
    }
    const fallback = await this.runLegacySnapshotFallback(
      reader,
      writer,
      fallbackDirection,
      {
        ...options,
        onProgress: value =>
          options.onProgress?.({
            ...value,
            pages: partial.pages + value.pages,
            inserts: partial.inserts + value.inserts,
            updates: partial.updates + value.updates,
            journalCheckpoint: copyJournalCheckpoint(partial.journalCheckpoint)
          })
      },
      selected
    )
    // These are actual acknowledged operations, including the durable journal
    // prefix. A retained journal position is custody data, not a claim that the
    // fallback acknowledged that journal window or used a coherent archive.
    return {
      ...fallback,
      pages: partial.pages + fallback.pages,
      inserts: partial.inserts + fallback.inserts,
      updates: partial.updates + fallback.updates,
      journalCheckpoint: copyJournalCheckpoint(partial.journalCheckpoint)
    }
  }

  private async copyJournalWindow(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    options: SyncSessionOptions = {},
    selection?: { generation: number; active: sdk.WalletStorageProvider },
    onCustody?: (value: JournalCopyCustody) => void,
    onDurableProgress?: (value: SnapshotJournalReconciliationProgress) => void,
    onRecoveredWindow?: (value: SnapshotJournalReconciliationProgress) => void
  ): Promise<SyncSessionResult | undefined> {
    if (reader === writer) return undefined
    // Protocol choice survives warm/final copies and a new manager. Read the
    // actual authenticated field window; never reinterpret it as a row window.
    // This is comparison DATA only: the field source/destination still obtain
    // their original owners and independently verify all financial effects.
    let recordedFields = false
    if (
      onCustody === undefined &&
      options.journalFields !== true &&
      snapshotJournalFieldArchiveProvider(reader) &&
      snapshotJournalFieldProvider(writer) &&
      (await reader.supportsSnapshotJournalFieldArchive()) &&
      (await writer.supportsSnapshotJournalFieldSync())
    ) {
      const current = selection ?? (await this.captureSyncSelection(options.signal))
      if (current === undefined || options.signal?.aborted)
        return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
      const settings = await reader.makeAvailable(),
        admission = this.journalCopyAdmission(reader, writer, current, this._authId.identityKey, options.signal)
      if (writer.journalDataCommitOutsideManager === true)
        await admission(() => awaitFromSync(() => this.getAuth()), 'observe')
      recordedFields =
        (await writer.getSnapshotJournalFieldStatus(this._authId.identityKey, settings.storageIdentityKey, {
          admission,
          limits: journalCopyLimits(options.maxItems, options.maxRoughSize)
        })) !== undefined
    }
    if ((options.journalFields === true || recordedFields) && onCustody === undefined) {
      const fields = await this.copyJournalFieldWindow(
        reader,
        writer,
        options,
        selection,
        onDurableProgress,
        false,
        onRecoveredWindow
      )
      if (fields !== undefined) return fields
      if (recordedFields)
        throw new WERR_INVALID_OPERATION('Existing field copy requires its original negotiated field protocol')
    }
    if (!journalSource(reader) || !journalDestination(writer))
      return await this.copyJournalDataWindow(reader, writer, options, selection, onCustody, onDurableProgress)
    if (!(await reader.supportsSnapshotJournalSync()) || !(await writer.supportsSnapshotJournalSync())) return undefined
    const limits = journalCopyLimits(options.maxItems, options.maxRoughSize)
    if (options.signal?.aborted) return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
    const selected = selection ?? (await this.captureSyncSelection(options.signal))
    if (selected === undefined) return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
    const identityKey = this._authId.identityKey
    const readerSettings = await reader.makeAvailable()
    const writerSettings = await writer.makeAvailable()
    assertSyncNetwork(readerSettings, writerSettings)
    const admission = this.journalCopyAdmission(reader, writer, selected, identityKey, options.signal)
    // Push/primary callers retain actual custody until their separate current
    // source-selection fence completes. Only a plain pull may return early.
    if (onCustody === undefined && !this.primaryCopyAdmissions.has(selected)) {
      const confirmation = await this.confirmJournalContentCopy(
        reader,
        writer,
        readerSettings.storageIdentityKey,
        identityKey,
        admission,
        options
      )
      if (confirmation.result !== undefined) return confirmation.result
    }
    const source = await reader.openCurrentSnapshotJournalSource(identityKey, {
      lifetimeMs: options.snapshotLifetimeMs,
      signal: options.signal
    })
    let last: SnapshotJournalReconciliationProgress | undefined
    let destination: SnapshotJournalReceiver | undefined
    let failure: { error: unknown } | undefined
    const cleanupScope1 = new Brc38CleanupScope(async () => {
      try {
        await closeSnapshotJournalSource(source, options.signal)
      } catch (cleanupError) {
        if (failure !== undefined && failure.error !== cleanupError)
          throw new AggregateError([failure.error, cleanupError], 'Journal copy and physical source cleanup failed', {
            cause: failure.error
          })
        throw cleanupError
      }
    })
    try {
      if (
        source.receiptBinding.identityKey !== identityKey ||
        source.receiptBinding.storageIdentity !== readerSettings.storageIdentityKey ||
        source.receiptBinding.chain !== readerSettings.chain
      )
        throw new WERR_UNAUTHORIZED()
      const run = runSnapshotJournalReconciliation(
        source,
        () =>
          mapAwaitFromSync(
            () =>
              writer.openSnapshotJournalDestination(
                source,
                snapshotJournalRevision('0'),
                limits,
                admission,
                options.signal,
                true,
                true
              ),
            opened => {
              destination = opened.destination
              return opened.destination
            }
          ),
        {
          signal: options.signal,
          onProgress: this.journalCopyProgress(options, onDurableProgress)
        }
      )
      for await (const progress of run) last = progress
      if (last === undefined || (last.state !== 'complete' && last.state !== 'stopped'))
        throw new WERR_INVALID_OPERATION('Journal copy did not reach a drained terminal state')
      if (last.state === 'complete') {
        if (destination === undefined) throw new WERR_INVALID_OPERATION('Journal destination custody is absent')
        onCustody?.({ reader, source, destination, checkpoint: { ...last.checkpoint } })
      }
      return {
        status: last.state === 'complete' ? 'completed' : 'cancelled',
        mode: 'paged',
        pages: last.progress.pages,
        inserts: last.progress.inserts,
        updates: last.progress.updates,
        journalCheckpoint: {
          ...last.checkpoint,
          ...(last.checkpoint.after === undefined ? {} : { after: { ...last.checkpoint.after } })
        }
      }
    } catch (error) {
      failure = { error }
      // A lost reply or a failed observer cannot decide actual SQL progress.
      // This read uses destination observe admission and starts no semantic write.
      if (destination !== undefined) {
        try {
          const status = await destination.status()
          onDurableProgress?.({ state: 'committed', ...status })
        } catch (custodyError) {
          if (custodyError !== error) {
            failure = {
              error: new AggregateError([error, custodyError], 'Journal copy and actual custody observation failed', {
                cause: error
              })
            }
            {
              await cleanupScope1.close()
              throw failure.error
            }
          }
        }
      }
      {
        await cleanupScope1.close()
        throw error
      }
    } finally {
      await cleanupScope1.close()
    }
  }

  /** Local unchanged pushes retain genuine current-source SQL ownership only
   * through one actual target comparison. No network endpoint implements this
   * local primitive, and no financial ACK or primary is synthesized. */
  private async confirmLocalJournalPushContent(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    options: SyncSessionOptions,
    selection?: { generation: number; active: sdk.WalletStorageProvider }
  ): Promise<SyncSessionResult | undefined> {
    if (
      !journalSource(reader) ||
      !journalDestination(writer) ||
      !snapshotJournalPrimaryContentProvider(writer) ||
      !(await reader.supportsSnapshotJournalSync()) ||
      !(await writer.supportsSnapshotJournalDataContent())
    )
      return undefined
    const selected = selection ?? (await this.captureSyncSelection(options.signal))
    if (selected === undefined || options.signal?.aborted)
      return { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
    const identityKey = this._authId.identityKey,
      settings = await reader.makeAvailable(),
      targetSettings = await writer.makeAvailable()
    assertSyncNetwork(settings, targetSettings)
    const admission = this.journalCopyAdmission(reader, writer, selected, identityKey, options.signal),
      prior = await writer.getSnapshotJournalDataContentReceipt(identityKey, settings.storageIdentityKey, { admission })
    if (prior === undefined) return undefined
    let ownedSource: SnapshotJournalReconciliationSource | undefined
    const changed = new WERR_INVALID_OPERATION('Current source changed before unchanged push confirmation')
    let result: SyncSessionResult | undefined, failure: { error: unknown } | undefined
    const cleanup = new Brc38CleanupScope(async () => {
      if (ownedSource === undefined) return
      try {
        await closeSnapshotJournalSource(ownedSource, options.signal)
      } catch (error) {
        if (failure !== undefined && failure.error !== error)
          throw new AggregateError([failure.error, error], 'Unchanged push and actual source cleanup failed', {
            cause: failure.error
          })
        throw error
      }
    })
    try {
      const source = await reader.openCurrentSnapshotJournalSource(identityKey, {
        lifetimeMs: options.snapshotLifetimeMs,
        signal: options.signal
      })
      ownedSource = source
      if (options.signal?.aborted)
        throw new SnapshotCancelledError('Unchanged push was cancelled while opening its source')
      if (
        source.receiptBinding.identityKey !== identityKey ||
        source.receiptBinding.storageIdentity !== settings.storageIdentityKey ||
        source.receiptBinding.chain !== settings.chain
      )
        throw new WERR_UNAUTHORIZED()
      const observed = await source.readContentRevision?.(snapshotSyncContentPosition(prior.source))
      if (options.signal?.aborted)
        throw new SnapshotCancelledError('Unchanged push was cancelled during source observation')
      if (observed !== undefined && snapshotSyncContentConfirms(prior.source, observed)) {
        const fencedAdmission: SnapshotJournalWriterAdmission = async operation =>
          await admission(() =>
            mapAwaitFromSync(
              () => source.withCurrentDataFence(source.receipt.highWater, operation),
              current => {
                if (!current.current) throw changed
                return current.value
              }
            )
          )
        const confirmed = await writer.confirmSnapshotJournalPrimaryContentReceipt(
          identityKey,
          settings.storageIdentityKey,
          observed,
          source.primary.activeStorage,
          { admission: fencedAdmission }
        )
        if (confirmed !== undefined) {
          if (
            JSON.stringify(confirmed.checkpoint) !== JSON.stringify(prior.checkpoint) ||
            !snapshotSyncContentConfirms(prior.source, confirmed.source)
          )
            throw new WERR_INVALID_OPERATION('Unchanged push changed its previous actual ACK')
          result = {
            status: options.signal?.aborted ? 'cancelled' : 'completed',
            mode: 'paged',
            pages: 0,
            inserts: 0,
            updates: 0,
            journalCheckpoint: copyJournalCheckpoint(confirmed.checkpoint),
            noChangeJournalReceipt: confirmed
          }
        }
      }
    } catch (error) {
      failure = { error }
      if (error !== changed) {
        if (error instanceof SnapshotCancelledError && options.signal?.aborted)
          result = { status: 'cancelled', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
        else throw error
      }
    } finally {
      await cleanup.close()
    }
    if (result !== undefined)
      options.onProgress?.({
        ...result,
        state: result.status,
        journalCheckpoint: copyJournalCheckpoint(result.journalCheckpoint)
      })
    return result
  }

  /** Preserve ordinary push selection propagation after the data ACK. Busy
   * foreground writers cause another incremental window, never an activation
   * from stale copied data. Every attempt releases source and manager ownership. */
  private async tryJournalPush(
    reader: sdk.WalletStorageSyncReader,
    writer: sdk.WalletStorageProvider,
    options: SyncSessionOptions = {},
    selection?: { generation: number; active: sdk.WalletStorageProvider }
  ): Promise<SyncSessionResult | undefined> {
    const unchanged = await this.confirmLocalJournalPushContent(reader, writer, options, selection)
    if (unchanged !== undefined) return unchanged
    let pages = 0,
      inserts = 0,
      updates = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      let custody: JournalCopyCustody | undefined
      const result = await this.tryJournalCopy(
        reader,
        writer,
        {
          ...options,
          onProgress: value =>
            options.onProgress?.({
              ...value,
              pages: pages + value.pages,
              inserts: inserts + value.inserts,
              updates: updates + value.updates
            })
        },
        selection,
        value => {
          custody = value
        },
        true,
        'push'
      )
      if (result === undefined) {
        if (attempt !== 0) throw new WERR_INVALID_OPERATION('Journal support changed during primary propagation')
        return undefined
      }
      pages += result.pages
      inserts += result.inserts
      updates += result.updates
      const total = { ...result, pages, inserts, updates }
      if (result.status === 'cancelled') return total
      // The serialized resource fallback has already propagated its actual
      // source selection under exclusive admission; it has no journal cutover.
      if (custody === undefined && result.mode === 'exclusive') return total
      if (custody === undefined) throw new WERR_INVALID_OPERATION('Journal push has no acknowledged custody')
      const activeStorage = custody.source.primary.activeStorage
      if (activeStorage === null) return total
      const current = await custody.reader.openCurrentSnapshotJournalSource(this._authId.identityKey, {
        lifetimeMs: options.snapshotLifetimeMs,
        signal: options.signal
      })
      try {
        if (
          await custody.destination.selectPrimary(
            custody.checkpoint,
            activeStorage,
            [{ source: current, since: custody.source.receipt.highWater }],
            changed => {
              if (changed) this.invalidatePrimarySelection()
            }
          )
        )
          return total
      } finally {
        await closeSnapshotJournalSource(current, options.signal)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    throw new WERR_INVALID_OPERATION(
      'Source is still changing before primary propagation; acknowledged copies are retained, retry sync'
    )
  }

  private invalidatePrimarySelection(): void {
    this._isAvailable = false
    this._authId.isActive = false
    for (const store of this._stores) store.isAvailable = false
  }

  /** Explicit local SQL reconciliation. Both providers must already participate
   * in this manager's single-profile selection. It neither changes the active
   * store nor enables an advertised remote capability. Source capture, paging,
   * proof preparation and observers never own the manager queue. Each actual
   * destination writer retains background ownership through physical cleanup.
   * A replacement process starts a fresh full view and recovers destination
   * custody; the destination alone decides which work is acknowledged. */
  async *reconcileJournal(
    reader: SnapshotJournalProvider,
    writer: SnapshotJournalProvider,
    limits: SnapshotJournalDestinationLimits,
    options: SnapshotJournalReconciliationOptions & Pick<RetainedReadSnapshotOptions, 'lifetimeMs'> = {}
  ): AsyncGenerator<SnapshotJournalReconciliationProgress, SnapshotJournalReconciliationProgress, void> {
    if (reader === writer) throw new WERR_INVALID_PARAMETER('writer', 'a different managed storage provider')
    const selected = await this.withAccess(
      active => {
        if (
          !this._stores.some(store => Object.is(store.storage, reader)) ||
          !this._stores.some(store => store.storage === writer)
        ) {
          throw new WERR_INVALID_OPERATION('Journal reconciliation requires two currently managed providers')
        }
        return Promise.resolve({ active, generation: this.generation, identityKey: this._authId.identityKey })
      },
      false,
      false,
      options.signal
    )
    const readerSettings = await reader.makeAvailable()
    const writerSettings = await writer.makeAvailable()
    assertSyncNetwork(readerSettings, writerSettings)
    const admission = <T>(operation: () => Promise<T>, observe?: 'observe'): Promise<T> =>
      this.withAccess(
        async active => {
          if (
            (observe !== 'observe' && (active !== selected.active || selected.generation !== this.generation)) ||
            selected.identityKey !== this._authId.identityKey ||
            !this._stores.some(store => Object.is(store.storage, reader)) ||
            !this._stores.some(store => store.storage === writer)
          ) {
            throw new WERR_INVALID_OPERATION('Journal reconciliation manager selection changed; open a fresh source')
          }
          const auth = await this.getAuth()
          if (auth.identityKey !== selected.identityKey) throw new WERR_UNAUTHORIZED()
          return await operation()
        },
        false,
        true,
        observe === 'observe' ? undefined : options.signal
      )
    const source = await reader.openCurrentSnapshotJournalSource(selected.identityKey, {
      lifetimeMs: options.lifetimeMs,
      signal: options.signal
    })
    try {
      if (
        source.receiptBinding.identityKey !== selected.identityKey ||
        source.receiptBinding.storageIdentity !== readerSettings.storageIdentityKey ||
        source.receiptBinding.chain !== readerSettings.chain
      )
        throw new WERR_UNAUTHORIZED()
      return yield* runSnapshotJournalReconciliation(
        source,
        () =>
          mapAwaitFromSync(
            () =>
              writer.openSnapshotJournalDestination(
                source,
                snapshotJournalRevision('0'),
                limits,
                admission,
                options.signal,
                true
              ),
            opened => {
              return opened.destination
            }
          ),
        options
      )
    } finally {
      await closeSnapshotJournalSource(source, options.signal)
    }
  }

  async syncFromReader(
    identityKey: string,
    reader: sdk.WalletStorageSyncReader,
    activeSync?: sdk.WalletStorageSync,
    log: string = ''
  ): Promise<{ inserts: number; updates: number; log: string }> {
    if (identityKey !== this._authId.identityKey) throw new WERR_UNAUTHORIZED()
    const readerSettings = await reader.makeAvailable()
    await this.preflightManagedNetworks(readerSettings)
    if (activeSync != null) assertSyncNetwork(readerSettings, activeSync.getSettings())
    const auth = await this.getAuth()

    if (activeSync == null) {
      const snapshot =
        (await this.tryJournalCopy(reader, this.getActive(), { maxRoughSize: 10000000 })) ??
        (await this.trySnapshotCopy(reader, this.getActive(), 'pull', { maxRoughSize: 10000000 }))
      if (snapshot !== undefined)
        return {
          inserts: snapshot.inserts,
          updates: snapshot.updates,
          log:
            log + `syncFromReader ${snapshot.mode} complete: ${snapshot.inserts} inserts, ${snapshot.updates} updates\n`
        }
    }

    let inserts = 0
    let updates = 0

    log = await this.runAsSync(async sync => {
      const writer = sync
      const writerSettings = writer.getSettings()
      assertSyncNetwork(readerSettings, writerSettings)

      log += `syncFromReader from ${readerSettings.storageName} to ${writerSettings.storageName}\n`

      const loadRequest = (): Promise<sdk.RequestSyncChunkArgs> =>
        this.loadSyncRequest(auth, writer, readerSettings, writerSettings.storageIdentityKey)
      let args = await loadRequest()
      const budget = new SyncPageBudget()
      let i = -1
      for (;;) {
        i++
        // Keep the caller/provider ceiling independent from this session's
        // adaptive limit so a fast page can grow the next request again.
        const pageArgs = budget.apply(args)
        pageArgs.includeNextCheckpoint = true
        const startedAt = Date.now()
        const chunk = await reader.getSyncChunk(pageArgs)
        const readMs = Date.now() - startedAt
        if (chunk.user != null) {
          // Merging state from a reader cannot update activeStorage
          chunk.user.activeStorage = ((this._active as ManagedStorage).user as TableUser).activeStorage
        }
        const r = await writer.processSyncChunk(pageArgs, chunk)
        throwSyncResultError(r)
        budget.committed(chunk, Date.now() - startedAt, readMs)
        inserts += r.inserts
        updates += r.updates
        log += `chunk ${i} inserted ${r.inserts} updated ${r.updates} ${String(r.maxUpdated_at)}\n`
        if (r.done) break
        const next =
          r.nextCheckpoint == null
            ? await loadRequest()
            : { ...args, ...validateSyncCheckpoint(r.nextCheckpoint, args) }
        assertSyncProgress(args, next)
        args = next
      }
      log += `syncFromReader complete: ${inserts} inserts, ${updates} updates\n`
      return log
    }, activeSync)

    return { inserts, updates, log }
  }

  /**
   * Resumable pull with cancellation and per-page progress. Local providers
   * advertising atomic checkpoints yield ownership during source I/O. Older
   * and remote destinations keep the safe exclusive path. This is an eventual
   * replica merge with a coherent source view when local SQL capabilities permit;
   * it does not activate a primary or provide an archive snapshot of the destination.
   */
  async syncFromReaderResumable(
    identityKey: string,
    reader: sdk.WalletStorageSyncReader,
    options: SyncSessionOptions = {}
  ): Promise<SyncSessionResult> {
    if (identityKey !== this._authId.identityKey) throw new WERR_UNAUTHORIZED()
    const readerSettings = await reader.makeAvailable()
    await this.preflightManagedNetworks(readerSettings)
    const auth = { ...(await this.getAuth()) }
    const writer = this.getActive()
    const writerSettings = writer.getSettings()
    assertSyncNetwork(readerSettings, writerSettings)
    const snapshot =
      (await this.tryJournalCopy(reader, writer, options)) ??
      (await this.trySnapshotCopy(reader, writer, 'pull', options))
    if (snapshot !== undefined) return snapshot
    const generation = this.generation
    const activeStorage = this.getActiveUser().activeStorage
    const atomicCheckpoint = this._active?.access?.atomicSyncPages === true
    const paged =
      writer.isStorageProvider() &&
      atomicCheckpoint &&
      reader !== writer &&
      typeof (writer as Partial<StorageProvider>).prepareSyncChunk === 'function'
    const assertCurrent = (): void => {
      if (generation !== this.generation || writer !== this.getActive()) {
        throw new WERR_INVALID_OPERATION(
          'Sync destination generation changed; resume on the selected storage provider.'
        )
      }
    }
    const run = (commit: <T>(operation: () => Promise<T>) => Promise<T>): Promise<SyncSessionResult> =>
      runPullSession(
        {
          reader,
          writer,
          activeStorage,
          atomicCheckpoint,
          mode: paged ? 'paged' : 'exclusive',
          loadRequest: () => this.loadSyncRequest(auth, writer, readerSettings, writerSettings.storageIdentityKey),
          prepare: paged ? (args, chunk) => (writer as StorageProvider).prepareSyncChunk(args, chunk) : undefined,
          commit
        },
        options
      )
    if (paged) {
      return await run(operation =>
        this.withAccess(
          () => {
            assertCurrent()
            return operation()
          },
          false,
          true,
          options.signal
        )
      )
    }
    return (
      (await this.runAsSyncCancellable(() => {
        assertCurrent()
        return run(operation => {
          assertCurrent()
          return operation()
        })
      }, options.signal)) ?? { status: 'cancelled', mode: 'exclusive', pages: 0, inserts: 0, updates: 0 }
    )
  }

  /** Bounded push on negotiated local snapshots, with the legacy serialized fallback. */
  async syncToWriterResumable(
    auth: sdk.AuthId,
    writer: sdk.WalletStorageProvider,
    options: SyncSessionOptions = {}
  ): Promise<SyncSessionResult> {
    if (auth.identityKey !== this._authId.identityKey) throw new WERR_UNAUTHORIZED()
    const writerSettings = await writer.makeAvailable()
    await this.preflightManagedNetworks(writerSettings)
    await this.getAuth()
    const snapshot =
      (await this.tryJournalPush(this.getActive(), writer, options)) ??
      (await this.trySnapshotCopy(this.getActive(), writer, 'push', options))
    if (snapshot !== undefined) return snapshot
    return (
      (await this.runAsSyncCancellable(
        reader =>
          awaitFromSync(() => {
            const settings = reader.getSettings()
            assertSyncNetwork(settings, writerSettings)
            return runPullSession(
              {
                reader,
                writer,
                atomicCheckpoint: false,
                mode: 'exclusive',
                loadRequest: () => this.loadSyncRequest(auth, writer, settings, writerSettings.storageIdentityKey),
                commit: operation => operation()
              },
              options
            )
          }),
        options.signal
      )) ?? { status: 'cancelled', mode: 'exclusive', pages: 0, inserts: 0, updates: 0 }
    )
  }

  async syncToWriter(
    auth: sdk.AuthId,
    writer: sdk.WalletStorageProvider,
    activeSync?: sdk.WalletStorageSync,
    log: string = '',
    progLog?: (s: string) => string
  ): Promise<{ inserts: number; updates: number; log: string }> {
    if (auth.identityKey !== this._authId.identityKey) throw new WERR_UNAUTHORIZED()
    progLog ||= s => s

    const writerSettings = await writer.makeAvailable()
    await this.preflightManagedNetworks(writerSettings)
    if (activeSync != null) assertSyncNetwork(activeSync.getSettings(), writerSettings)

    if (activeSync == null) {
      await this.getAuth()
      const options: SyncSessionOptions = {
        maxRoughSize: 10000000,
        onProgress: progress => {
          log += this.committedPageLog(progress, progLog)
        }
      }
      const snapshot =
        (await this.tryJournalPush(this.getActive(), writer, options)) ??
        (await this.trySnapshotCopy(this.getActive(), writer, 'push', options))
      if (snapshot !== undefined)
        return {
          inserts: snapshot.inserts,
          updates: snapshot.updates,
          log:
            log +
            progLog(
              `syncToWriter ${snapshot.mode} complete: ${snapshot.inserts} inserts, ${snapshot.updates} updates\n`
            )
        }
    }

    let inserts = 0
    let updates = 0

    log = await this.runAsSync(async sync => {
      const reader = sync
      const readerSettings = reader.getSettings()
      assertSyncNetwork(readerSettings, writerSettings)

      log += progLog(`syncToWriter from ${readerSettings.storageName} to ${writerSettings.storageName}\n`)

      const loadRequest = (): Promise<sdk.RequestSyncChunkArgs> =>
        this.loadSyncRequest(auth, writer, readerSettings, writerSettings.storageIdentityKey)
      let args = await loadRequest()
      const budget = new SyncPageBudget()
      let i = -1
      for (;;) {
        i++
        // Keep the caller/provider ceiling independent from this session's
        // adaptive limit so a fast page can grow the next request again.
        const pageArgs = budget.apply(args)
        pageArgs.includeNextCheckpoint = true
        const startedAt = Date.now()
        const chunk = await reader.getSyncChunk(pageArgs)
        const readMs = Date.now() - startedAt
        log += EntitySyncState.syncChunkSummary(chunk)
        const r = await writer.processSyncChunk(pageArgs, chunk)
        throwSyncResultError(r)
        budget.committed(chunk, Date.now() - startedAt, readMs)
        inserts += r.inserts
        updates += r.updates
        log += progLog(`chunk ${i} inserted ${r.inserts} updated ${r.updates} ${String(r.maxUpdated_at)}\n`)
        if (r.done) break
        const next =
          r.nextCheckpoint == null
            ? await loadRequest()
            : { ...args, ...validateSyncCheckpoint(r.nextCheckpoint, args) }
        assertSyncProgress(args, next)
        args = next
      }
      log += progLog(`syncToWriter complete: ${inserts} inserts, ${updates} updates\n`)
      return log
    }, activeSync)

    return { inserts, updates, log }
  }

  async updateBackups(activeSync?: sdk.WalletStorageSync, progLog?: (s: string) => string): Promise<string> {
    progLog ||= s => s
    const auth = await this.getAuth(true)
    if (activeSync == null) {
      const selected = { generation: this.generation, active: this.getActive() }
      const backups = [...(this._backups as ManagedStorage[])]
      let log = progLog(`BACKUP CURRENT ACTIVE TO ${backups.length} STORES\n`)
      // One source view at a time; stop before starting another backup on failure.
      await runInSeries(backups, async backup => {
        const options: SyncSessionOptions = {
          maxRoughSize: 10000000,
          onProgress: progress => {
            log += this.committedPageLog(progress, progLog)
          }
        }
        const result =
          (await this.tryJournalPush(selected.active, backup.storage, options, selected)) ??
          (await this.trySnapshotCopy(selected.active, backup.storage, 'push', options, selected)) ??
          (await this.runLegacySnapshotFallback(selected.active, backup.storage, 'push', options, selected))
        log += progLog(
          `${result.mode === 'paged' ? 'snapshot' : 'serialized'} complete: ${result.inserts} inserts, ${result.updates} updates\n`
        )
      })
      return log
    }
    return await this.runAsSync(async sync => {
      let log = progLog(`BACKUP CURRENT ACTIVE TO ${(this._backups as ManagedStorage[]).length} STORES\n`)
      for (const backup of this._backups as ManagedStorage[]) {
        const stwr = await this.syncToWriter(auth, backup.storage, sync, undefined, progLog)
        log += stwr.log
      }
      return log
    }, activeSync)
  }

  /**
   * Updates backups and switches to new active storage provider from among current backup providers.
   *
   * Also resolves conflicting actives.
   *
   * @param storageIdentityKey of current backup storage provider that is to become the new active provider.
   */
  async setActive(
    storageIdentityKey: string,
    progLog?: (s: string) => string,
    options: SyncSessionOptions = {}
  ): Promise<string> {
    const release = await this.primaryTransitions.acquire('exclusive', 'foreground', options.signal)
    try {
      await this.makeAvailable()
      return (
        (await this.trySetActiveHandoff(storageIdentityKey, progLog ?? (value => value), options)) ??
        (await this.trySetActiveJournal(storageIdentityKey, progLog ?? (value => value))) ??
        (await this.setActiveLegacy(storageIdentityKey, progLog))
      )
    } finally {
      release()
    }
  }

  /** Durable controls and real bounded provider copies. Only short local
   * commits own this queue; remote controls/copies run outside it. An uncertain
   * result preserves the inactive barrier and resumes the actual stored plan. */
  private async trySetActiveHandoff(
    storageIdentityKey: string,
    progLog: (value: string) => string,
    options: SyncSessionOptions = {}
  ): Promise<string | undefined> {
    options.signal?.throwIfAborted()
    const stores = [...this._stores],
      identityKey = this._authId.identityKey
    if (stores.length < 2 || stores.length > 9) return undefined
    const target = stores.find(store => store.settings?.storageIdentityKey === storageIdentityKey)
    if (target === undefined) throw new WERR_INVALID_PARAMETER('storageIdentityKey', 'a registered storage provider')
    if (this.#primaryHandoffPending !== undefined) {
      this.assertPrimaryHandoffGraph(this.#primaryHandoffPending.stores, this.#primaryHandoffPending.identityKey)
      if (this.#primaryHandoffPending.target !== storageIdentityKey)
        throw new WERR_INVALID_OPERATION('Resume the pending primary target before choosing another')
    }
    const participants: PrimaryHandoffParticipant[] = []
    let unsupported = false,
      enrolled = false
    for (const store of stores) {
      const provider = store.storage as sdk.WalletStorageProvider & {
        getPrimaryHandoffControl?: (
          options?: PrimaryHandoffControlOptions
        ) => Promise<PrimaryHandoffControl | undefined>
      }
      const control = await provider.getPrimaryHandoffControl?.({ signal: options.signal })
      if (control === undefined) {
        unsupported = true
        continue
      }
      const { user } = await provider.findOrInsertUser(identityKey)
      const auth = { identityKey, userId: user.userId }
      const state = await control.status(auth)
      enrolled ||= state !== undefined
      participants.push({
        storageIdentityKey: store.settings!.storageIdentityKey,
        activeStorage: user.activeStorage,
        auth,
        control
      })
    }
    if (unsupported) {
      if (options.signal !== undefined)
        throw new WERR_NOT_IMPLEMENTED('Cancellable primary handoff requires negotiated participant controls')
      if (enrolled || this.#primaryHandoffPending !== undefined)
        throw new WERR_INVALID_OPERATION('All enrolled handoff participants require control-aware providers')
      return undefined
    }
    this.assertPrimaryHandoffGraph(stores, identityKey)
    const generation = this.generation,
      selected = { active: this.getActive(), generation }
    const queue = async <T>(operation: () => Promise<T>, observe?: 'observe'): Promise<T> => {
      const leave = this.accessQueue.admit()
      let release: (() => void) | undefined
      try {
        release = await this.accessQueue.acquire(
          'exclusive',
          'background',
          observe === 'observe' ? undefined : options.signal
        )
        this.assertPrimaryHandoffGraph(stores, identityKey)
        if (this.generation !== generation)
          throw new WERR_INVALID_OPERATION('Manager generation changed during primary handoff')
        return await operation()
      } finally {
        release?.()
        leave()
      }
    }
    const ordinary: SnapshotJournalWriterAdmission = <T>(operation: () => Promise<T>, observe?: 'observe') =>
      queue(operation, observe)
    this.primaryCopyAdmissions.set(selected, ordinary)
    let log = progLog(`setActive to ${target.settings?.storageName} using durable primary handoff\n`)
    try {
      const pending = await Promise.all(
        participants.map(value => awaitFromSync(() => value.control.status(value.auth)))
      )
      const agreed = participants.every(value => value.activeStorage === storageIdentityKey)
      if (
        !agreed ||
        pending.some(value => value !== undefined && ['prepared', 'retired', 'activated'].includes(value.phase))
      ) {
        await runPrimaryHandoffProgram({
          participants,
          targetStorageIdentityKey: storageIdentityKey,
          newOperationId: () => Utils.toHex(Random(16)),
          arm: (_plan: PrimaryHandoffPlan) =>
            awaitFromSync(() =>
              queue(() => {
                return promiseFromSync(() => {
                  if (
                    this.#primaryHandoffPending !== undefined &&
                    this.#primaryHandoffPending.target !== storageIdentityKey
                  )
                    throw new WERR_INVALID_OPERATION('Another primary handoff is pending')
                  this.#primaryHandoffPending = { target: storageIdentityKey, stores, identityKey }
                  this._authId.isActive = false
                })
              })
            ),
          copy: async (source, destination) => {
            const reader = stores.find(
                store => store.settings?.storageIdentityKey === source.storageIdentityKey
              )!.storage,
              writer = stores.find(
                store => store.settings?.storageIdentityKey === destination.storageIdentityKey
              )!.storage
            let observerFailure: { error: unknown } | undefined
            const notify = <T>(callback: ((value: T) => unknown) | undefined, value: T) => {
              try {
                return callback?.(value)
              } catch (error) {
                observerFailure = { error }
                throw error
              }
            }
            const copy = (fields = false) =>
              awaitFromSync(() =>
                this.tryJournalCopy(
                  reader,
                  writer,
                  {
                    ...options,
                    maxRoughSize: options.maxRoughSize ?? 10000000,
                    ...(fields ? { journalFields: true } : {}),
                    onProgress: progress => {
                      notify(options.onProgress, progress)
                      log += this.committedPageLog(progress, value => notify(progLog, value) as string)
                    },
                    onJournalProgress: progress => notify(options.onJournalProgress, progress)
                  },
                  selected,
                  undefined,
                  false
                )
              )
            let copied: SyncSessionResult | undefined
            try {
              copied = await copy()
            } catch (error) {
              if (observerFailure !== undefined && observerFailure.error === error) throw error
              if (!(error instanceof SnapshotResourceLimitError)) throw error
              copied = await copy(true)
              if (copied === undefined) throw error
            }
            if (copied?.status === 'cancelled')
              throw new SnapshotCancelledError('Primary copy stopped; recover actual participant status')
            if (copied?.status !== 'completed')
              throw new WERR_INVALID_OPERATION('Durable primary copy did not complete')
          }
        })
      }
      // Observe actual agreed roles outside ownership, then release the local
      // lifecycle barrier and refresh selection without holding a queue over HTTP.
      for (const store of stores) {
        const { user } = await store.storage.findOrInsertUser(identityKey)
        if (user.activeStorage !== storageIdentityKey)
          throw new WERR_INVALID_OPERATION('Primary selection is not agreed by all managed stores')
      }
      await queue(() => {
        return promiseFromSync(() => {
          this.#primaryHandoffPending = undefined
          this.invalidatePrimarySelection()
        })
      })
      await this.makeAvailable()
      if (this.getActiveStore() !== storageIdentityKey || !this.isActiveEnabled)
        throw new WERR_INVALID_OPERATION('Primary handoff selection did not become available')
      return log + progLog('DURABLE PRIMARY SELECTION AND PROPAGATION COMPLETE\n')
    } catch (error) {
      this.invalidatePrimarySelection()
      throw error
    } finally {
      this.primaryCopyAdmissions.delete(selected)
    }
  }

  /** Complete data merge precedes a short primary cutover. The transition queue
   * serializes competing selections; foreground wallet access keeps using its
   * actual current primary while every source/proof read runs outside ownership.
   * Older providers retain their explicit serialized compatibility contract. */
  private async trySetActiveJournal(
    storageIdentityKey: string,
    progLog: (value: string) => string
  ): Promise<string | undefined> {
    const stores = [...this._stores]
    if (stores.length < 2 || stores.length > 9) return undefined
    for (const store of stores) {
      if (
        !journalSource(store.storage) ||
        !journalDestination(store.storage) ||
        !(await store.storage.supportsSnapshotJournalSync())
      )
        return undefined
    }
    const selected = await this.withAccess(active => {
      if (stores.length !== this._stores.length || stores.some(store => !this._stores.includes(store)))
        throw new WERR_INVALID_OPERATION('Managed stores changed before primary reconciliation; retry selection')
      const target = stores.find(store => store.settings?.storageIdentityKey === storageIdentityKey)
      if (target === undefined) throw new WERR_INVALID_PARAMETER('storageIdentityKey', 'a registered storage provider')
      const contributors = this._conflictingActives?.length
        ? [...new Set([this._active as ManagedStorage, ...(this._conflictingActives ?? [])])].filter(
            store => store !== target
          )
        : [this._active as ManagedStorage].filter(store => store !== target)
      return Promise.resolve({
        active,
        generation: this.generation,
        target,
        contributors,
        unchanged: storageIdentityKey === this.getActiveStore() && this.isActiveEnabled
      })
    })
    if (selected.unchanged) return progLog(`setActive to ${selected.target.settings?.storageName} unchanged\n`)
    if (selected.contributors.length === 0) return undefined
    let log = progLog(
      `setActive to ${selected.target.settings?.storageName}\nMERGE CURRENT SOURCE DATA BEFORE PRIMARY CUTOVER\n`
    )
    let activated = false
    try {
      for (let attempt = 0; attempt < 8 && !activated; attempt++) {
        const copies: JournalCopyCustody[] = []
        for (const contributor of selected.contributors) {
          const copied = await this.tryJournalCopy(
            contributor.storage,
            selected.target.storage,
            {
              maxRoughSize: 10000000,
              onProgress: progress => {
                log += this.committedPageLog(progress, progLog)
              }
            },
            selected,
            value => copies.push(value),
            false
          )
          if (copied?.status !== 'completed')
            throw new WERR_INVALID_OPERATION('Primary source reconciliation did not complete')
        }
        const sources: SnapshotJournalCutoverSource[] = []
        let selectionFailure: { cause: unknown } | undefined
        try {
          // Opening and closure validation can read/prove source payloads; keep
          // them outside the actual manager's final cutover admission.
          for (const copy of copies)
            sources.push({
              source: await copy.reader.openCurrentSnapshotJournalSource(this._authId.identityKey),
              since: copy.source.receipt.highWater
            })
          sources.sort((a, b) => a.source.receiptBinding.backend.localeCompare(b.source.receiptBinding.backend))
          const last = copies[copies.length - 1]
          activated = await last.destination.selectPrimary(last.checkpoint, storageIdentityKey, sources, () => {
            this.generation++
            this.invalidatePrimarySelection()
          })
        } catch (cause) {
          selectionFailure = { cause }
        }
        // Drain every contributor before propagating selection or close errors.
        const drained = await Promise.allSettled(
          sources.map(value => awaitVoidFromSync(() => closeSnapshotJournalSource(value.source)))
        )
        const failures = drained.filter(value => value.status === 'rejected')
        if (failures.length !== 0)
          throw new AggregateError(
            [
              ...(selectionFailure === undefined ? [] : [selectionFailure.cause]),
              ...failures.map(value => value.reason)
            ],
            'Primary source ownership did not drain'
          )
        if (selectionFailure !== undefined) throw selectionFailure.cause
        if (!activated) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (!activated)
        throw new WERR_INVALID_OPERATION(
          'Sources remain busy before cutover; copied pages are retained, retry selection'
        )
      // The target now owns the selected primary. Reconcile and propagate its
      // selection to each other managed store using fresh independent windows.
      await this.makeAvailable()
      for (const store of stores) {
        if (store === selected.target) continue
        const copied = await this.tryJournalPush(selected.target.storage, store.storage, {
          maxRoughSize: 10000000,
          onProgress: progress => {
            log += this.committedPageLog(progress, progLog)
          }
        })
        if (copied?.status !== 'completed') throw new WERR_INVALID_OPERATION('Primary propagation did not complete')
      }
      await this.makeAvailable()
      if (this.getActiveStore() !== storageIdentityKey || !this.isActiveEnabled)
        throw new WERR_INVALID_OPERATION('Primary selection is not agreed by all managed stores')
      return log + progLog('PRIMARY SELECTION AND PROPAGATION COMPLETE\n')
    } catch (error) {
      this.invalidatePrimarySelection()
      throw error
    }
  }

  private async setActiveLegacy(storageIdentityKey: string, progLog?: (s: string) => string): Promise<string> {
    progLog ||= s => s
    if (!this.isAvailable()) await this.makeAvailable()

    // Confirm a valid storageIdentityKey: must match one of the _stores.
    const newActiveIndex = this._stores.findIndex(
      s => (s.settings as TableSettings).storageIdentityKey === storageIdentityKey
    )
    if (newActiveIndex < 0) {
      throw new WERR_INVALID_PARAMETER(
        'storageIdentityKey',
        `registered with this "WalletStorageManager". ${storageIdentityKey} does not match any managed store.`
      )
    }

    const identityKey = (await this.getAuth()).identityKey
    const newActive = this._stores[newActiveIndex]

    let log = progLog(`setActive to ${(newActive.settings as TableSettings).storageName}`)

    log += await this.runAsSync(async _sync => {
      // An earlier queued switch may have changed the primary since this call.
      // Decide even a no-op under the same ownership as an actual switch.
      if (storageIdentityKey === this.getActiveStore() && this.isActiveEnabled) {
        return progLog(' unchanged\n')
      }
      let log = progLog('\n')
      this.generation++

      try {
        if ((this._conflictingActives as ManagedStorage[]).length > 0) {
          // Merge state from conflicting actives into `newActive`.

          // Handle case where new active is current active to resolve conflicts.
          // And where new active is one of the current conflict actives.
          ;(this._conflictingActives as ManagedStorage[]).push(this._active as ManagedStorage)
          // Remove the new active from conflicting actives and
          // set new active as the conflicting active that matches the target `storageIdentityKey`
          this._conflictingActives = (this._conflictingActives as ManagedStorage[]).filter(ca => {
            const isNewActive = (ca.settings as TableSettings).storageIdentityKey === storageIdentityKey
            return !isNewActive
          })

          // Merge state from conflicting actives into `newActive`.
          for (const conflict of this._conflictingActives) {
            log += progLog('MERGING STATE FROM CONFLICTING ACTIVES:\n')
            const sfr = await this.syncToWriter(
              { identityKey, userId: (newActive.user as TableUser).userId, isActive: false },
              newActive.storage,
              conflict.storage,
              undefined,
              progLog
            )
            log += sfr.log
          }
          log += progLog('PROPAGATE MERGED ACTIVE STATE TO NON-ACTIVES\n')
        } else {
          log += progLog('BACKUP CURRENT ACTIVE STATE THEN SET NEW ACTIVE\n')
        }

        // If there were conflicting actives,
        // Push state merged from all merged actives into newActive to all stores other than the now single active.
        // Otherwise,
        // Push state from current active to all other stores.
        const backupSource =
          (this._conflictingActives as ManagedStorage[]).length > 0 ? newActive : (this._active as ManagedStorage)

        // Update the backupSource's user record with the new activeStorage
        // which will propagate to all other stores in the following backup loop.
        await backupSource.storage.setActive(
          { identityKey, userId: (backupSource.user as TableUser).userId },
          storageIdentityKey
        )

        for (const store of this._stores) {
          // Update cached user.activeStorage of all stores
          ;(store.user as TableUser).activeStorage = storageIdentityKey

          if (
            (store.settings as TableSettings).storageIdentityKey !==
            (backupSource.settings as TableSettings).storageIdentityKey
          ) {
            // If this store is not the backupSource store push state from backupSource to this store.
            const stwr = await this.syncToWriter(
              { identityKey, userId: (store.user as TableUser).userId, isActive: false },
              store.storage,
              backupSource.storage,
              undefined,
              progLog
            )
            log += stwr.log
          }
        }

        this._isAvailable = false
        await this.makeAvailable()

        return log
      } catch (error) {
        // Partial propagation can leave stores disagreeing about the primary.
        // Discard cached users before the next authorization or queued access.
        this._isAvailable = false
        this._authId.isActive = false
        for (const store of this._stores) store.isAvailable = false
        throw error
      }
    })

    return log
  }

  /**
   * Return the remote HTTP(S) endpoint for a managed store, if any.
   *
   * Duck-types `endpointUrl` on the provider (as set by `StorageClientBase`).
   * Do **not** key this off `constructor.name === 'StorageClient'`: production
   * minifiers (Vite/esbuild/webpack) rename classes, so that check fails and
   * every remote store reports `endpointURL: undefined` even though the URL is
   * present. Consumers that match backups by URL (e.g. making a remote store
   * primary) then fail while sync still works, because sync walks `_backups`
   * without needing `endpointURL`.
   */
  getStoreEndpointURL(store: ManagedStorage): string | undefined {
    const url = (store.storage as { endpointUrl?: unknown }).endpointUrl
    if (typeof url === 'string' && url.length > 0) return url
    return undefined
  }

  getStores(): sdk.WalletStorageInfo[] {
    const stores: sdk.WalletStorageInfo[] = []
    if (this._active != null) {
      stores.push({
        isActive: true,
        isEnabled: this.isActiveEnabled,
        isBackup: false,
        isConflicting: false,
        userId: (this._active.user as TableUser).userId,
        storageIdentityKey: (this._active.settings as TableSettings).storageIdentityKey,
        storageName: (this._active.settings as TableSettings).storageName,
        storageClass: this._active.storage.constructor.name,
        endpointURL: this.getStoreEndpointURL(this._active)
      })
    }
    for (const store of this._conflictingActives ?? []) {
      stores.push({
        isActive: true,
        isEnabled: false,
        isBackup: false,
        isConflicting: true,
        userId: (store.user as TableUser).userId,
        storageIdentityKey: (store.settings as TableSettings).storageIdentityKey,
        storageName: (store.settings as TableSettings).storageName,
        storageClass: store.storage.constructor.name,
        endpointURL: this.getStoreEndpointURL(store)
      })
    }
    for (const store of this._backups ?? []) {
      stores.push({
        isActive: false,
        isEnabled: false,
        isBackup: true,
        isConflicting: false,
        userId: (store.user as TableUser).userId,
        storageIdentityKey: (store.settings as TableSettings).storageIdentityKey,
        storageName: (store.settings as TableSettings).storageName,
        storageClass: store.storage.constructor.name,
        endpointURL: this.getStoreEndpointURL(store)
      })
    }
    return stores
  }
}

export interface VerifyAndRepairBeefResult {
  isStructurallyValid: boolean
  originalRoots: Record<number, string>
  invalidRoots: Record<number, { root: string; reproveResults: sdk.ReproveHeaderResult }>
  verifiedBeef?: Beef
}
