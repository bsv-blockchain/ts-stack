import {
  P2PKH,
  PublicKey,
  Script,
  OP,
  Utils,
  PushDrop,
  SecurityLevel,
  Random,
  WalletInterface
} from '@bsv/sdk'
import { PeerPayClient } from '@bsv/message-box-client'
import { mergeDefaults } from './defaults'
import {
  WalletDefaults,
  WalletStatus,
  WalletInfo,
  PaymentOptions,
  SendOptions,
  SendResult,
  SendOutputDetail,
  TransactionResult,
  PaymentRequest,
  IncomingPayment,
  DirectPaymentResult
} from './types'

export abstract class WalletCore {
  public readonly identityKey: string
  public readonly defaults: WalletDefaults

  constructor (identityKey: string, defaults?: Partial<WalletDefaults>) {
    this.identityKey = identityKey
    this.defaults = mergeDefaults(defaults ?? {})
  }

  abstract getClient (): WalletInterface

  // ============================================================================
  // Wallet Info
  // ============================================================================

  getIdentityKey (): string {
    return this.identityKey
  }

  getAddress (): string {
    return PublicKey.fromString(this.identityKey).toAddress()
  }

  getStatus (): WalletStatus {
    return {
      isConnected: true,
      identityKey: this.identityKey,
      network: this.defaults.network
    }
  }

  getWalletInfo (): WalletInfo {
    return {
      identityKey: this.identityKey,
      address: this.getAddress(),
      network: this.defaults.network,
      isConnected: true
    }
  }

  // ============================================================================
  // Key Derivation
  // ============================================================================

  async derivePublicKey (
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

  async derivePaymentKey (counterparty: string, invoiceNumber?: string): Promise<string> {
    const protocolID: [SecurityLevel, string] = [2 as SecurityLevel, '3241645161d8']
    const keyID = invoiceNumber ?? Math.random().toString(36).substring(2)
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

  private convertDataElement (element: string | object | number[]): number[] {
    if (Array.isArray(element)) return element
    if (typeof element === 'object' && element !== null) { return Array.from(Utils.toArray(JSON.stringify(element), 'utf8')) }
    return Array.from(Utils.toArray(String(element), 'utf8'))
  }

  async send (options: SendOptions): Promise<SendResult> {
    try {
      if (options.outputs == null || options.outputs.length === 0) {
        throw new Error('At least one output is required')
      }

      const client = this.getClient()
      const actionOutputs: any[] = []
      const outputDetails: SendOutputDetail[] = []

      for (let i = 0; i < options.outputs.length; i++) {
        const spec = options.outputs[i]
        const desc = spec.description ?? this.defaults.outputDescription

        if ((spec.data != null) && (spec.to == null)) {
          // OP_RETURN: data fields, no recipient
          const script = new Script()
            .writeOpCode(OP.OP_FALSE)
            .writeOpCode(OP.OP_RETURN)
          for (const element of spec.data) {
            script.writeBin(this.convertDataElement(element))
          }
          actionOutputs.push({
            lockingScript: script.toHex(),
            satoshis: 0,
            outputDescription: desc,
            ...(spec.basket != null ? { basket: spec.basket } : {})
          })
          outputDetails.push({ index: i, type: 'op_return', satoshis: 0, description: desc })
        } else if ((spec.to != null) && (spec.data != null)) {
          // PushDrop: data fields locked to recipient
          const sats = spec.satoshis ?? 1
          if (sats < 1) throw new Error(`PushDrop output #${i} needs satoshis >= 1`)
          const protocolID = (spec.protocolID ?? this.defaults.tokenProtocolID) as [SecurityLevel, string]
          const keyID = spec.keyID ?? Utils.toBase64(Random(8))
          const basket = spec.basket ?? this.defaults.tokenBasket

          const fields = spec.data.map(el => this.convertDataElement(el))
          const pushdrop = new PushDrop(client)
          const lockingScript = await pushdrop.lock(
            fields,
            protocolID,
            keyID,
            'self',
            true,
            false
          )

          actionOutputs.push({
            lockingScript: lockingScript.toHex(),
            satoshis: sats,
            outputDescription: desc,
            basket,
            customInstructions: JSON.stringify({ protocolID, keyID, counterparty: 'self' }),
            tags: ['token']
          })
          outputDetails.push({ index: i, type: 'pushdrop', satoshis: sats, description: desc })
        } else if ((spec.to != null) && (spec.data == null)) {
          // P2PKH: simple payment
          const sats = spec.satoshis ?? 0
          if (sats <= 0) throw new Error(`P2PKH output #${i} needs satoshis > 0`)

          const lockingScript = new P2PKH()
            .lock(PublicKey.fromString(spec.to).toAddress())
            .toHex()

          actionOutputs.push({
            lockingScript,
            satoshis: sats,
            outputDescription: desc,
            ...(spec.basket != null ? { basket: spec.basket } : {})
          })
          outputDetails.push({ index: i, type: 'p2pkh', satoshis: sats, description: desc })
        } else {
          throw new Error(`Output #${i}: must have 'to' (P2PKH), 'data' (OP_RETURN), or both (PushDrop)`)
        }
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

  async pay (options: PaymentOptions): Promise<TransactionResult> {
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
  createPaymentRequest (options: { satoshis: number, memo?: string }): PaymentRequest {
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
  async sendDirectPayment (request: PaymentRequest): Promise<DirectPaymentResult> {
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

      const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(derivedKey).toAddress())
        .toHex()

      const outputs: any[] = [{
        lockingScript,
        satoshis: request.satoshis,
        outputDescription: `Direct payment: ${request.satoshis} sats`,
        customInstructions: JSON.stringify({
          derivationPrefix: request.derivationPrefix,
          derivationSuffix: request.derivationSuffix,
          payee: request.serverIdentityKey
        })
      }]

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
  async receiveDirectPayment (payment: IncomingPayment): Promise<void> {
    try {
      const client = this.getClient()
      const tx = payment.tx instanceof Uint8Array
        ? Array.from(payment.tx)
        : payment.tx

      await (client as any).internalizeAction({
        tx,
        outputs: [{
          outputIndex: payment.outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: {
            senderIdentityKey: payment.senderIdentityKey,
            derivationPrefix: payment.derivationPrefix,
            derivationSuffix: payment.derivationSuffix
          }
        }],
        description: payment.description ?? `Payment from ${payment.senderIdentityKey.substring(0, 20)}...`,
        labels: ['direct_payment']
      })
    } catch (error) {
      throw new Error(`Failed to receive direct payment: ${(error as Error).message}`)
    }
  }

  // ============================================================================
  // Fund Server Wallet
  // ============================================================================

  async fundServerWallet (request: PaymentRequest, basket?: string): Promise<TransactionResult> {
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

      const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(derivedKey).toAddress())
        .toHex()

      const outputs: any[] = [{
        lockingScript,
        satoshis: request.satoshis,
        outputDescription: `Server wallet funding: ${request.satoshis} sats`,
        ...(basket != null ? { basket } : {})
      }]

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
