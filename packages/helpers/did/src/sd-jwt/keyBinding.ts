import type { JsonObject, PrivateKeyInput, Jwk } from '../types.js'
import { sha256Base64Url } from '../utils/crypto.js'
import { signJwt, verifyJwt } from '../utils/jwt.js'

export interface KeyBindingOptions {
  audience?: string
  nonce?: string
  issuedAt?: number
}

// Implements RFC 9901 section 4.3 Key Binding JWT. The sd_hash is computed
// over the US-ASCII bytes of the selected SD-JWT ending with "~".
export function createKeyBindingJwt (
  selectedSdJwt: string,
  holderPrivateKey: PrivateKeyInput,
  options: KeyBindingOptions = {}
): string {
  const payload: JsonObject = {
    iat: options.issuedAt ?? Math.floor(Date.now() / 1000),
    sd_hash: sha256Base64Url(selectedSdJwt),
    ...(options.audience != null ? { aud: options.audience } : {}),
    ...(options.nonce != null ? { nonce: options.nonce } : {})
  }
  return signJwt({ typ: 'kb+jwt' }, payload, holderPrivateKey)
}

export function verifyKeyBindingJwt (
  selectedSdJwt: string,
  kbJwt: string,
  holderJwk: Jwk,
  options: KeyBindingOptions = {}
): boolean {
  const decoded = verifyJwt(kbJwt, holderJwk)
  if (decoded.header.typ !== 'kb+jwt') throw new Error('Invalid KB-JWT typ header')
  if (decoded.payload.sd_hash !== sha256Base64Url(selectedSdJwt)) {
    throw new Error('KB-JWT sd_hash does not match selected SD-JWT')
  }
  if (options.audience != null && decoded.payload.aud !== options.audience) {
    throw new Error('KB-JWT audience mismatch')
  }
  if (options.nonce != null && decoded.payload.nonce !== options.nonce) {
    throw new Error('KB-JWT nonce mismatch')
  }
  return true
}
