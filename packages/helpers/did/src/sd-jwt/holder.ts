/* eslint-disable @typescript-eslint/no-extraneous-class */
import type { GeneratePresentationOptions, SdJwtPresentation, SdJwtVc } from '../types.js'
import { decodeJwt } from '../utils/jwt.js'
import { createKeyBindingJwt } from './keyBinding.js'
import { parseSdJwt, serializeSdJwt } from './format.js'
import { selectDisclosures } from './disclosures.js'

const store: SdJwtVc[] = []

export class SdJwtVcHolder {
  static store (sdJwtVc: SdJwtVc): void {
    store.push(sdJwtVc)
  }

  static getAll (): SdJwtVc[] {
    return [...store]
  }

  static clear (): void {
    store.length = 0
  }

  static async generatePresentation (
    sdJwtVc: SdJwtVc | string,
    disclosedClaims: string[],
    options: GeneratePresentationOptions = {}
  ): Promise<SdJwtPresentation> {
    const parsed = parseSdJwt(typeof sdJwtVc === 'string' ? sdJwtVc : sdJwtVc.sdJwt)
    const issuerPayload = decodeJwt(parsed.issuerSignedJwt).payload
    const selectedDisclosures = selectDisclosures(issuerPayload, parsed.disclosures, disclosedClaims)
    const selectedSdJwt = serializeSdJwt(parsed.issuerSignedJwt, selectedDisclosures)

    if (options.holderPrivateKey == null) {
      return { sdJwt: selectedSdJwt }
    }

    return {
      sdJwt: selectedSdJwt,
      kbJwt: createKeyBindingJwt(selectedSdJwt, options.holderPrivateKey, {
        audience: options.audience,
        nonce: options.nonce,
        issuedAt: options.issuedAt
      })
    }
  }
}
