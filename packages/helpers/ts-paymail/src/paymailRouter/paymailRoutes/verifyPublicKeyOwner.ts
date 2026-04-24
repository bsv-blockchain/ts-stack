import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import VerifyPublicKeyOwnerCapability from '../../capability/verifyPublicKeyOwnerCapability.js'

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
  constructor (config: VerifyPublicKeyOwnerRouteConfig) {
    super({
      capability: VerifyPublicKeyOwnerCapability,
      endpoint: config.endpoint || '/verifypubkey/:paymail/:pubkey',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected serializeResponse (domainLogicResponse: VerifyPublicKeyOwnerResponse): string {
    return JSON.stringify({
      bsvalias: '1.0',
      handle: domainLogicResponse.handle,
      pubkey: domainLogicResponse.pubkey,
      match: domainLogicResponse.match
    })
  }
}
