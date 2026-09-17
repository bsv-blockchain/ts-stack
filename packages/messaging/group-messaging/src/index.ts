/**
 * @bsv/group-messaging — end-to-end encrypted group messaging for BRC-100
 * wallets, using MLS (RFC 9420) for group state.
 *
 * Start with {@link GroupMessagingClient}. The layers underneath it are
 * exported too, for callers who want to compose them differently.
 */

export { GroupMessagingClient } from './client.js'
export type { ClientEvents, GroupMessagingClientOptions } from './client.js'
export { Group } from './group.js'

// ── The layers, for lower-level use ────────────────────────────────────────

export { IdentityService } from './identity/index.js'
export type { IdentityInput, WalletLike } from './identity/index.js'

export { StorageProvider } from './storage/index.js'
export type {
  StorageInput,
  StorageBackend,
  StorageTable,
  Awaitable,
  ChatRecord
} from './storage/index.js'
export { MapStorageBackend, SqlStorageBackend, IndexedDbStorageBackend } from './storage/index.js'
export {
  openDatabase,
  STORAGE_TABLES,
  DEFAULT_TABLE_NAME,
  DEFAULT_DATABASE_NAME
} from './storage/index.js'
export type { SqlDriver, SqlBindValue, SqlRunResult, SqlStorageOptions } from './storage/index.js'

export { TransportService, BroadcastError, DeliveryFailed } from './transport/index.js'
export type { TransportInput, TransportBackend } from './transport/index.js'
export {
  InProcessTransportHub,
  MessageBoxTransport,
  LiveDeliveryUnavailable,
  DEFAULT_MESSAGE_BOX,
  DEFAULT_MESSAGE_BOX_HOST,
  DEFAULT_POLL_INTERVAL_MS,
  LIVE_BACKSTOP_INTERVAL_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_REMEMBERED_MESSAGES,
  BODY_VERSION,
  MalformedBodyError,
  UnparsableBodyError
} from './transport/index.js'
export type {
  LiveStatus,
  MessageBoxClientLike,
  MessageBoxTransportOptions
} from './transport/index.js'

export { MlsEngine } from './mls/index.js'
export type {
  KeyPackageDescription,
  KeyPackageVerification,
  MlsEngineOptions,
  MlsGroupSummary,
  MlsProcessResult
} from './mls/index.js'
export { asKeyPackageBytes, asPrivateKeyPackageBytes } from './mls/key-package-codec.js'

// ── Invitations and bootstrap traffic ──────────────────────────────────────

export { InviteService } from './invites/index.js'
export type { InviteServiceDeps } from './invites/index.js'
export { encodeEnvelope, decodeEnvelope, EnvelopeError } from './bootstrap/index.js'
export type { BootstrapMessage, Envelope } from './bootstrap/index.js'

// ── Identity and credentials ───────────────────────────────────────────────

export {
  GROUP_MESSAGING_PROTOCOL,
  CREDENTIAL_KEY_ID_PREFIX,
  newCredentialKeyId,
  attestationPreimage,
  attestationPublicKey,
  createCredentialIdentity,
  encodeCredentialIdentity,
  decodeCredentialIdentity,
  verifyCredentialIdentity
} from './identity/index.js'
export type { CredentialIdentity } from './identity/index.js'

// ── Message content ────────────────────────────────────────────────────────

export * from './content/index.js'

// ── Shared ─────────────────────────────────────────────────────────────────

export { Emitter } from './events.js'
export type { ListenerErrorHandler } from './events.js'
export { FramingError, decodeFrames, encodeFrames } from './storage/index.js'
export {
  GroupMessagingError,
  NotImplementedError,
  UnknownGroupError,
  CredentialBindingError,
  EpochMismatchError,
  PermanentProcessingError,
  isPermanent
} from './errors.js'
export { IndexedDbUnavailableError } from './storage/index.js'
export { DEFAULT_CIPHERSUITE } from './types.js'
export type {
  ChatId,
  ChatInfo,
  CiphersuiteChoice,
  IdentityKey,
  InviteId,
  KeyPackageBytes,
  KeyPackageOptions,
  KeyPackageRef,
  Member,
  MessageId,
  MintedKeyPackage,
  MlsCiphersuiteName,
  MlsGroupId,
  PendingInvite,
  PrivateKeyPackageBytes,
  Unsubscribe,
  WirePayload
} from './types.js'
export { toHex, fromHex, bytesEqual, randomId } from './bytes.js'
