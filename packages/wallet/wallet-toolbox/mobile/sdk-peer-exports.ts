// Keep peer SDK implementation objects external. The package build selects
// only used public SDK categories; root-only exports retain the original root.
// All public types continue to come from the original peer SDK root.
export type * from '@bsv/sdk'

export {
  BigNumber,
  Curve,
  ECDSA,
  Hash,
  KeyShares,
  MAX_SHAMIR_SHARES,
  Point,
  PointInFiniteField,
  Polynomial,
  PrivateKey,
  PublicKey,
  Random,
  Schnorr,
  Secp256r1,
  Signature,
  SymmetricKey,
  TransactionSignature,
  Utils,
  isAsyncCryptoDigest,
  readyAsyncCryptoBackend,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend,
  validateAsyncCryptoBytes
} from '@bsv/sdk/primitives'
export {
  LockingScript,
  OP,
  P2PKH,
  PushDrop,
  RPuzzle,
  Script,
  ScriptEvaluationError,
  ScriptResourceLimitError,
  Spend,
  UnlockingScript,
  decodeCanonicalPushDrop
} from '@bsv/sdk/script'
export {
  ATOMIC_BEEF,
  BEEF_V1,
  BEEF_V2,
  Beef,
  BeefParty,
  BeefTx,
  MerklePath,
  TX_DATA_FORMAT,
  Transaction,
  TransactionEvidenceCoordinator,
  TransactionEvidenceError,
  defaultTransactionEvidenceLimits,
  isBroadcastFailure,
  isBroadcastResponse,
  isChainTracker,
  registerScriptVerificationBackend,
  scriptVerificationBackend,
  unregisterScriptVerificationBackend
} from '@bsv/sdk/transaction'
export { LivePolicy, SatoshisPerKilobyte } from '@bsv/sdk/transaction/fee-models'
export { ARC, Teranode, WhatsOnChainBroadcaster, defaultBroadcaster } from '@bsv/sdk/transaction/broadcasters'
export { BlockHeadersService, WhatsOnChain, defaultChainTracker } from '@bsv/sdk/transaction/chaintrackers'
export { FetchHttpClient, NodejsHttpClient, binaryHttpClient, defaultHttpClient } from '@bsv/sdk/transaction/http'
export { EncryptedMessage, SignedMessage } from '@bsv/sdk/messages'
export { BSM, ECIES, HD, Mnemonic, fromUtxo } from '@bsv/sdk/compat'
export { TOTP } from '@bsv/sdk/totp'
export {
  BOUND_ACTION_OUTPUT_AUTHORIZATION_VERSION,
  CachedKeyDeriver,
  HTTPWalletJSON,
  HTTPWalletWire,
  InvokableWalletBase,
  KeyDeriver,
  MAX_WALLET_WIRE_FRAME_BYTES,
  ProtoWallet,
  ReactNativeWebView,
  SecurityLevels,
  Validation,
  WERR_INSUFFICIENT_FUNDS,
  WERR_INVALID_PARAMETER,
  WERR_REVIEW_ACTIONS,
  WalletClient,
  WalletError,
  WalletErrors,
  WalletWireProcessor,
  WalletWireTransceiver,
  WindowCWISubstrate,
  XDM,
  assertSafeWalletJSONValue,
  assertSafeWalletValue,
  brc100JsonReplacer,
  completeBoundAction,
  normalizeBRC100ByteArray,
  normalizeBRC100ByteFields,
  normalizeBRC100WalletByteFields,
  snapshotWalletResultRequest,
  stringifyBRC100,
  toBRC100PortableByteArray,
  validateWalletArgs,
  validateWalletResult,
  walletErrors
} from '@bsv/sdk/wallet'
export {
  AuthFetch,
  Certificate,
  CompletedProtoWallet,
  DEFAULT_AUTH_SESSION_IDLE_MS,
  DEFAULT_MAX_AUTH_SESSIONS,
  DEFAULT_MAX_INITIAL_REQUEST_NONCES,
  DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY,
  DEFAULT_MAX_MESSAGE_NONCES_PER_SESSION,
  DEFAULT_SIMPLIFIED_FETCH_MAX_HANDSHAKE_RESPONSE_BYTES,
  DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES,
  DEFAULT_SIMPLIFIED_FETCH_REQUEST_TIMEOUT_MS,
  MasterCertificate,
  PaymentTransportError,
  Peer,
  SessionManager,
  SimplifiedFetchTransport,
  VerifiableCertificate,
  authenticatedContentType,
  buildMultipartPayment,
  createNonce,
  findPaymentBytes,
  getVerifiableCertificates,
  isMultipartPaymentType,
  parseKnownTxidsHeader,
  paymentBoundary,
  paymentPayloadContentType,
  paymentTransports,
  preparePaymentTransport,
  resolvePaymentTransportLimits,
  snapshotAuthMessage,
  validateCertificates,
  verifyNonce
} from '@bsv/sdk/auth'
export {
  DEFAULT_LOOKUP_LIMITS,
  DEFAULT_SLAP_TRACKERS,
  DEFAULT_TESTNET_SLAP_TRACKERS,
  DEFAULT_TTN_SLAP_TRACKERS,
  HTTPSOverlayBroadcastFacilitator,
  HTTPSOverlayLookupFacilitator,
  LookupHTTPError,
  LookupResolver,
  LookupResourceLimitError,
  MAX_OVERLAY_NAME_BYTES,
  OVERLAY_LOOKUP_SERVICE_NAME_PATTERN,
  OVERLAY_TOPIC_NAME_PATTERN,
  OverlayAdminTokenTemplate,
  SHIPBroadcaster,
  SHIPCast,
  TopicBroadcaster,
  isOverlayLookupServiceName,
  isOverlayTopicName,
  withDoubleSpendRetry
} from '@bsv/sdk/overlay-tools'
export {
  DEFAULT_UHRP_SERVERS,
  MAX_UHRP_ADVERTISEMENT_URL_BYTES,
  RenewResiliencyError,
  StorageDownloader,
  StorageUploader,
  StorageUtils,
  UHRP_ADVERTISEMENT_KEY_ID,
  UHRP_ADVERTISEMENT_PROTOCOL,
  createPublicHTTPSFetch,
  createPublicNetworkFetch,
  decodeAndVerifyUHRPAdvertisement,
  isPublicNetworkAddress
} from '@bsv/sdk/storage'
export {
  DEFAULT_IDENTITY_CLIENT_OPTIONS,
  IdentityClient,
  KNOWN_IDENTITY_TYPES,
  defaultIdentity
} from '@bsv/sdk/identity'
export {
  RegistryClient,
  decodeAndVerifyRegistryToken,
  decodeAndVerifySignedPushDropToken,
  deserializeWalletProtocol
} from '@bsv/sdk'
export {
  GlobalKVStore,
  LocalKVStore,
  decodeAndVerifyKVStoreToken,
  validateKVStoreController,
  validateKVStoreKey,
  validateKVStoreProtocol,
  validateKVStoreTags,
  validateKVStoreValue
} from '@bsv/sdk/kvstore'
export {
  Brc29RemittanceModule,
  DEFAULT_REMITTANCE_MESSAGEBOX,
  DefaultLockingScriptProvider,
  DefaultNonceProvider,
  InvoiceHandle,
  REMITTANCE_STATE_TRANSITIONS,
  RemittanceManager,
  SAT_UNIT,
  ThreadHandle
} from '@bsv/sdk/remittance'
export {
  Telemetry,
  TelemetrySpan,
  formatTraceparent,
  instrumentWallet,
  parseTraceparent,
  sanitizeTelemetryText
} from '@bsv/sdk/telemetry'
