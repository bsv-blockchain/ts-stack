import {
  P2PKH,
  PublicKey,
  Script,
  OP,
  Utils,
  PushDrop,
  SecurityLevel,
  Random,
  WalletInterface,
  CreateActionOutput
} from '@bsv/sdk'
import { PeerPayClient } from '@bsv/message-box-client'
import { mergeDefaults } from './defaults'
import {
  WalletDefaults,
  WalletStatus,
  WalletInfo,
  BalanceResult,
  PaymentOptions,
  SendOptions,
  SendResult,
  SendOutputSpec,
  SendOutputDetail,
  TransactionResult,
  PaymentRequest,
  IncomingPayment,
  DirectPaymentResult
} from './types'

export abstract class WalletCore {
  public readonly identityKey: string
  public readonly defaults: WalletDefaults

  constructor(identityKey: string, defaults?: Partial<WalletDefaults>) {
    this.identityKey = identityKey
    this.defaults = mergeDefaults(defaults ?? {})
  }

  abstract getClient(): WalletInterface

  // ============================================================================
  // Wallet Info
  // ============================================================================

  getIdentityKey(): string {
    return this.identityKey
  }

  getAddress(): string {
    return PublicKey.fromString(this.identityKey).toAddress()
  }

  getStatus(): WalletStatus {
    return {
      isConnected: true,
      identityKey: this.identityKey,
      network: this.defaults.network
    }
  }

  getWalletInfo(): WalletInfo {
    return {
      identityKey: this.identityKey,
      address: this.getAddress(),
      network: this.defaults.network,
      isConnected: true
    }
  }

  // ============================================================================
  // Balance
  // ============================================================================

  async getBalance(basket?: string): Promise<BalanceResult> {
    const client = this.getClient()

    if (basket != null) {
      const result = await client.listOutputs({ basket })
      const outputs = result?.outputs ?? []
      const totalSatoshis = outputs.reduce(
        (sum: number, o: any) => sum + ((o.satoshis as number) ?? 0),
        0
      )
      const spendable = outputs.filter((o: any) => o.spendable !== false)
      const spendableSatoshis = spendable.reduce(
        (sum: number, o: any) => sum + ((o.satoshis as number) ?? 0),
        0
      )
      return {
        totalSatoshis,
        totalOutputs: result?.totalOutputs ?? outputs.length,
        spendableSatoshis,
        spendableOutputs: spendable.length
      }
    }

    // Use wallet-toolbox specOpWalletBalance for optimized balance query
    const WALLET_BALANCE_BASKET = '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8'
    const result = await client.listOutputs({ basket: WALLET_BALANCE_BASKET })
    const balance = result?.totalOutputs ?? 0
    return {
      totalSatoshis: balance,
      totalOutputs: 0,
      spendableSatoshis: balance,
      spendableOutputs: 0
    }
  }

  // ============================================================================
  // Key Derivation
  // ============================================================================

  async derivePublicKey(
    protocolID: [SecurityLevel, string],
    keyID: string,
    counterparty?: string,
    forSelf?: boolean
  ): Promise<string> {
    const result = await this.getClient().getPublicKey({
      protocolID,
      keyID,
      counterparty: counterparty ?? 'anyone',
      forSelf: forSelf ?? false
    })
    return result.publicKey
  }

  async derivePaymentKey(counterparty: string, invoiceNumber?: string): Promise<string> {
    const protocolID: [SecurityLevel, string] = [2 as SecurityLevel, '3241645161d8']
    const keyID = invoiceNumber ?? Utils.toBase64(Random(8))
    const result = await this.getClient().getPublicKey({
      protocolID,
      keyID,
      counterparty,
      forSelf: false
    })
    return result.publicKey
  }

  // ============================================================================
  // Multi-Output Send (core primitive)
  // ============================================================================

  private convertDataElement(element: string | object | number[]): number[] {
    if (Array.isArray(element)) return element
    if (typeof element === 'object' && element !== null) {
      return Array.from(Utils.toArray(JSON.stringify(element), 'utf8'))
    }
    return Array.from(Utils.toArray(String(element), 'utf8'))
  }

  private buildDataOnlyOutput(
    spec: SendOutputSpec,
    index: number,
    description: string
  ): { actionOutput: CreateActionOutput; detail: SendOutputDetail } {
    const script = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN)
    for (const element of spec.data ?? []) {
      script.writeBin(this.convertDataElement(element))
    }
    return {
      actionOutput: {
        lockingScript: script.toHex(),
        satoshis: 0,
        outputDescription: description,
        ...(spec.basket == null ? {} : { basket: spec.basket })
      },
      detail: { index, type: 'op_return', satoshis: 0, description }
    }
  }

  private async buildSendOutput(
    client: WalletInterface,
    spec: SendOutputSpec,
    index: number
  ): Promise<{ actionOutput: CreateActionOutput; detail: SendOutputDetail }> {
    const description = spec.description ?? this.defaults.outputDescription

    if (spec.data != null && spec.to == null) {
      return this.buildDataOnlyOutput(spec, index, description)
    }

    if (spec.to != null && spec.data != null) {
      const satoshis = spec.satoshis ?? 1
      if (satoshis < 1) throw new Error(`PushDrop output #${index} needs satoshis >= 1`)
      const protocolID = (spec.protocolID ?? this.defaults.tokenProtocolID) as [
        SecurityLevel,
        string
      ]
      const keyID = spec.keyID ?? Utils.toBase64(Random(8))
      const basket = spec.basket ?? this.defaults.tokenBasket
      const fields = spec.data.map(element => this.convertDataElement(element))
      const lockingScript = await new PushDrop(client).lock(
        fields,
        protocolID,
        keyID,
        'self',
        true,
        false
      )

      return {
        actionOutput: {
          lockingScript: lockingScript.toHex(),
          satoshis,
          outputDescription: description,
          basket,
          customInstructions: JSON.stringify({ protocolID, keyID, counterparty: 'self' }),
          tags: ['token']
        },
        detail: { index, type: 'pushdrop', satoshis, description }
      }
    }

    if (spec.to != null && spec.data == null) {
      const satoshis = spec.satoshis ?? 0
      if (satoshis <= 0) throw new Error(`P2PKH output #${index} needs satoshis > 0`)
      const lockingScript = new P2PKH().lock(PublicKey.fromString(spec.to).toAddress()).toHex()

      return {
        actionOutput: {
          lockingScript,
          satoshis,
          outputDescription: description,
          ...(spec.basket == null ? {} : { basket: spec.basket })
        },
        detail: { index, type: 'p2pkh', satoshis, description }
      }
    }

    throw new Error(
      `Output #${index}: must have 'to' (P2PKH), 'data' (OP_RETURN), or both (PushDrop)`
    )
  }

  async send(options: SendOptions): Promise<SendResult> {
    try {
      if (options.outputs == null || options.outputs.length === 0) {
        throw new Error('At least one output is required')
      }

      const client = this.getClient()
      const actionOutputs: any[] = []
      const outputDetails: SendOutputDetail[] = []

      for (let i = 0; i < options.outputs.length; i++) {
        const { actionOutput, detail } = await this.buildSendOutput(client, options.outputs[i], i)
        actionOutputs.push(actionOutput)
        outputDetails.push(detail)
      }

      const result = await client.createAction({
        description: options.description ?? this.defaults.description,
        outputs: actionOutputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })

      return {
        txid: result.txid ?? '',
        tx: result.tx,
        outputDetails
      }
    } catch (error) {
      throw new Error(`Send failed: ${(error as Error).message}`)
    }
  }

  // ============================================================================
  // Pay (convenience wrapper around send)
  // ============================================================================

  async pay(options: PaymentOptions): Promise<TransactionResult> {
    try {
      const peerPay = new PeerPayClient({
        walletClient: this.getClient() as any,
        messageBoxHost: this.defaults.messageBoxHost,
        enableLogging: false
      })

      const result = await peerPay.sendPayment({
        recipient: options.to,
        amount: options.satoshis
      })

      return {
        txid: result?.txid ?? '',
        tx: result?.tx
      }
    } catch (error) {
      throw new Error(`Payment failed: ${(error as Error).message}`)
    }
  }

  // ============================================================================
  // Direct Payment (BRC-29 wallet payment internalization)
  // ============================================================================

  /**
   * Generate a payment request containing BRC-29 derivation data.
   * Share this with the sender so they can create a payment via `sendDirectPayment()`.
   */
  createPaymentRequest(options: { satoshis: number; memo?: string }): PaymentRequest {
    const derivationPrefix = Utils.toBase64(Utils.toArray('payment', 'utf8'))
    const derivationSuffix = Utils.toBase64(Random(8))
    return {
      serverIdentityKey: this.identityKey,
      derivationPrefix,
      derivationSuffix,
      satoshis: options.satoshis,
      memo: options.memo
    }
  }

  /**
   * Create a BRC-29 derived P2PKH transaction for the recipient described in the request.
   * Returns the transaction plus remittance data the recipient needs to call `receiveDirectPayment()`.
   */
  async sendDirectPayment(request: PaymentRequest): Promise<DirectPaymentResult> {
    try {
      const client = this.getClient()
      const protocolID: [SecurityLevel, string] = [2 as SecurityLevel, '3241645161d8']
      const keyID = `${request.derivationPrefix} ${request.derivationSuffix}`

      const { publicKey: derivedKey } = await client.getPublicKey({
        protocolID,
        keyID,
        counterparty: request.serverIdentityKey,
        forSelf: false
      })

      const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKey).toAddress()).toHex()

      const outputs: any[] = [
        {
          lockingScript,
          satoshis: request.satoshis,
          outputDescription: `Direct payment: ${request.satoshis} sats`,
          customInstructions: JSON.stringify({
            derivationPrefix: request.derivationPrefix,
            derivationSuffix: request.derivationSuffix,
            payee: request.serverIdentityKey
          })
        }
      ]

      if (request.memo != null && request.memo !== '') {
        const memoScript = new Script()
          .writeOpCode(OP.OP_FALSE)
          .writeOpCode(OP.OP_RETURN)
          .writeBin(Array.from(Utils.toArray(request.memo, 'utf8')))
        outputs.push({
          lockingScript: memoScript.toHex(),
          satoshis: 0,
          outputDescription: 'Payment memo'
        })
      }

      const result = await client.createAction({
        description: request.memo ?? `Direct payment (${request.satoshis} sats)`,
        outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })

      return {
        txid: result.txid ?? '',
        tx: result.tx,
        senderIdentityKey: this.identityKey,
        derivationPrefix: request.derivationPrefix,
        derivationSuffix: request.derivationSuffix,
        outputIndex: 0
      }
    } catch (error) {
      throw new Error(`Direct payment failed: ${(error as Error).message}`)
    }
  }

  /**
   * Internalize a received payment directly into the wallet's spendable balance
   * using the `wallet payment` protocol. This does NOT put the output into a basket —
   * it becomes a regular spendable UTXO managed by the wallet.
   */
  async receiveDirectPayment(payment: IncomingPayment): Promise<void> {
    try {
      const client = this.getClient()
      const tx = payment.tx instanceof Uint8Array ? Array.from(payment.tx) : payment.tx

      await (client as any).internalizeAction({
        tx,
        outputs: [
          {
            outputIndex: payment.outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              senderIdentityKey: payment.senderIdentityKey,
              derivationPrefix: payment.derivationPrefix,
              derivationSuffix: payment.derivationSuffix
            }
          }
        ],
        description:
          payment.description ?? `Payment from ${payment.senderIdentityKey.substring(0, 20)}...`,
        labels: ['direct_payment']
      })
    } catch (error) {
      throw new Error(`Failed to receive direct payment: ${(error as Error).message}`)
    }
  }

  // ============================================================================
  // Fund Server Wallet
  // ============================================================================

  async fundServerWallet(request: PaymentRequest, basket?: string): Promise<TransactionResult> {
    try {
      const client = this.getClient()
      const protocolID: [SecurityLevel, string] = [2 as SecurityLevel, '3241645161d8']
      const keyID = `${request.derivationPrefix} ${request.derivationSuffix}`

      const { publicKey: derivedKey } = await client.getPublicKey({
        protocolID,
        keyID,
        counterparty: request.serverIdentityKey,
        forSelf: false
      })

      const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKey).toAddress()).toHex()

      const outputs: any[] = [
        {
          lockingScript,
          satoshis: request.satoshis,
          outputDescription: `Server wallet funding: ${request.satoshis} sats`,
          ...(basket == null ? {} : { basket })
        }
      ]

      if (request.memo != null && request.memo !== '') {
        const memoScript = new Script()
          .writeOpCode(OP.OP_FALSE)
          .writeOpCode(OP.OP_RETURN)
          .writeBin(Array.from(Utils.toArray(request.memo, 'utf8')))
        outputs.push({
          lockingScript: memoScript.toHex(),
          satoshis: 0,
          outputDescription: 'Funding memo'
        })
      }

      const result = await client.createAction({
        description: request.memo ?? `Fund server wallet (${request.satoshis} sats)`,
        outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })

      return {
        txid: result.txid ?? '',
        tx: result.tx,
        outputs: outputs.map((out, index) => ({
          index,
          satoshis: out.satoshis,
          lockingScript: out.lockingScript
        }))
      }
    } catch (error) {
      throw new Error(`Server wallet funding failed: ${(error as Error).message}`)
    }
  }
}
