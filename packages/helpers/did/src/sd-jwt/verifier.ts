/* eslint-disable @typescript-eslint/no-extraneous-class */
import type { Jwk, JsonObject, SdJwtPresentation, SdJwtVcVerificationOptions, SdJwtVcVerificationResult } from '../types.js'
import { publicKeyFromDid } from '../utils/multibase.js'
import { publicKeyToJwk } from '../utils/crypto.js'
import { decodeJwt, verifyJwt } from '../utils/jwt.js'
import { applyDisclosures } from './disclosures.js'
import { parseSdJwt, serializeSdJwt } from './format.js'
import { verifyKeyBindingJwt } from './keyBinding.js'

export class SdJwtVcVerifier {
  // Implements RFC 9901 section 7.3 Verification by the Verifier and
  // draft-ietf-oauth-sd-jwt-vc section 2.2.2 registered SD-JWT VC claims.
  static async verify (
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
      let serialized: string
      if (typeof presentation === 'string') {
        serialized = presentation
      } else if (presentation.kbJwt == null) {
        serialized = presentation.sdJwt
      } else {
        serialized = SdJwtVcPresenterString(presentation)
      }
      const parsed = parseSdJwt(serialized)
      disclosures = parsed.disclosures
      const decoded = decodeJwt(parsed.issuerSignedJwt)
      const issuerPublicKey = resolveIssuerPublicKey(decoded.payload, decoded.header, options)
      verifyJwt(parsed.issuerSignedJwt, issuerPublicKey)
      issuerSignedJwtVerified = true

      const applied = applyDisclosures(decoded.payload, disclosures)
      payload = applied.payload
      disclosedClaims = applied.disclosedClaims

      const cnf = payload.cnf
      const holderJwk = isCnfJwk(cnf) ? cnf.jwk : null
      const kbJwt = parsed.kbJwt

      if (kbJwt != null) {
        if (holderJwk == null) throw new Error('SD-JWT VC has no cnf.jwk for Key Binding verification')
        verifyKeyBindingJwt(serializeSdJwt(parsed.issuerSignedJwt, disclosures), kbJwt, holderJwk, {
          audience: options.expectedAudience,
          nonce: options.expectedNonce
        })
        keyBindingVerified = true
      } else if (options.requireKeyBinding === true) {
        throw new Error('Key Binding JWT is required')
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
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

function resolveIssuerPublicKey (
  payload: JsonObject,
  header: JsonObject,
  options: SdJwtVcVerificationOptions
): Jwk {
  if (options.issuerPublicKey != null) {
    return isJwk(options.issuerPublicKey)
      ? options.issuerPublicKey
      : publicKeyToJwk(options.issuerPublicKey)
  }
  if (isJwk(header.jwk)) return header.jwk
  if (typeof payload.iss === 'string' && payload.iss.startsWith('did:key:')) {
    return publicKeyToJwk(publicKeyFromDid(payload.iss))
  }
  throw new Error('Issuer public key is required unless iss is did:key or header.jwk is present')
}

function isJwk (value: unknown): value is Jwk {
  return typeof value === 'object' && value != null && (value as Jwk).kty === 'EC'
}

function isCnfJwk (value: unknown): value is { jwk: Jwk } {
  return typeof value === 'object' && value != null && isJwk((value as { jwk?: unknown }).jwk)
}

function SdJwtVcPresenterString (presentation: SdJwtPresentation): string {
  const parsed = parseSdJwt(presentation.sdJwt)
  return serializeSdJwt(parsed.issuerSignedJwt, parsed.disclosures, presentation.kbJwt)
}
