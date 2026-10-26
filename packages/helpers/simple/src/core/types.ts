import { SecurityLevel, WalletProtocol, type LookupNetworkPreset } from '@bsv/sdk'

// ============================================================================
// Common Types
// ============================================================================

export type Network = 'main' | 'testnet'

// ============================================================================
// Defaults
// ============================================================================

export interface WalletDefaults {
  network: Network
  description: string
  outputDescription: string
  tokenBasket: string
  tokenProtocolID: [SecurityLevel, string]
  tokenKeyID: string
  messageBoxHost: string
  registryUrl?: string
  /** Explicitly trusted registry transport for controlled local/private deployments. */
  registryFetch?: typeof fetch
}

// ============================================================================
// Transaction Result Types
// ============================================================================

export interface TransactionResult {
  txid: string
  tx: any
  outputs?: OutputInfo[]
}

export interface OutputInfo {
  index: number
  satoshis: number
  lockingScript: string
  description?: string
}

// ============================================================================
// Wallet Status
// ============================================================================

export interface WalletStatus {
  isConnected: boolean
  identityKey: string | null
  network: string
}

export interface WalletInfo {
  identityKey: string
  address: string
  network: string
  isConnected: boolean
}

export interface BalanceResult {
  totalSatoshis: number
  totalOutputs: number
  spendableSatoshis: number
  spendableOutputs: number
}

// ============================================================================
// Payment Types
// ============================================================================

export interface PaymentOptions {
  to: string
  satoshis: number
  memo?: string
  description?: string
}

// ============================================================================
// Send Types (multi-output primitive)
// ============================================================================

export interface SendOutputSpec {
  to?: string
  satoshis?: number
  data?: Array<string | object | number[]>
  description?: string
  basket?: string
  protocolID?: [number, string]
  keyID?: string
}

export interface SendOutputDetail {
  index: number
  type: 'p2pkh' | 'op_return' | 'pushdrop'
  satoshis: number
  description: string
}

export interface SendOptions {
  outputs: SendOutputSpec[]
  description?: string
}

export interface SendResult extends TransactionResult {
  outputDetails: SendOutputDetail[]
}

// ============================================================================
// Derivation Types (BRC-29)
// ============================================================================

export interface DerivationInfo {
  counterparty: string
  protocolID: WalletProtocol
  keyID: string
  publicKey: string
}

export interface PaymentDerivation {
  derivationPrefix: string
  derivationSuffix: string
  publicKey: string
}

// ============================================================================
// Token Types
// ============================================================================

export interface TokenOptions {
  to?: string
  data: any
  basket?: string
  protocolID?: [number, string]
  keyID?: string
  satoshis?: number
}

export interface TokenResult extends TransactionResult {
  basket: string
  encrypted: boolean
}

export interface TokenDetail {
  outpoint: string
  satoshis: number
  data: any
  protocolID: any
  keyID: string
  counterparty: string
}

export interface SendTokenOptions {
  basket: string
  outpoint: string
  to: string
}

export interface RedeemTokenOptions {
  basket: string
  outpoint: string
}

// ============================================================================
// Inscription Types
// ============================================================================

export type InscriptionType = 'text' | 'json' | 'file-hash' | 'image-hash'

export interface InscriptionOptions {
  data: string | object
  type: InscriptionType
  basket?: string
  description?: string
}

export interface InscriptionResult extends TransactionResult {
  type: InscriptionType
  dataSize: number
  basket: string
}

// ============================================================================
// MessageBox Types
// ============================================================================

export interface MessageBoxConfig {
  host?: string
  enableLogging?: boolean
}

// ============================================================================
// Certification Types
// ============================================================================

export interface CertifierConfig {
  privateKey?: string
  /**
   * Canonical base64 certificate identifier. A bounded historical short value
   * is retained as an offline-migration alias while new issuance uses its
   * 32-byte SHA-256 digest.
   */
  certificateType?: string
  defaultFields?: Record<string, string>
  includeTimestamp?: boolean
}

export interface CertificateData {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
  keyringForSubject: Record<string, string>
}

// ============================================================================
// Overlay Types
// ============================================================================

export interface OverlayConfig {
  topics: string[]
  network?: LookupNetworkPreset
  requireAckFromAllHosts?: 'all' | 'any' | string[]
  requireAckFromAnyHost?: 'all' | 'any' | string[]
  slapTrackers?: string[]
  hostOverrides?: Record<string, string[]>
  additionalHosts?: Record<string, string[]>
}

export interface OverlayInfo {
  topics: string[]
  network: string
  admittanceInstructions?: string
}

export interface OverlayBroadcastResult {
  success: boolean
  txid?: string
  steak?: Record<
    string,
    { outputsToAdmit: number[]; coinsToRetain: number[]; coinsRemoved?: number[] }
  >
  code?: string
  description?: string
}

export interface OverlayOutput {
  beef: number[]
  outputIndex: number
  context?: number[]
}

// ============================================================================
// Direct Payment Types (BRC-29 wallet payment internalization)
// ============================================================================

export interface DirectPaymentResult extends TransactionResult {
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  outputIndex: number
}

// ============================================================================
// Server Wallet Types
// ============================================================================

export interface ServerWalletConfig {
  privateKey: string
  network?: Network
  storageUrl?: string
}

export interface PaymentRequest {
  serverIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  satoshis: number
  memo?: string
}

export interface IncomingPayment {
  tx: number[] | Uint8Array
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  outputIndex: number
  description?: string
}

// ============================================================================
// Credential Schema Types
// ============================================================================

export type CredentialFieldType =
  'text' | 'email' | 'date' | 'number' | 'textarea' | 'checkbox' | 'select'

export interface CredentialFieldSchema {
  key: string
  label: string
  type: CredentialFieldType
  required?: boolean
  placeholder?: string
  format?: string
  options?: Array<{ value: string; label: string }>
  helpText?: string
  group?: string
}

export interface CredentialSchemaConfig {
  id: string
  name: string
  description?: string
  /**
   * Canonical base64 certificate identifier. A bounded historical short value
   * is retained as an offline-migration alias while new issuance uses its
   * 32-byte SHA-256 digest.
   */
  certificateTypeBase64?: string
  /** Exact historical identifiers accepted when verifying offline persisted credentials. */
  legacyCertificateTypesBase64?: string[]
  fields: CredentialFieldSchema[]
  fieldGroups?: Array<{ key: string; label: string }>
  validate?: (values: Record<string, string>) => string | null
  computedFields?: (values: Record<string, string>) => Record<string, string>
}

// ============================================================================
// Credential Issuer Types
// ============================================================================

export interface CredentialIssuerConfig {
  privateKey: string
  schemas?: CredentialSchemaConfig[]
  revocation?: {
    enabled: boolean
    wallet?: any
    store?: RevocationStore
  }
}

export interface RevocationRecord {
  secret: string
  outpoint: string
  beef: number[]
}

export interface RevocationStore {
  save: (serialNumber: string, record: RevocationRecord) => Promise<void>
  load: (serialNumber: string) => Promise<RevocationRecord | undefined>
  delete: (serialNumber: string) => Promise<void>
  has: (serialNumber: string) => Promise<boolean>
  findByOutpoint: (outpoint: string) => Promise<boolean>
}

// ============================================================================
// Server Handler Config Types
// ============================================================================

export interface RegistryEntry {
  tag: string
  identityKey: string
  createdAt: string
}

export interface IdentityRegistryStore {
  load: () => RegistryEntry[]
  save: (entries: RegistryEntry[]) => void
}

export interface IdentityRegistryConfig {
  /**
   * Persistence for the legacy unauthenticated directory. Possession of an
   * identity key string does not prove control of its private key.
   */
  store?: IdentityRegistryStore
  /** Content validation only; this callback is not an authentication hook. */
  validateTag?: (tag: string, identityKey: string) => string | null
  /** Maximum tags retained for one identity. Defaults to 32; maximum 256. */
  maxTagsPerIdentity?: number
  /** Maximum entries loaded or retained by the registry. Defaults to 10,000. */
  maxEntries?: number
  /** Maximum matches returned by one lookup. Defaults to 100; maximum 1,000. */
  maxLookupResults?: number
}

export interface ServerWalletManagerConfig {
  envVar?: string
  keyFile?: string
  network?: Network
  storageUrl?: string
  defaultRequestSatoshis?: number
  requestMemo?: string
  /** Maximum decoded JSON request bytes. Defaults to 64 MiB; maximum 256 MiB. */
  maxRequestBytes?: number
  /**
   * Mandatory authorization policy for every generated server-wallet route.
   * Only a literal `true` authorizes access; omission defaults closed.
   */
  authorize?: (request: {
    action: 'status' | 'reset' | 'create' | 'request' | 'balance' | 'outputs' | 'receive'
    url: string
    headers?: Headers
  }) => boolean | Promise<boolean>
}

export interface CredentialIssuerHandlerConfig {
  schemas: CredentialSchemaConfig[]
  envVar?: string
  keyFile?: string
  serverWalletManager?: any
  revocationStorePath?: string
  /** Maximum decoded JSON request bytes. Defaults to 64 MiB; maximum 256 MiB. */
  maxRequestBytes?: number
  /**
   * Mandatory authorization policy for certificate issuance and revocation.
   * Only a literal `true` authorizes the requested state change. Public info,
   * schema, status, and signature-verification queries do not invoke it.
   */
  authorize?: (request: {
    action: 'certify' | 'issue' | 'revoke'
    subjectIdentityKey?: string
    schemaId?: string
    fields?: Record<string, string>
    serialNumber?: string
    url: string
    headers?: Headers
  }) => boolean | Promise<boolean>
}
