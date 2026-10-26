/* eslint-disable @typescript-eslint/no-extraneous-class */
import type {
  GeneratePresentationOptions,
  SdJwtPresentation,
  SdJwtVc,
  SdJwtVcVerificationOptions
} from '../types.js'
import { defineOwn, getOwnDataProperties, snapshotJsonObject } from '../validation.js'
import { jwkToPublicKey, normalizePrivateKey } from '../utils/crypto.js'
import { decodeJwt } from '../utils/jwt.js'
import { createKeyBindingJwt } from './keyBinding.js'
import { parseSdJwt, serializeSdJwt } from './format.js'
import { applyDisclosures, selectDisclosures } from './disclosures.js'
import { SdJwtVcVerifier } from './verifier.js'

const store: SdJwtVc[] = []
const MAX_STORED_CREDENTIALS = 1_024
const PRESENTATION_OPTION_KEYS = new Set([
  'holderPrivateKey',
  'audience',
  'nonce',
  'issuedAt',
  'verificationOptions'
])
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

export class SdJwtVcHolder {
  static store(sdJwtVc: SdJwtVc): void {
    if (store.length >= MAX_STORED_CREDENTIALS) throw new Error('Credential store limit reached')
    store.push(snapshotCredential(sdJwtVc))
  }

  static getAll(): SdJwtVc[] {
    return store.map(snapshotCredential)
  }

  static clear(): void {
    store.length = 0
  }

  static async generatePresentation(
    sdJwtVc: SdJwtVc | string,
    disclosedClaims: string[],
    options: GeneratePresentationOptions = {}
  ): Promise<SdJwtPresentation> {
    const input = getOwnDataProperties(options, 'Presentation options', PRESENTATION_OPTION_KEYS)
    const serialized = typeof sdJwtVc === 'string' ? sdJwtVc : snapshotCredential(sdJwtVc).sdJwt
    const parsed = parseSdJwt(serialized)
    if (parsed.kbJwt != null)
      throw new Error('A Holder must not accept an SD-JWT+KB as a credential')
    const verificationOptions =
      input.verificationOptions === undefined
        ? ({} as Record<string, unknown>)
        : getOwnDataProperties(
            input.verificationOptions,
            'Holder credential verification options',
            VERIFICATION_OPTION_KEYS
          )
    if (
      verificationOptions.expectedAudience !== undefined ||
      verificationOptions.expectedNonce !== undefined ||
      verificationOptions.requireKeyBinding === true
    ) {
      throw new TypeError('Holder credential verification must not require Key Binding')
    }
    defineOwn(verificationOptions, 'requireKeyBinding', false)
    delete verificationOptions.expectedAudience
    delete verificationOptions.expectedNonce
    const verification = await SdJwtVcVerifier.verify(
      serialized,
      verificationOptions as SdJwtVcVerificationOptions
    )
    if (!verification.verified) {
      throw new Error(`Credential verification failed: ${verification.errors.join('; ')}`)
    }
    const issuerPayload = decodeJwt(parsed.issuerSignedJwt).payload
    const selectedDisclosures = selectDisclosures(
      issuerPayload,
      parsed.disclosures,
      disclosedClaims
    )
    const selectedSdJwt = serializeSdJwt(parsed.issuerSignedJwt, selectedDisclosures)

    if (input.holderPrivateKey === undefined) {
      if (
        input.audience !== undefined ||
        input.nonce !== undefined ||
        input.issuedAt !== undefined
      ) {
        throw new TypeError('Key Binding options require holderPrivateKey')
      }
      return { sdJwt: selectedSdJwt }
    }

    const cnf = verification.payload?.cnf
    if (typeof cnf !== 'object' || cnf === null || Array.isArray(cnf) || !('jwk' in cnf)) {
      throw new Error('Credential has no holder cnf.jwk')
    }
    const credentialHolder = jwkToPublicKey(cnf.jwk as never)
    const signingHolder = normalizePrivateKey(input.holderPrivateKey as never).toPublicKey()
    if (credentialHolder.toString() !== signingHolder.toString()) {
      throw new Error('Holder private key does not match credential cnf.jwk')
    }

    return {
      sdJwt: selectedSdJwt,
      kbJwt: createKeyBindingJwt(selectedSdJwt, input.holderPrivateKey as never, {
        audience: input.audience as string | undefined,
        nonce: input.nonce as string | undefined,
        issuedAt: input.issuedAt as number | undefined
      })
    }
  }
}

function snapshotCredential(value: SdJwtVc): SdJwtVc {
  const input = getOwnDataProperties(
    value,
    'Stored credential',
    new Set(['sdJwt', 'issuerSignedJwt', 'disclosures', 'claims'])
  )
  if (typeof input.sdJwt !== 'string')
    throw new TypeError('Stored credential sdJwt must be a string')
  const parsed = parseSdJwt(input.sdJwt)
  if (parsed.kbJwt != null) throw new Error('A stored credential must not contain Key Binding')
  if (input.issuerSignedJwt !== parsed.issuerSignedJwt) {
    throw new Error('Stored credential issuerSignedJwt does not match sdJwt')
  }
  if (!equalDisclosureArray(input.disclosures, parsed.disclosures)) {
    throw new Error('Stored credential disclosures do not match sdJwt')
  }
  snapshotJsonObject(input.claims, 'Stored credential claims')
  return {
    sdJwt: input.sdJwt,
    issuerSignedJwt: parsed.issuerSignedJwt,
    disclosures: [...parsed.disclosures],
    claims: snapshotJsonObject(
      applyDisclosures(decodeJwt(parsed.issuerSignedJwt).payload, parsed.disclosures).payload,
      'Stored credential claims'
    )
  }
}

function equalDisclosureArray(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return expected.every((item, index) => {
    const descriptor = descriptors[String(index)]
    return (
      descriptor != null &&
      descriptor.enumerable &&
      'value' in descriptor &&
      descriptor.value === item
    )
  })
}
