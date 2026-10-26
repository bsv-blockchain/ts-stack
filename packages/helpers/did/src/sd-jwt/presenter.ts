/* eslint-disable @typescript-eslint/no-extraneous-class */
import type { SdJwtPresentation } from '../types.js'
import { getOwnDataProperties } from '../validation.js'
import { parseSdJwt, serializeSdJwt } from './format.js'

export class SdJwtVcPresenter {
  static present(presentation: SdJwtPresentation): string {
    const input = getOwnDataProperties(
      presentation,
      'SD-JWT presentation',
      new Set(['sdJwt', 'kbJwt'])
    )
    if (typeof input.sdJwt !== 'string') throw new TypeError('Presentation sdJwt must be a string')
    const parsed = parseSdJwt(input.sdJwt)
    if (input.kbJwt === undefined) return input.sdJwt
    if (typeof input.kbJwt !== 'string') throw new TypeError('Presentation kbJwt must be a string')
    if (parsed.kbJwt != null) throw new Error('Presentation contains duplicate Key Binding JWTs')
    return serializeSdJwt(parsed.issuerSignedJwt, parsed.disclosures, input.kbJwt)
  }
}
