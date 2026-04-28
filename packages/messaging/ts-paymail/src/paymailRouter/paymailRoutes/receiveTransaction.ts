import Joi from 'joi'
import { PublicKey, Transaction, Signature, Utils, Hash, BigNumber, BSM } from '@bsv/sdk'
import PaymailRoute, { DomainLogicHandler } from './paymailRoute.js'
import P2pReceiveTransactionCapability from '../../capability/p2pReceiveTransactionCapability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import PaymailClient from '../../paymailClient/paymailClient.js'
const { sha256 } = Hash

interface ReceiveTransactionResponse {
  txid: string
  note?: string
}

interface ReceiveTransactionRouteConfig {
  domainLogicHandler: DomainLogicHandler
  verifySignature?: boolean
  paymailClient: PaymailClient
  endpoint?: string
}

export default class ReceiveTransactionRoute extends PaymailRoute {
  private readonly verifySignature: boolean
  private readonly paymailClient: PaymailClient

  constructor (config: ReceiveTransactionRouteConfig) {
    super({
      capability: P2pReceiveTransactionCapability,
      endpoint: config.endpoint || '/receive-transaction/:paymail',
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
    await this.validateTransaction(value)
  }

  private buildSchema () {
    const metadataSchema = Joi.object({
      sender: this.verifySignature ? Joi.string().required() : Joi.string().allow('').optional(),
      pubkey: this.verifySignature ? Joi.string().required() : Joi.string().allow('').optional(),
      signature: this.verifySignature ? Joi.string().required() : Joi.string().allow('').optional(),
      note: Joi.string().allow('', null).optional()
    }).options({ stripUnknown: true })
    return Joi.object({
      hex: Joi.string().required(),
      metadata: this.verifySignature ? metadataSchema.required() : metadataSchema,
      reference: Joi.string().required()
    }).options({ stripUnknown: true })
  }

  private async validateTransaction (value: any) {
    const tx = this.validateTransactionFormat(value.hex)
    if (this.verifySignature) {
      await this.validateSignature(tx, value.metadata)
    }
  }

  private validateTransactionFormat (hex: string): Transaction {
    try {
      return Transaction.fromHex(hex)
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
    await this.verifySenderPublicKey(sender, pubkey)
    this.verifyTransactionSignature(tx.id('hex'), signature, pubkey)
  }

  private async verifySenderPublicKey (sender: string, pubkey: string): Promise<void> {
    const { match } = await this.paymailClient.verifyPublicKey(sender, pubkey)
    if (!match) {
      throw new PaymailBadRequestError('Invalid Public Key for sender')
    }
  }

  private verifyTransactionSignature (message: string, signature: string, pubkey: string): void {
    const msg = Utils.toArray(message, 'utf8')
    const sig = Signature.fromCompact(signature, 'base64')
    const recovery = Utils.toArray(signature, 'base64')[0] - 27 - 4
    const msgHash = BSM.magicHash(msg)
    const pkRecovered = sig.RecoverPublicKey(recovery, new BigNumber(msgHash))
    if (pkRecovered.toString() !== pubkey) throw new PaymailBadRequestError('PubKey does not match signature')
    if (!BSM.verify(msg, sig, pkRecovered)) throw new PaymailBadRequestError('Invalid Signature')
  }

  protected serializeResponse (domainLogicResponse: ReceiveTransactionResponse): string {
    return JSON.stringify({
      txid: domainLogicResponse.txid,
      note: domainLogicResponse.note || ''
    })
  }
}
