import { Transaction, Signature, PublicKey } from '@bsv/sdk'
import Joi from 'joi'
import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import P2pReceiveBeefTransactionCapability from '../../capability/p2pReceiveBeefTransactionCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import PaymailClient from '../../paymailClient/paymailClient.js'

interface ReceiveTransactionResponse {
  txid: string
  note?: string
}

interface ReceiveBeefTransactionRouteConfig {
  domainLogicHandler: DomainLogicHandler
  verifySignature?: boolean
  paymailClient: PaymailClient
}

export default class ReceiveBeefTransactionRoute extends PaymailRoute {
  private readonly verifySignature: boolean
  private readonly paymailClient: PaymailClient

  constructor (config: ReceiveBeefTransactionRouteConfig) {
    super({
      capability: P2pReceiveBeefTransactionCapability,
      endpoint: '/receive-beef-transaction/:paymail',
      domainLogicHandler: config.domainLogicHandler
    })
    this.verifySignature = config.verifySignature ?? false
    this.paymailClient = config.paymailClient
  }

  protected async validateBody (body: any): Promise<void> {
    const schema = this.buildSchema()
    const { error, value } = schema.validate(body)
    if (error) {
      throw new PaymailBadRequestError(error.message)
    }
    await this.validateBeefTransaction(value)
  }

  private buildSchema () {
    const metadataSchema = Joi.object({
      sender: Joi.string().required(),
      pubkey: Joi.string().required(),
      signature: Joi.string().required(),
      note: Joi.string().allow('', null).optional()
    })

    return Joi.object({
      beef: Joi.string().required(),
      metadata: this.verifySignature ? metadataSchema.required() : Joi.object().optional(),
      reference: Joi.string().required()
    })
  }

  private async validateBeefTransaction (value: any): Promise<void> {
    const tx = this.validateTransactionFormat(value.beef)
    if (this.verifySignature) {
      await this.validateSignature(tx, value.metadata)
    }
  }

  private validateTransactionFormat (beef: string): Transaction {
    try {
      return Transaction.fromHexBEEF(beef)
    } catch (error) {
      throw new PaymailBadRequestError('Invalid body: ' + error.message)
    }
  }

  private async validateSignature (tx: Transaction, metadata: {
    sender: string
    pubkey: string
    signature: string
  }): Promise<void> {
    const { sender, pubkey, signature } = metadata
    const match = await this.verifySenderPublicKey(sender, pubkey)
    if (!match) {
      throw new PaymailBadRequestError('Invalid Public Key for sender')
    }
    this.verifyTransactionSignature(tx.id('hex'), signature, pubkey)
  }

  private async verifySenderPublicKey (sender: string, pubkey: string): Promise<boolean> {
    const { match } = await this.paymailClient.verifyPublicKey(sender, pubkey)
    return match
  }

  private verifyTransactionSignature (message: string, signature: string, pubkey: string): void {
    const sig = Signature.fromDER(signature, 'hex')
    if (!sig.verify(message, PublicKey.fromString(pubkey))) {
      throw new PaymailBadRequestError('Invalid Signature')
    }
  }

  protected serializeResponse (domainLogicResponse: ReceiveTransactionResponse): string {
    return JSON.stringify({
      txid: domainLogicResponse.txid,
      note: domainLogicResponse.note || ''
    })
  }
}
