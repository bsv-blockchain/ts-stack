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
import { runPullSession, type SyncSessionOptions, type SyncSessionResult } from './sync/syncSession'
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
  access?: sdk.StorageCapabilities['storageAccess']
  user?: TableUser

  constructor(public storage: sdk.WalletStorageProvider) {
    this.isStorageProvider = storage.isStorageProvider()
    this.isAvailable = false
  }
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
    for (const store of this._stores) {
      store.settings ??= await store.storage.makeAvailable()
      if (reference != null) assertSyncNetwork(reference, store.settings)
      reference ??= store.settings
    }
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

  private async withAccess<R>(
    operation: (active: sdk.WalletStorageProvider) => Promise<R>,
    read = false,
    background = false
  ): Promise<R> {
    await this.makeAvailable()
    const concurrent = read && this._active?.access?.concurrentReads === true
    const release = await this.accessQueue.acquire(
      concurrent ? 'read' : 'exclusive',
      background ? 'background' : 'foreground'
    )
    // Primary selection may have changed while this request was queued. Never
    // apply the former provider's read-sharing promise to its replacement.
    if (concurrent && this._active?.access?.concurrentReads !== true) {
      release()
      return await this.withAccess(operation, read, background)
    }
    try {
      return await operation(this.getActive())
    } finally {
      release()
    }
  }

  async runAsWriter<R>(writer: (active: sdk.WalletStorageWriter) => Promise<R>): Promise<R> {
    return await this.withAccess(writer)
  }

  async runAsReader<R>(reader: (active: sdk.WalletStorageReader) => Promise<R>): Promise<R> {
    return await this.withAccess(reader, true)
  }

  /** Borrowed activeSync is the legacy explicit reentrancy contract for an already-held exclusive operation. */
  async runAsSync<R>(
    sync: (active: sdk.WalletStorageSync) => Promise<R>,
    activeSync?: sdk.WalletStorageSync
  ): Promise<R> {
    return activeSync == null ? await this.withAccess(sync) : await sync(activeSync)
  }

  async runAsStorageProvider<R>(sync: (active: StorageProvider) => Promise<R>): Promise<R> {
    return await this.withAccess(async active => {
      if (!active.isStorageProvider()) {
        throw new WERR_INVALID_OPERATION('Active "WalletStorageProvider" does not support "StorageProvider" interface.')
      }
      return await sync(active as unknown as StorageProvider)
    })
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
      await storage.transaction(async trx => {
        await invalidatePreparedBeefs(storage, trx)
      })
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

  async migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    return await this.runAsWriter(async writer => {
      return await writer.migrate(storageName, storageIdentityKey)
    })
  }

  async destroy(): Promise<void> {
    if (this._stores.length < 1) return
    return await this.runAsWriter(async _writer => {
      this.generation++
      for (const store of this._stores) await store.storage.destroy()
    })
  }

  async findOrInsertUser(identityKey: string): Promise<{ user: TableUser; isNew: boolean }> {
    const auth = await this.getAuth()
    if (identityKey !== auth.identityKey) throw new WERR_UNAUTHORIZED()

    return await this.runAsWriter(async writer => {
      const r = await writer.findOrInsertUser(identityKey)

      if (auth.userId != null && auth.userId !== 0 && auth.userId !== r.user.userId) {
        throw new WERR_INTERNAL('userId may not change for given identityKey')
      }
      this._authId.userId = r.user.userId
      return r
    })
  }

  async abortAction(args: AbortActionArgs): Promise<AbortActionResult> {
    validateAbortActionArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.abortAction(auth, args)
    })
  }

  async createAction(vargs: ValidCreateActionArgs): Promise<sdk.StorageCreateActionResult> {
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.createAction(auth, vargs)
    })
  }

  async internalizeAction(args: InternalizeActionArgs): Promise<sdk.StorageInternalizeActionResult> {
    validateInternalizeActionArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.internalizeAction(auth, args)
    })
  }

  async relinquishCertificate(args: RelinquishCertificateArgs): Promise<number> {
    validateRelinquishCertificateArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.relinquishCertificate(auth, args)
    })
  }

  async relinquishOutput(args: RelinquishOutputArgs): Promise<number> {
    validateRelinquishOutputArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.relinquishOutput(auth, args)
    })
  }

  async processAction(args: sdk.StorageProcessActionArgs): Promise<sdk.StorageProcessActionResults> {
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.processAction(auth, args)
    })
  }

  async prepareNoSendExpiry(args: ValidCreateActionArgs): Promise<sdk.StoragePrepareNoSendExpiryResult> {
    return await this.runAsWriter(async writer => {
      if (writer.prepareNoSendExpiry == null) {
        throw new WERR_INVALID_OPERATION('Active storage does not support BRC-177 noSend expiry')
      }
      return await writer.prepareNoSendExpiry(await this.getAuth(true), args)
    })
  }

  async activateNoSendExpiry(
    args: sdk.StorageActivateNoSendExpiryArgs
  ): Promise<sdk.StorageActivateNoSendExpiryResult> {
    return await this.runAsWriter(async writer => {
      if (writer.activateNoSendExpiry == null) {
        throw new WERR_INVALID_OPERATION('Active storage does not support BRC-177 noSend expiry')
      }
      return await writer.activateNoSendExpiry(await this.getAuth(true), args)
    })
  }

  async armNoSendExpiry(args: sdk.StorageArmNoSendExpiryArgs): Promise<void> {
    await this.runAsWriter(async writer => {
      if (writer.armNoSendExpiry == null) {
        throw new WERR_INVALID_OPERATION('Active storage does not support BRC-177 noSend expiry')
      }
      await writer.armNoSendExpiry(await this.getAuth(true), args)
    })
  }

  async getCapabilities(): Promise<sdk.StorageCapabilities> {
    return await this.runAsReader(async () => await this.getActive().getCapabilities())
  }

  async beginActionBatch(args: sdk.BeginActionBatchArgs): Promise<sdk.BeginActionBatchResult> {
    return await this.runAsWriter(async writer => await writer.beginActionBatch(await this.getAuth(true), args))
  }

  async extendActionBatch(args: sdk.ExtendActionBatchArgs): Promise<sdk.ExtendActionBatchResult> {
    return await this.runAsWriter(async writer => await writer.extendActionBatch(await this.getAuth(true), args))
  }

  async renewActionBatch(batchId: string): Promise<sdk.RenewActionBatchResult> {
    return await this.runAsWriter(async writer => await writer.renewActionBatch(await this.getAuth(true), batchId))
  }

  async resumeActionBatch(args: sdk.ResumeActionBatchArgs): Promise<sdk.ResumeActionBatchResult> {
    return await this.runAsWriter(async writer => {
      if (writer.resumeActionBatch == null) {
        throw new WERR_NOT_IMPLEMENTED('action batch resume is not available')
      }
      return await writer.resumeActionBatch(await this.getAuth(true), args)
    })
  }

  async prepareActionBatchCommit(manifest: sdk.ActionBatchManifest): Promise<sdk.PrepareActionBatchCommitResult> {
    return await this.runAsWriter(
      async writer => await writer.prepareActionBatchCommit(await this.getAuth(true), manifest)
    )
  }

  async putActionBatchBlob(args: sdk.PutActionBatchBlobArgs): Promise<void> {
    return await this.runAsWriter(async writer => await writer.putActionBatchBlob(await this.getAuth(true), args))
  }

  async putActionBatchPack(args: sdk.PutActionBatchPackArgs): Promise<void> {
    return await this.runAsWriter(async writer => {
      if (writer.putActionBatchPack == null) {
        throw new WERR_NOT_IMPLEMENTED('packed action batch uploads are not available')
      }
      await writer.putActionBatchPack(await this.getAuth(true), args)
    })
  }

  async commitActionBatch(manifest: sdk.ActionBatchManifest): Promise<sdk.CommitActionBatchResult> {
    return await this.runAsWriter(async writer => await writer.commitActionBatch(await this.getAuth(true), manifest))
  }

  async commitActionBatchByDigest(args: sdk.CommitActionBatchByDigestArgs): Promise<sdk.CommitActionBatchResult> {
    return await this.runAsWriter(async writer => {
      if (writer.commitActionBatchByDigest == null) {
        throw new WERR_NOT_IMPLEMENTED('digest-only action batch commit is not available')
      }
      return await writer.commitActionBatchByDigest(await this.getAuth(true), args)
    })
  }

  async abortActionBatch(batchId: string): Promise<sdk.AbortActionBatchResult> {
    return await this.runAsWriter(async writer => await writer.abortActionBatch(await this.getAuth(true), batchId))
  }

  async insertCertificate(certificate: TableCertificate): Promise<number> {
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.insertCertificateAuth(auth, certificate)
    })
  }

  async listActions(vargs: ValidListActionsArgs): Promise<ListActionsResult> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.listActions(auth, vargs)
    })
  }

  async listCertificates(args: ValidListCertificatesArgs): Promise<ListCertificatesResult> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.listCertificates(auth, args)
    })
  }

  async listOutputs(vargs: ValidListOutputsArgs): Promise<ListOutputsResult> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.listOutputs(auth, vargs)
    })
  }

  async findCertificates(args: sdk.FindCertificatesArgs): Promise<TableCertificateX[]> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.findCertificatesAuth(auth, args)
    })
  }

  async findOutputBaskets(args: sdk.FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.findOutputBasketsAuth(auth, args)
    })
  }

  async findOutputs(args: sdk.FindOutputsArgs): Promise<TableOutput[]> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.findOutputsAuth(auth, args)
    })
  }

  async findProvenTxReqs(args: sdk.FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    return await this.runAsReader(async reader => {
      return await reader.findProvenTxReqs(args)
    })
  }

  /**
   * For each proven_txs record currently sourcing its transaction merkle proof from the given deactivated header,
   * attempt to reprove the transaction against the current chain,
   * updating the proven_txs record if a new valid proof is found.
   *
   * @param deactivatedHash An orphaned header than may have served as a proof source for proven_txs records.
   * @returns
   */
  async reproveHeader(deactivatedHash: string): Promise<sdk.ReproveHeaderResult> {
    return await this.reproveMatching({ blockHash: deactivatedHash }, `block ${deactivatedHash} orphaned`)
  }

  /** Audit a stale root against the same canonical evidence as reorg recovery. */
  async reproveHeightMerkleRoot(height: number, staleMerkleRoot: string): Promise<sdk.ReproveHeaderResult> {
    return await this.reproveMatching(
      { height, merkleRoot: staleMerkleRoot },
      `height ${height} stale merkleRoot ${staleMerkleRoot}`
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
    const prepared = await mapProofWork(ptxs, async ptx => await this.prepareReproof(storage, ptx))
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
        for (let index = 0; index < ptxs.length; index++) {
          const ptx = ptxs[index]
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
        }
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
    const { storage, generation } = await this.runAsStorageProvider(async storage => ({
      storage,
      generation: this.generation
    }))
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

    let inserts = 0
    let updates = 0

    log = await this.runAsSync(async sync => {
      const writer = sync
      const writerSettings = writer.getSettings()
      assertSyncNetwork(readerSettings, writerSettings)

      log += `syncFromReader from ${readerSettings.storageName} to ${writerSettings.storageName}\n`

      const loadRequest = async (): Promise<sdk.RequestSyncChunkArgs> =>
        await this.loadSyncRequest(auth, writer, readerSettings, writerSettings.storageIdentityKey)
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
   * replica merge, not a point-in-time source snapshot or primary activation.
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
    const run = async (commit: <T>(operation: () => Promise<T>) => Promise<T>): Promise<SyncSessionResult> =>
      await runPullSession(
        {
          reader,
          writer,
          activeStorage,
          atomicCheckpoint,
          mode: paged ? 'paged' : 'exclusive',
          loadRequest: async () =>
            await this.loadSyncRequest(auth, writer, readerSettings, writerSettings.storageIdentityKey),
          prepare: paged
            ? async (args, chunk) => await (writer as StorageProvider).prepareSyncChunk(args, chunk)
            : undefined,
          commit
        },
        options
      )
    if (paged) {
      return await run(
        async operation =>
          await this.withAccess(
            async () => {
              assertCurrent()
              return await operation()
            },
            false,
            true
          )
      )
    }
    return await this.runAsSync(async () => {
      assertCurrent()
      return await run(async operation => {
        assertCurrent()
        return await operation()
      })
    })
  }

  async syncToWriter(
    auth: sdk.AuthId,
    writer: sdk.WalletStorageProvider,
    activeSync?: sdk.WalletStorageSync,
    log: string = '',
    progLog?: (s: string) => string
  ): Promise<{ inserts: number; updates: number; log: string }> {
    progLog ||= s => s

    const writerSettings = await writer.makeAvailable()
    await this.preflightManagedNetworks(writerSettings)
    if (activeSync != null) assertSyncNetwork(activeSync.getSettings(), writerSettings)

    let inserts = 0
    let updates = 0

    log = await this.runAsSync(async sync => {
      const reader = sync
      const readerSettings = reader.getSettings()
      assertSyncNetwork(readerSettings, writerSettings)

      log += progLog(`syncToWriter from ${readerSettings.storageName} to ${writerSettings.storageName}\n`)

      const loadRequest = async (): Promise<sdk.RequestSyncChunkArgs> =>
        await this.loadSyncRequest(auth, writer, readerSettings, writerSettings.storageIdentityKey)
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
  async setActive(storageIdentityKey: string, progLog?: (s: string) => string): Promise<string> {
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

    if (storageIdentityKey === this.getActiveStore() && this.isActiveEnabled) {
      /** Setting the current active as the new active is a permitted no-op. */
      return log + progLog(' unchanged\n')
    }

    log += progLog('\n')

    log += await this.runAsSync(async _sync => {
      this.generation++
      let log = ''

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
