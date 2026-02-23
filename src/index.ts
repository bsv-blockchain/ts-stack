// Browser-safe default entrypoint
// Server-only exports are available via '@bsv/simple/server'

export { createWallet, Wallet, Overlay, Certifier, WalletCore } from './browser'
export type { BrowserWallet } from './browser'

// DID & Credentials (browser-safe)
export { DID } from './modules/did'
export {
  CredentialSchema,
  CredentialIssuer,
  MemoryRevocationStore,
  toVerifiableCredential,
  toVerifiablePresentation
} from './modules/credentials'

// Types
export type {
  Network,
  WalletDefaults,
  TransactionResult,
  OutputInfo,
  WalletStatus,
  WalletInfo,
  PaymentOptions,
  SendOutputSpec,
  SendOutputDetail,
  SendOptions,
  SendResult,
  DerivationInfo,
  PaymentDerivation,
  TokenOptions,
  TokenResult,
  TokenDetail,
  SendTokenOptions,
  RedeemTokenOptions,
  InscriptionType,
  InscriptionOptions,
  InscriptionResult,
  MessageBoxConfig,
  CertifierConfig,
  CertificateData,
  OverlayConfig,
  OverlayInfo,
  OverlayBroadcastResult,
  OverlayOutput,
  ServerWalletConfig,
  PaymentRequest,
  IncomingPayment,
  DIDDocument,
  DIDVerificationMethod,
  DIDParseResult,
  DIDDocumentV2,
  DIDVerificationMethodV2,
  DIDService,
  DIDCreateOptions,
  DIDCreateResult,
  DIDResolutionResult,
  DIDChainState,
  DIDUpdateOptions,
  CredentialFieldType,
  CredentialFieldSchema,
  CredentialSchemaConfig,
  VerifiableCredential,
  VerifiablePresentation,
  VerificationResult,
  CredentialIssuerConfig,
  RevocationRecord,
  RevocationStore,
  RegistryEntry,
  IdentityRegistryStore,
  IdentityRegistryConfig,
  DIDResolverConfig,
  ServerWalletManagerConfig,
  CredentialIssuerHandlerConfig
} from './core/types'

// Errors
export {
  SimpleError,
  WalletError,
  TransactionError,
  MessageBoxError,
  CertificationError,
  DIDError,
  CredentialError
} from './core/errors'
