
import { PublicKeyInfrastructureRoute } from '@bsv/paymail'
import { fetchUser } from '../mockUser.js'

const pkiRoute = new PublicKeyInfrastructureRoute({
  domainLogicHandler: async (params) => {
    const { name, domain } = PublicKeyInfrastructureRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    return {
      bsvalias: '1.0',
      handle: `${name}@${domain}`,
      pubkey: user.getIdentityKey()
    }
  }
})

export default pkiRoute
