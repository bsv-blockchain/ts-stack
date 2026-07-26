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
  constructor(config: OrdinalP2pPaymentDestinationRouteConfig) {
    super({
      capability: simpleP2pOrdinalDestinationsCapability,
      endpoint: '/ordinal-p2p-payment-destination/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected async validateBody(body: unknown): Promise<unknown> {
    const schema = joi.object({
      ordinals: joi.number().integer().min(1).required()
    })
    const { error, value } = schema.validate(body, { stripUnknown: true })
    if (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
    return value
  }

  protected serializeResponse(domainLogicResponse: OrdinalP2pDestinationsResponse): string {
    return JSON.stringify({
      outputs: domainLogicResponse.outputs.map(output => ({
        script: output.script
      })),
      reference: domainLogicResponse.reference
    })
  }
}
