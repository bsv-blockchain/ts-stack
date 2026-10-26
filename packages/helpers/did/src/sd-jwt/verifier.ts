/* eslint-disable @typescript-eslint/no-extraneous-class */
import type {
  JsonObject,
  PublicKeyInput,
  SdJwtPresentation,
  SdJwtVcVerificationOptions,
  SdJwtVcVerificationResult
} from '../types.js'
import {
  assertBoundedString,
  assertDuration,
  assertNumericDate,
  getOwnDataProperties,
  hasOwn,
  isPlainRecord,
  MAX_IDENTIFIER_BYTES
} from '../validation.js'
import { jwkToPublicKey, normalizePublicKey } from '../utils/crypto.js'
import { decodeJwt, verifyJwt } from '../utils/jwt.js'
import { publicKeyFromDid } from '../utils/multibase.js'
import { applyDisclosures } from './disclosures.js'
import { parseSdJwt, serializeSdJwt } from './format.js'
import { verifyKeyBindingJwt } from './keyBinding.js'

const VERIFICATION_OPTION_KEYS = new Set([
  'issuerPublicKey',
  'expectedIssuer',
  'expectedVct',
  'expectedCredentialAudience',
  'expectedAudience',
  'expectedNonce',
  'requireKeyBinding',
  'now',
  'clockToleranceSeconds',
  'maxKeyBindingAgeSeconds'
])

interface VerificationPolicy {
  issuerPublicKey?: PublicKeyInput | JsonObject
  expectedIssuer?: string
  expectedVct?: string
  expectedCredentialAudience?: string
  expectedAudience?: string
  expectedNonce?: string
  requireKeyBinding: boolean
  now: number
  clockToleranceSeconds: number
  maxKeyBindingAgeSeconds: number
}

export class SdJwtVcVerifier {
  // Implements RFC 9901 section 7.3 Verification by the Verifier and
  // draft-ietf-oauth-sd-jwt-vc section 2.2.2 registered SD-JWT VC claims.
  static async verify(
    presentation: SdJwtPresentation | string,
    options: SdJwtVcVerificationOptions = {}
  ): Promise<SdJwtVcVerificationResult> {
    const errors: string[] = []
    let issuerSignedJwtVerified = false
    let keyBindingVerified: boolean | null = null
    let payload: JsonObject | null = null
    let disclosedClaims: JsonObject = {}
    let disclosures: string[] = []

    try {
      const policy = snapshotPolicy(options)
      const serialized = snapshotPresentation(presentation)
      const parsed = parseSdJwt(serialized)
      disclosures = [...parsed.disclosures]
      const decoded = decodeJwt(parsed.issuerSignedJwt)
      assertIssuerHeader(decoded.header)
      const issuerPublicKey = resolveIssuerPublicKey(decoded.payload, policy)
      verifyJwt(parsed.issuerSignedJwt, issuerPublicKey)
      issuerSignedJwtVerified = true

      const applied = applyDisclosures(decoded.payload, disclosures)
      validateCredentialClaims(applied.payload, policy)
      payload = applied.payload
      disclosedClaims = applied.disclosedClaims

      const kbJwt = parsed.kbJwt
      if (kbJwt != null) {
        const holderJwk = getHolderJwk(payload.cnf)
        verifyKeyBindingJwt(
          serializeSdJwt(parsed.issuerSignedJwt, disclosures),
          kbJwt,
          holderJwk as never,
          {
            audience: policy.expectedAudience,
            nonce: policy.expectedNonce,
            now: policy.now,
            clockToleranceSeconds: policy.clockToleranceSeconds,
            maxAgeSeconds: policy.maxKeyBindingAgeSeconds
          }
        )
        keyBindingVerified = true
      } else if (policy.requireKeyBinding) {
        throw new Error('Key Binding JWT is required')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SD-JWT verification failed'
      errors.push(message.slice(0, 1_024))
      payload = null
      disclosedClaims = {}
      disclosures = []
    }

    return {
      verified: issuerSignedJwtVerified && errors.length === 0,
      issuerSignedJwtVerified,
      keyBindingVerified,
      payload,
      disclosedClaims,
      disclosures,
      errors
    }
  }
}

function snapshotPolicy(options: SdJwtVcVerificationOptions): VerificationPolicy {
  const input = getOwnDataProperties(
    options,
    'SD-JWT verification options',
    VERIFICATION_OPTION_KEYS
  )
  if (input.expectedIssuer !== undefined) {
    assertBoundedString(input.expectedIssuer, 'Expected issuer', MAX_IDENTIFIER_BYTES)
  }
  if (input.expectedVct !== undefined) {
    assertBoundedString(input.expectedVct, 'Expected vct', MAX_IDENTIFIER_BYTES)
  }
  if (input.expectedCredentialAudience !== undefined) {
    assertBoundedString(
      input.expectedCredentialAudience,
      'Expected credential audience',
      MAX_IDENTIFIER_BYTES
    )
  }
  if (input.expectedAudience !== undefined) {
    assertBoundedString(
      input.expectedAudience,
      'Expected Key Binding audience',
      MAX_IDENTIFIER_BYTES
    )
  }
  if (input.expectedNonce !== undefined) {
    assertBoundedString(input.expectedNonce, 'Expected Key Binding nonce', MAX_IDENTIFIER_BYTES)
  }
  if (input.requireKeyBinding !== undefined && typeof input.requireKeyBinding !== 'boolean') {
    throw new TypeError('requireKeyBinding must be a boolean')
  }
  const requireKeyBinding =
    input.requireKeyBinding === true ||
    input.expectedAudience !== undefined ||
    input.expectedNonce !== undefined
  if (
    requireKeyBinding &&
    (input.expectedAudience === undefined || input.expectedNonce === undefined)
  ) {
    throw new TypeError('Key Binding verification requires expectedAudience and expectedNonce')
  }
  const now = input.now ?? Math.floor(Date.now() / 1000)
  assertNumericDate(now, 'Current time')
  const clockToleranceSeconds = input.clockToleranceSeconds ?? 60
  const maxKeyBindingAgeSeconds = input.maxKeyBindingAgeSeconds ?? 300
  assertDuration(clockToleranceSeconds, 'clockToleranceSeconds', 300)
  assertDuration(maxKeyBindingAgeSeconds, 'maxKeyBindingAgeSeconds', 86_400)
  return {
    ...(input.issuerPublicKey !== undefined
      ? { issuerPublicKey: input.issuerPublicKey as PublicKeyInput | JsonObject }
      : {}),
    ...(input.expectedIssuer !== undefined ? { expectedIssuer: input.expectedIssuer } : {}),
    ...(input.expectedVct !== undefined ? { expectedVct: input.expectedVct } : {}),
    ...(input.expectedCredentialAudience !== undefined
      ? { expectedCredentialAudience: input.expectedCredentialAudience }
      : {}),
    ...(input.expectedAudience !== undefined ? { expectedAudience: input.expectedAudience } : {}),
    ...(input.expectedNonce !== undefined ? { expectedNonce: input.expectedNonce } : {}),
    requireKeyBinding,
    now,
    clockToleranceSeconds,
    maxKeyBindingAgeSeconds
  }
}

function snapshotPresentation(presentation: SdJwtPresentation | string): string {
  if (typeof presentation === 'string') return presentation
  const input = getOwnDataProperties(
    presentation,
    'SD-JWT presentation',
    new Set(['sdJwt', 'kbJwt'])
  )
  if (typeof input.sdJwt !== 'string') throw new TypeError('Presentation sdJwt must be a string')
  if (input.kbJwt === undefined) return input.sdJwt
  if (typeof input.kbJwt !== 'string') throw new TypeError('Presentation kbJwt must be a string')
  const parsed = parseSdJwt(input.sdJwt)
  if (parsed.kbJwt != null) throw new Error('Presentation contains duplicate Key Binding JWTs')
  return serializeSdJwt(parsed.issuerSignedJwt, parsed.disclosures, input.kbJwt)
}

function assertIssuerHeader(header: JsonObject): void {
  if (header.typ !== 'dc+sd-jwt' && header.typ !== 'vc+sd-jwt') {
    throw new Error('Invalid SD-JWT VC typ header')
  }
}

function resolveIssuerPublicKey(payload: JsonObject, policy: VerificationPolicy) {
  const issuer = payload.iss
  if (issuer !== undefined) assertBoundedString(issuer, 'Credential issuer', MAX_IDENTIFIER_BYTES)
  if (policy.expectedIssuer !== undefined && issuer !== policy.expectedIssuer) {
    throw new Error('SD-JWT VC issuer mismatch')
  }

  const didKey =
    typeof issuer === 'string' && issuer.startsWith('did:key:')
      ? publicKeyFromDid(issuer)
      : undefined
  const configured =
    policy.issuerPublicKey === undefined
      ? undefined
      : isJwk(policy.issuerPublicKey)
        ? jwkToPublicKey(policy.issuerPublicKey as never)
        : normalizePublicKey(policy.issuerPublicKey as PublicKeyInput)

  if (didKey != null) {
    if (configured != null && configured.toString() !== didKey.toString()) {
      throw new Error('Configured issuer key does not match did:key issuer')
    }
    return didKey
  }
  if (configured != null) return configured
  throw new Error('Issuer public key is required unless iss is did:key')
}

function validateCredentialClaims(payload: JsonObject, policy: VerificationPolicy): void {
  assertBoundedString(payload.vct, 'Credential vct', MAX_IDENTIFIER_BYTES)
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(payload.vct)) {
    throw new Error('Credential vct is not a collision-resistant URI or URN')
  }
  if (policy.expectedVct !== undefined && payload.vct !== policy.expectedVct) {
    throw new Error('SD-JWT VC type mismatch')
  }
  if (hasOwn(payload, 'aud')) {
    if (policy.expectedCredentialAudience === undefined) {
      throw new Error('Credential audience requires expectedCredentialAudience')
    }
    const audiences = snapshotAudiences(payload.aud)
    if (!audiences.includes(policy.expectedCredentialAudience)) {
      throw new Error('SD-JWT VC credential audience mismatch')
    }
  } else if (policy.expectedCredentialAudience !== undefined) {
    throw new Error('SD-JWT VC credential audience is missing')
  }
  for (const [claim, value] of [
    ['iat', payload.iat],
    ['nbf', payload.nbf],
    ['exp', payload.exp]
  ] as const) {
    if (value !== undefined) assertNumericDate(value, `Credential ${claim}`)
  }
  if (typeof payload.iat === 'number' && payload.iat > policy.now + policy.clockToleranceSeconds) {
    throw new Error('SD-JWT VC was issued in the future')
  }
  if (typeof payload.nbf === 'number' && payload.nbf > policy.now + policy.clockToleranceSeconds) {
    throw new Error('SD-JWT VC is not yet valid')
  }
  if (typeof payload.exp === 'number' && payload.exp <= policy.now - policy.clockToleranceSeconds) {
    throw new Error('SD-JWT VC has expired')
  }
  if (
    typeof payload.nbf === 'number' &&
    typeof payload.exp === 'number' &&
    payload.exp <= payload.nbf
  ) {
    throw new Error('SD-JWT VC validity interval is invalid')
  }
  if (hasOwn(payload, 'cnf')) jwkToPublicKey(getHolderJwk(payload.cnf) as never)
}

function snapshotAudiences(value: unknown): string[] {
  if (typeof value === 'string') {
    assertBoundedString(value, 'Credential audience', MAX_IDENTIFIER_BYTES)
    return [value]
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error('Credential audience must be a string or bounded string array')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const out: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Credential audience entries must be own data strings')
    }
    assertBoundedString(descriptor.value, `Credential audience ${index}`, MAX_IDENTIFIER_BYTES)
    if (seen.has(descriptor.value)) throw new Error('Credential audiences must be unique')
    seen.add(descriptor.value)
    out.push(descriptor.value)
  }
  return out
}

function getHolderJwk(cnf: unknown): JsonObject {
  if (!isPlainRecord(cnf)) throw new Error('SD-JWT VC has no cnf.jwk for Key Binding verification')
  const descriptor = Object.getOwnPropertyDescriptor(cnf, 'jwk')
  if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
    throw new Error('SD-JWT VC has no cnf.jwk for Key Binding verification')
  }
  if (!isJwk(descriptor.value)) {
    throw new Error('SD-JWT VC cnf.jwk is invalid')
  }
  return descriptor.value
}

function isJwk(value: unknown): value is JsonObject {
  if (!isPlainRecord(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return (
    descriptors.kty != null &&
    'value' in descriptors.kty &&
    descriptors.kty.value === 'EC' &&
    descriptors.crv != null &&
    'value' in descriptors.crv &&
    descriptors.crv.value === 'secp256k1' &&
    descriptors.x != null &&
    'value' in descriptors.x &&
    typeof descriptors.x.value === 'string' &&
    descriptors.y != null &&
    'value' in descriptors.y &&
    typeof descriptors.y.value === 'string' &&
    !hasOwn(value, 'd')
  )
}
