import type { PrivateKey, PublicKey } from '@bsv/sdk'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export type PublicKeyInput = Uint8Array | number[] | string | PublicKey
export type PrivateKeyInput = Uint8Array | number[] | string | PrivateKey
export type SdJwtAlgorithm = 'ES256K'

export interface Jwk extends JsonObject {
  kty: 'EC'
  crv: 'secp256k1'
  x: string
  y: string
  kid?: string
  alg?: SdJwtAlgorithm
}

export interface VerificationMethod {
  id: string
  type: 'Multikey'
  controller: string
  publicKeyMultibase: string
}

export interface DidDocument {
  '@context': string[]
  id: string
  verificationMethod: VerificationMethod[]
  authentication: string[]
  assertionMethod: string[]
  capabilityDelegation: string[]
  capabilityInvocation: string[]
}

export interface DisclosureFrame {
  [claimName: string]: boolean | DisclosureFrame
}

export interface SdJwtVc {
  sdJwt: string
  issuerSignedJwt: string
  disclosures: string[]
  claims: JsonObject
}

export interface SdJwtVcCreateParams {
  issuer: string
  issuerPrivateKey: PrivateKeyInput
  issuerPublicKey?: PublicKeyInput
  holderPublicKey: PublicKeyInput
  claims: JsonObject
  vct: string
  disclosureFrame?: DisclosureFrame
  subject?: string
  issuedAt?: number
  notBefore?: number
  expiresAt?: number
  status?: JsonObject
  header?: JsonObject
}

export interface SdJwtPresentation {
  sdJwt: string
  kbJwt?: string
}

export interface GeneratePresentationOptions {
  holderPrivateKey?: PrivateKeyInput
  audience?: string
  nonce?: string
  issuedAt?: number
}

export interface SdJwtVcVerificationOptions {
  issuerPublicKey?: PublicKeyInput | Jwk
  expectedAudience?: string
  expectedNonce?: string
  requireKeyBinding?: boolean
}

export interface SdJwtVcVerificationResult {
  verified: boolean
  issuerSignedJwtVerified: boolean
  keyBindingVerified: boolean | null
  payload: JsonObject | null
  disclosedClaims: JsonObject
  disclosures: string[]
  errors: string[]
}

export type QrMode = 'did' | 'vc'

export interface QrCodeOptions {
  output?: 'svg' | 'data-url'
  moduleSize?: number
  margin?: number
  darkColor?: string
  lightColor?: string
  errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high' | 'L' | 'M' | 'Q' | 'H'
}
