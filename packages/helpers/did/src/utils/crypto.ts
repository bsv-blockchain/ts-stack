import { BigNumber, PrivateKey, PublicKey, Random, Signature } from '@bsv/sdk/primitives'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import type { Jwk, PrivateKeyInput, PublicKeyInput, SdJwtAlgorithm } from '../types.js'
import {
  assertBoundedString,
  isPlainRecord,
  MAX_JSON_STRING_BYTES,
  snapshotBytes
} from '../validation.js'
import { base64UrlDecode, base64UrlEncode } from './base64url.js'

const SECP256K1_FIELD_PRIME = BigInt(
  '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f'
)

export function normalizePrivateKey(privateKey: PrivateKeyInput): PrivateKey {
  let bytes: number[]
  if (privateKey instanceof PrivateKey) {
    bytes = privateKey.toArray('be', 32)
  } else if (typeof privateKey === 'string') {
    if (!/^[0-9A-Fa-f]{64}$/.test(privateKey)) {
      throw new TypeError('Private key must be 32 hex bytes')
    }
    bytes = toArray(privateKey, 'hex')
  } else {
    bytes = snapshotBytes(privateKey, 'Private key', 32, [32])
  }
  const normalized = new PrivateKey(bytes, 10, 'be', 'error')
  if (normalized.isZero()) throw new TypeError('Private key scalar must be non-zero')
  return normalized
}

export function normalizePublicKey(publicKey: PublicKeyInput): PublicKey {
  let bytes: number[]
  if (publicKey instanceof PublicKey) {
    bytes = publicKey.toDER() as number[]
  } else if (typeof publicKey === 'string') {
    if (!/^(?:[0-9A-Fa-f]{66}|[0-9A-Fa-f]{130})$/.test(publicKey)) {
      throw new TypeError('Public key must be canonical hex DER')
    }
    bytes = toArray(publicKey, 'hex')
  } else {
    bytes = snapshotBytes(publicKey, 'Public key', 65, [33, 65])
  }
  const normalized = PublicKey.fromDER(bytes)
  if (!normalized.validate()) throw new TypeError('Public key is not a valid secp256k1 point')
  return PublicKey.fromDER(normalized.toDER() as number[])
}

export function publicKeyToJwk(publicKey: PublicKeyInput, kid?: string): Jwk {
  const key = normalizePublicKey(publicKey)
  if (kid !== undefined) assertBoundedString(kid, 'JWK kid', 2_048)
  return {
    kty: 'EC',
    crv: 'secp256k1',
    x: base64UrlEncode(key.getX().toArray('be', 32)),
    y: base64UrlEncode(key.getY().toArray('be', 32)),
    alg: 'ES256K',
    ...(kid != null ? { kid } : {})
  }
}

export function privateKeyToJwk(privateKey: PrivateKeyInput, kid?: string): Jwk {
  return publicKeyToJwk(normalizePrivateKey(privateKey).toPublicKey(), kid)
}

export function jwkToPublicKey(jwk: Jwk): PublicKey {
  if (!isPlainRecord(jwk)) throw new TypeError('JWK must be a plain object')
  const descriptors = Object.getOwnPropertyDescriptors(jwk)
  const read = (key: string): unknown => {
    const descriptor = descriptors[key]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`JWK ${key} must be an enumerable own data property`)
    }
    return descriptor.value
  }
  const kty = read('kty')
  const crv = read('crv')
  const xValue = read('x')
  const yValue = read('y')
  if (kty !== 'EC' || crv !== 'secp256k1') {
    throw new Error('Only secp256k1 EC JWKs are supported')
  }
  if (typeof xValue !== 'string' || typeof yValue !== 'string') {
    throw new TypeError('JWK coordinates must be strings')
  }
  if (descriptors.d != null) throw new TypeError('A public JWK must not contain private material')
  if (descriptors.alg != null && read('alg') !== 'ES256K') {
    throw new TypeError('JWK algorithm must be ES256K when present')
  }
  if (descriptors.kid != null) {
    const kid = read('kid')
    assertBoundedString(kid, 'JWK kid', 2_048)
  }
  if (descriptors.use != null && read('use') !== 'sig') {
    throw new TypeError('JWK use must be "sig" when present')
  }
  if (descriptors.key_ops != null) {
    const operations = read('key_ops')
    const operation = Array.isArray(operations)
      ? Object.getOwnPropertyDescriptor(operations, '0')
      : undefined
    if (
      !Array.isArray(operations) ||
      operations.length !== 1 ||
      operation == null ||
      !operation.enumerable ||
      !('value' in operation) ||
      operation.value !== 'verify'
    ) {
      throw new TypeError('JWK key_ops must contain only "verify"')
    }
  }
  const xBytes = base64UrlDecode(xValue, 32)
  const yBytes = base64UrlDecode(yValue, 32)
  if (xBytes.length !== 32 || yBytes.length !== 32) {
    throw new TypeError('JWK coordinates must be exactly 32 bytes')
  }
  if (
    BigInt(`0x${toHex(xBytes)}`) >= SECP256K1_FIELD_PRIME ||
    BigInt(`0x${toHex(yBytes)}`) >= SECP256K1_FIELD_PRIME
  ) {
    throw new TypeError('JWK coordinate outside secp256k1 field')
  }
  const key = PublicKey.fromDER([0x04, ...xBytes, ...yBytes])
  return PublicKey.fromDER(key.toDER() as number[])
}

export function signCompact(
  data: string,
  privateKey: PrivateKeyInput,
  alg: SdJwtAlgorithm = 'ES256K'
): string {
  assertSupportedAlg(alg)
  assertBoundedString(data, 'Signing input', MAX_JSON_STRING_BYTES, true)
  const signature = normalizePrivateKey(privateKey).sign(Array.from(new TextEncoder().encode(data)))
  return base64UrlEncode([...signature.r.toArray('be', 32), ...signature.s.toArray('be', 32)])
}

export function verifyCompact(
  data: string,
  signatureValue: string,
  publicKey: PublicKeyInput | Jwk,
  alg: SdJwtAlgorithm = 'ES256K'
): boolean {
  assertSupportedAlg(alg)
  assertBoundedString(data, 'Signing input', MAX_JSON_STRING_BYTES, true)
  const key = isJwk(publicKey) ? jwkToPublicKey(publicKey) : normalizePublicKey(publicKey)
  const signatureBytes = base64UrlDecode(signatureValue, 64)
  if (signatureBytes.length !== 64) return false
  const signature = new Signature(
    new BigNumber(signatureBytes.slice(0, 32)),
    new BigNumber(signatureBytes.slice(32, 64))
  )
  return key.verify(Array.from(new TextEncoder().encode(data)), signature)
}

export function sha256Base64Url(value: string | number[] | Uint8Array): string {
  const bytes =
    typeof value === 'string'
      ? (assertBoundedString(value, 'Hash input', MAX_JSON_STRING_BYTES, true),
        Array.from(new TextEncoder().encode(value)))
      : snapshotBytes(value, 'Hash input', MAX_JSON_STRING_BYTES)
  return base64UrlEncode(sha256(bytes))
}

export function randomSalt(byteLength = 16): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new TypeError('Salt length must be 16..64 bytes')
  }
  return base64UrlEncode(Random(byteLength))
}

function assertSupportedAlg(alg: SdJwtAlgorithm): void {
  if (alg !== 'ES256K') {
    throw new Error('Unsupported JOSE algorithm')
  }
}

function isJwk(value: PublicKeyInput | Jwk): value is Jwk {
  if (!isPlainRecord(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return descriptors.kty != null && descriptors.crv != null
}
