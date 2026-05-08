/* eslint-disable @typescript-eslint/no-extraneous-class */
import type { SdJwtPresentation } from '../types.js'
import { parseSdJwt, serializeSdJwt } from './format.js'

export class SdJwtVcPresenter {
  static present (presentation: SdJwtPresentation): string {
    if (presentation.kbJwt == null) return presentation.sdJwt
    const parsed = parseSdJwt(presentation.sdJwt)
    return serializeSdJwt(parsed.issuerSignedJwt, parsed.disclosures, presentation.kbJwt)
  }
}
