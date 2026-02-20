import { SecurityLevel, WalletProtocol } from '@bsv/sdk'

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
  changeBasket?: string
  tokenBasket: string
  tokenProtocolID: [SecurityLevel, string]
  tokenKeyID: string
  messageBoxHost: string
  registryUrl?: string
  didBasket: string
  didResolverUrl: string
  didProxyUrl?: string
  didProtocolID: [SecurityLevel, string]
}

// ============================================================================
// Transaction Result Types
// ============================================================================

export interface TransactionResult {
  txid: string
  tx: any
  outputs?: OutputInfo[]
  reinternalized?: ReinternalizeResult
}

export interface OutputInfo {
  index: number
  satoshis: number
  lockingScript: string
  description?: string
}

export interface ReinternalizeResult {
  count: number
  errors: string[]
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

// ============================================================================
// Payment Types
// ============================================================================

export interface PaymentOptions {
  to: string
  satoshis: number
  memo?: string
  description?: string
  basket?: string
  changeBasket?: string
  derivationPrefix?: string
  derivationSuffix?: string
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
  changeBasket?: string
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
  network?: 'mainnet' | 'testnet' | 'local'
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
  steak?: Record<string, { outputsToAdmit: number[], coinsToRetain: number[], coinsRemoved?: number[] }>
  code?: string
  description?: string
}

export interface OverlayOutput {
  beef: number[]
  outputIndex: number
  context?: number[]
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
// DID Types (Legacy — kept for backward compatibility)
// ============================================================================

export interface DIDDocument {
  '@context': string[]
  id: string
  controller: string
  verificationMethod: DIDVerificationMethod[]
  authentication: string[]
  assertionMethod: string[]
}

export interface DIDVerificationMethod {
  id: string
  type: string
  controller: string
  publicKeyHex: string
}

export interface DIDParseResult {
  method: string
  identifier: string
}

// ============================================================================
// DID Types V2 (did:bsv spec-compliant — Teranode/nChain)
// ============================================================================

export interface DIDDocumentV2 {
  '@context': string | string[]
  id: string
  controller?: string
  verificationMethod: DIDVerificationMethodV2[]
  authentication: (string | DIDVerificationMethodV2)[]
  assertionMethod?: (string | DIDVerificationMethodV2)[]
  service?: DIDService[]
}

export interface DIDVerificationMethodV2 {
  id: string
  type: string
  controller: string
  publicKeyJwk: { kty: string; crv: string; x: string; y: string }
}

export interface DIDService {
  id: string
  type: string
  serviceEndpoint: string
}

export interface DIDCreateOptions {
  identityCode?: string
  satoshis?: number
  basket?: string
  controllerKey?: string
  services?: DIDService[]
}

export interface DIDCreateResult {
  did: string
  txid: string
  identityCode: string
  document: DIDDocumentV2
}

export interface DIDResolutionResult {
  didDocument: DIDDocumentV2 | null
  didDocumentMetadata: {
    created?: string
    updated?: string
    deactivated?: boolean
    versionId?: string
    nextVersionId?: string
  }
  didResolutionMetadata: {
    contentType?: string
    error?: string
    message?: string
  }
}

export interface DIDChainState {
  did: string
  identityCode: string
  issuanceTxid: string
  currentOutpoint: string
  status: 'active' | 'deactivated'
  created: string
  updated: string
}

export interface DIDUpdateOptions {
  did: string
  services?: DIDService[]
  additionalKeys?: string[]
}

// ============================================================================
// Credential Schema Types
// ============================================================================

export type CredentialFieldType =
  | 'text' | 'email' | 'date' | 'number'
  | 'textarea' | 'checkbox' | 'select'

export interface CredentialFieldSchema {
  key: string
  label: string
  type: CredentialFieldType
  required?: boolean
  placeholder?: string
  format?: string
  options?: Array<{ value: string, label: string }>
  helpText?: string
  group?: string
}

export interface CredentialSchemaConfig {
  id: string
  name: string
  description?: string
  certificateTypeBase64?: string
  fields: CredentialFieldSchema[]
  fieldGroups?: Array<{ key: string, label: string }>
  validate?: (values: Record<string, string>) => string | null
  computedFields?: (values: Record<string, string>) => Record<string, string>
}

// ============================================================================
// W3C Verifiable Credential Types
// ============================================================================

export interface VerifiableCredential {
  '@context': string[]
  type: string[]
  id?: string
  issuer: string
  issuanceDate: string
  expirationDate?: string
  credentialSubject: {
    id: string
    [key: string]: any
  }
  credentialStatus?: {
    id: string
    type: string
  }
  proof: {
    type: string
    created: string
    proofPurpose: string
    verificationMethod: string
    signatureValue: string
  }
  _bsv: {
    certificate: CertificateData
  }
}

export interface VerifiablePresentation {
  '@context': string[]
  type: string[]
  holder: string
  verifiableCredential: VerifiableCredential[]
  proof: {
    type: string
    created: string
    proofPurpose: string
    verificationMethod: string
  }
}

export interface VerificationResult {
  valid: boolean
  revoked: boolean
  errors: string[]
  issuer?: string
  subject?: string
  type?: string
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
  load(): RegistryEntry[]
  save(entries: RegistryEntry[]): void
}

export interface IdentityRegistryConfig {
  store?: IdentityRegistryStore
  validateTag?: (tag: string, identityKey: string) => string | null
  maxTagsPerIdentity?: number
}

export interface DIDResolverConfig {
  resolverUrl?: string
  wocBaseUrl?: string
  resolverTimeout?: number
  maxHops?: number
}

export interface ServerWalletManagerConfig {
  envVar?: string
  keyFile?: string
  network?: Network
  storageUrl?: string
  defaultRequestSatoshis?: number
  requestMemo?: string
}

export interface CredentialIssuerHandlerConfig {
  schemas: CredentialSchemaConfig[]
  envVar?: string
  keyFile?: string
  serverWalletManager?: any
  revocationStorePath?: string
}
