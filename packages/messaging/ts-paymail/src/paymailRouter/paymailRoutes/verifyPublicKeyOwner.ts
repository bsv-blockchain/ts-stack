import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import VerifyPublicKeyOwnerCapability from '../../capability/verifyPublicKeyOwnerCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import type { PaymailRouteParams } from './paymailRoute.js'
import { isCanonicalCompressedPublicKey } from '../../p2pSignature.js'

interface VerifyPublicKeyOwnerResponse {
  handle: string
  pubkey: string
  match: boolean
}

interface VerifyPublicKeyOwnerRouteConfig {
  domainLogicHandler: DomainLogicHandler
  endpoint?: string
}

export default class VerifyPublicKeyOwnerRoute extends PaymailRoute {
  constructor(config: VerifyPublicKeyOwnerRouteConfig) {
    super({
      capability: VerifyPublicKeyOwnerCapability,
      endpoint: config.endpoint || '/verifypubkey/:paymail/:pubkey',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected override validateParams(params: PaymailRouteParams): PaymailRouteParams {
    if (!isCanonicalCompressedPublicKey(params.pubkey ?? '')) {
      throw new PaymailBadRequestError('Invalid compressed public key.')
    }
    return params
  }

  protected override serializeResponse(
    domainLogicResponse: VerifyPublicKeyOwnerResponse,
    _validatedBody?: unknown,
    validatedParams?: PaymailRouteParams
  ): string {
    if (
      validatedParams == null ||
      typeof domainLogicResponse.match !== 'boolean' ||
      typeof domainLogicResponse.handle !== 'string' ||
      typeof domainLogicResponse.pubkey !== 'string' ||
      !isCanonicalCompressedPublicKey(domainLogicResponse.pubkey) ||
      domainLogicResponse.handle.toLowerCase() !== validatedParams.paymail.toLowerCase() ||
      domainLogicResponse.pubkey.toLowerCase() !== validatedParams.pubkey.toLowerCase()
    ) {
      throw new Error('Invalid public-key ownership response from domain handler')
    }
    return JSON.stringify({
      bsvalias: '1.0',
      handle: domainLogicResponse.handle,
      pubkey: domainLogicResponse.pubkey,
      match: domainLogicResponse.match
    })
  }
}
