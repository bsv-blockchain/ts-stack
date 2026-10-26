// Browser-safe default entrypoint
// Server-only exports are available via '@bsv/simple/server'

export { createWallet, Overlay, Certifier, WalletCore } from './browser'
export type { BrowserWallet, Wallet } from './browser'

// DID & Credentials (browser-safe)
export { DID } from './modules/did'
export { CredentialSchema, CredentialIssuer, MemoryRevocationStore } from './modules/credentials'

// Types
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
  CredentialFieldType,
  CredentialFieldSchema,
  CredentialSchemaConfig,
  CredentialIssuerConfig,
  RevocationRecord,
  RevocationStore,
  RegistryEntry,
  IdentityRegistryStore,
  IdentityRegistryConfig,
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
  CredentialError
} from './core/errors'

export type { DidDocument, DidResolutionResult } from '@bsv/did'
export type { BRC52Envelope, BRC52VerificationResult } from '@bsv/did/brc52'
export type { IssuedCredential } from './modules/credentials'
