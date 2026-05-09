/* eslint-disable @typescript-eslint/no-extraneous-class */
import type { JsonObject, SdJwtVc, SdJwtVcCreateParams } from '../types.js'
import { publicKeyToJwk } from '../utils/crypto.js'
import { signJwt } from '../utils/jwt.js'
import { makeSdPayload } from './disclosures.js'
import { serializeSdJwt } from './format.js'

export class SdJwtVcIssuer {
  // Implements draft-ietf-oauth-sd-jwt-vc section 2.2.2 JWT Claims Set and
  // RFC 9901 section 4.1 Issuer-Signed JWT.
  static async create (params: SdJwtVcCreateParams): Promise<SdJwtVc> {
    assertNoRegisteredClaimCollisions(params.claims)
    const now = params.issuedAt ?? Math.floor(Date.now() / 1000)
    const payload: JsonObject = {
      iss: params.issuer,
      iat: now,
      vct: params.vct,
      cnf: {
        jwk: publicKeyToJwk(params.holderPublicKey)
      },
      ...params.claims,
      ...(params.subject != null ? { sub: params.subject } : {}),
      ...(params.notBefore != null ? { nbf: params.notBefore } : {}),
      ...(params.expiresAt != null ? { exp: params.expiresAt } : {}),
      ...(params.status != null ? { status: params.status } : {})
    }
    const { payload: sdPayload, disclosures } = makeSdPayload(payload, params.disclosureFrame)
    const header = {
      ...params.header,
      typ: 'dc+sd-jwt'
    }
    const issuerSignedJwt = signJwt(header, sdPayload, params.issuerPrivateKey)
    const disclosureValues = disclosures.map(item => item.disclosure)

    return {
      sdJwt: serializeSdJwt(issuerSignedJwt, disclosureValues),
      issuerSignedJwt,
      disclosures: disclosureValues,
      claims: payload
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

function assertNoRegisteredClaimCollisions (claims: JsonObject): void {
  for (const key of Object.keys(claims)) {
    if (REGISTERED_SD_JWT_VC_CLAIMS.has(key)) {
      throw new Error(`Claim "${key}" is managed by SD-JWT VC metadata`)
    }
  }
}
