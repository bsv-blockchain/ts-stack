import { PublicKey, Utils } from '@bsv/sdk'
import type { PublicKeyInput } from '../types.js'

export const SECP256K1_PUB_MULTICODEC_PREFIX = [0xe7, 0x01]
export const MULTIBASE_BASE58BTC_PREFIX = 'z'

export interface DecodedDidKey {
  did: string
  multibaseValue: string
  publicKeyBytes: number[]
}

export function normalizePublicKey (publicKey: PublicKeyInput | PublicKey): number[] {
  if (publicKey instanceof PublicKey) {
    return publicKey.toDER() as number[]
  }

  const bytes = typeof publicKey === 'string'
    ? Utils.toArray(publicKey, 'hex')
    : Array.from(publicKey)

  const key = PublicKey.fromDER(bytes)
  return key.toDER() as number[]
}

export function encodeBase58Multibase (bytes: number[]): string {
  return `${MULTIBASE_BASE58BTC_PREFIX}${Utils.toBase58(bytes)}`
}

export function decodeBase58Multibase (value: string): number[] {
  if (!value.startsWith(MULTIBASE_BASE58BTC_PREFIX)) {
    throw new Error('Only base58-btc multibase values are supported')
  }
  return Utils.fromBase58(value.slice(1))
}

// Implements did:key Identifier Syntax, section "did:key Identifier Syntax":
// https://w3c-ccg.github.io/did-key-spec/#did-key-identifier-syntax
export function publicKeyToDidKey (publicKey: PublicKeyInput | PublicKey): string {
  const compressed = normalizePublicKey(publicKey)
  if (compressed.length !== 33) {
    throw new Error('secp256k1 did:key requires a 33-byte compressed public key')
  }
  const multibaseValue = encodeBase58Multibase([
    ...SECP256K1_PUB_MULTICODEC_PREFIX,
    ...compressed
  ])
  return `did:key:${multibaseValue}`
}

export function verificationMethodForDid (did: string): string {
  const { multibaseValue } = decodeDidKey(did)
  return `${did}#${multibaseValue}`
}

// Implements did:key "Decode Public Key Algorithm":
// https://w3c-ccg.github.io/did-key-spec/#decode-public-key-algorithm
export function decodeDidKey (did: string): DecodedDidKey {
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
    throw new Error('Unsupported did:key multicodec; expected secp256k1-pub')
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

export function publicKeyFromDid (did: string): PublicKey {
  const { publicKeyBytes } = decodeDidKey(did)
  return PublicKey.fromDER(publicKeyBytes)
}

export function didFromVerificationMethod (verificationMethod: string): string {
  const [did, fragment] = verificationMethod.split('#')
  if (fragment == null || fragment.length === 0) {
    throw new Error('Verification method must be a DID URL with a fragment')
  }
  const { multibaseValue } = decodeDidKey(did)
  if (fragment !== multibaseValue) {
    throw new Error('Verification method fragment does not match did:key material')
  }
  return did
}
