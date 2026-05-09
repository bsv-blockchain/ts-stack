import { BigNumber, Hash, PrivateKey, PublicKey, Random, Signature, Utils } from '@bsv/sdk'
import type { Jwk, PrivateKeyInput, PublicKeyInput, SdJwtAlgorithm } from '../types.js'
import { base64UrlDecode, base64UrlEncode } from './base64url.js'

export function normalizePrivateKey (privateKey: PrivateKeyInput): PrivateKey {
  if (privateKey instanceof PrivateKey) return privateKey
  if (typeof privateKey === 'string') return PrivateKey.fromHex(privateKey)
  return new PrivateKey(Array.from(privateKey))
}

export function normalizePublicKey (publicKey: PublicKeyInput): PublicKey {
  if (publicKey instanceof PublicKey) return publicKey
  const bytes = typeof publicKey === 'string'
    ? Utils.toArray(publicKey, 'hex')
    : Array.from(publicKey)
  return PublicKey.fromDER(bytes)
}

export function publicKeyToJwk (publicKey: PublicKeyInput, kid?: string): Jwk {
  const key = normalizePublicKey(publicKey)
  return {
    kty: 'EC',
    crv: 'secp256k1',
    x: base64UrlEncode(key.getX().toArray('be', 32)),
    y: base64UrlEncode(key.getY().toArray('be', 32)),
    alg: 'ES256K',
    ...(kid != null ? { kid } : {})
  }
}

export function privateKeyToJwk (privateKey: PrivateKeyInput, kid?: string): Jwk {
  return publicKeyToJwk(normalizePrivateKey(privateKey).toPublicKey(), kid)
}

export function jwkToPublicKey (jwk: Jwk): PublicKey {
  if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1') {
    throw new Error('Only secp256k1 EC JWKs are supported')
  }
  const x = Utils.toHex(base64UrlDecode(jwk.x))
  const y = Utils.toHex(base64UrlDecode(jwk.y))
  return new PublicKey(x, y)
}

export function signCompact (data: string, privateKey: PrivateKeyInput, alg: SdJwtAlgorithm = 'ES256K'): string {
  assertSupportedAlg(alg)
  const signature = normalizePrivateKey(privateKey).sign(Array.from(new TextEncoder().encode(data)))
  return base64UrlEncode([
    ...signature.r.toArray('be', 32),
    ...signature.s.toArray('be', 32)
  ])
}

export function verifyCompact (data: string, signatureValue: string, publicKey: PublicKeyInput | Jwk, alg: SdJwtAlgorithm = 'ES256K'): boolean {
  assertSupportedAlg(alg)
  const key = isJwk(publicKey) ? jwkToPublicKey(publicKey) : normalizePublicKey(publicKey)
  const signatureBytes = base64UrlDecode(signatureValue)
  if (signatureBytes.length !== 64) return false
  const signature = new Signature(
    new BigNumber(signatureBytes.slice(0, 32)),
    new BigNumber(signatureBytes.slice(32, 64))
  )
  return key.verify(Array.from(new TextEncoder().encode(data)), signature)
}

export function sha256Base64Url (value: string | number[] | Uint8Array): string {
  const bytes = typeof value === 'string'
    ? Array.from(new TextEncoder().encode(value))
    : Array.from(value)
  return base64UrlEncode(Hash.sha256(bytes))
}

export function randomSalt (byteLength = 16): string {
  return base64UrlEncode(Random(byteLength))
}

function assertSupportedAlg (alg: SdJwtAlgorithm): void {
  if (alg !== 'ES256K') {
    throw new Error('Unsupported JOSE algorithm')
  }
}

function isJwk (value: PublicKeyInput | Jwk): value is Jwk {
  return typeof value === 'object' && value != null && 'kty' in value && 'crv' in value
}
