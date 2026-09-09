import { type SyncTransferCapabilities, type SyncTransferManifest, type SyncTransferPart,
  encodeSyncTransfer, syncTransferDigest, receiveSyncTransfer,
  validateSyncTransferCapabilities, validateSyncTransferManifest } from './SyncTransfer'
import { syncChunkBinary } from './syncChunkBinary'
import { validateSyncCheckpoint } from '../sync/syncCheckpoint'
import {
  AbortActionArgs,
  AbortActionResult,
  Beef,
  InternalizeActionArgs,
  ListActionsResult,
  ListCertificatesResult,
  ListOutputsResult,
  RelinquishCertificateArgs,
  RelinquishOutputArgs,
  WalletInterface,
  AuthFetch,
  Validation,
  Telemetry,
  TelemetryConfig,
  TelemetrySpan
} from '@bsv/sdk'
import {
  AuthId,
  FindCertificatesArgs,
  FindOutputBasketsArgs,
  FindOutputsArgs,
  FindProvenTxReqsArgs,
  ProcessSyncChunkResult,
  RequestSyncChunkArgs,
  StorageCreateActionResult,
  StorageInternalizeActionResult,
  StorageProcessActionArgs,
  StorageProcessActionResults,
  StoragePrepareNoSendExpiryResult,
  StorageActivateNoSendExpiryArgs,
  StorageActivateNoSendExpiryResult,
  StorageArmNoSendExpiryArgs,
  SyncChunk,
  SyncCheckpoint,
  UpdateProvenTxReqWithNewProvenTxArgs,
  UpdateProvenTxReqWithNewProvenTxResult,
  WalletStorageProvider
} from '../../sdk/WalletStorage.interfaces'
import {
  AbortActionBatchResult,
  ActionBatchManifest,
  BeginActionBatchArgs,
  BeginActionBatchResult,
  CommitActionBatchByDigestArgs,
  CommitActionBatchResult,
  ExtendActionBatchArgs,
  ExtendActionBatchResult,
  PrepareActionBatchCommitResult,
  PutActionBatchBlobArgs,
  PutActionBatchPackArgs,
  ResumeActionBatchArgs,
  ResumeActionBatchResult,
  RenewActionBatchResult,
  StorageCapabilities
} from '../../sdk/ActionBatch.interfaces'
import { TableSettings } from '../schema/tables/TableSettings'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { WalletServices } from '../../sdk/WalletServices.interfaces'
import { TableUser } from '../schema/tables/TableUser'
import { TableSyncState } from '../schema/tables/TableSyncState'
import { TableCertificateX } from '../schema/tables/TableCertificate'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableProvenTxReq } from '../schema/tables/TableProvenTxReq'
import { EntityTimeStamp } from '../../sdk/types'
import { validateDate, validateEntity, validateEntities, validateSyncChunkEntities } from './entityValidationHelpers'
import {
  ACTION_BATCH_PACK_ENCODING_HEADER,
  actionBatchPackLength,
  compressActionBatchPackItems,
  encodeActionBatchPack,
  supportedActionBatchPackEncodings
} from '../../utility/actionBatchPack'
import { pruneBeefForTxids } from '../../utility/beefForTxids'

const syncChunkResponseRetryLimit = 4
const minimumSyncChunkRoughSize = 64 * 1024

function isSyncChunkResponseTooLarge (error: unknown): boolean {
  return error instanceof Error && /WalletStorageClient rpcCall: network error 413(?:\s|$)/.test(error.message)
}

type RemoteStorageSettings = TableSettings & {
  /** Runtime-only RPC advertisement, not a persisted settings-table column. */
  syncCheckpointVersion?: 1
  syncTransfer?: SyncTransferCapabilities
}

export interface StorageClientOptions {
  /**
   * Send compact tagged binary request values after the server advertises
   * support. Leave disabled during rolling deployments where an endpoint may
   * still route requests to legacy server instances.
   */
  binaryRequests?: boolean
  /**
   * Optional vendor-neutral tracing. Disabled unless an enabled sink is
   * supplied. Request parameters and response payloads are never emitted.
   */
  telemetry?: TelemetryConfig
}

/**
 * Abstract base class shared by `StorageClient` and `StorageMobile`.
 *
 * Contains all `WalletStorageProvider` method implementations and entity-validation
 * helpers. Subclasses only need to provide `rpcCall`, which differs between
 * the full (logger-aware) and mobile (lightweight) variants.
 */
export abstract class StorageClientBase implements WalletStorageProvider {
  readonly endpointUrl: string
  protected readonly authClient: AuthFetch
  protected nextId = 1
  protected serverSupportsBinary = false
  protected readonly binaryRequests: boolean
  protected readonly telemetry: Telemetry
  private syncChunkRoughSizeLimit?: number
  /** Optional progress/cancellation hook for a bounded transfer; never receives wallet contents. */
  onSyncTransferProgress?: (progress: { direction: 'read' | 'write'; bytes: number; totalBytes: number }) => void

  // Track ephemeral (in-memory) "settings" if you wish to align with isAvailable() checks
  public settings?: RemoteStorageSettings

  constructor(wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {}) {
    this.authClient = new AuthFetch(wallet)
    this.endpointUrl = endpointUrl
    this.binaryRequests = options.binaryRequests === true
    this.telemetry = new Telemetry(options.telemetry)
  }

  protected async traceRpcCall<T>(
    method: string,
    params: unknown[],
    callback: (span?: TelemetrySpan) => Promise<T>
  ): Promise<T> {
    if (!this.telemetry.enabled) return await callback()
    const carrier = params.find(param => typeof param === 'object' && param != null) as object | undefined
    return await this.telemetry.withSpan(
      'wallet.storage.rpc',
      {
        component: 'wallet-storage-client',
        kind: 'client',
        carrier,
        attributes: {
          'rpc.method': method,
          'rpc.system': 'wallet-storage',
          'network.protocol': 'http'
        }
      },
      callback
    )
  }

  protected async traceRpcStep<T>(
    name: string,
    parent: TelemetrySpan | undefined,
    callback: (span?: TelemetrySpan) => Promise<T> | T,
    attributes?: Readonly<Record<string, unknown>>
  ): Promise<T> {
    if (parent == null) return await callback()
    return await this.telemetry.withSpan(
      name,
      {
        component: 'wallet-storage-client',
        kind: 'client',
        parent: parent.context,
        attributes
      },
      callback
    )
  }

  /**
   * The `StorageClient` implements the `WalletStorageProvider` interface.
   * It does not implement the lower level `StorageProvider` interface.
   *
   * @returns false
   */
  isStorageProvider(): boolean {
    return false
  }

  /**
   * Make a JSON-RPC call to the remote server.
   * Implemented differently by each subclass (with or without logger support).
   * @param method The WalletStorage method name to call.
   * @param params The array of parameters to pass to the method in order.
   */
  protected abstract rpcCall<T>(method: string, params: unknown[]): Promise<T>

  /**
   * @returns true once storage `TableSettings` have been retreived from remote storage.
   */
  isAvailable(): boolean {
    // We'll just say "yes" if we have settings
    return this.settings != null
  }

  /**
   * @returns remote storage `TableSettings` if they have been retreived by `makeAvailable`.
   * @throws WERR_INVALID_OPERATION if `makeAvailable` has not yet been called.
   */
  getSettings(): RemoteStorageSettings {
    if (this.settings == null) {
      throw new WERR_INVALID_OPERATION('call makeAvailable at least once before getSettings')
    }
    return this.settings
  }

  /**
   * Must be called prior to making use of storage.
   * Retreives `TableSettings` from remote storage provider.
   * @returns remote storage `TableSettings`
   */
  async makeAvailable(): Promise<RemoteStorageSettings> {
    this.settings ??= await this.rpcCall<RemoteStorageSettings>('makeAvailable', [])
    return this.settings
  }

  /// ///////////////////////////////////////////////////////////////////////////
  //
  // Implementation of all WalletStorage interface methods
  // They are simple pass-thrus to rpcCall
  //
  // IMPORTANT: The parameter ordering must match exactly as in your interface.
  /// ///////////////////////////////////////////////////////////////////////////

  /**
   * Called to cleanup resources when no further use of this object will occur.
   */
  async destroy(): Promise<void> {
    return await this.rpcCall<void>('destroy', [])
  }

  /**
   * Requests schema migration to latest.
   * Typically remote storage will ignore this request.
   * @param storageName Unique human readable name for remote storage if it does not yet exist.
   * @param storageIdentityKey Unique identity key for remote storage if it does not yet exist.
   * @returns current schema migration identifier
   */
  async migrate(storageName: string, _storageIdentityKey: string): Promise<string> {
    return await this.rpcCall<string>('migrate', [storageName])
  }

  /**
   * Remote storage does not offer `Services` to remote clients.
   * @throws WERR_INVALID_OPERATION
   */
  getServices(): WalletServices {
    // Typically, the client would not store or retrieve "Services" from a remote server.
    // The "services" in local in-memory usage is a no-op or your own approach:
    throw new WERR_INVALID_OPERATION(
      'getServices() not implemented in remote client. This method typically is not used remotely.'
    )
  }

  /**
   * Ignored. Remote storage cannot share `Services` with remote clients.
   */
  setServices(_v: WalletServices): void {
    // Typically no-op for remote client
    // Because "services" are usually local definitions to the Storage.
  }

  /**
   * Storage level processing for wallet `internalizeAction`.
   * Updates internalized outputs in remote storage.
   * Triggers proof validation of containing transaction.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Original wallet `internalizeAction` arguments.
   * @returns `internalizeAction` results
   */
  async internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult> {
    return await this.rpcCall<StorageInternalizeActionResult>('internalizeAction', [auth, args])
  }

  /**
   * Storage level processing for wallet `createAction`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `createAction` arguments.
   * @returns `StorageCreateActionResults` supporting additional wallet processing to yield `createAction` results.
   */
  async createAction(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult> {
    if (args.inputBEEF != null) {
      if (args.inputs.length === 0) {
        args = {
          ...args,
          inputBEEF: undefined
        }
      } else {
        let source: Beef | undefined
        try {
          source = Beef.fromBinary(args.inputBEEF)
        } catch {
          // Forward malformed proof data so the server preserves its established
          // validation error contract.
          source = undefined
        }
        if (source != null) {
          const pruned = pruneBeefForTxids(
            source,
            args.inputs.map(input => input.outpoint.txid)
          )
          if (pruned != null) {
            args = {
              ...args,
              inputBEEF: pruned.toBinary()
            }
          }
        }
      }
    }
    return await this.rpcCall<StorageCreateActionResult>('createAction', [auth, args])
  }

  /**
   * Storage level processing for wallet `createAction` and `signAction`.
   *
   * Handles remaining storage tasks once a fully signed transaction has been completed. This is common to both `createAction` and `signAction`.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args `StorageProcessActionArgs` convey completed signed transaction to storage.
   * @returns `StorageProcessActionResults` supporting final wallet processing to yield `createAction` or `signAction` results.
   */
  async processAction(auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults> {
    return await this.rpcCall<StorageProcessActionResults>('processAction', [auth, args])
  }

  async prepareNoSendExpiry(
    auth: AuthId,
    args: Validation.ValidCreateActionArgs
  ): Promise<StoragePrepareNoSendExpiryResult> {
    return await this.rpcCall<StoragePrepareNoSendExpiryResult>('prepareNoSendExpiry', [auth, args])
  }

  async activateNoSendExpiry(
    auth: AuthId,
    args: StorageActivateNoSendExpiryArgs
  ): Promise<StorageActivateNoSendExpiryResult> {
    return await this.rpcCall<StorageActivateNoSendExpiryResult>('activateNoSendExpiry', [auth, args])
  }

  async armNoSendExpiry(auth: AuthId, args: StorageArmNoSendExpiryArgs): Promise<void> {
    await this.rpcCall<void>('armNoSendExpiry', [auth, args])
  }

  async getCapabilities(): Promise<StorageCapabilities> {
    return await this.rpcCall<StorageCapabilities>('getCapabilities', [])
  }

  async beginActionBatch(auth: AuthId, args: BeginActionBatchArgs): Promise<BeginActionBatchResult> {
    return await this.rpcCall<BeginActionBatchResult>('beginActionBatch', [auth, args])
  }

  async extendActionBatch(auth: AuthId, args: ExtendActionBatchArgs): Promise<ExtendActionBatchResult> {
    return await this.rpcCall<ExtendActionBatchResult>('extendActionBatch', [auth, args])
  }

  async renewActionBatch(auth: AuthId, batchId: string): Promise<RenewActionBatchResult> {
    return await this.rpcCall<RenewActionBatchResult>('renewActionBatch', [auth, batchId])
  }

  async resumeActionBatch(auth: AuthId, args: ResumeActionBatchArgs): Promise<ResumeActionBatchResult> {
    return await this.rpcCall<ResumeActionBatchResult>('resumeActionBatch', [auth, args])
  }

  async prepareActionBatchCommit(auth: AuthId, manifest: ActionBatchManifest): Promise<PrepareActionBatchCommitResult> {
    return await this.rpcCall<PrepareActionBatchCommitResult>('prepareActionBatchCommit', [auth, manifest])
  }

  async putActionBatchBlob(auth: AuthId, args: PutActionBatchBlobArgs): Promise<void> {
    const baseUrl = this.endpointUrl.endsWith('/') ? this.endpointUrl.slice(0, -1) : this.endpointUrl
    const url = `${baseUrl}/action-batch/${encodeURIComponent(args.batchId)}/blob/${encodeURIComponent(args.digest)}`
    const bytes = args.bytes instanceof Uint8Array ? args.bytes : Uint8Array.from(args.bytes)
    const response = await this.authClient.fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes
    })
    if (!response.ok) {
      const details = (await response.text()).slice(0, 512)
      throw new Error(
        `WalletStorageClient putActionBatchBlob: network error ${response.status} ${response.statusText}: ${details}`
      )
    }
  }

  async putActionBatchPack(_auth: AuthId, args: PutActionBatchPackArgs): Promise<void> {
    const available = new Set(supportedActionBatchPackEncodings())
    const encoding = (args.preferredEncodings ?? ['identity']).find(candidate => available.has(candidate)) ?? 'identity'
    const frameLength = actionBatchPackLength(args.items)
    let body = await compressActionBatchPackItems(args.items, encoding, args.maxPackBytes, args.maxItems)
    let transmittedEncoding = encoding
    if (encoding !== 'identity' && body.length >= frameLength) {
      body = encodeActionBatchPack(args.items, args.maxPackBytes, args.maxItems)
      transmittedEncoding = 'identity'
    }
    const baseUrl = this.endpointUrl.endsWith('/') ? this.endpointUrl.slice(0, -1) : this.endpointUrl
    const url = `${baseUrl}/action-batch/${encodeURIComponent(args.batchId)}/pack`
    const response = await this.authClient.fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        [ACTION_BATCH_PACK_ENCODING_HEADER]: transmittedEncoding
      },
      body
    })
    if (!response.ok) {
      const details = (await response.text()).slice(0, 512)
      throw new Error(
        `WalletStorageClient putActionBatchPack: network error ${response.status} ${response.statusText}: ${details}`
      )
    }
  }

  async commitActionBatch(auth: AuthId, manifest: ActionBatchManifest): Promise<CommitActionBatchResult> {
    return await this.rpcCall<CommitActionBatchResult>('commitActionBatch', [auth, manifest])
  }

  async commitActionBatchByDigest(auth: AuthId, args: CommitActionBatchByDigestArgs): Promise<CommitActionBatchResult> {
    return await this.rpcCall<CommitActionBatchResult>('commitActionBatchByDigest', [auth, args])
  }

  async abortActionBatch(auth: AuthId, batchId: string): Promise<AbortActionBatchResult> {
    return await this.rpcCall<AbortActionBatchResult>('abortActionBatch', [auth, batchId])
  }

  /**
   * Aborts an action by `reference` string.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args original wallet `abortAction` args.
   * @returns `abortAction` result.
   */
  async abortAction(auth: AuthId, args: AbortActionArgs): Promise<AbortActionResult> {
    return await this.rpcCall<AbortActionResult>('abortAction', [auth, args])
  }

  /**
   * Used to both find and initialize a new user by identity key.
   * It is up to the remote storage whether to allow creation of new users by this method.
   * @param identityKey of the user.
   * @returns `TableUser` for the user and whether a new user was created.
   */
  async findOrInsertUser(identityKey: string): Promise<{ user: TableUser; isNew: boolean }> {
    return await this.rpcCall<{ user: TableUser; isNew: boolean }>('findOrInsertUser', [identityKey])
  }

  /** Read compact progress only when the provider advertises support. */
  async getSyncCheckpoint(auth: AuthId, storageIdentityKey: string, storageName: string): Promise<SyncCheckpoint | undefined> {
    // Settings are already exchanged with legacy providers. Only an advertised
    // capability enables this RPC; transport and authentication failures propagate.
    if ((await this.makeAvailable()).syncCheckpointVersion !== 1) return undefined
    const checkpoint = await this.rpcCall<SyncCheckpoint>('getSyncCheckpoint', [auth, storageIdentityKey, storageName])
    return validateSyncCheckpoint(checkpoint)
  }

  /**
   * Used to both find and insert a `TableSyncState` record for the user to track wallet data replication across storage providers.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param storageName the name of the remote storage being sync'd
   * @param storageIdentityKey the identity key of the remote storage being sync'd
   * @returns `TableSyncState` and whether a new record was created.
   */
  async findOrInsertSyncStateAuth(
    auth: AuthId,
    storageIdentityKey: string,
    storageName: string
  ): Promise<{ syncState: TableSyncState; isNew: boolean }> {
    const r = await this.rpcCall<{ syncState: TableSyncState; isNew: boolean }>('findOrInsertSyncStateAuth', [
      auth,
      storageIdentityKey,
      storageName
    ])
    r.syncState = validateEntity(r.syncState, ['when'])
    return r
  }

  /**
   * Inserts a new certificate with fields and keyring into remote storage.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param certificate the certificate to insert.
   * @returns record Id of the inserted `TableCertificate` record.
   */
  async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> {
    const r = await this.rpcCall<number>('insertCertificateAuth', [auth, certificate])
    return r
  }

  /**
   * Storage level processing for wallet `listActions`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `listActions` arguments.
   * @returns `listActions` results.
   */
  async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> {
    const r = await this.rpcCall<ListActionsResult>('listActions', [auth, vargs])
    return r
  }

  /**
   * Storage level processing for wallet `listOutputs`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `listOutputs` arguments.
   * @returns `listOutputs` results.
   */
  async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> {
    const r = await this.rpcCall<ListOutputsResult>('listOutputs', [auth, vargs])
    return r
  }

  /**
   * Storage level processing for wallet `listCertificates`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `listCertificates` arguments.
   * @returns `listCertificates` results.
   */
  async listCertificates(auth: AuthId, vargs: Validation.ValidListCertificatesArgs): Promise<ListCertificatesResult> {
    const r = await this.rpcCall<ListCertificatesResult>('listCertificates', [auth, vargs])
    return r
  }

  /**
   * Find user certificates, optionally with fields.
   *
   * This certificate retrieval method supports internal wallet operations.
   * Field values are stored and retrieved encrypted.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args `FindCertificatesArgs` determines which certificates to retrieve and whether to include fields.
   * @returns array of certificates matching args.
   */
  async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    const r = await this.rpcCall<TableCertificateX[]>('findCertificatesAuth', [auth, args])
    validateEntities(r)
    if (args.includeFields) {
      for (const c of r) {
        if (c.fields != null) validateEntities(c.fields)
      }
    }
    return r
  }

  /**
   * Find output baskets.
   *
   * This retrieval method supports internal wallet operations.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args `FindOutputBasketsArgs` determines which baskets to retrieve.
   * @returns array of output baskets matching args.
   */
  async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    const r = await this.rpcCall<TableOutputBasket[]>('findOutputBasketsAuth', [auth, args])
    validateEntities(r)
    return r
  }

  /**
   * Find outputs.
   *
   * This retrieval method supports internal wallet operations.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args `FindOutputsArgs` determines which outputs to retrieve.
   * @returns array of outputs matching args.
   */
  async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    const r = await this.rpcCall<TableOutput[]>('findOutputsAuth', [auth, args])
    validateEntities(r)
    return r
  }

  /**
   * Find requests for transaction proofs.
   *
   * This retrieval method supports internal wallet operations.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args `FindProvenTxReqsArgs` determines which proof requests to retrieve.
   * @returns array of proof requests matching args.
   */
  async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    const r = await this.rpcCall<TableProvenTxReq[]>('findProvenTxReqs', [args])
    validateEntities(r)
    return r
  }

  /**
   * Relinquish a certificate.
   *
   * For storage supporting replication records must be kept of deletions. Therefore certificates are marked as deleted
   * when relinquished, and no longer returned by `listCertificates`, but are still retained by storage.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args original wallet `relinquishCertificate` args.
   */
  async relinquishCertificate(auth: AuthId, args: RelinquishCertificateArgs): Promise<number> {
    return await this.rpcCall<number>('relinquishCertificate', [auth, args])
  }

  /**
   * Relinquish an output.
   *
   * Relinquishing an output removes the output from whatever basket was tracking it.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args original wallet `relinquishOutput` args.
   */
  async relinquishOutput(auth: AuthId, args: RelinquishOutputArgs): Promise<number> {
    return await this.rpcCall<number>('relinquishOutput', [auth, args])
  }

  /**
   * Process a "chunk" of replication data for the user.
   *
   * The normal data flow is for the active storage to push backups as a sequence of data chunks to backup storage providers.
   *
   * @param args a copy of the replication request args that initiated the sequence of data chunks.
   * @param chunk the current data chunk to process.
   * @returns whether processing is done, counts of inserts and udpates, and related progress tracking properties.
   */
  async processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult> {
    const wireChunk = this.binaryRequests && this.serverSupportsBinary ? syncChunkBinary(chunk) : chunk
    const capabilities = this.syncTransferCapabilities()
    // Keep ordinary pages on the existing RPC. Only an oversized encoded payload uses staging.
    const bytes = capabilities == null ? undefined : encodeSyncTransfer({ args, chunk: syncChunkBinary(chunk) })
    // Legacy numeric byte arrays can require four JSON characters per byte.
    const expansion = this.binaryRequests && this.serverSupportsBinary ? 1 : 4
    const r = bytes != null && bytes.length * expansion > (capabilities!.inlineBytes ?? 6 * 1024 * 1024)
      ? await this.uploadSyncTransfer(args.identityKey, bytes, capabilities!)
      : await this.rpcCall<ProcessSyncChunkResult>('processSyncChunk', [args, wireChunk])
    if (r.nextCheckpoint != null) r.nextCheckpoint = validateSyncCheckpoint(r.nextCheckpoint, args)
    return r
  }

  /**
   * Request a "chunk" of replication data for a specific user and storage provider.
   *
   * The normal data flow is for the active storage to push backups as a sequence of data chunks to backup storage providers.
   * Also supports recovery where non-active storage can attempt to merge available data prior to becoming active.
   *
   * @param args that identify the non-active storage which will receive replication data and constrains the replication process.
   * @returns the next "chunk" of replication data
   */
  async getSyncChunk(args: RequestSyncChunkArgs): Promise<SyncChunk> {
    const transfer = this.syncTransferCapabilities()
    let requestArgs = { ...args, ...(transfer == null ? {} : { syncTransferVersion: 1 }) }
    if (this.syncChunkRoughSizeLimit != null) {
      requestArgs.maxRoughSize = Math.min(requestArgs.maxRoughSize, this.syncChunkRoughSizeLimit)
    }

    for (let retries = 0; ; retries++) {
      try {
        return await this.readSyncChunkResponse(requestArgs, args.maxRoughSize, transfer)
      } catch (error: unknown) {
        if (!isSyncChunkResponseTooLarge(error)) throw error
        const smaller = this.smallerSyncRequest(requestArgs, retries)
        if (smaller != null) { requestArgs = smaller; continue }
        if (transfer == null) throw error
        return await this.downloadSyncTransfer(requestArgs, transfer)
      }
    }
  }

  private async readSyncChunkResponse(args: RequestSyncChunkArgs, originalMaxRoughSize: number,
    transfer: SyncTransferCapabilities | undefined): Promise<SyncChunk> {
    const r = await this.rpcCall<SyncChunk | { syncTransfer: SyncTransferManifest }>('getSyncChunk', [args])
    if ('syncTransfer' in r) {
      if (transfer == null || Object.keys(r).length !== 1) throw new Error('Unexpected wallet sync transfer response')
      return await this.downloadSyncTransfer(args, transfer, r.syncTransfer)
    }
    if (args.maxRoughSize < originalMaxRoughSize) {
      this.syncChunkRoughSizeLimit = args.maxRoughSize
    }
    return validateSyncChunkEntities(r)
  }

  protected requestUsesBinary(method: string): boolean {
    const transferPart = method === 'writeSyncTransferPart' && this.settings?.syncTransfer?.version === 1
    return (this.binaryRequests || transferPart) && this.serverSupportsBinary
  }

  protected rpcResponseError(response: Response): Error {
    const error = new Error(`WalletStorageClient rpcCall: network error ${response.status} ${response.statusText}`)
    if (response.status !== 429) return error
    const after = response.headers.get('retry-after')
    let delay = 1000
    if (after != null) delay = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()
    return Object.assign(error, { retryAfterMs: delay })
  }

  private smallerSyncRequest(args: RequestSyncChunkArgs, retries: number): RequestSyncChunkArgs | undefined {
    const nextRoughSize = Math.max(minimumSyncChunkRoughSize, Math.floor(args.maxRoughSize / 2))
    if (retries < syncChunkResponseRetryLimit && nextRoughSize < args.maxRoughSize) {
      return { ...args, maxRoughSize: nextRoughSize }
    }
    if (args.maxItems === 1) return undefined
    return { ...args, maxItems: 1, maxRoughSize: minimumSyncChunkRoughSize }
  }

  private syncTransferCapabilities(): SyncTransferCapabilities | undefined {
    const value = this.settings?.syncTransfer
    return value == null ? undefined : validateSyncTransferCapabilities(value)
  }

  private syncTransferRetryDelay(error: unknown, attempt: number): number | undefined {
    const message = error instanceof Error ? error.message : ''
    if (attempt >= 2 || !/network error (?:429|502|503|504)|timed out waiting for authenticated response|fetch failed|Failed to fetch/i.test(message)) return undefined
    if (!/network error 429/.test(message)) return 250 * 2 ** attempt
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    const retryAfter = cause != null && typeof cause === 'object' ? Reflect.get(cause, 'retryAfterMs') : undefined
    const delay = retryAfter ?? 1000
    return Number.isFinite(delay) && delay >= 0 && delay <= 60_000 ? delay : undefined
  }

  private async transferPartCall<T>(method: string, input: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.rpcCall<T>(method, [input]) } catch (error) {
        // Only immutable reads and identical staged part writes may be retried here. Never commit.
        const delay = this.syncTransferRetryDelay(error, attempt)
        if (delay == null) throw error
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  private async releaseSyncTransfer(identityKey: string, transferId: string): Promise<void> {
    try { await this.rpcCall('releaseSyncTransfer', [{ identityKey, transferId }]) } catch {
      // Expiry reclaims staging if the connection is gone. Wallet records are never removed.
    }
  }

  private async downloadSyncTransfer(args: RequestSyncChunkArgs, capabilities: SyncTransferCapabilities,
    suppliedManifest?: SyncTransferManifest): Promise<SyncChunk> {
    const manifest = validateSyncTransferManifest(suppliedManifest ?? await this.transferPartCall<SyncTransferManifest>(
      'beginReadSyncTransfer', { identityKey: args.identityKey, args }), capabilities)
    try {
      const chunk = await receiveSyncTransfer(manifest, async offset => {
        this.onSyncTransferProgress?.({ direction: 'read', bytes: offset, totalBytes: manifest.totalBytes })
        return await this.transferPartCall<SyncTransferPart>('readSyncTransferPart', {
          identityKey: args.identityKey, transferId: manifest.transferId, offset })
      }) as SyncChunk
      this.onSyncTransferProgress?.({ direction: 'read', bytes: manifest.totalBytes, totalBytes: manifest.totalBytes })
      if (chunk?.userIdentityKey !== args.identityKey || chunk.fromStorageIdentityKey !== args.fromStorageIdentityKey ||
        chunk.toStorageIdentityKey !== args.toStorageIdentityKey) throw new Error('Wallet sync transfer identities changed')
      return validateSyncChunkEntities(chunk)
    } finally {
      await this.releaseSyncTransfer(args.identityKey, manifest.transferId)
    }
  }

  private async uploadSyncTransfer(identityKey: string, bytes: Uint8Array, capabilities: SyncTransferCapabilities): Promise<ProcessSyncChunkResult> {
    if (bytes.length > capabilities.maxBytes) throw new RangeError('Wallet sync record exceeds the negotiated transfer size limit')
    const response = await this.transferPartCall<SyncTransferManifest & { receivedBytes: number }>(
      'beginWriteSyncTransfer', { identityKey, digest: syncTransferDigest(bytes), totalBytes: bytes.length })
    const manifest = validateSyncTransferManifest(response, capabilities)
    if (manifest.digest !== syncTransferDigest(bytes) || manifest.totalBytes !== bytes.length ||
      !Number.isSafeInteger(response.receivedBytes) || response.receivedBytes < 0 || response.receivedBytes > bytes.length ||
      (response.receivedBytes !== bytes.length && response.receivedBytes % manifest.partBytes !== 0)) {
      throw new Error('Invalid wallet sync upload checkpoint')
    }
    for (let offset = response.receivedBytes; offset < bytes.length;) {
      this.onSyncTransferProgress?.({ direction: 'write', bytes: offset, totalBytes: bytes.length })
      const part = bytes.subarray(offset, offset + manifest.partBytes)
      const next = await this.transferPartCall<number>('writeSyncTransferPart', {
        identityKey, transferId: manifest.transferId, offset, bytes: part
      })
      if (next !== offset + part.length) throw new Error('Invalid wallet sync upload acknowledgement')
      offset = next
    }
    // An uncertain commit is surfaced. The next sync starts from the writer's durable checkpoint.
    const result = await this.rpcCall<ProcessSyncChunkResult>('commitSyncTransfer', [{ identityKey, transferId: manifest.transferId }])
    await this.releaseSyncTransfer(identityKey, manifest.transferId)
    return result
  }

  /**
   * Handles the data received when a new transaction proof is found in response to an outstanding request for proof data:
   *
   *   - Creates a new `TableProvenTx` record.
   *   - Notifies all user transaction records of the new status.
   *   - Updates the proof request record to 'completed' status which enables delayed deletion.
   *
   * @param args proof request and new transaction proof data
   * @returns results of updates
   */
  async updateProvenTxReqWithNewProvenTx(
    args: UpdateProvenTxReqWithNewProvenTxArgs
  ): Promise<UpdateProvenTxReqWithNewProvenTxResult> {
    const r = await this.rpcCall<UpdateProvenTxReqWithNewProvenTxResult>('updateProvenTxReqWithNewProvenTx', [args])
    return r
  }

  /**
   * Ensures up-to-date wallet data replication to all configured backup storage providers,
   * then promotes one of the configured backups to active,
   * demoting the current active to new backup.
   *
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param newActiveStorageIdentityKey which must be a currently configured backup storage provider.
   */
  async setActive(auth: AuthId, newActiveStorageIdentityKey: string): Promise<number> {
    return await this.rpcCall<number>('setActive', [auth, newActiveStorageIdentityKey])
  }

  /** @see {@link validateDate} */
  validateDate(date: Date | string | number): Date {
    return validateDate(date)
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all individual records with time stamps retreived from database.
   * @see {@link validateEntity}
   */
  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T {
    return validateEntity(entity, dateFields)
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all arrays of records with time stamps retreived from database.
   * @returns input `entities` array with contained values validated.
   * @see {@link validateEntities}
   */
  validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[] {
    return validateEntities(entities, dateFields)
  }
}
