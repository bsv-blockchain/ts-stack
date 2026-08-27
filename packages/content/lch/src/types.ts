import type { WalletInterface } from '@bsv/sdk'

export type LCHUint = number | bigint
export type LCHValue =
  null | boolean | LCHUint | string | Uint8Array | LCHValue[] | { [key: string]: LCHValue }

export type LCHObjectType =
  | 'asset'
  | 'header'
  | 'authority'
  | 'offer'
  | 'selection'
  | 'license-request'
  | 'quote'
  | 'payment-demand'
  | 'payment-delivery'
  | 'payment-receipt'
  | 'license'
  | 'composition-record'

export interface SignedObject<T extends Record<string, LCHValue> = Record<string, LCHValue>> {
  body: T
  signatures: Uint8Array[]
}

export type RangeTuple = readonly [start: LCHUint, end: LCHUint]
export type Selection =
  | { type: 'all' }
  | { type: 'segments' | 'bytes' | 'pages'; ranges: RangeTuple[] }
  | { type: 'media-fragment'; value: string }

export interface KeyPeriod {
  keyId: Uint8Array
  firstSegment: LCHUint
  segmentCount: LCHUint
}

export interface KeyGrant {
  keyId: Uint8Array
  delivery: string
  payload: Uint8Array
}

export interface SegmentedEncryptionDescriptor {
  algorithm: string
  encryptionId: Uint8Array
  plaintextLength: LCHUint
  segmentSize: LCHUint
  segmentCount: LCHUint
  noncePrefix: Uint8Array
  keyPeriods: KeyPeriod[]
}

export interface EncryptionResult {
  ciphertext: Uint8Array
  descriptor: SegmentedEncryptionDescriptor
  keys: Map<string, Uint8Array>
}

export interface ContentReference {
  ciphertextDigest: Uint8Array
  ciphertextLength: LCHUint
  plaintextDigest?: Uint8Array
  encryption: SegmentedEncryptionDescriptor
  locators: string[]
}

export interface ContentSource {
  read(locator: string, start?: bigint, end?: bigint): Promise<Uint8Array>
}

export interface ContentSink {
  put(ciphertext: Uint8Array): Promise<string[]>
}

export interface LCHSigner {
  identityKey: Uint8Array
  sign(preimage: Uint8Array): Promise<Uint8Array>
}

export interface LCHSignatureVerifier {
  verify(preimage: Uint8Array, signature: Uint8Array): Promise<boolean>
}

export interface WalletSignerOptions {
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>
  identityKey?: string
  random?: (length: number) => Uint8Array
}

export interface RevocationObservation {
  status: 'unspent' | 'spent-mempool' | 'spent-confirmed' | 'unknown'
  network: 'mainnet' | 'testnet'
  observedAt: bigint
  blockHeight?: bigint
  tipHash?: string
  reorganizationAffected?: boolean
}

export interface RevocationSource {
  status(outpoint: string): Promise<RevocationObservation>
}

export interface StoredLicense {
  assetId: string
  offerId: string
  license: SignedObject
  storedAt: bigint
}

export interface LicenseStore {
  get(assetId: string, offerId?: string): Promise<StoredLicense | undefined>
  put(record: StoredLicense): Promise<void>
  delete(assetId: string, offerId: string): Promise<void>
}

export interface C2PAIngredientBinding {
  sourceAssetId: Uint8Array
  relationship: 'componentOf' | 'inputTo'
  hashedUri: { url: string; alg?: string; hash: Uint8Array }
}

export interface C2PAAdapter {
  validate(asset: Uint8Array, manifest?: Uint8Array): Promise<C2PAIngredientBinding[]>
}

export interface PaymentOutput {
  satoshis: bigint
  lockingScript: Uint8Array
  outputIndex?: number
}

export interface PaymentDemand {
  demandId: Uint8Array
  satoshis: bigint
  lockingScript: Uint8Array
}
