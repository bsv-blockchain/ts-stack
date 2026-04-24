import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import simpleP2pOrdinalDestinationsCapability from '../../capability/simpleP2pOrdinalDestinationsCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import joi from 'joi'

interface OrdinalP2pDestination {
  script: string
}

interface OrdinalP2pDestinationsResponse {
  outputs: OrdinalP2pDestination[]
  reference: string
}

interface OrdinalP2pPaymentDestinationRouteConfig {
  domainLogicHandler: DomainLogicHandler
}

export default class OrdinalP2pPaymentDestinationRoute extends PaymailRoute {
  constructor (config: OrdinalP2pPaymentDestinationRouteConfig) {
    super({
      capability: simpleP2pOrdinalDestinationsCapability,
      endpoint: '/ordinal-p2p-payment-destination/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected async validateBody (body: any): Promise<void> {
    const schema = joi.object({
      ordinals: joi.number().required()
    })
    const { error } = schema.validate(body)
    if (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
  }

  protected serializeResponse (domainLogicResponse: OrdinalP2pDestinationsResponse): string {
    return JSON.stringify({
      outputs: domainLogicResponse.outputs.map(output => ({
        script: output.script
      })),
      reference: domainLogicResponse.reference
    })
  }
}
