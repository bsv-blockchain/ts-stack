
import { P2pPaymentDestinationRoute } from '@bsv/paymail'
import { fetchUser } from '../mockUser.js'

const p2pDestinationsRoute = new P2pPaymentDestinationRoute({
  domainLogicHandler: async (params, body) => {
    const { name, domain } = P2pPaymentDestinationRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    const { destinationScript, reference } = user.getPaymailDestination()
    return {
      outputs: [
        {
          script: destinationScript,
          satoshis: body.satoshis
        }
      ],
      reference
    }
  }
})

export default p2pDestinationsRoute
