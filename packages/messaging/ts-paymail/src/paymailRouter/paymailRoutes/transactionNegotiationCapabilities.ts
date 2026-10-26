import Joi from 'joi'
import { Response } from 'express'
import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import TransactionNegotiationCapabilities from '../../capability/transactionNegotiationCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import { parsePaymail } from '../../paymailAddress.js'
import { transactionIdFromHex } from '../../transactionEncoding.js'

const EVEN_HEX = /^(?:[0-9a-fA-F]{2})+$/

function isUnsafePeerChannel(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return true
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (hostname === '') return true
  const localDevelopment = hostname === 'localhost' && url.protocol === 'http:'
  return (
    (!localDevelopment && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname.includes(':') ||
    (!localDevelopment && !hostname.includes('.'))
  )
}

interface TransactionNegotiationCapabilitiesRouteConfig {
  endpoint?: string
  domainLogicHandler: DomainLogicHandler
}

export default class TransactionNegotiationCapabilitiesRoute extends PaymailRoute {
  constructor(config: TransactionNegotiationCapabilitiesRouteConfig) {
    super({
      capability: TransactionNegotiationCapabilities,
      endpoint: config.endpoint || '/transaction-negotiation/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
  }

  protected override async validateBody(body: unknown): Promise<unknown> {
    const feeSchema = Joi.object({
      feeType: Joi.string().valid('standard', 'data').required(),
      satoshis: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required(),
      bytes: Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).required()
    }).options({ stripUnknown: true, convert: false })

    const txSchema = Joi.object({
      tx: Joi.string().pattern(EVEN_HEX).required(),
      merkle_proofs: Joi.array().items(Joi.object()).optional(),
      miner_responses: Joi.array().items(Joi.object()).optional()
    }).options({ stripUnknown: true, convert: false })

    const spentOutputSchema = Joi.object({
      value: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required(),
      locking_script: Joi.string().pattern(EVEN_HEX).required()
    }).options({ stripUnknown: true, convert: false })

    const schema = Joi.object({
      thread_id: Joi.string().required(),
      fees: Joi.array().items(feeSchema).optional(),
      expanded_tx: Joi.object({
        tx: Joi.string().pattern(EVEN_HEX).required(),
        ancestors: Joi.array().items(txSchema).optional(),
        spent_outputs: Joi.array().items(spentOutputSchema).optional()
      })
        .options({ stripUnknown: true, convert: false })
        .required(),
      expiry: Joi.number().integer().min(0).required(),
      timestamp: Joi.number().integer().min(0).required(),
      reply_to: Joi.object({
        handle: Joi.string()
          .max(318)
          .custom((value: string, helpers) =>
            parsePaymail(value) == null ? helpers.error('string.paymail') : value
          )
          .required(),
        peer_channel: Joi.string()
          .custom((value: string, helpers) =>
            isUnsafePeerChannel(value) ? helpers.error('string.uri') : value
          )
          .optional()
      })
        .options({ stripUnknown: true, convert: false })
        .required()
    }).options({ stripUnknown: true, convert: false })

    const { error, value } = schema.validate(body)
    if (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
    const negotiation = value as {
      expanded_tx: { tx: string; ancestors?: Array<{ tx: string }> }
    }
    try {
      transactionIdFromHex(negotiation.expanded_tx.tx)
      for (const ancestor of negotiation.expanded_tx.ancestors ?? []) {
        transactionIdFromHex(ancestor.tx)
      }
    } catch (transactionError) {
      throw new PaymailBadRequestError(
        `Invalid body: ${
          transactionError instanceof Error ? transactionError.message : String(transactionError)
        }`
      )
    }
    return value
  }

  protected override serializeResponse(): string {
    return JSON.stringify({})
  }

  protected override sendSuccessResponse(res: Response): Response {
    return res.type('application/json').status(202).send()
  }
}
