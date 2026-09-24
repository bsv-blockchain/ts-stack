import {
  type ValidCreateActionArgs,
  type ValidListActionsArgs,
  type ValidListCertificatesArgs,
  type ValidListOutputsArgs
} from '@bsv/sdk/wallet/validationHelpers'
import {
  type SyncTransferCapabilities,
  type SyncTransferManifest,
  type SyncTransferPart,
  encodeSyncTransfer,
  syncTransferDigest,
  receiveSyncTransfer,
  validateSyncTransferCapabilities,
  validateSyncTransferManifest
} from './SyncTransfer'
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
  PublicKey,
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

function isSyncChunkResponseTooLarge(error: unknown): boolean {
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
  /**
   * Optional independently validated server identity key. When omitted, the
   * first authenticated response is authoritative for this client instance.
   */
  serverIdentityKey?: string
  /**
   * Optional independently validated storage-provider identity. The storage
   * and authenticated server may use distinct keys. When omitted, the value
   * advertised in the first authenticated `makeAvailable` response is
   * authoritative for this client instance.
   */
  storageIdentityKey?: string
}

function hasControlCharacter(value: string): boolean {
  // All rejected characters are in the first 160 UTF-16 code units; avoid
  // allocating a code-point array for every endpoint or storage identifier.
  for (let index = 0; index < value.length; index++) {
    const point = value.charCodeAt(index)
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) return true
  }
  return false
}

function isLoopbackStorageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  )
}

function normalizeStorageEndpointUrl(endpointUrl: string): string {
  if (
    typeof endpointUrl !== 'string' ||
    endpointUrl !== endpointUrl.trim() ||
    endpointUrl.length > 8192 ||
    hasControlCharacter(endpointUrl)
  ) {
    throw new TypeError('Wallet storage endpoint must be an exact bounded URL.')
  }
  let parsed: URL
  try {
    parsed = new URL(endpointUrl)
  } catch {
    throw new TypeError('Wallet storage endpoint must be an absolute URL.')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('Wallet storage endpoint cannot include credentials, query, or fragment.')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackStorageHost(parsed.hostname))) {
    throw new TypeError('Wallet storage endpoint requires HTTPS except on localhost.')
  }
  // Preserve the caller's path spelling because endpoint URLs are also
  // surfaced through WalletStorageManager. Parsing above is the security
  // boundary; canonicalizing here would be an unrelated observable change.
  return endpointUrl
}

function normalizeServerIdentityKey(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Wallet storage server identity key must be canonical.')
  }
  try {
    if (PublicKey.fromString(value).toString() !== value) throw new Error()
  } catch {
    throw new TypeError('Wallet storage server identity key must be canonical.')
  }
  return value
}

function normalizeStorageIdentityKey(value: unknown): string {
  // Despite the historical "key" name, existing stores use both public keys
  // and opaque identifiers, including legacy 32-byte and current 33-byte
  // random values. Preserve that contract while enforcing the schema's
  // bounded, non-control identifier domain.
  if (typeof value !== 'string' || value.length < 1 || value.length > 130 || hasControlCharacter(value)) {
    throw new TypeError('Wallet storage identity must be an exact bounded identifier.')
  }
  return value
}

function validateRemoteStorageSettings(value: unknown): RemoteStorageSettings {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Wallet storage returned invalid settings.')
  }
  const prototype = Object.getPrototypeOf(value)
  const properties = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    throw new Error('Wallet storage returned invalid settings.')
  }

  normalizeStorageIdentityKey(properties.storageIdentityKey?.value)
  const storageName = properties.storageName?.value
  if (
    storageName !== undefined &&
    (typeof storageName !== 'string' ||
      storageName.length < 1 ||
      storageName.length > 255 ||
      hasControlCharacter(storageName))
  ) {
    throw new Error('Wallet storage returned invalid settings.')
  }
  const chain = properties.chain?.value
  if (chain !== undefined && (typeof chain !== 'string' || !['main', 'test', 'stn', 'ttn', 'tstn'].includes(chain))) {
    throw new Error('Wallet storage returned invalid settings.')
  }
  const dbtype = properties.dbtype?.value
  if (dbtype !== undefined && (typeof dbtype !== 'string' || !['SQLite', 'MySQL', 'IndexedDB'].includes(dbtype))) {
    throw new Error('Wallet storage returned invalid settings.')
  }
  const maxOutputScript = properties.maxOutputScript?.value
  if (
    maxOutputScript !== undefined &&
    (!Number.isSafeInteger(maxOutputScript) || maxOutputScript < 0 || maxOutputScript > 16 * 1024 * 1024)
  ) {
    throw new Error('Wallet storage returned invalid settings.')
  }
  for (const key of ['created_at', 'updated_at'] as const) {
    const date = properties[key]?.value
    if (date !== undefined && !(date instanceof Date) && !(typeof date === 'string' || typeof date === 'number')) {
      throw new Error('Wallet storage returned invalid settings.')
    }
    if (date !== undefined && !Number.isFinite(new Date(date).getTime())) {
      throw new Error('Wallet storage returned invalid settings.')
    }
  }
  if (properties.syncCheckpointVersion != null && properties.syncCheckpointVersion.value !== 1) {
    throw new Error('Wallet storage returned invalid settings.')
  }
  return value as RemoteStorageSettings
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
  private authenticatedServerIdentityKey?: string
  private readonly expectedStorageIdentityKey?: string
  private syncChunkRoughSizeLimit?: number
  /** Optional progress/cancellation hook for a bounded transfer; never receives wallet contents. */
  onSyncTransferProgress?: (progress: { direction: 'read' | 'write'; bytes: number; totalBytes: number }) => void

  // Track ephemeral (in-memory) "settings" if you wish to align with isAvailable() checks
  public settings?: RemoteStorageSettings

  constructor(wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {}) {
    this.authClient = new AuthFetch(wallet)
    this.endpointUrl = normalizeStorageEndpointUrl(endpointUrl)
    this.binaryRequests = options.binaryRequests === true
    this.telemetry = new Telemetry(options.telemetry)
    this.authenticatedServerIdentityKey =
      options.serverIdentityKey === undefined ? undefined : normalizeServerIdentityKey(options.serverIdentityKey)
    this.expectedStorageIdentityKey =
      options.storageIdentityKey === undefined ? undefined : normalizeStorageIdentityKey(options.storageIdentityKey)
  }

  protected async authenticatedFetch(url: string, config: Parameters<AuthFetch['fetch']>[1]): Promise<Response> {
    const response = await this.authClient.fetch(url, config)
    const authenticatedIdentityKey = response.headers.get('x-bsv-auth-identity-key')
    if (authenticatedIdentityKey == null) {
      throw new Error('Wallet storage response was not mutually authenticated.')
    }
    const identityKey = normalizeServerIdentityKey(authenticatedIdentityKey)
    if (this.authenticatedServerIdentityKey !== undefined && identityKey !== this.authenticatedServerIdentityKey) {
      throw new Error('Wallet storage authenticated server identity changed.')
    }
    this.authenticatedServerIdentityKey = identityKey
    return response
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

  /** Share the asynchronous rejection boundary, including custom transports that throw synchronously. */
  private async forwardRpc<T>(method: string, params: unknown[]): Promise<T> {
    return this.rpcCall<T>(method, params)
  }

  private async readEntities<T extends EntityTimeStamp>(method: string, params: unknown[]): Promise<T[]> {
    return validateEntities(await this.rpcCall<T[]>(method, params))
  }

  protected nextRequestId(): number {
    if (!Number.isSafeInteger(this.nextId) || this.nextId < 1) {
      throw new Error('Wallet storage request identifier space exhausted.')
    }
    return this.nextId++
  }

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
    if (this.settings != null) return this.settings
    const settings = validateRemoteStorageSettings(await this.rpcCall<RemoteStorageSettings>('makeAvailable', []))
    const descriptor = Object.getOwnPropertyDescriptor(settings, 'storageIdentityKey')
    const storageIdentityKey = normalizeStorageIdentityKey(
      descriptor != null && 'value' in descriptor ? descriptor.value : undefined
    )
    if (this.expectedStorageIdentityKey !== undefined && storageIdentityKey !== this.expectedStorageIdentityKey) {
      throw new Error('Wallet storage settings identity does not match the configured storage identity.')
    }
    this.settings = settings
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
  destroy(): Promise<void> {
    return this.forwardRpc<void>('destroy', [])
  }

  /**
   * Requests schema migration to latest.
   * Typically remote storage will ignore this request.
   * @param storageName Unique human readable name for remote storage if it does not yet exist.
   * @param storageIdentityKey Unique identity key for remote storage if it does not yet exist.
   * @returns current schema migration identifier
   */
  migrate(storageName: string, _storageIdentityKey: string): Promise<string> {
    return this.forwardRpc<string>('migrate', [storageName])
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
  internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult> {
    return this.forwardRpc<StorageInternalizeActionResult>('internalizeAction', [auth, args])
  }

  /**
   * Storage level processing for wallet `createAction`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `createAction` arguments.
   * @returns `StorageCreateActionResults` supporting additional wallet processing to yield `createAction` results.
   */
  async createAction(auth: AuthId, args: ValidCreateActionArgs): Promise<StorageCreateActionResult> {
    if (args.inputBEEF != null) {
      if (args.inputs.length === 0) {
        args = {
          ...args,
          inputBEEF: undefined
        }
      } else {
        let source: Beef | undefined
        try {
          source = Beef.fromBinaryStrict(args.inputBEEF)
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
  processAction(auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults> {
    return this.forwardRpc<StorageProcessActionResults>('processAction', [auth, args])
  }

  prepareNoSendExpiry(auth: AuthId, args: ValidCreateActionArgs): Promise<StoragePrepareNoSendExpiryResult> {
    return this.forwardRpc<StoragePrepareNoSendExpiryResult>('prepareNoSendExpiry', [auth, args])
  }

  activateNoSendExpiry(
    auth: AuthId,
    args: StorageActivateNoSendExpiryArgs
  ): Promise<StorageActivateNoSendExpiryResult> {
    return this.forwardRpc<StorageActivateNoSendExpiryResult>('activateNoSendExpiry', [auth, args])
  }

  async armNoSendExpiry(auth: AuthId, args: StorageArmNoSendExpiryArgs): Promise<void> {
    await this.rpcCall<void>('armNoSendExpiry', [auth, args])
  }

  getCapabilities(): Promise<StorageCapabilities> {
    return this.forwardRpc<StorageCapabilities>('getCapabilities', [])
  }

  beginActionBatch(auth: AuthId, args: BeginActionBatchArgs): Promise<BeginActionBatchResult> {
    return this.forwardRpc<BeginActionBatchResult>('beginActionBatch', [auth, args])
  }

  extendActionBatch(auth: AuthId, args: ExtendActionBatchArgs): Promise<ExtendActionBatchResult> {
    return this.forwardRpc<ExtendActionBatchResult>('extendActionBatch', [auth, args])
  }

  renewActionBatch(auth: AuthId, batchId: string): Promise<RenewActionBatchResult> {
    return this.forwardRpc<RenewActionBatchResult>('renewActionBatch', [auth, batchId])
  }

  resumeActionBatch(auth: AuthId, args: ResumeActionBatchArgs): Promise<ResumeActionBatchResult> {
    return this.forwardRpc<ResumeActionBatchResult>('resumeActionBatch', [auth, args])
  }

  prepareActionBatchCommit(auth: AuthId, manifest: ActionBatchManifest): Promise<PrepareActionBatchCommitResult> {
    return this.forwardRpc<PrepareActionBatchCommitResult>('prepareActionBatchCommit', [auth, manifest])
  }

  async putActionBatchBlob(auth: AuthId, args: PutActionBatchBlobArgs): Promise<void> {
    const baseUrl = this.endpointUrl.endsWith('/') ? this.endpointUrl.slice(0, -1) : this.endpointUrl
    const url = `${baseUrl}/action-batch/${encodeURIComponent(args.batchId)}/blob/${encodeURIComponent(args.digest)}`
    const bytes = args.bytes instanceof Uint8Array ? args.bytes : Uint8Array.from(args.bytes)
    const response = await this.authenticatedFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes
    })
    if (!response.ok) {
      throw new Error(`WalletStorageClient putActionBatchBlob: network error ${response.status}`)
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
    const response = await this.authenticatedFetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        [ACTION_BATCH_PACK_ENCODING_HEADER]: transmittedEncoding
      },
      body
    })
    if (!response.ok) {
      throw new Error(`WalletStorageClient putActionBatchPack: network error ${response.status}`)
    }
  }

  commitActionBatch(auth: AuthId, manifest: ActionBatchManifest): Promise<CommitActionBatchResult> {
    return this.forwardRpc<CommitActionBatchResult>('commitActionBatch', [auth, manifest])
  }

  commitActionBatchByDigest(auth: AuthId, args: CommitActionBatchByDigestArgs): Promise<CommitActionBatchResult> {
    return this.forwardRpc<CommitActionBatchResult>('commitActionBatchByDigest', [auth, args])
  }

  abortActionBatch(auth: AuthId, batchId: string): Promise<AbortActionBatchResult> {
    return this.forwardRpc<AbortActionBatchResult>('abortActionBatch', [auth, batchId])
  }

  /**
   * Aborts an action by `reference` string.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args original wallet `abortAction` args.
   * @returns `abortAction` result.
   */
  abortAction(auth: AuthId, args: AbortActionArgs): Promise<AbortActionResult> {
    return this.forwardRpc<AbortActionResult>('abortAction', [auth, args])
  }

  /**
   * Used to both find and initialize a new user by identity key.
   * It is up to the remote storage whether to allow creation of new users by this method.
   * @param identityKey of the user.
   * @returns `TableUser` for the user and whether a new user was created.
   */
  findOrInsertUser(identityKey: string): Promise<{ user: TableUser; isNew: boolean }> {
    return this.forwardRpc<{ user: TableUser; isNew: boolean }>('findOrInsertUser', [identityKey])
  }

  /** Read compact progress only when the provider advertises support. */
  async getSyncCheckpoint(
    auth: AuthId,
    storageIdentityKey: string,
    storageName: string
  ): Promise<SyncCheckpoint | undefined> {
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
  insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> {
    return this.forwardRpc<number>('insertCertificateAuth', [auth, certificate])
  }

  /**
   * Storage level processing for wallet `listActions`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `listActions` arguments.
   * @returns `listActions` results.
   */
  listActions(auth: AuthId, vargs: ValidListActionsArgs): Promise<ListActionsResult> {
    return this.forwardRpc<ListActionsResult>('listActions', [auth, vargs])
  }

  /**
   * Storage level processing for wallet `listOutputs`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `listOutputs` arguments.
   * @returns `listOutputs` results.
   */
  listOutputs(auth: AuthId, vargs: ValidListOutputsArgs): Promise<ListOutputsResult> {
    return this.forwardRpc<ListOutputsResult>('listOutputs', [auth, vargs])
  }

  /**
   * Storage level processing for wallet `listCertificates`.
   * @param auth Identifies client by identity key and the storage identity key of their currently active storage.
   * This must match the `AuthFetch` identity securing the remote conneciton.
   * @param args Validated extension of original wallet `listCertificates` arguments.
   * @returns `listCertificates` results.
   */
  listCertificates(auth: AuthId, vargs: ValidListCertificatesArgs): Promise<ListCertificatesResult> {
    return this.forwardRpc<ListCertificatesResult>('listCertificates', [auth, vargs])
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
  findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    return this.readEntities<TableOutputBasket>('findOutputBasketsAuth', [auth, args])
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
  findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    return this.readEntities<TableOutput>('findOutputsAuth', [auth, args])
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
  findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    return this.readEntities<TableProvenTxReq>('findProvenTxReqs', [args])
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
  relinquishCertificate(auth: AuthId, args: RelinquishCertificateArgs): Promise<number> {
    return this.forwardRpc<number>('relinquishCertificate', [auth, args])
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
  relinquishOutput(auth: AuthId, args: RelinquishOutputArgs): Promise<number> {
    return this.forwardRpc<number>('relinquishOutput', [auth, args])
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
    const r =
      bytes != null && bytes.length * expansion > (capabilities!.inlineBytes ?? 6 * 1024 * 1024)
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
        if (smaller != null) {
          requestArgs = smaller
          continue
        }
        if (transfer == null) throw error
        return await this.downloadSyncTransfer(requestArgs, transfer)
      }
    }
  }

  private async readSyncChunkResponse(
    args: RequestSyncChunkArgs,
    originalMaxRoughSize: number,
    transfer: SyncTransferCapabilities | undefined
  ): Promise<SyncChunk> {
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
    const error = new Error(`WalletStorageClient rpcCall: network error ${response.status}`)
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
    if (
      attempt >= 2 ||
      !/network error (?:429|502|503|504)|timed out waiting for authenticated response|fetch failed|Failed to fetch/i.test(
        message
      )
    )
      return undefined
    if (!/network error 429/.test(message)) return 250 * 2 ** attempt
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    const retryAfter = cause != null && typeof cause === 'object' ? Reflect.get(cause, 'retryAfterMs') : undefined
    const delay = retryAfter ?? 1000
    return Number.isFinite(delay) && delay >= 0 && delay <= 60_000 ? delay : undefined
  }

  private async transferPartCall<T>(method: string, input: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.rpcCall<T>(method, [input])
      } catch (error) {
        // Only immutable reads and identical staged part writes may be retried here. Never commit.
        const delay = this.syncTransferRetryDelay(error, attempt)
        if (delay == null) throw error
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  private async releaseSyncTransfer(identityKey: string, transferId: string): Promise<void> {
    try {
      await this.rpcCall('releaseSyncTransfer', [{ identityKey, transferId }])
    } catch {
      // Expiry reclaims staging if the connection is gone. Wallet records are never removed.
    }
  }

  private async downloadSyncTransfer(
    args: RequestSyncChunkArgs,
    capabilities: SyncTransferCapabilities,
    suppliedManifest?: SyncTransferManifest
  ): Promise<SyncChunk> {
    const manifest = validateSyncTransferManifest(
      suppliedManifest ??
        (await this.transferPartCall<SyncTransferManifest>('beginReadSyncTransfer', {
          identityKey: args.identityKey,
          args
        })),
      capabilities
    )
    try {
      const chunk = (await receiveSyncTransfer(manifest, async offset => {
        this.onSyncTransferProgress?.({ direction: 'read', bytes: offset, totalBytes: manifest.totalBytes })
        return await this.transferPartCall<SyncTransferPart>('readSyncTransferPart', {
          identityKey: args.identityKey,
          transferId: manifest.transferId,
          offset
        })
      })) as SyncChunk
      this.onSyncTransferProgress?.({ direction: 'read', bytes: manifest.totalBytes, totalBytes: manifest.totalBytes })
      if (
        chunk?.userIdentityKey !== args.identityKey ||
        chunk.fromStorageIdentityKey !== args.fromStorageIdentityKey ||
        chunk.toStorageIdentityKey !== args.toStorageIdentityKey
      )
        throw new Error('Wallet sync transfer identities changed')
      return validateSyncChunkEntities(chunk)
    } finally {
      await this.releaseSyncTransfer(args.identityKey, manifest.transferId)
    }
  }

  private async uploadSyncTransfer(
    identityKey: string,
    bytes: Uint8Array,
    capabilities: SyncTransferCapabilities
  ): Promise<ProcessSyncChunkResult> {
    if (bytes.length > capabilities.maxBytes)
      throw new RangeError('Wallet sync record exceeds the negotiated transfer size limit')
    const response = await this.transferPartCall<SyncTransferManifest & { receivedBytes: number }>(
      'beginWriteSyncTransfer',
      { identityKey, digest: syncTransferDigest(bytes), totalBytes: bytes.length }
    )
    const manifest = validateSyncTransferManifest(response, capabilities)
    if (
      manifest.digest !== syncTransferDigest(bytes) ||
      manifest.totalBytes !== bytes.length ||
      !Number.isSafeInteger(response.receivedBytes) ||
      response.receivedBytes < 0 ||
      response.receivedBytes > bytes.length ||
      (response.receivedBytes !== bytes.length && response.receivedBytes % manifest.partBytes !== 0)
    ) {
      throw new Error('Invalid wallet sync upload checkpoint')
    }
    for (let offset = response.receivedBytes; offset < bytes.length;) {
      this.onSyncTransferProgress?.({ direction: 'write', bytes: offset, totalBytes: bytes.length })
      const part = bytes.subarray(offset, offset + manifest.partBytes)
      const next = await this.transferPartCall<number>('writeSyncTransferPart', {
        identityKey,
        transferId: manifest.transferId,
        offset,
        bytes: part
      })
      if (next !== offset + part.length) throw new Error('Invalid wallet sync upload acknowledgement')
      offset = next
    }
    // An uncertain commit is surfaced. The next sync starts from the writer's durable checkpoint.
    const result = await this.rpcCall<ProcessSyncChunkResult>('commitSyncTransfer', [
      { identityKey, transferId: manifest.transferId }
    ])
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
  updateProvenTxReqWithNewProvenTx(
    args: UpdateProvenTxReqWithNewProvenTxArgs
  ): Promise<UpdateProvenTxReqWithNewProvenTxResult> {
    return this.forwardRpc<UpdateProvenTxReqWithNewProvenTxResult>('updateProvenTxReqWithNewProvenTx', [args])
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
  setActive(auth: AuthId, newActiveStorageIdentityKey: string): Promise<number> {
    return this.forwardRpc<number>('setActive', [auth, newActiveStorageIdentityKey])
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
