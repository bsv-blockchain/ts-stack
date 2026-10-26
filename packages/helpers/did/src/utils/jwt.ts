import type { JsonObject, PrivateKeyInput, PublicKeyInput, SdJwtAlgorithm, Jwk } from '../types.js'
import { assertBoundedString, hasOwn, MAX_JWT_BYTES, snapshotJsonObject } from '../validation.js'
import { base64UrlDecode } from './base64url.js'
import { base64UrlDecodeJson, base64UrlEncodeJson } from './base64url.js'
import { signCompact, verifyCompact } from './crypto.js'

export interface DecodedJwt {
  header: JsonObject
  payload: JsonObject
  signingInput: string
  signature: string
}

export function signJwt(
  header: JsonObject,
  payload: JsonObject,
  privateKey: PrivateKeyInput,
  alg: SdJwtAlgorithm = 'ES256K'
): string {
  const headerSnapshot = snapshotJsonObject(header, 'JWT header')
  const payloadSnapshot = snapshotJsonObject(payload, 'JWT payload')
  const protectedHeader = { ...headerSnapshot, alg }
  const signingInput = `${base64UrlEncodeJson(protectedHeader)}.${base64UrlEncodeJson(payloadSnapshot)}`
  if (new TextEncoder().encode(signingInput).length > MAX_JWT_BYTES) {
    throw new TypeError('JWT exceeds the byte limit')
  }
  return `${signingInput}.${signCompact(signingInput, privateKey, alg)}`
}

export function decodeJwt(jwt: string): DecodedJwt {
  assertBoundedString(jwt, 'JWT', MAX_JWT_BYTES)
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid compact JWT')
  if (parts.some(part => part.length === 0 || !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('Invalid compact JWT')
  }
  const signature = base64UrlDecode(parts[2], 64)
  if (signature.length !== 64) throw new Error('Invalid ES256K compact signature length')
  const header = snapshotJsonObject(base64UrlDecodeJson<unknown>(parts[0]), 'JWT header')
  const payload = snapshotJsonObject(base64UrlDecodeJson<unknown>(parts[1]), 'JWT payload')
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: parts[2]
  }
}

export function verifyJwt(jwt: string, publicKey: PublicKeyInput | Jwk): DecodedJwt {
  const decoded = decodeJwt(jwt)
  const alg = decoded.header.alg
  if (typeof alg !== 'string' || alg !== 'ES256K') throw new Error('Unsupported JOSE algorithm')
  if (hasOwn(decoded.header, 'crit') || hasOwn(decoded.header, 'b64')) {
    throw new Error('Unsupported critical JOSE header')
  }
  if (!verifyCompact(decoded.signingInput, decoded.signature, publicKey, alg)) {
    throw new Error('JWT signature verification failed')
  }
  return decoded
}
