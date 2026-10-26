/* eslint-disable @typescript-eslint/no-extraneous-class */
import type { JsonObject, SdJwtVc, SdJwtVcCreateParams } from '../types.js'
import {
  assertBoundedString,
  assertNumericDate,
  defineOwn,
  getOwnDataProperties,
  MAX_IDENTIFIER_BYTES,
  snapshotJsonObject
} from '../validation.js'
import { normalizePrivateKey, normalizePublicKey, publicKeyToJwk } from '../utils/crypto.js'
import { signJwt } from '../utils/jwt.js'
import { publicKeyToDidKey } from '../utils/multibase.js'
import { makeSdPayload } from './disclosures.js'
import { serializeSdJwt } from './format.js'

const CREATE_PARAM_KEYS = new Set([
  'issuer',
  'issuerPrivateKey',
  'issuerPublicKey',
  'holderPublicKey',
  'claims',
  'vct',
  'disclosureFrame',
  'subject',
  'issuedAt',
  'notBefore',
  'expiresAt',
  'status',
  'header'
])

export class SdJwtVcIssuer {
  // Implements draft-ietf-oauth-sd-jwt-vc section 2.2.2 JWT Claims Set and
  // RFC 9901 section 4.1 Issuer-Signed JWT.
  static async create(params: SdJwtVcCreateParams): Promise<SdJwtVc> {
    const input = getOwnDataProperties(params, 'SD-JWT VC creation parameters', CREATE_PARAM_KEYS)
    assertBoundedString(input.issuer, 'Issuer', MAX_IDENTIFIER_BYTES)
    assertBoundedString(input.vct, 'vct', MAX_IDENTIFIER_BYTES)
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input.vct)) {
      throw new TypeError('vct must be a collision-resistant URI or URN')
    }
    const claims = snapshotJsonObject(input.claims, 'Credential claims')
    assertNoRegisteredClaimCollisions(claims)
    const issuerPrivateKey = normalizePrivateKey(input.issuerPrivateKey as never)
    const issuerSigningPublicKey = issuerPrivateKey.toPublicKey()
    if (
      input.issuer.startsWith('did:key:') &&
      publicKeyToDidKey(issuerSigningPublicKey) !== input.issuer
    ) {
      throw new Error('Issuer private key does not match the did:key issuer')
    }
    if (input.issuerPublicKey !== undefined) {
      const declared = normalizePublicKey(input.issuerPublicKey as never)
      if (declared.toString() !== issuerSigningPublicKey.toString()) {
        throw new Error('Issuer private and public keys do not match')
      }
    }
    const holderJwk = publicKeyToJwk(input.holderPublicKey as never)
    const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000)
    assertNumericDate(issuedAt, 'issuedAt')
    if (input.notBefore !== undefined) assertNumericDate(input.notBefore, 'notBefore')
    if (input.expiresAt !== undefined) assertNumericDate(input.expiresAt, 'expiresAt')
    if (
      input.notBefore !== undefined &&
      input.expiresAt !== undefined &&
      input.expiresAt <= input.notBefore
    ) {
      throw new TypeError('expiresAt must be later than notBefore')
    }
    if (input.expiresAt !== undefined && input.expiresAt <= issuedAt) {
      throw new TypeError('expiresAt must be later than issuedAt')
    }
    if (input.subject !== undefined) {
      assertBoundedString(input.subject, 'Subject', MAX_IDENTIFIER_BYTES)
    }
    const status =
      input.status === undefined ? undefined : snapshotJsonObject(input.status, 'Credential status')
    const header =
      input.header === undefined ? {} : snapshotJsonObject(input.header, 'Issuer JOSE header')
    for (const prohibited of ['crit', 'b64', 'jwk', 'jku', 'x5c', 'x5u']) {
      if (prohibited in header) {
        throw new TypeError(`Unsupported or ambiguous JOSE header "${prohibited}"`)
      }
    }

    const payload: JsonObject = {
      iss: input.issuer,
      iat: issuedAt,
      vct: input.vct,
      cnf: { jwk: holderJwk }
    }
    for (const [key, value] of Object.entries(claims)) defineOwn(payload, key, value)
    if (input.subject !== undefined) defineOwn(payload, 'sub', input.subject)
    if (input.notBefore !== undefined) defineOwn(payload, 'nbf', input.notBefore)
    if (input.expiresAt !== undefined) defineOwn(payload, 'exp', input.expiresAt)
    if (status !== undefined) defineOwn(payload, 'status', status)

    const { payload: sdPayload, disclosures } = makeSdPayload(
      payload,
      input.disclosureFrame as never
    )
    const issuerSignedJwt = signJwt({ ...header, typ: 'dc+sd-jwt' }, sdPayload, issuerPrivateKey)
    const disclosureValues = disclosures.map(item => item.disclosure)

    return {
      sdJwt: serializeSdJwt(issuerSignedJwt, disclosureValues),
      issuerSignedJwt,
      disclosures: disclosureValues,
      claims: snapshotJsonObject(payload, 'Issued credential claims')
    }
  }
}

const REGISTERED_SD_JWT_VC_CLAIMS = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'nbf',
  'iat',
  'jti',
  'cnf',
  'vct',
  'vct#integrity',
  'status',
  '_sd',
  '_sd_alg',
  '...'
])

function assertNoRegisteredClaimCollisions(claims: JsonObject): void {
  for (const key of Object.keys(claims)) {
    if (REGISTERED_SD_JWT_VC_CLAIMS.has(key)) {
      throw new Error(`Claim "${key}" is managed by SD-JWT VC metadata`)
    }
  }
}
