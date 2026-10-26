import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import PublicKeyInfrastructureCapability from '../../capability/pkiCapability.js'
import type { PaymailRouteParams } from './paymailRoute.js'
import { isCanonicalCompressedPublicKey } from '../../p2pSignature.js'

interface PkiResponse {
  bsvalias: '1.0'
  handle: string
  pubkey: string
}

interface PublicKeyInfrastructureRouteConfig {
  domainLogicHandler: DomainLogicHandler
  endpoint?: string
}

export default class PublicKeyInfrastructureRoute extends PaymailRoute {
  constructor(config: PublicKeyInfrastructureRouteConfig) {
    super({
      capability: PublicKeyInfrastructureCapability,
      endpoint: config.endpoint || '/id/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected override serializeResponse(
    domainLogicResponse: PkiResponse,
    _validatedBody?: unknown,
    validatedParams?: PaymailRouteParams
  ): string {
    if (
      validatedParams == null ||
      typeof domainLogicResponse?.handle !== 'string' ||
      domainLogicResponse.handle.toLowerCase() !== validatedParams.paymail.toLowerCase() ||
      typeof domainLogicResponse.pubkey !== 'string' ||
      !isCanonicalCompressedPublicKey(domainLogicResponse.pubkey)
    ) {
      throw new Error('Invalid PKI response from domain handler')
    }
    return JSON.stringify({
      bsvalias: '1.0',
      handle: domainLogicResponse.handle,
      pubkey: domainLogicResponse.pubkey
    })
  }
}
