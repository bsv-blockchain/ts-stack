import Joi from 'joi'
import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import P2pReceiveTransactionCapability from '../../capability/p2pReceiveTransactionCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import PaymailClient from '../../paymailClient/paymailClient.js'
import { verifyP2PSignature } from '../../p2pSignature.js'
import { transactionIdFromHex } from '../../transactionEncoding.js'

interface ReceiveTransactionResponse {
  txid: string
  note?: string
}

interface ValidatedReceiveTransactionBody {
  hex: string
  metadata?: { sender?: string; pubkey?: string; signature?: string; note?: string | null }
  reference: string
}

const COMPACT_SIGNATURE = /^[A-Za-z0-9+/]{87}=$/
const COMPRESSED_PUBLIC_KEY = /^(?:02|03)[0-9a-fA-F]{64}$/
const EVEN_HEX = /^(?:[0-9a-fA-F]{2})+$/

interface ReceiveTransactionRouteConfig {
  domainLogicHandler: DomainLogicHandler
  verifySignature?: boolean
  paymailClient: PaymailClient
  endpoint?: string
}

export default class ReceiveTransactionRoute extends PaymailRoute {
  private readonly verifySignature: boolean
  private readonly paymailClient: PaymailClient

  constructor(config: ReceiveTransactionRouteConfig) {
    const verifySignature = config.verifySignature
    if (verifySignature !== undefined && typeof verifySignature !== 'boolean') {
      throw new TypeError('verifySignature must be a boolean')
    }
    super({
      capability: P2pReceiveTransactionCapability,
      endpoint: config.endpoint || '/receive-transaction/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
    this.verifySignature = verifySignature ?? false
    this.paymailClient = config.paymailClient
  }

  protected override async validateBody(body: unknown): Promise<unknown> {
    const schema = this.buildSchema()
    const { error, value } = schema.validate(body)
    if (error) {
      throw new PaymailBadRequestError(error.message)
    }
    await this.validateTransaction(value)
    return value
  }

  protected override snapshotValidatedBody(body: unknown): unknown {
    return { hex: (body as ValidatedReceiveTransactionBody).hex }
  }

  private buildSchema() {
    const metadataSchema = Joi.object({
      sender: this.verifySignature
        ? Joi.string().max(318).required()
        : Joi.string().max(318).allow('').optional(),
      pubkey: this.verifySignature
        ? Joi.string().pattern(COMPRESSED_PUBLIC_KEY).required()
        : Joi.string().pattern(COMPRESSED_PUBLIC_KEY).allow('').optional(),
      signature: this.verifySignature
        ? Joi.string().pattern(COMPACT_SIGNATURE).required()
        : Joi.string().pattern(COMPACT_SIGNATURE).allow('').optional(),
      note: Joi.string().allow('', null).optional()
    }).options({ stripUnknown: true, convert: false })
    return Joi.object({
      hex: Joi.string().pattern(EVEN_HEX).required(),
      metadata: this.verifySignature ? metadataSchema.required() : metadataSchema,
      reference: Joi.string().required()
    }).options({ stripUnknown: true, convert: false })
  }

  private async validateTransaction(value: {
    hex: string
    metadata: { sender: string; pubkey: string; signature: string }
  }): Promise<void> {
    const transactionId = this.validateTransactionFormat(value.hex)
    if (this.verifySignature) {
      await this.validateSignature(transactionId, value.metadata)
    }
  }

  private validateTransactionFormat(hex: string): string {
    try {
      return transactionIdFromHex(hex)
    } catch (error) {
      throw new PaymailBadRequestError(
        `Invalid body: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async validateSignature(
    transactionId: string,
    metadata: {
      sender: string
      pubkey: string
      signature: string
    }
  ): Promise<void> {
    const { sender, pubkey, signature } = metadata
    this.verifyTransactionSignature(transactionId, signature, pubkey)
    await this.verifySenderPublicKey(sender, pubkey)
  }

  private async verifySenderPublicKey(sender: string, pubkey: string): Promise<void> {
    const { match } = await this.paymailClient.verifyPublicKey(sender, pubkey)
    if (!match) {
      throw new PaymailBadRequestError('Invalid Public Key for sender')
    }
  }

  private verifyTransactionSignature(message: string, signature: string, pubkey: string): void {
    const verification = verifyP2PSignature(message, signature, pubkey)
    if (!verification.publicKeyMatches) {
      throw new PaymailBadRequestError('PubKey does not match signature')
    }
    if (!verification.signatureValid) {
      throw new PaymailBadRequestError('Invalid Signature')
    }
  }

  protected override serializeResponse(
    domainLogicResponse: ReceiveTransactionResponse,
    validatedBody?: ValidatedReceiveTransactionBody
  ): string {
    if (validatedBody == null) throw new Error('Validated transaction body is required')
    const expectedTransactionId = this.validateTransactionFormat(validatedBody.hex)
    if (
      !/^[0-9a-fA-F]{64}$/.test(domainLogicResponse.txid) ||
      domainLogicResponse.txid.toLowerCase() !== expectedTransactionId
    ) {
      throw new Error('Domain handler acknowledged a different transaction')
    }
    if (domainLogicResponse.note != null && typeof domainLogicResponse.note !== 'string') {
      throw new Error('Domain handler returned an invalid transaction note')
    }
    return JSON.stringify({
      txid: expectedTransactionId,
      note: domainLogicResponse.note || ''
    })
  }

  public override getSenderValidationMode(): 'required' | 'disabled' {
    return this.verifySignature ? 'required' : 'disabled'
  }
}
