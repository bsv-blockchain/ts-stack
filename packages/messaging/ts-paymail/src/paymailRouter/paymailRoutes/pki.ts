import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import PublicKeyInfrastructureCapability from '../../capability/pkiCapability.js'

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
  constructor (config: PublicKeyInfrastructureRouteConfig) {
    super({
      capability: PublicKeyInfrastructureCapability,
      endpoint: config.endpoint || '/id/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected serializeResponse (domainLogicResponse: PkiResponse): string {
    return JSON.stringify({
      bsvalias: '1.0',
      handle: domainLogicResponse.handle,
      pubkey: domainLogicResponse.pubkey
    })
  }
}
