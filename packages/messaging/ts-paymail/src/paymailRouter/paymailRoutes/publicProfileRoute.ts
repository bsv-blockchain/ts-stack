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
  constructor(config: PublicProfileRouteConfig) {
    super({
      capability: PublicProfileCapability,
      endpoint: config.endpoint || '/public-profile/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected override serializeResponse(domainLogicResponse: PublicProfileResponse): string {
    if (
      typeof domainLogicResponse?.name !== 'string' ||
      domainLogicResponse.name.length === 0 ||
      typeof domainLogicResponse.avatar !== 'string'
    ) {
      throw new Error('Invalid public-profile response from domain handler')
    }
    let avatar: URL
    try {
      avatar = new URL(domainLogicResponse.avatar)
    } catch {
      throw new Error('Invalid public-profile response from domain handler')
    }
    const hostname = avatar.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.+$/, '')
    if (
      avatar.protocol !== 'https:' ||
      avatar.username !== '' ||
      avatar.password !== '' ||
      avatar.hash !== '' ||
      hostname === '' ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      !hostname.includes('.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
      hostname.includes(':')
    ) {
      throw new Error('Invalid public-profile response from domain handler')
    }
    return JSON.stringify({
      avatar: avatar.toString(),
      name: domainLogicResponse.name
    })
  }
}
