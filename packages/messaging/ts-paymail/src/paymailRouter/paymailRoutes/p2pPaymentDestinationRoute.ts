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
  constructor(config: P2pPaymentDestinationRouteConfig) {
    super({
      capability: P2pPaymentDestinationCapability,
      endpoint: '/p2p-payment-destination/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected override async validateBody(body: unknown): Promise<unknown> {
    const schema = joi.object({
      satoshis: joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).required()
    })
    const { error, value } = schema.validate(body, { stripUnknown: true, convert: false })
    if (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
    return value
  }

  protected override snapshotValidatedBody(body: unknown): unknown {
    const validated = body as { satoshis: number }
    return { satoshis: validated.satoshis }
  }

  protected override serializeResponse(
    domainLogicResponse: P2pDestinationsResponse,
    validatedBody?: { satoshis: number }
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
                .required(),
              satoshis: joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required()
            })
          )
          .min(1)
          .required(),
        reference: joi.string().required()
      })
      .options({ stripUnknown: true, convert: false })
    const { error, value } = schema.validate(domainLogicResponse)
    if (error || validatedBody == null) {
      throw new Error(`Invalid P2P destination response${error ? `: ${error.message}` : ''}`)
    }
    const response = value as P2pDestinationsResponse
    const total = response.outputs.reduce((sum, output) => sum + output.satoshis, 0)
    if (!Number.isSafeInteger(total) || total !== validatedBody.satoshis) {
      throw new Error('P2P destination response does not equal the requested amount')
    }
    return JSON.stringify({
      outputs: response.outputs.map(output => ({
        script: output.script,
        satoshis: output.satoshis
      })),
      reference: response.reference
    })
  }
}
