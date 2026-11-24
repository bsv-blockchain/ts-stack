import {
  P2PKH,
  PublicKey,
  Script,
  OP,
  PushDrop,
  SecurityLevel,
  Random,
  WalletInterface,
  CreateActionOutput,
  validateWalletArgs,
  validateWalletResult,
  snapshotWalletResultRequest
} from '@bsv/sdk'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import { snapshotPlainDataRecord } from './certificate-validation'
import { snapshotDenseByteArray } from './byte-validation'
import {
  validateBase64String,
  validateInteger,
  validateSatoshis,
  validateStringLength
} from '@bsv/sdk/wallet/validationHelpers'
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
  private static readonly BALANCE_PAGE_SIZE = 10_000
  private static readonly MAX_BALANCE_OUTPUTS = 100_000
  private static readonly MAX_SATOSHIS = 21e14
  private static readonly MAX_SEND_OUTPUTS = 1_000
  private static readonly MAX_SEND_DATA_FIELDS = 256
  private static readonly MAX_SEND_DATA_BYTES = 1024 * 1024
  private static readonly MAX_DIRECT_PAYMENT_TX_BYTES = 64 * 1024 * 1024

  public readonly identityKey: string
  public readonly defaults: WalletDefaults

  constructor(identityKey: string, defaults?: Partial<WalletDefaults>) {
    this.identityKey = identityKey
    this.defaults = mergeDefaults(defaults ?? {})
  }

  abstract getClient(): WalletInterface

  private canonicalPublicKey(value: unknown, name: string): string {
    if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(value)) {
      throw new TypeError(`${name} must be a canonical compressed public key.`)
    }
    try {
      if (PublicKey.fromString(value).toString() !== value) throw new Error('non-canonical key')
    } catch {
      throw new TypeError(`${name} must be a canonical compressed public key.`)
    }
    return value
  }

  private async getPublicKeyValidated(
    client: WalletInterface,
    args: Parameters<WalletInterface['getPublicKey']>[0]
  ): Promise<Awaited<ReturnType<WalletInterface['getPublicKey']>>> {
    validateWalletArgs('getPublicKey', args)
    const bindingRequest = snapshotWalletResultRequest('getPublicKey', args)
    const result = await client.getPublicKey(args)
    return validateWalletResult('getPublicKey', result, bindingRequest)
  }

  private async createActionValidated(
    client: WalletInterface,
    args: Parameters<WalletInterface['createAction']>[0]
  ): Promise<Awaited<ReturnType<WalletInterface['createAction']>>> {
    validateWalletArgs('createAction', args)
    const bindingRequest = snapshotWalletResultRequest('createAction', args)
    const result = await client.createAction(args)
    return validateWalletResult('createAction', result, bindingRequest)
  }

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

  private async listOutputsValidated(
    client: WalletInterface,
    args: Parameters<WalletInterface['listOutputs']>[0]
  ): Promise<Awaited<ReturnType<WalletInterface['listOutputs']>> & { totalOutputs: number }> {
    validateWalletArgs('listOutputs', args)
    const bindingRequest = snapshotWalletResultRequest('listOutputs', args)
    const result = validateWalletResult(
      'listOutputs',
      await client.listOutputs(args),
      bindingRequest
    )
    const { totalOutputs } = result
    if (typeof totalOutputs !== 'number') {
      throw new TypeError('Wallet returned a module balance where an output count was expected')
    }
    return { ...result, totalOutputs }
  }

  private addBalanceAmount(total: number, amount: number): number {
    const next = total + amount
    if (!Number.isSafeInteger(next) || next > WalletCore.MAX_SATOSHIS) {
      throw new Error('Wallet balance exceeds the maximum valid satoshi amount.')
    }
    return next
  }

  async getBalance(basket?: string): Promise<BalanceResult> {
    const client = this.getClient()

    if (basket != null) {
      let offset = 0
      let expectedTotal: number | undefined
      let totalSatoshis = 0
      let spendableSatoshis = 0
      let spendableOutputs = 0
      const seenOutpoints = new Set<string>()

      while (expectedTotal === undefined || offset < expectedTotal) {
        const result = await this.listOutputsValidated(client, {
          basket,
          limit: WalletCore.BALANCE_PAGE_SIZE,
          offset
        })
        if (expectedTotal === undefined) {
          expectedTotal = result.totalOutputs
          if (expectedTotal > WalletCore.MAX_BALANCE_OUTPUTS) {
            throw new Error(
              `Basket contains more than ${WalletCore.MAX_BALANCE_OUTPUTS} outputs; refusing a partial balance.`
            )
          }
        } else if (result.totalOutputs !== expectedTotal) {
          throw new Error('Basket changed while its balance was being calculated.')
        }

        if (result.outputs.length === 0 && offset < expectedTotal) {
          throw new Error('Wallet returned an incomplete basket balance page.')
        }
        if (offset + result.outputs.length > expectedTotal) {
          throw new Error('Wallet returned more basket outputs than declared.')
        }

        for (const output of result.outputs) {
          const outpoint = output.outpoint.toLowerCase()
          if (seenOutpoints.has(outpoint)) {
            throw new Error('Wallet returned a duplicate output while calculating balance.')
          }
          seenOutpoints.add(outpoint)
          totalSatoshis = this.addBalanceAmount(totalSatoshis, output.satoshis)
          if (output.spendable) {
            spendableSatoshis = this.addBalanceAmount(spendableSatoshis, output.satoshis)
            spendableOutputs++
          }
        }
        offset += result.outputs.length
      }

      return {
        totalSatoshis,
        totalOutputs: expectedTotal,
        spendableSatoshis,
        spendableOutputs
      }
    }

    // Use wallet-toolbox specOpWalletBalance for optimized balance query
    const WALLET_BALANCE_BASKET = '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8'
    const result = await this.listOutputsValidated(client, {
      basket: WALLET_BALANCE_BASKET,
      limit: 1
    })
    const balance = result.totalOutputs
    if (balance > WalletCore.MAX_SATOSHIS) {
      throw new Error('Wallet balance exceeds the maximum valid satoshi amount.')
    }
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
    const client = this.getClient()
    const result = await this.getPublicKeyValidated(client, {
      protocolID,
      keyID,
      counterparty: counterparty ?? 'anyone',
      forSelf: forSelf ?? false
    })
    return result.publicKey
  }

  async derivePaymentKey(counterparty: string, invoiceNumber?: string): Promise<string> {
    const protocolID: [SecurityLevel, string] = [2 as SecurityLevel, '3241645161d8']
    const keyID = invoiceNumber ?? toBase64(Random(8))
    const client = this.getClient()
    const result = await this.getPublicKeyValidated(client, {
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
    if (Array.isArray(element)) {
      return snapshotDenseByteArray(element, 'Data field', WalletCore.MAX_SEND_DATA_BYTES)
    }
    let serialized: string
    if (typeof element === 'object' && element !== null) {
      try {
        const value = JSON.stringify(element)
        if (value === undefined) throw new TypeError('not JSON serializable')
        serialized = value
      } catch {
        throw new TypeError('Data objects must be JSON serializable.')
      }
    } else {
      serialized = String(element)
    }
    const bytes = Array.from(toArray(serialized, 'utf8'))
    if (bytes.length > WalletCore.MAX_SEND_DATA_BYTES) {
      throw new RangeError('A data field exceeds the maximum permitted size.')
    }
    return bytes
  }

  private normalizeDataFields(value: unknown, index: number): number[][] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`Output #${index} data must be a standard array.`)
    }
    if (value.length > WalletCore.MAX_SEND_DATA_FIELDS) {
      throw new RangeError(`Output #${index} contains too many data fields.`)
    }
    let totalBytes = 0
    const fields: number[][] = []
    for (let fieldIndex = 0; fieldIndex < value.length; fieldIndex++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(fieldIndex))
      if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
        throw new TypeError(`Output #${index} data must be a dense accessor-free array.`)
      }
      const field = this.convertDataElement(descriptor.value as string | object | number[])
      totalBytes += field.length
      if (totalBytes > WalletCore.MAX_SEND_DATA_BYTES) {
        throw new RangeError(`Output #${index} data exceeds the maximum permitted size.`)
      }
      fields.push(field)
    }
    return fields
  }

  private normalizeProtocolID(value: unknown, index: number): [SecurityLevel, string] {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new TypeError(`Output #${index} protocolID must be a two-item tuple.`)
    }
    const level = Object.getOwnPropertyDescriptor(value, '0')
    const name = Object.getOwnPropertyDescriptor(value, '1')
    if (
      level == null ||
      name == null ||
      Object.getOwnPropertyDescriptor(level, 'value') == null ||
      Object.getOwnPropertyDescriptor(name, 'value') == null
    ) {
      throw new TypeError(`Output #${index} protocolID must be a dense own-data tuple.`)
    }
    const securityLevel = validateInteger(
      level.value as number | undefined,
      `output #${index} protocolID[0]`,
      undefined,
      0,
      2
    )
    const protocolName = validateStringLength(
      name.value as string,
      `output #${index} protocolID[1]`,
      5,
      400
    )
    return [securityLevel as SecurityLevel, protocolName]
  }

  private buildDataOnlyOutput(
    spec: SendOutputSpec,
    index: number,
    description: string
  ): { actionOutput: CreateActionOutput; detail: SendOutputDetail } {
    const fields = this.normalizeDataFields(spec.data, index)
    const script = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN)
    for (const field of fields) script.writeBin(field)
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
    validateStringLength(description, `output #${index} description`, 5, 2000)

    if (spec.data != null && spec.to == null) {
      return this.buildDataOnlyOutput(spec, index, description)
    }

    if (spec.to != null && spec.data != null) {
      const recipient = this.canonicalPublicKey(spec.to, `Output #${index} recipient`)
      const satoshis = validateSatoshis(spec.satoshis ?? 1, `output #${index} satoshis`, 1)
      const protocolID = this.normalizeProtocolID(
        spec.protocolID ?? this.defaults.tokenProtocolID,
        index
      )
      const keyID = spec.keyID ?? toBase64(Random(8))
      const basket = spec.basket ?? this.defaults.tokenBasket
      const fields = this.normalizeDataFields(spec.data, index)
      const counterparty = recipient === this.identityKey ? 'self' : recipient
      const forSelf = counterparty === 'self'
      const lockingScript = await new PushDrop(client).lock(
        fields,
        protocolID,
        keyID,
        counterparty,
        forSelf,
        false
      )

      return {
        actionOutput: {
          lockingScript: lockingScript.toHex(),
          satoshis,
          outputDescription: description,
          basket,
          customInstructions: JSON.stringify({ protocolID, keyID, counterparty }),
          tags: ['token']
        },
        detail: { index, type: 'pushdrop', satoshis, description }
      }
    }

    if (spec.to != null && spec.data == null) {
      const recipient = this.canonicalPublicKey(spec.to, `Output #${index} recipient`)
      const satoshis = validateSatoshis(spec.satoshis ?? 0, `output #${index} satoshis`, 1)
      const lockingScript = new P2PKH().lock(PublicKey.fromString(recipient).toAddress()).toHex()

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
      const ownedOptions = snapshotPlainDataRecord(options)
      if (
        ownedOptions == null ||
        !Array.isArray(ownedOptions.outputs) ||
        Object.getPrototypeOf(ownedOptions.outputs) !== Array.prototype ||
        ownedOptions.outputs.length === 0
      ) {
        throw new Error('At least one output is required')
      }
      if (ownedOptions.outputs.length > WalletCore.MAX_SEND_OUTPUTS) {
        throw new RangeError(`A send may contain at most ${WalletCore.MAX_SEND_OUTPUTS} outputs.`)
      }
      const actionDescription =
        ownedOptions.description === undefined
          ? this.defaults.description
          : typeof ownedOptions.description === 'string'
            ? ownedOptions.description
            : (() => {
                throw new TypeError('description must be a string')
              })()
      validateStringLength(actionDescription, 'description', 5, 2000)

      const client = this.getClient()
      const actionOutputs: any[] = []
      const outputDetails: SendOutputDetail[] = []

      for (let i = 0; i < ownedOptions.outputs.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(ownedOptions.outputs, String(i))
        const spec =
          descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null
            ? undefined
            : snapshotPlainDataRecord(descriptor.value)
        if (spec == null) {
          throw new TypeError('Send outputs must be a dense array of objects.')
        }
        const { actionOutput, detail } = await this.buildSendOutput(
          client,
          spec as unknown as SendOutputSpec,
          i
        )
        actionOutputs.push(actionOutput)
        outputDetails.push(detail)
      }

      const result = await this.createActionValidated(client, {
        description: actionDescription,
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
      const ownedOptions = snapshotPlainDataRecord(options)
      if (ownedOptions == null) throw new TypeError('Payment options must be an object.')
      const recipient = this.canonicalPublicKey(ownedOptions.to, 'Payment recipient')
      const amount = validateSatoshis(ownedOptions.satoshis as number | undefined, 'satoshis', 1)
      const peerPay = new PeerPayClient({
        walletClient: this.getClient() as any,
        messageBoxHost: this.defaults.messageBoxHost,
        enableLogging: false
      })

      const result = await peerPay.sendPayment({
        recipient,
        amount
      })
      // PeerPay historically resolves with no result after the message has been
      // accepted for delivery. Preserve that contract, but never turn a
      // malformed or prototype-backed claimed result into an apparent success.
      if (result === undefined) return { txid: '', tx: undefined }
      const ownedResult = snapshotPlainDataRecord(result)
      if (ownedResult == null) {
        throw new TypeError('PeerPay returned an invalid payment result.')
      }
      const txid = ownedResult.txid
      if (txid !== undefined && (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid))) {
        throw new TypeError('PeerPay returned an invalid payment txid.')
      }
      let normalizedTx: number[] | undefined
      if (ownedResult.tx !== undefined) {
        try {
          normalizedTx = snapshotDenseByteArray(
            ownedResult.tx,
            'PeerPay payment transaction',
            WalletCore.MAX_DIRECT_PAYMENT_TX_BYTES
          )
          if (normalizedTx.length === 0) throw new TypeError('empty transaction')
        } catch {
          throw new TypeError('PeerPay returned an invalid payment transaction.')
        }
      }

      return {
        txid: (txid as string | undefined) ?? '',
        tx: normalizedTx
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
    const ownedOptions = snapshotPlainDataRecord(options)
    if (ownedOptions == null) throw new TypeError('Payment request options must be an object.')
    const satoshis = validateSatoshis(ownedOptions.satoshis as number | undefined, 'satoshis', 1)
    if (ownedOptions.memo !== undefined) {
      validateStringLength(ownedOptions.memo as string, 'memo', 0, 2000)
    }
    const derivationPrefix = toBase64(toArray('payment', 'utf8'))
    const derivationSuffix = toBase64(Random(8))
    return Object.assign(Object.create(null) as PaymentRequest, {
      serverIdentityKey: this.identityKey,
      derivationPrefix,
      derivationSuffix,
      satoshis,
      ...(ownedOptions.memo === undefined ? {} : { memo: ownedOptions.memo as string })
    })
  }

  private normalizePaymentRequest(request: PaymentRequest): PaymentRequest {
    const record = snapshotPlainDataRecord(request)
    if (record == null) throw new TypeError('Payment request must be an object.')
    const serverIdentityKey = this.canonicalPublicKey(
      record.serverIdentityKey,
      'Payment request server identity key'
    )
    const derivationPrefix = validateBase64String(
      record.derivationPrefix as string,
      'derivationPrefix',
      1,
      256
    )
    const derivationSuffix = validateBase64String(
      record.derivationSuffix as string,
      'derivationSuffix',
      1,
      256
    )
    const satoshis = validateSatoshis(record.satoshis as number | undefined, 'satoshis', 1)
    if (record.memo !== undefined) {
      validateStringLength(record.memo as string, 'memo', 0, 2000)
    }
    return Object.assign(Object.create(null) as PaymentRequest, {
      serverIdentityKey,
      derivationPrefix,
      derivationSuffix,
      satoshis,
      ...(record.memo === undefined ? {} : { memo: record.memo as string })
    })
  }

  /**
   * Create a BRC-29 derived P2PKH transaction for the recipient described in the request.
   * Returns the transaction plus remittance data the recipient needs to call `receiveDirectPayment()`.
   */
  async sendDirectPayment(request: PaymentRequest): Promise<DirectPaymentResult> {
    try {
      request = this.normalizePaymentRequest(request)
      const client = this.getClient()
      const protocolID: [SecurityLevel, string] = [2 as SecurityLevel, '3241645161d8']
      const keyID = `${request.derivationPrefix} ${request.derivationSuffix}`

      const { publicKey: derivedKey } = await this.getPublicKeyValidated(client, {
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
          .writeBin(Array.from(toArray(request.memo, 'utf8')))
        outputs.push({
          lockingScript: memoScript.toHex(),
          satoshis: 0,
          outputDescription: 'Payment memo'
        })
      }

      const result = await this.createActionValidated(client, {
        description:
          request.memo == null || request.memo === ''
            ? `Direct payment (${request.satoshis} sats)`
            : request.memo,
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
      const record = snapshotPlainDataRecord(payment)
      if (record == null) throw new TypeError('Incoming payment must be an object.')
      const tx = snapshotDenseByteArray(
        record.tx,
        'Incoming payment transaction',
        WalletCore.MAX_DIRECT_PAYMENT_TX_BYTES
      )
      if (tx.length === 0) {
        throw new TypeError('Incoming payment transaction is invalid.')
      }
      const senderIdentityKey = this.canonicalPublicKey(
        record.senderIdentityKey,
        'Incoming payment sender identity key'
      )
      const derivationPrefix = validateBase64String(
        record.derivationPrefix as string,
        'derivationPrefix',
        1,
        256
      )
      const derivationSuffix = validateBase64String(
        record.derivationSuffix as string,
        'derivationSuffix',
        1,
        256
      )
      const outputIndex = validateInteger(
        record.outputIndex as number | undefined,
        'outputIndex',
        undefined,
        0,
        0xffffffff
      )
      if (record.description !== undefined) {
        validateStringLength(record.description as string, 'description', 5, 2000)
      }

      const internalizeArgs = {
        tx,
        outputs: [
          {
            outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              senderIdentityKey,
              derivationPrefix,
              derivationSuffix
            }
          }
        ],
        description: record.description ?? `Payment from ${senderIdentityKey.substring(0, 20)}...`,
        labels: ['direct_payment']
      } as Parameters<WalletInterface['internalizeAction']>[0]
      validateWalletArgs('internalizeAction', internalizeArgs)
      const bindingRequest = snapshotWalletResultRequest('internalizeAction', internalizeArgs)
      const internalizeResult = await client.internalizeAction(internalizeArgs)
      validateWalletResult('internalizeAction', internalizeResult, bindingRequest)
    } catch (error) {
      throw new Error(`Failed to receive direct payment: ${(error as Error).message}`)
    }
  }

  // ============================================================================
  // Fund Server Wallet
  // ============================================================================

  async fundServerWallet(request: PaymentRequest, basket?: string): Promise<TransactionResult> {
    try {
      request = this.normalizePaymentRequest(request)
      const client = this.getClient()
      const protocolID: [SecurityLevel, string] = [2 as SecurityLevel, '3241645161d8']
      const keyID = `${request.derivationPrefix} ${request.derivationSuffix}`

      const { publicKey: derivedKey } = await this.getPublicKeyValidated(client, {
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
          .writeBin(Array.from(toArray(request.memo, 'utf8')))
        outputs.push({
          lockingScript: memoScript.toHex(),
          satoshis: 0,
          outputDescription: 'Funding memo'
        })
      }

      const result = await this.createActionValidated(client, {
        description:
          request.memo == null || request.memo === ''
            ? `Fund server wallet (${request.satoshis} sats)`
            : request.memo,
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
