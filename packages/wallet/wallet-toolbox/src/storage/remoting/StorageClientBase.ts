import { isSnapshotArchiveChain, type SnapshotArchiveChain } from '../snapshot/archive/SnapshotArchiveChain'
import { promiseFromSync, awaitFromSync, awaitVoidFromSync, mapAwaitFromSync } from '../../utility/promiseFromSync'
import type { StorageWriterAdmission } from '../StorageActiveWrite'
import type { PrimaryHandoffControl, PrimaryHandoffControlOptions } from '../PrimaryHandoffControl'
import { canonicalPrimaryHandoffPlan } from '../PrimaryHandoffPlan'
import {
  isPrimaryHandoffMethod,
  validatePrimaryHandoffCapabilities,
  parsePrimaryHandoffStatus,
  parsePrimaryHandoffSource,
  primaryHandoffRequestBytes,
  primaryHandoffResponseBytes,
  type PrimaryHandoffMethod,
  primaryHandoffCapabilities
} from './PrimaryHandoffProtocol'
import {
  parseSnapshotJournalFieldArchiveReference,
  type SnapshotJournalFieldArchiveReference
} from '../snapshot/journal/SnapshotJournalReceiptData'
import {
  retrySnapshotArchiveOperation,
  isSnapshotArchiveTransportFailure,
  snapshotArchiveRateLimitDelay,
  waitSnapshotArchiveRateLimit
} from '../snapshot/archive/SnapshotArchiveTransportFailure'
import type { SnapshotSyncContentRevision } from '../snapshot/SnapshotSyncContentRevision'
import { RemoteSnapshotJournalFieldDestination } from '../snapshot/journal/RemoteSnapshotJournalFieldDestination'
import {
  isSnapshotJournalFieldRpcMethod,
  validateSnapshotJournalFieldRpcCapabilities,
  type SnapshotJournalFieldRpcMethod,
  snapshotJournalFieldRpcCapabilities
} from '../snapshot/journal/SnapshotJournalFieldRpcProtocol'
import {
  validateSnapshotJournalFieldArchiveCapabilities,
  type SnapshotJournalFieldArchiveCapabilities,
  type SnapshotJournalFieldArchiveMethod
} from '../snapshot/journal/SnapshotJournalFieldArchiveProtocol'
import { SnapshotJournalFieldArchiveTransport } from '../snapshot/journal/SnapshotJournalFieldArchiveTransport'
import { openRemoteSnapshotJournalFieldArchive } from '../snapshot/journal/openRemoteSnapshotJournalFieldArchive'
import {
  validateSnapshotJournalDataContentCapabilities,
  snapshotJournalDataContentCapabilities
} from '../snapshot/journal/SnapshotJournalDataProtocol'
import type { SnapshotJournalDataOptions } from '../snapshot/journal/SnapshotJournalDataProvider'
import type { SnapshotJournalDataStatus } from '../snapshot/journal/SnapshotJournalDataProtocol'
import { RemoteSnapshotJournalDataDestination } from '../snapshot/journal/RemoteSnapshotJournalDataDestination'
import {
  isSnapshotJournalDataMethod,
  validateSnapshotJournalDataCapabilities,
  type SnapshotJournalDataCapabilities,
  type SnapshotJournalDataMethod
} from '../snapshot/journal/SnapshotJournalDataProtocol'
import type { SnapshotJournalArchiveBinding } from '../snapshot/journal/SnapshotJournalArchiveBinding'
import type { WalletReadSnapshotOptions } from '../snapshot/WalletReadSnapshot'
import {
  validateSnapshotJournalArchiveCapabilities,
  type SnapshotJournalArchiveCapabilities,
  type SnapshotJournalArchiveMethod
} from '../snapshot/journal/SnapshotJournalArchiveProtocol'
import { SnapshotJournalArchiveTransport } from '../snapshot/journal/SnapshotJournalArchiveTransport'
import { openRemoteSnapshotJournalArchive } from '../snapshot/journal/openRemoteSnapshotJournalArchive'
import type { SnapshotJournalArchivePosition } from '../snapshot/journal/SnapshotJournalReceiptData'
import {
  validateRemoteSnapshotSyncContentCapabilities,
  type RemoteSnapshotSyncContentCapabilities
} from '../snapshot/RemoteSnapshotSyncContentProtocol'
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
import { SnapshotArchiveTransport } from '../snapshot/archive/SnapshotArchiveTransport'
import { openRemoteSnapshot } from '../snapshot/archive/openRemoteSnapshot'
import { SnapshotCancelledError } from '../snapshot/SnapshotCancelledError'
import { snapshotArchiveFetch } from '../snapshot/archive/SnapshotArchiveTransportFailure'
import type { SnapshotSyncStorage } from '../snapshot/SnapshotSync'
import { RemoteSnapshotSyncDestination } from '../snapshot/RemoteSnapshotSyncDestination'
import {
  remoteSnapshotSyncRequestBytes,
  remoteSnapshotSyncResponseBytes,
  validateRemoteSnapshotSyncCapabilities,
  remoteSnapshotSyncMethods,
  type RemoteSnapshotSyncCapabilities,
  type RemoteSnapshotSyncMethod
} from '../snapshot/RemoteSnapshotSyncProtocol'
import {
  snapshotArchiveResponseBytes,
  snapshotArchiveRequestBytes,
  validateSnapshotArchiveCapabilities,
  type SnapshotArchiveCapabilities,
  type SnapshotArchiveMethod
} from '../snapshot/archive/SnapshotArchiveProtocol'
import {
  BINARY_ENCODING,
  BINARY_ENCODING_HEADER,
  BINARY_REQUEST_ENCODING_HEADER,
  parseJsonRpc,
  stringifyJsonRpc,
  validateJsonRpcResponse
} from './BinaryJson'
import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'

const syncChunkResponseRetryLimit = 4
const minimumSyncChunkRoughSize = 64 * 1024

/** Hold proof data as bytes so negotiated binary JSON carries it compactly. */
function withBeefBytes<T extends { inputBEEF?: number[] | Uint8Array }>(args: T): T {
  if (args.inputBEEF == null || args.inputBEEF instanceof Uint8Array) return args
  return { ...args, inputBEEF: Uint8Array.from(args.inputBEEF) }
}

function isSyncChunkResponseTooLarge(error: unknown): boolean {
  return error instanceof Error && /WalletStorageClient rpcCall: network error 413(?:\s|$)/.test(error.message)
}

type RemoteStorageSettings = TableSettings & {
  /** Runtime-only RPC advertisement, not a persisted settings-table column. */
  syncCheckpointVersion?: 1
  primaryHandoff?: typeof primaryHandoffCapabilities
  syncTransfer?: SyncTransferCapabilities
  snapshotArchive?: SnapshotArchiveCapabilities
  snapshotJournalArchive?: SnapshotJournalArchiveCapabilities
  snapshotJournalFieldArchiveRecoveryVersion?: 1
  snapshotJournalFieldRecoveryVersion?: 1
  snapshotJournalFields?: typeof snapshotJournalFieldRpcCapabilities
  snapshotJournalFieldArchive?: SnapshotJournalFieldArchiveCapabilities
  snapshotJournalArchiveContentVersion?: 1
  snapshotJournalData?: SnapshotJournalDataCapabilities
  snapshotJournalDataContent?: typeof snapshotJournalDataContentCapabilities
  snapshotArchiveReaderVersion?: 1
  snapshotSyncDestination?: RemoteSnapshotSyncCapabilities
  snapshotSyncContent?: RemoteSnapshotSyncContentCapabilities
}

export interface StorageClientOptions {
  /** Disable immutable remote snapshots during a mixed-version rollout. */
  snapshotArchives?: boolean
  /** Per explicit primary-control HTTP request, including negotiation; default
   * 30s, configurable1..300000ms. Independent of whole-copy duration. */
  primaryHandoffRequestTimeoutMs?: number
  /**
   * Options forwarded to AuthFetch's existing fifth constructor argument.
   * Omission preserves the SDK defaults. Available options follow the installed
   * SDK; extending an authenticated request requires both its transport timeout
   * and response-wait timeout to cover the intended operation.
   */
  authFetchOptions?: ConstructorParameters<typeof AuthFetch>[4]
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
  return Array.from(value).some(character => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f)
  })
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
  if (
    chain !== undefined &&
    (typeof chain !== 'string' || !['main', 'test', 'stn', 'ttn', 'tstn', 'regtest'].includes(chain))
  ) {
    throw new Error('Wallet storage returned invalid settings.')
  }
  const dbtype = properties.dbtype?.value
  if (
    dbtype !== undefined &&
    (typeof dbtype !== 'string' || !['SQLite', 'MySQL', 'Postgres', 'IndexedDB'].includes(dbtype))
  ) {
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
  if (properties.primaryHandoff != null) validatePrimaryHandoffCapabilities(properties.primaryHandoff.value)
  if (properties.snapshotArchive != null) validateSnapshotArchiveCapabilities(properties.snapshotArchive.value)
  if (
    properties.snapshotJournalArchiveContentVersion != null &&
    (properties.snapshotJournalArchiveContentVersion.value !== 1 || properties.snapshotJournalArchive == null)
  )
    throw new Error('Wallet storage returned invalid journal content settings.')
  for (const name of ['snapshotJournalFieldArchiveRecoveryVersion', 'snapshotJournalFieldRecoveryVersion'])
    if (properties[name] !== undefined && properties[name].value !== 1)
      throw new TypeError('Invalid field recovery capability')
  if (properties.snapshotJournalFields != null)
    validateSnapshotJournalFieldRpcCapabilities(properties.snapshotJournalFields.value)
  if (properties.snapshotJournalDataContent != null)
    validateSnapshotJournalDataContentCapabilities(properties.snapshotJournalDataContent.value)
  if (properties.snapshotJournalData != null)
    validateSnapshotJournalDataCapabilities(properties.snapshotJournalData.value)
  if (properties.snapshotJournalFieldArchive != null) {
    validateSnapshotJournalFieldArchiveCapabilities(properties.snapshotJournalFieldArchive.value)
    if (properties.snapshotArchive == null || properties.snapshotJournalArchive == null)
      throw new Error('Wallet storage returned invalid field archive settings.')
  }
  if (properties.snapshotJournalArchive != null) {
    validateSnapshotJournalArchiveCapabilities(properties.snapshotJournalArchive.value)
    if (properties.snapshotArchive == null) throw new Error('Wallet storage returned invalid settings.')
  }
  if (properties.snapshotSyncContent != null)
    validateRemoteSnapshotSyncContentCapabilities(properties.snapshotSyncContent.value)
  if (properties.snapshotSyncDestination != null)
    validateRemoteSnapshotSyncCapabilities(properties.snapshotSyncDestination.value)
  if (
    properties.snapshotArchiveReaderVersion != null &&
    (properties.snapshotArchiveReaderVersion.value !== 1 || properties.snapshotArchive == null)
  ) {
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
  private readonly primaryHandoffRequestTimeoutMs: number
  private readonly snapshotArchivesEnabled: boolean
  private readonly snapshotWallet: WalletInterface
  private snapshotAuthClient?: AuthFetch
  private snapshotDestinationAuthClient?: AuthFetch
  private snapshotSource?: { identityKey: string; chain: SnapshotArchiveChain; supportsReader: boolean }
  /** Optional progress/cancellation hook for a bounded transfer; never receives wallet contents. */
  onSyncTransferProgress?: (progress: { direction: 'read' | 'write'; bytes: number; totalBytes: number }) => void

  // Track ephemeral (in-memory) "settings" if you wish to align with isAvailable() checks
  public settings?: RemoteStorageSettings

  constructor(wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {}) {
    this.authClient = new AuthFetch(wallet, undefined, undefined, undefined, options.authFetchOptions)
    this.snapshotWallet = wallet
    this.primaryHandoffRequestTimeoutMs = options.primaryHandoffRequestTimeoutMs ?? 30000
    if (
      !Number.isSafeInteger(this.primaryHandoffRequestTimeoutMs) ||
      this.primaryHandoffRequestTimeoutMs < 1 ||
      this.primaryHandoffRequestTimeoutMs > 300000
    )
      throw new TypeError('Invalid primary control HTTP deadline')
    this.snapshotArchivesEnabled = options.snapshotArchives !== false
    this.endpointUrl = normalizeStorageEndpointUrl(endpointUrl)
    this.binaryRequests = options.binaryRequests === true
    this.telemetry = new Telemetry(options.telemetry)
    this.authenticatedServerIdentityKey =
      options.serverIdentityKey === undefined ? undefined : normalizeServerIdentityKey(options.serverIdentityKey)
    this.expectedStorageIdentityKey =
      options.storageIdentityKey === undefined ? undefined : normalizeStorageIdentityKey(options.storageIdentityKey)
  }

  protected async authenticatedFetch(url: string, config: Parameters<AuthFetch['fetch']>[1]): Promise<Response> {
    return this.validateAuthenticatedResponse(await this.authClient.fetch(url, config))
  }

  private validateAuthenticatedResponse(response: Response): Response {
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

  /** Source/destination support negotiate independently. Older servers retain
   * their original exclusive destination path. */
  getSnapshotSync(): SnapshotSyncStorage | undefined {
    if (!this.snapshotArchivesEnabled) return undefined
    return new RemoteSnapshotSyncDestination(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      () =>
        mapAwaitFromSync(
          () => this.makeAvailable(),
          settings => {
            return {
              storageIdentityKey: settings.storageIdentityKey,
              supportsDestination: settings.snapshotSyncDestination !== undefined,
              supportsContentSource: settings.snapshotSyncContent?.source === true,
              supportsContentDestination: settings.snapshotSyncContent?.destination === true
            }
          }
        ),
      async (identityKey, options) => {
        const transport = await this.getSnapshotArchiveTransport(identityKey)
        return transport === undefined ? undefined : await openRemoteSnapshot(transport, options)
      },
      async (identityKey, options) => {
        const transport = await this.getSnapshotArchiveTransport(identityKey, true)
        return transport === undefined ? undefined : await openRemoteSnapshot(transport, options)
      }
    )
  }

  /** Available only after an authenticated compatible advertisement. */
  async getSnapshotArchiveTransport(
    identityKey: string,
    contentRevision = false
  ): Promise<SnapshotArchiveTransport | undefined> {
    const settings = await this.makeAvailable()
    if (
      !this.snapshotArchivesEnabled ||
      this.snapshotSource === undefined ||
      (contentRevision && settings.snapshotSyncContent?.source !== true)
    )
      return undefined
    return new SnapshotArchiveTransport(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      this.snapshotSource.identityKey,
      this.snapshotSource.chain,
      this.snapshotSource.supportsReader,
      contentRevision
    )
  }

  /** Opens an authenticated immutable journal artifact; this is not a live SQL source. */
  async openSnapshotJournalArchive(
    identityKey: string,
    position?: SnapshotJournalArchivePosition,
    options: WalletReadSnapshotOptions = {}
  ) {
    const settings = await this.makeAvailable()
    if (
      !this.snapshotArchivesEnabled ||
      this.snapshotSource === undefined ||
      settings.snapshotJournalArchive === undefined
    )
      return undefined
    const transport = new SnapshotJournalArchiveTransport(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      this.snapshotSource.identityKey,
      this.snapshotSource.chain,
      settings.snapshotJournalArchive
    )
    return await openRemoteSnapshotJournalArchive(transport, position, options)
  }

  /** A distinct actual immutable field reader; no SQL source/fence is exposed. */
  async openSnapshotJournalFieldArchive(
    identityKey: string,
    position?: SnapshotJournalArchivePosition,
    options: WalletReadSnapshotOptions = {}
  ) {
    const settings = await this.makeAvailable()
    if (
      !this.snapshotArchivesEnabled ||
      this.snapshotSource === undefined ||
      settings.snapshotJournalFieldArchive === undefined
    )
      return undefined
    const transport = new SnapshotJournalFieldArchiveTransport(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      this.snapshotSource.identityKey,
      this.snapshotSource.chain,
      settings.snapshotJournalFieldArchive
    )
    return await openRemoteSnapshotJournalFieldArchive(transport, position, options)
  }
  async supportsSnapshotJournalFieldArchive(): Promise<boolean> {
    return this.snapshotArchivesEnabled && (await this.makeAvailable()).snapshotJournalFieldArchive !== undefined
  }

  supportsSnapshotJournalFieldArchiveRecovery(): Promise<boolean> {
    return mapAwaitFromSync(
      () => this.journalFieldRecoverySettings(),
      settings => {
        return (
          this.snapshotArchivesEnabled &&
          settings.snapshotJournalFieldArchiveRecoveryVersion === 1 &&
          settings.snapshotJournalFieldArchive !== undefined
        )
      }
    )
  }
  private fieldArchiveRecoveryTransport(identityKey: string, signal?: AbortSignal) {
    return mapAwaitFromSync(
      () => this.journalFieldRecoverySettings(signal),
      settings => {
        if (
          !this.snapshotArchivesEnabled ||
          settings.snapshotJournalFieldArchiveRecoveryVersion !== 1 ||
          settings.snapshotJournalFieldArchive === undefined ||
          this.snapshotSource === undefined
        )
          return undefined
        return new SnapshotJournalFieldArchiveTransport(
          (method, params, signal) => this.snapshotRpcCall(method, params, signal),
          identityKey,
          this.snapshotSource.identityKey,
          this.snapshotSource.chain,
          settings.snapshotJournalFieldArchive
        )
      }
    )
  }
  async resumeSnapshotJournalFieldArchive(
    identityKey: string,
    input: SnapshotJournalFieldArchiveReference,
    options: WalletReadSnapshotOptions = {}
  ) {
    const reference = parseSnapshotJournalFieldArchiveReference(input),
      transport = await this.fieldArchiveRecoveryTransport(identityKey, options.signal)
    if (transport === undefined) return undefined
    return await openRemoteSnapshotJournalFieldArchive(transport, undefined, options, reference)
  }
  async retireSnapshotJournalFieldArchive(
    identityKey: string,
    input: SnapshotJournalFieldArchiveReference
  ): Promise<void> {
    const reference = parseSnapshotJournalFieldArchiveReference(input),
      transport = await this.fieldArchiveRecoveryTransport(identityKey)
    if (transport === undefined) throw new WERR_INVALID_OPERATION('Exact field source retirement is not negotiated')
    await transport.retire(reference)
  }
  supportsSnapshotJournalFieldRecovery(): Promise<boolean> {
    return mapAwaitFromSync(
      () => this.journalFieldRecoverySettings(),
      settings => {
        return (
          this.snapshotArchivesEnabled &&
          settings.snapshotJournalFields !== undefined &&
          settings.snapshotJournalFieldRecoveryVersion === 1
        )
      }
    )
  }
  async findSnapshotJournalFieldUpload(
    identityKey: string,
    sourceStorageIdentity: string,
    options: SnapshotJournalDataOptions = {}
  ) {
    const settings = await this.journalFieldRecoverySettings(options.signal)
    if (
      !this.snapshotArchivesEnabled ||
      settings.snapshotJournalFields === undefined ||
      settings.snapshotJournalFieldRecoveryVersion !== 1
    )
      return undefined
    return await RemoteSnapshotJournalFieldDestination.find(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      sourceStorageIdentity,
      options.signal
    )
  }
  private fieldWriterPreflight(options: SnapshotJournalDataOptions): (() => Promise<void>) | undefined {
    const admission = options.admission
    return admission === undefined
      ? undefined
      : () => awaitVoidFromSync(() => admission(() => promiseFromSync(() => this.getSettings())))
  }

  async supportsSnapshotJournalFieldSync(): Promise<boolean> {
    return this.snapshotArchivesEnabled && (await this.makeAvailable()).snapshotJournalFields !== undefined
  }
  async getSnapshotJournalFieldStatus(identityKey: string, sourceStorageIdentity: string) {
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalFields === undefined) return undefined
    return await RemoteSnapshotJournalFieldDestination.observe(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      sourceStorageIdentity,
      normalizeStorageIdentityKey(settings.storageIdentityKey)
    )
  }
  async getSnapshotJournalFieldContentReceipt(identityKey: string, sourceStorageIdentity: string) {
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalFields === undefined) return undefined
    return await RemoteSnapshotJournalFieldDestination.contentReceipt(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      sourceStorageIdentity,
      normalizeStorageIdentityKey(settings.storageIdentityKey)
    )
  }
  async confirmSnapshotJournalFieldContentReceipt(
    identityKey: string,
    sourceStorageIdentity: string,
    revision: SnapshotSyncContentRevision
  ) {
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalFields === undefined) return undefined
    return await RemoteSnapshotJournalFieldDestination.contentReceipt(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      sourceStorageIdentity,
      normalizeStorageIdentityKey(settings.storageIdentityKey),
      revision
    )
  }
  async openSnapshotJournalFieldDestination(
    identityKey: string,
    source: import('../snapshot/journal/SnapshotJournalArchiveBinding').SnapshotJournalFieldArchiveBinding,
    options: SnapshotJournalDataOptions = {}
  ) {
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalFields === undefined) return undefined
    if (source.sourceStorage.chain !== settings.chain)
      throw new WERR_INVALID_OPERATION('Field source and destination networks differ')
    return await RemoteSnapshotJournalFieldDestination.open(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      normalizeStorageIdentityKey(settings.storageIdentityKey),
      source,
      options.signal,
      undefined,
      this.fieldWriterPreflight(options)
    )
  }

  /** Read-only recovery negotiation uses the dedicated bounded fetch marker.
   * A stopped/restarted endpoint can lose one native socket before its first
   * settings response. Authentication, identity and malformed replies never retry. */
  private async journalFieldRecoverySettings(signal?: AbortSignal): Promise<RemoteStorageSettings> {
    if (this.settings !== undefined) return this.settings
    if (signal?.aborted) throw new SnapshotCancelledError('Field recovery negotiation cancelled')
    const controller = new AbortController(),
      abort = () => controller.abort(signal?.reason),
      timer = setTimeout(
        () => controller.abort(new WERR_INVALID_OPERATION('Field recovery negotiation I/O deadline reached')),
        snapshotJournalFieldRpcCapabilities.maxIoMs
      )
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const settings = await retrySnapshotArchiveOperation(() =>
        awaitFromSync(() => this.snapshotRpcCall('makeAvailable', [], controller.signal))
      )
      return this.acceptRemoteSettings(settings)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async resumeSnapshotJournalFieldDestination(
    identityKey: string,
    resume: import('../snapshot/journal/RemoteSnapshotJournalFieldDestination').SnapshotJournalFieldUploadResume,
    options: SnapshotJournalDataOptions = {}
  ) {
    const settings = await this.journalFieldRecoverySettings(options.signal)
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalFields === undefined)
      throw new WERR_INVALID_OPERATION('Field upload recovery is not negotiated')
    if (resume.source.sourceStorage.chain !== settings.chain)
      throw new WERR_INVALID_OPERATION('Field recovery network differs')
    return await RemoteSnapshotJournalFieldDestination.resume(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      normalizeStorageIdentityKey(settings.storageIdentityKey),
      resume,
      options.signal,
      this.fieldWriterPreflight(options)
    )
  }

  /** Runtime scheduling only. The advertised current server still captures
   * and validates its actual primary epoch across preparation and SQL commit. */
  async supportsPreparedWalletWrites(): Promise<boolean> {
    return this.snapshotArchivesEnabled && (await this.makeAvailable()).primaryHandoff !== undefined
  }
  async withPreparedWalletWrite<T>(
    _auth: AuthId,
    admission: StorageWriterAdmission,
    operation: () => Promise<T>
  ): Promise<T> {
    const dispatched = await admission(() => {
      return promiseFromSync(() => {
        const result = operation()
        void result.catch(() => undefined)
        return { result }
      })
    })
    const result = await dispatched.result
    await admission(() => promiseFromSync(() => {}))
    return result
  }

  /** Authenticated explicit control; supplied auth userId/isActive are never
   * sent as grants. The server resolves its actual current local user. */
  async getPrimaryHandoffControl(
    options: PrimaryHandoffControlOptions = {}
  ): Promise<PrimaryHandoffControl | undefined> {
    const signal = options.signal
    const invoke = async (method: PrimaryHandoffMethod | 'makeAvailable', params: unknown[]): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted()
        const controller = new AbortController(),
          abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(
          () => controller.abort(new Error('Primary control HTTP deadline expired')),
          this.primaryHandoffRequestTimeoutMs
        )
        let rateDelay: number | undefined
        try {
          return method === 'makeAvailable'
            ? await this.rpcCall(method, params, controller.signal)
            : await this.snapshotRpcCall(method, params, controller.signal)
        } catch (error) {
          rateDelay = snapshotArchiveRateLimitDelay(error)
          if (rateDelay === undefined || attempt >= 2) {
            if (controller.signal.aborted && isSnapshotArchiveTransportFailure(error)) {
              const cancelled = new SnapshotCancelledError(
                'Primary control HTTP stopped; recover actual participant status'
              )
              Object.defineProperty(cancelled, 'cause', { value: error })
              throw cancelled
            }
            throw error
          }
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }
        // The response is complete: backoff owns no HTTP or manager writer.
        // Every subsequent request has a fresh independent I/O deadline.
        await waitSnapshotArchiveRateLimit(rateDelay, signal)
      }
    }
    const settings = this.settings ?? this.acceptRemoteSettings(await invoke('makeAvailable', []))
    if (!this.snapshotArchivesEnabled || settings.primaryHandoff === undefined) return undefined
    const local = normalizeStorageIdentityKey(settings.storageIdentityKey)
    const call = (method: PrimaryHandoffMethod, auth: AuthId, ...params: unknown[]): Promise<unknown> =>
      awaitFromSync(() => invoke(method, [auth.identityKey, ...params]))
    const status = (value: unknown) => {
      const result = parsePrimaryHandoffStatus(value)
      if (result.localStorageIdentityKey !== local) throw new TypeError('Primary control storage identity changed')
      return result
    }
    return {
      status: auth =>
        mapAwaitFromSync(
          () => call('primaryHandoffStatus', auth),
          value => {
            return value === null ? undefined : status(value)
          }
        ),
      prepareSource: async (auth, id, target) => {
        const value = parsePrimaryHandoffSource(await call('preparePrimaryHandoffSource', auth, id, target))
        if (value.storageIdentityKey !== local) throw new TypeError('Primary source storage identity changed')
        return value
      },
      prepareTarget: async (auth, plan) =>
        status(await call('preparePrimaryHandoffTarget', auth, canonicalPrimaryHandoffPlan(plan))),
      retireSource: async (auth, plan) =>
        status(await call('retirePrimaryHandoffSource', auth, canonicalPrimaryHandoffPlan(plan))),
      activateTarget: async (auth, plan) =>
        status(await call('activatePrimaryHandoffTarget', auth, canonicalPrimaryHandoffPlan(plan))),
      completeSource: async (auth, plan) =>
        status(await call('completePrimaryHandoffSource', auth, canonicalPrimaryHandoffPlan(plan))),
      completeTarget: async (auth, plan) =>
        status(await call('completePrimaryHandoffTarget', auth, canonicalPrimaryHandoffPlan(plan))),
      followTarget: async (auth, plan) =>
        status(await call('followPrimaryHandoffTarget', auth, canonicalPrimaryHandoffPlan(plan))),
      cancel: async (auth, id) => status(await call('cancelPrimaryHandoff', auth, id))
    }
  }

  readonly journalDataCommitOutsideManager = true as const

  async supportsSnapshotJournalArchive(): Promise<boolean> {
    return this.snapshotArchivesEnabled && (await this.makeAvailable()).snapshotJournalArchive !== undefined
  }
  async supportsSnapshotJournalArchiveContent(): Promise<boolean> {
    return this.snapshotArchivesEnabled && (await this.makeAvailable()).snapshotJournalArchiveContentVersion === 1
  }
  async supportsSnapshotJournalDataContent(): Promise<boolean> {
    return this.snapshotArchivesEnabled && (await this.makeAvailable()).snapshotJournalDataContent !== undefined
  }
  async getSnapshotJournalDataContentReceipt(identityKey: string, sourceStorageIdentity: string) {
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalDataContent === undefined) return undefined
    return await RemoteSnapshotJournalDataDestination.contentReceipt(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      sourceStorageIdentity,
      normalizeStorageIdentityKey(settings.storageIdentityKey)
    )
  }
  async confirmSnapshotJournalDataContentReceipt(
    identityKey: string,
    sourceStorageIdentity: string,
    revision: import('../snapshot/SnapshotSyncContentRevision').SnapshotSyncContentRevision
  ) {
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalDataContent === undefined) return undefined
    return await RemoteSnapshotJournalDataDestination.contentReceipt(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      sourceStorageIdentity,
      normalizeStorageIdentityKey(settings.storageIdentityKey),
      revision
    )
  }
  async supportsSnapshotJournalDataSync(): Promise<boolean> {
    return this.snapshotArchivesEnabled && (await this.makeAvailable()).snapshotJournalData !== undefined
  }
  async getSnapshotJournalDataStatus(
    identityKey: string,
    sourceStorageIdentity: string
  ): Promise<SnapshotJournalDataStatus | undefined> {
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalData === undefined) return undefined
    return await RemoteSnapshotJournalDataDestination.observe(
      (method, params, signal) => this.snapshotRpcCall(method, params, signal),
      identityKey,
      sourceStorageIdentity,
      normalizeStorageIdentityKey(settings.storageIdentityKey)
    )
  }

  /** Actual authenticated destination admission; no local source fence is serialized. */
  async openSnapshotJournalDataDestination(
    identityKey: string,
    source: SnapshotJournalArchiveBinding,
    options: SnapshotJournalDataOptions | AbortSignal = {}
  ): Promise<RemoteSnapshotJournalDataDestination | undefined> {
    const signal = 'aborted' in options ? options : options.signal
    const settings = await this.makeAvailable()
    if (!this.snapshotArchivesEnabled || settings.snapshotJournalData === undefined) return undefined
    if (source.sourceStorage.chain !== settings.chain)
      throw new WERR_INVALID_OPERATION('Journal source and destination networks differ')
    return await RemoteSnapshotJournalDataDestination.open(
      (method, params, requestSignal) => this.snapshotRpcCall(method, params, requestSignal),
      identityKey,
      normalizeStorageIdentityKey(settings.storageIdentityKey),
      source,
      signal
    )
  }

  private async snapshotRpcCall(
    method:
      | SnapshotArchiveMethod
      | SnapshotJournalArchiveMethod
      | SnapshotJournalFieldArchiveMethod
      | RemoteSnapshotSyncMethod
      | SnapshotJournalDataMethod
      | SnapshotJournalFieldRpcMethod
      | PrimaryHandoffMethod
      | 'makeAvailable',
    params: unknown[],
    signal?: AbortSignal,
    rateAttempt = 0
  ): Promise<unknown> {
    const id = this.nextRequestId()
    const remoteDestination =
      remoteSnapshotSyncMethods.includes(method as RemoteSnapshotSyncMethod) ||
      isSnapshotJournalDataMethod(method) ||
      isSnapshotJournalFieldRpcMethod(method) ||
      isPrimaryHandoffMethod(method)
    const body = stringifyJsonRpc({ jsonrpc: '2.0', method, params, id }, true)
    if (
      new TextEncoder().encode(body).length >
      (isPrimaryHandoffMethod(method)
        ? primaryHandoffRequestBytes
        : remoteDestination
          ? remoteSnapshotSyncRequestBytes
          : snapshotArchiveRequestBytes)
    )
      throw new TypeError('Snapshot archive request exceeds its transport limit')
    const createAuthClient = (maxResponseBytes: number): AuthFetch =>
      new AuthFetch(
        this.snapshotWallet,
        undefined,
        undefined,
        undefined,
        { maxResponseBytes },
        snapshotArchiveFetch(fetch, true)
      )
    const authClient = remoteDestination
      ? (this.snapshotDestinationAuthClient ??= createAuthClient(remoteSnapshotSyncResponseBytes))
      : (this.snapshotAuthClient ??= createAuthClient(snapshotArchiveResponseBytes))
    let received: Response
    try {
      received = await authClient.fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [BINARY_ENCODING_HEADER]: BINARY_ENCODING,
          [BINARY_REQUEST_ENCODING_HEADER]: BINARY_ENCODING
        },
        body,
        signal
      })
    } catch (error) {
      const rateDelay = snapshotArchiveRateLimitDelay(error)
      if (rateDelay !== undefined && !isPrimaryHandoffMethod(method) && rateAttempt < 2) {
        await waitSnapshotArchiveRateLimit(rateDelay, signal)
        return await this.snapshotRpcCall(method, params, signal, rateAttempt + 1)
      }
      // AuthFetch uses its typed cancellation code before a native fetch may
      // exist. Inspect only its own data code here, before RPC/response parsing;
      // this also works with older SDKs that lack the exported error class.
      if (
        signal?.aborted === true &&
        error instanceof Error &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ERR_PAYMENT_CANCELLED'
      )
        throw new SnapshotCancelledError('Snapshot archive authenticated request was cancelled')
      throw error
    }
    const response = this.validateAuthenticatedResponse(received)
    if (!response.ok) throw this.rpcResponseError(response)
    if (response.headers.get(BINARY_ENCODING_HEADER) !== BINARY_ENCODING)
      throw new TypeError('Snapshot archive requires compact binary responses')
    const receivedText = await response.text()
    if (isPrimaryHandoffMethod(method) && new TextEncoder().encode(receivedText).length > primaryHandoffResponseBytes)
      throw new TypeError('Primary control response exceeds its transport bound')
    const json = validateJsonRpcResponse(parseJsonRpc(receivedText, true), id)
    if ('error' in json) throw WalletErrorFromJson(json.error as object)
    return json.result
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
  protected abstract rpcCall<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T>

  /** Share the asynchronous rejection boundary, including custom transports that throw synchronously. */
  private forwardRpc<T>(method: string, params: unknown[]): Promise<T> {
    return promiseFromSync(() => {
      return this.rpcCall<T>(method, params)
    })
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
    return this.acceptRemoteSettings(await this.rpcCall<RemoteStorageSettings>('makeAvailable', []))
  }

  private acceptRemoteSettings(input: unknown): RemoteStorageSettings {
    const settings = validateRemoteStorageSettings(input)
    const descriptor = Object.getOwnPropertyDescriptor(settings, 'storageIdentityKey')
    const storageIdentityKey = normalizeStorageIdentityKey(
      descriptor != null && 'value' in descriptor ? descriptor.value : undefined
    )
    if (this.expectedStorageIdentityKey !== undefined && storageIdentityKey !== this.expectedStorageIdentityKey) {
      throw new Error('Wallet storage settings identity does not match the configured storage identity.')
    }
    if (settings.snapshotArchive !== undefined && isSnapshotArchiveChain(settings.chain)) {
      this.snapshotSource = {
        identityKey: storageIdentityKey,
        chain: settings.chain,
        supportsReader: settings.snapshotArchiveReaderVersion === 1
      }
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
              inputBEEF: pruned.toUint8Array()
            }
          }
        }
      }
    }
    return await this.rpcCall<StorageCreateActionResult>('createAction', [auth, withBeefBytes(args)])
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
    return awaitFromSync(() =>
      this.rpcCall<StoragePrepareNoSendExpiryResult>('prepareNoSendExpiry', [auth, withBeefBytes(args)])
    )
  }

  activateNoSendExpiry(
    auth: AuthId,
    args: StorageActivateNoSendExpiryArgs
  ): Promise<StorageActivateNoSendExpiryResult> {
    return awaitFromSync(() =>
      this.rpcCall<StorageActivateNoSendExpiryResult>('activateNoSendExpiry', [
        auth,
        { ...args, target: withBeefBytes(args.target) }
      ])
    )
  }

  armNoSendExpiry(auth: AuthId, args: StorageArmNoSendExpiryArgs): Promise<void> {
    return awaitVoidFromSync(() => this.rpcCall<void>('armNoSendExpiry', [auth, args]))
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
  findOrInsertSyncStateAuth(
    auth: AuthId,
    storageIdentityKey: string,
    storageName: string
  ): Promise<{ syncState: TableSyncState; isNew: boolean }> {
    return mapAwaitFromSync(
      () =>
        this.rpcCall<{ syncState: TableSyncState; isNew: boolean }>('findOrInsertSyncStateAuth', [
          auth,
          storageIdentityKey,
          storageName
        ]),
      r => {
        r.syncState = validateEntity(r.syncState, ['when'])
        return r
      }
    )
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
  findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    return mapAwaitFromSync(
      () => this.rpcCall<TableCertificateX[]>('findCertificatesAuth', [auth, args]),
      r => {
        validateEntities(r)
        if (args.includeFields) {
          for (const c of r) {
            if (c.fields != null) validateEntities(c.fields)
          }
        }
        return r
      }
    )
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
    return mapAwaitFromSync(
      () => this.rpcCall<TableOutputBasket[]>('findOutputBasketsAuth', [auth, args]),
      r => {
        validateEntities(r)
        return r
      }
    )
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
    return mapAwaitFromSync(
      () => this.rpcCall<TableOutput[]>('findOutputsAuth', [auth, args]),
      r => {
        validateEntities(r)
        return r
      }
    )
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
    return mapAwaitFromSync(
      () => this.rpcCall<TableProvenTxReq[]>('findProvenTxReqs', [args]),
      r => {
        validateEntities(r)
        return r
      }
    )
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
    // Preserve the failure result; its error takes precedence over checkpoint fields.
    if (r.error == null && r.nextCheckpoint != null)
      r.nextCheckpoint = validateSyncCheckpoint(r.nextCheckpoint, args, r.done === true)
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
      const chunk = (await receiveSyncTransfer(manifest, offset =>
        awaitFromSync(() => {
          this.onSyncTransferProgress?.({ direction: 'read', bytes: offset, totalBytes: manifest.totalBytes })
          return this.transferPartCall<SyncTransferPart>('readSyncTransferPart', {
            identityKey: args.identityKey,
            transferId: manifest.transferId,
            offset
          })
        })
      )) as SyncChunk
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
