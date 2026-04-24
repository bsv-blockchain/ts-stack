import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import PublicProfileCapability from '../../capability/publicProfileCapability.js'

interface PublicProfileResponse {
  avatar: string
  name: string
}

interface PublicProfileRouteConfig {
  domainLogicHandler: DomainLogicHandler
  endpoint?: string
}

export default class PublicProfileRoute extends PaymailRoute {
  constructor (config: PublicProfileRouteConfig) {
    super({
      capability: PublicProfileCapability,
      endpoint: config.endpoint || '/public-profile/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected serializeResponse (domainLogicResponse: PublicProfileResponse): string {
    return JSON.stringify({
      avatar: domainLogicResponse.avatar,
      name: domainLogicResponse.name
    })
  }
}
