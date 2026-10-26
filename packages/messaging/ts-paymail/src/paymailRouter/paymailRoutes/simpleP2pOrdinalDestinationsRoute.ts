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

  protected override async validateBody(body: unknown): Promise<unknown> {
    const schema = joi.object({
      ordinals: joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).required()
    })
    const { error, value } = schema.validate(body, { stripUnknown: true, convert: false })
    if (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
    return value
  }

  protected override snapshotValidatedBody(body: unknown): unknown {
    return { ordinals: (body as { ordinals: number }).ordinals }
  }

  protected override serializeResponse(
    domainLogicResponse: OrdinalP2pDestinationsResponse,
    validatedBody?: { ordinals: number }
  ): string {
    const schema = joi
      .object({
        outputs: joi
          .array()
          .items(
            joi.object({
              script: joi
                .string()
                .pattern(/^(?:[0-9a-fA-F]{2})+$/)
                .max(1024 * 1024)
                .required()
            })
          )
          .min(1)
          .required(),
        reference: joi.string().required()
      })
      .options({ stripUnknown: true, convert: false })
    const { error, value } = schema.validate(domainLogicResponse)
    if (error || validatedBody == null) {
      throw new Error(`Invalid ordinal destination response${error ? `: ${error.message}` : ''}`)
    }
    const response = value as OrdinalP2pDestinationsResponse
    if (response.outputs.length !== validatedBody.ordinals) {
      throw new Error('Ordinal destination response does not equal the requested count')
    }
    return JSON.stringify({
      outputs: response.outputs.map(output => ({
        script: output.script
      })),
      reference: response.reference
    })
  }
}
