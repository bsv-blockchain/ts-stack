import { PublicKey } from '@bsv/sdk/primitives'
import { fromBase58, toBase58 } from '@bsv/sdk/primitives/utils'
import type { PublicKeyInput } from '../types.js'
import { assertBoundedString, snapshotBytes } from '../validation.js'
import { normalizePublicKey as normalizePublicKeyInput } from './crypto.js'

const MAX_MULTIBASE_BYTES = 1_048_576
const MAX_DID_BYTES = 2_048

export const SECP256K1_PUB_MULTICODEC_PREFIX: readonly number[] = Object.freeze([0xe7, 0x01])
export const MULTIBASE_BASE58BTC_PREFIX = 'z'

export interface DecodedDidKey {
  did: string
  multibaseValue: string
  publicKeyBytes: number[]
}

export function normalizePublicKey(publicKey: PublicKeyInput | PublicKey): number[] {
  return normalizePublicKeyInput(publicKey).toDER() as number[]
}

export function encodeBase58Multibase(bytes: number[]): string {
  return `${MULTIBASE_BASE58BTC_PREFIX}${toBase58(
    snapshotBytes(bytes, 'Multibase input', MAX_MULTIBASE_BYTES)
  )}`
}

export function decodeBase58Multibase(value: string): number[] {
  assertBoundedString(value, 'Multibase value', MAX_MULTIBASE_BYTES * 2)
  if (!value.startsWith(MULTIBASE_BASE58BTC_PREFIX)) {
    throw new Error('Only base58-btc multibase is supported')
  }
  const encoded = value.slice(1)
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(encoded)) {
    throw new Error('Invalid base58-btc multibase value')
  }
  const decoded = fromBase58(encoded)
  if (decoded.length > MAX_MULTIBASE_BYTES) throw new Error('Multibase value exceeds the limit')
  if (toBase58(decoded) !== encoded) throw new Error('Noncanonical base58-btc multibase value')
  return decoded
}

// Implements did:key Identifier Syntax, section "did:key Identifier Syntax":
// https://w3c-ccg.github.io/did-key-spec/#did-key-identifier-syntax
export function publicKeyToDidKey(publicKey: PublicKeyInput | PublicKey): string {
  const compressed = normalizePublicKey(publicKey)
  const multibaseValue = encodeBase58Multibase([...SECP256K1_PUB_MULTICODEC_PREFIX, ...compressed])
  return `did:key:${multibaseValue}`
}

export function verificationMethodForDid(did: string): string {
  const { multibaseValue } = decodeDidKey(did)
  return `${did}#${multibaseValue}`
}

// Implements did:key "Decode Public Key Algorithm":
// https://w3c-ccg.github.io/did-key-spec/#decode-public-key-algorithm
export function decodeDidKey(did: string): DecodedDidKey {
  assertBoundedString(did, 'did:key identifier', MAX_DID_BYTES)
  const parts = did.split(':')
  if (parts.length !== 3 || parts[0] !== 'did' || parts[1] !== 'key') {
    throw new Error('Invalid did:key identifier')
  }

  const multibaseValue = parts[2]
  const bytes = decodeBase58Multibase(multibaseValue)
  const [prefixA, prefixB, ...publicKeyBytes] = bytes

  if (
    prefixA !== SECP256K1_PUB_MULTICODEC_PREFIX[0] ||
    prefixB !== SECP256K1_PUB_MULTICODEC_PREFIX[1]
  ) {
    throw new Error('Unsupported did:key multicodec')
  }

  if (publicKeyBytes.length !== 33) {
    throw new Error('Invalid secp256k1 public key length')
  }

  PublicKey.fromDER(publicKeyBytes)

  return {
    did,
    multibaseValue,
    publicKeyBytes
  }
}

export function publicKeyFromDid(did: string): PublicKey {
  const { publicKeyBytes } = decodeDidKey(did)
  return PublicKey.fromDER(publicKeyBytes)
}

export function didFromVerificationMethod(verificationMethod: string): string {
  assertBoundedString(verificationMethod, 'Verification method', MAX_DID_BYTES * 2)
  const parts = verificationMethod.split('#')
  if (parts.length !== 2) {
    throw new Error('Verification method must be a DID URL with a fragment')
  }
  const [did, fragment] = parts
  if (fragment == null || fragment.length === 0) {
    throw new Error('Verification method must be a DID URL with a fragment')
  }
  const { multibaseValue } = decodeDidKey(did)
  if (fragment !== multibaseValue) {
    throw new Error('Verification method fragment does not match did:key material')
  }
  return did
}
