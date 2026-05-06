// Re-export everything from the browser entry
export * from './browser'
export type { BrowserWallet } from './browser'

// Re-export all types (including server-only types)
export type {
  Network,
  WalletDefaults,
  TransactionResult,
  OutputInfo,
  WalletStatus,
  WalletInfo,
  BalanceResult,
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
  DirectPaymentResult,
  DIDDocument,
  DIDVerificationMethod,
  DIDParseResult,
  CredentialFieldType,
  CredentialFieldSchema,
  CredentialSchemaConfig,
  VerifiableCredential,
  VerifiablePresentation,
  VerificationResult,
  CredentialIssuerConfig,
  RevocationRecord,
  RevocationStore
} from './core/types'

// Re-export errors
export {
  SimpleError,
  WalletError,
  TransactionError,
  MessageBoxError,
  CertificationError,
  DIDError,
  CredentialError
} from './core/errors'

// Server-specific exports
export { FileRevocationStore } from './modules/file-revocation-store'

// ============================================================================
// Utility: generate a random private key hex without exposing @bsv/sdk
// ============================================================================
//
// Defined in `./server/generate-private-key` so that sibling files inside
// `./server/` can dynamically import it without going through this barrel
// (which would create a circular dependency:
//  server.ts -> server/index.ts -> server/<sibling>.ts -> server.ts).
export { generatePrivateKey } from './server/generate-private-key'

// ============================================================================
// ServerWallet class + factory
// ============================================================================
//
// Defined in `./server/server-wallet` for the same reason: sibling files
// inside `./server/` (notably `server-wallet-manager.ts`) need to import it
// without looping back through this barrel.
export { ServerWallet } from './server/server-wallet'

// ============================================================================
// Re-export server handler utilities
// ============================================================================

export {
  // Handler types & utilities
  HandlerRequest,
  HandlerResponse,
  RouteHandler,
  getSearchParams,
  jsonResponse,
  toNextHandlers,
  // File persistence
  JsonFileStore,
  // Identity Registry
  IdentityRegistry,
  RegistryResult,
  createIdentityRegistryHandler,
  // DID Resolver
  DIDResolverService,
  createDIDResolverHandler,
  // Server Wallet Manager
  ServerWalletManager,
  createServerWalletHandler,
  // Credential Issuer Handler
  createCredentialIssuerHandler
} from './server/index'
