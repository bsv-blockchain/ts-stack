import Joi from 'joi'
import { Response } from 'express'
import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import TransactionNegotiationCapabilities from '../../capability/transactionNegotiationCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'

interface TransactionNegotiationCapabilitiesRouteConfig {
  endpoint?: string
  domainLogicHandler: DomainLogicHandler
}

export default class TransactionNegotiationCapabilitiesRoute extends PaymailRoute {
  constructor (config: TransactionNegotiationCapabilitiesRouteConfig) {
    super({
      capability: TransactionNegotiationCapabilities,
      endpoint: config.endpoint || '/transaction-negotiation/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected async validateBody (body: any): Promise<void> {
    const feeSchema = Joi.object({
      feeType: Joi.string().valid('standard', 'data').required(),
      satoshis: Joi.number().required(),
      bytes: Joi.number().required()
    })

    const txSchema = Joi.object({
      tx: Joi.string().required(),
      merkle_proofs: Joi.array().items(Joi.object()).optional(),
      miner_responses: Joi.array().items(Joi.object()).optional()
    })

    const spentOutputSchema = Joi.object({
      value: Joi.number().required(),
      locking_script: Joi.string().required()
    })

    const schema = Joi.object({
      thread_id: Joi.string().required(),
      fees: Joi.array().items(feeSchema).optional(),
      expanded_tx: Joi.object({
        tx: Joi.string().required(),
        ancestors: Joi.array().items(txSchema).optional(),
        spent_outputs: Joi.array().items(spentOutputSchema).optional()
      }),
      expiry: Joi.number().required(),
      timestamp: Joi.number().required(),
      reply_to: Joi.object({
        handle: Joi.string().required(),
        peer_channel: Joi.string().uri().optional()
      })
    })

    const { error } = schema.validate(body)
    if (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
  }

  protected serializeResponse (): string {
    return JSON.stringify({})
  }

  protected sendSuccessResponse (res: Response): Response {
    return res.type('application/json').status(202).send()
  }
}
