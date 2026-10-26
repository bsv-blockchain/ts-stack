import type { JsonObject, PrivateKeyInput, Jwk } from '../types.js'
import {
  assertBoundedString,
  assertDuration,
  assertNumericDate,
  getOwnDataProperties,
  MAX_IDENTIFIER_BYTES
} from '../validation.js'
import { sha256Base64Url } from '../utils/crypto.js'
import { signJwt, verifyJwt } from '../utils/jwt.js'
import { parseSdJwt } from './format.js'

export interface KeyBindingOptions {
  audience?: string
  nonce?: string
  issuedAt?: number
  now?: number
  clockToleranceSeconds?: number
  maxAgeSeconds?: number
}

const KEY_BINDING_OPTION_KEYS = new Set([
  'audience',
  'nonce',
  'issuedAt',
  'now',
  'clockToleranceSeconds',
  'maxAgeSeconds'
])

// Implements RFC 9901 section 4.3 Key Binding JWT. The sd_hash is computed
// over the US-ASCII bytes of the selected SD-JWT ending with "~".
export function createKeyBindingJwt(
  selectedSdJwt: string,
  holderPrivateKey: PrivateKeyInput,
  options: KeyBindingOptions = {}
): string {
  assertSelectedSdJwt(selectedSdJwt)
  const input = getOwnDataProperties(options, 'Key Binding options', KEY_BINDING_OPTION_KEYS)
  if (input.audience !== undefined) {
    assertBoundedString(input.audience, 'Key Binding audience', MAX_IDENTIFIER_BYTES)
  }
  if (input.nonce !== undefined) {
    assertBoundedString(input.nonce, 'Key Binding nonce', MAX_IDENTIFIER_BYTES)
  }
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000)
  assertNumericDate(issuedAt, 'Key Binding issuedAt')
  const payload: JsonObject = {
    iat: issuedAt,
    sd_hash: sha256Base64Url(selectedSdJwt)
  }
  if (input.audience !== undefined) payload.aud = input.audience
  if (input.nonce !== undefined) payload.nonce = input.nonce
  return signJwt({ typ: 'kb+jwt' }, payload, holderPrivateKey)
}

export function verifyKeyBindingJwt(
  selectedSdJwt: string,
  kbJwt: string,
  holderJwk: Jwk,
  options: KeyBindingOptions = {}
): boolean {
  assertSelectedSdJwt(selectedSdJwt)
  const input = getOwnDataProperties(
    options,
    'Key Binding verification options',
    KEY_BINDING_OPTION_KEYS
  )
  if (input.audience !== undefined) {
    assertBoundedString(input.audience, 'Expected Key Binding audience', MAX_IDENTIFIER_BYTES)
  }
  if (input.nonce !== undefined) {
    assertBoundedString(input.nonce, 'Expected Key Binding nonce', MAX_IDENTIFIER_BYTES)
  }
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const clockToleranceSeconds = input.clockToleranceSeconds ?? 60
  const maxAgeSeconds = input.maxAgeSeconds ?? 300
  assertNumericDate(now, 'Key Binding current time')
  assertDuration(clockToleranceSeconds, 'Key Binding clock tolerance', 300)
  assertDuration(maxAgeSeconds, 'Key Binding maximum age', 86_400)
  const decoded = verifyJwt(kbJwt, holderJwk)
  if (decoded.header.typ !== 'kb+jwt') throw new Error('Invalid KB-JWT typ header')
  assertNumericDate(decoded.payload.iat, 'KB-JWT iat')
  if (decoded.payload.iat > now + clockToleranceSeconds) {
    throw new Error('KB-JWT iat is in the future')
  }
  if (decoded.payload.iat < now - maxAgeSeconds - clockToleranceSeconds) {
    throw new Error('KB-JWT is too old')
  }
  if (decoded.payload.sd_hash !== sha256Base64Url(selectedSdJwt)) {
    throw new Error('KB-JWT sd_hash does not match selected SD-JWT')
  }
  if (input.audience !== undefined && decoded.payload.aud !== input.audience) {
    throw new Error('KB-JWT audience mismatch')
  }
  if (input.nonce !== undefined && decoded.payload.nonce !== input.nonce) {
    throw new Error('KB-JWT nonce mismatch')
  }
  return true
}

function assertSelectedSdJwt(value: string): void {
  const parsed = parseSdJwt(value)
  if (parsed.kbJwt != null)
    throw new TypeError('Selected SD-JWT must not already contain Key Binding')
}
