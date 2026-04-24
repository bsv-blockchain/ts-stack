import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import P2pPaymentDestinationCapability from '../../capability/p2pPaymentDestinationCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import joi from 'joi'

interface P2pDestination {
  script: string
  satoshis: number
}

interface P2pDestinationsResponse {
  outputs: P2pDestination[]
  reference: string
}

interface P2pPaymentDestinationRouteConfig {
  domainLogicHandler: DomainLogicHandler
}

export default class P2pPaymentDestinationRoute extends PaymailRoute {
  constructor (config: P2pPaymentDestinationRouteConfig) {
    super({
      capability: P2pPaymentDestinationCapability,
      endpoint: '/p2p-payment-destination/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected async validateBody (body: any): Promise<void> {
    const schema = joi.object({
      satoshis: joi.number().required()
    })
    const { error } = schema.validate(body)
    if (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
  }

  protected serializeResponse (domainLogicResponse: P2pDestinationsResponse): string {
    return JSON.stringify({
      outputs: domainLogicResponse.outputs.map(output => ({
        script: output.script,
        satoshis: output.satoshis
      })),
      reference: domainLogicResponse.reference
    })
  }
}
