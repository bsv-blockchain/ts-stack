import type { JsonObject, PrivateKeyInput, PublicKeyInput, SdJwtAlgorithm, Jwk } from '../types.js'
import { base64UrlDecodeJson, base64UrlEncodeJson } from './base64url.js'
import { signCompact, verifyCompact } from './crypto.js'

export interface DecodedJwt {
  header: JsonObject
  payload: JsonObject
  signingInput: string
  signature: string
}

export function signJwt (
  header: JsonObject,
  payload: JsonObject,
  privateKey: PrivateKeyInput,
  alg: SdJwtAlgorithm = 'ES256K'
): string {
  const protectedHeader = {
    ...header,
    alg
  }
  const signingInput = `${base64UrlEncodeJson(protectedHeader)}.${base64UrlEncodeJson(payload)}`
  return `${signingInput}.${signCompact(signingInput, privateKey, alg)}`
}

export function decodeJwt (jwt: string): DecodedJwt {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid compact JWT')
  return {
    header: base64UrlDecodeJson<JsonObject>(parts[0]),
    payload: base64UrlDecodeJson<JsonObject>(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: parts[2]
  }
}

export function verifyJwt (jwt: string, publicKey: PublicKeyInput | Jwk): DecodedJwt {
  const decoded = decodeJwt(jwt)
  const alg = decoded.header.alg
  if (alg !== 'ES256K') throw new Error(`Unsupported JOSE algorithm: ${String(alg)}`)
  if (!verifyCompact(decoded.signingInput, decoded.signature, publicKey, alg)) {
    throw new Error('JWT signature verification failed')
  }
  return decoded
}
