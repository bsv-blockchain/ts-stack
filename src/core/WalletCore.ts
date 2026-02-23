import {
  P2PKH,
  PublicKey,
  Script,
  OP,
  Utils,
  PushDrop,
  SecurityLevel,
  Random,
  Transaction,
  WalletInterface,
  AtomicBEEF
} from '@bsv/sdk'
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
  ReinternalizeResult,
  PaymentRequest
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
        options: { randomizeOutputs: false }
      })

      let reinternalized: ReinternalizeResult | undefined
      if (options.changeBasket != null && options.changeBasket !== '') {
        if (result.tx != null) {
          const skipIndexes = actionOutputs.map((_: any, i: number) => i)
          reinternalized = await this.reinternalizeChange(result.tx, options.changeBasket, skipIndexes)
        } else {
          reinternalized = { count: 0, errors: ['result.tx is missing from createAction response'] }
        }
      }

      return {
        txid: result.txid ?? '',
        tx: result.tx,
        reinternalized,
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
      const client = this.getClient()
      const outputs: any[] = []

      let recipientKey = options.to
      if ((options.derivationPrefix != null && options.derivationPrefix !== '') || (options.derivationSuffix != null && options.derivationSuffix !== '')) {
        const invoiceNumber = (options.derivationPrefix != null && options.derivationPrefix !== '') && (options.derivationSuffix != null && options.derivationSuffix !== '')
          ? `${options.derivationPrefix}-${options.derivationSuffix}`
          : options.derivationPrefix ?? options.derivationSuffix ?? undefined
        recipientKey = await this.derivePaymentKey(options.to, invoiceNumber)
      }

      const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(recipientKey).toAddress())
        .toHex()

      outputs.push({
        lockingScript,
        satoshis: options.satoshis,
        outputDescription: this.defaults.outputDescription,
        ...(options.basket != null ? { basket: options.basket } : {})
      })

      if (options.memo != null && options.memo !== '') {
        const memoScript = new Script()
          .writeOpCode(OP.OP_FALSE)
          .writeOpCode(OP.OP_RETURN)
          .writeBin(Array.from(Utils.toArray(options.memo, 'utf8')))
        outputs.push({
          lockingScript: memoScript.toHex(),
          satoshis: 0,
          outputDescription: 'Payment memo'
        })
      }

      const result = await client.createAction({
        description: options.description ?? this.defaults.description,
        outputs,
        options: { randomizeOutputs: false }
      })

      let reinternalized: ReinternalizeResult | undefined
      if (options.changeBasket != null && options.changeBasket !== '') {
        if (result.tx != null) {
          const skipIndexes = outputs.map((_: any, i: number) => i)
          reinternalized = await this.reinternalizeChange(result.tx, options.changeBasket, skipIndexes)
        } else {
          reinternalized = { count: 0, errors: ['result.tx is missing from createAction response'] }
        }
      }

      return {
        txid: result.txid ?? '',
        tx: result.tx,
        reinternalized,
        outputs: outputs.map((out, index) => ({
          index,
          satoshis: out.satoshis,
          lockingScript: out.lockingScript
        }))
      }
    } catch (error) {
      throw new Error(`Payment failed: ${(error as Error).message}`)
    }
  }

  // ============================================================================
  // Fund Server Wallet
  // ============================================================================

  async fundServerWallet (request: PaymentRequest, basket?: string, changeBasket?: string): Promise<TransactionResult> {
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
        options: { randomizeOutputs: false }
      })

      let reinternalized: ReinternalizeResult | undefined
      if (changeBasket != null && changeBasket !== '') {
        if (result.tx != null) {
          const skipIndexes = outputs.map((_: any, i: number) => i)
          reinternalized = await this.reinternalizeChange(result.tx, changeBasket, skipIndexes)
        } else {
          reinternalized = { count: 0, errors: ['result.tx is missing from createAction response'] }
        }
      }

      return {
        txid: result.txid ?? '',
        tx: result.tx,
        reinternalized,
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

  // ============================================================================
  // Change Output Re-internalization
  // ============================================================================

  async reinternalizeChange (
    tx: AtomicBEEF,
    basket: string,
    skipOutputIndexes: number[] = [0]
  ): Promise<ReinternalizeResult> {
    if (tx.length === 0) {
      return { count: 0, errors: ['No tx bytes available for reinternalization'] }
    }

    interface ChangeOutput { index: number, satoshis: number }
    const changeOutputs: ChangeOutput[] = []

    try {
      const transaction = Transaction.fromAtomicBEEF(tx)
      const totalOutputs = transaction.outputs.length

      for (let i = 0; i < totalOutputs; i++) {
        if (skipOutputIndexes.includes(i)) continue
        const output = transaction.outputs[i]
        const sats = output.satoshis ?? 0
        if (sats === 0) continue
        changeOutputs.push({ index: i, satoshis: sats })
      }
    } catch (parseError) {
      return { count: 0, errors: ['Failed to parse transaction'] }
    }

    if (changeOutputs.length === 0) {
      return { count: 0, errors: [] }
    }

    // Skip the largest change output — the wallet tracks it automatically
    if (changeOutputs.length > 1) {
      const largestIdx = changeOutputs.reduce((maxI, cur, i, arr) =>
        cur.satoshis > arr[maxI].satoshis ? i : maxI, 0)
      changeOutputs.splice(largestIdx, 1)
    } else {
      return { count: 0, errors: [] }
    }

    if (changeOutputs.length === 0) {
      return { count: 0, errors: [] }
    }

    // Wait for broadcast with exponential backoff
    const client = this.getClient()
    const MAX_WAIT_MS = 30000
    let delay = 2000
    const startTime = Date.now()
    let broadcastReady = false
    let probeError = ''

    while (Date.now() - startTime < MAX_WAIT_MS) {
      try {
        await client.internalizeAction({
          tx,
          outputs: [{
            outputIndex: changeOutputs[0].index,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket,
              customInstructions: 'change',
              tags: ['change']
            }
          }],
          description: `Recover orphaned change output #${changeOutputs[0].index}`
        } as any)
        broadcastReady = true
        break
      } catch (error) {
        const msg = (error as Error).message !== '' ? (error as Error).message : String(error)
        if (!msg.includes('sending')) {
          probeError = msg
          break
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 16000)
      }
    }

    if (!broadcastReady) {
      const reason = probeError !== '' ? probeError : 'Transaction broadcast did not complete within 30s timeout'
      return { count: 0, errors: [reason] }
    }

    // First output already recovered by probe — process remaining
    let count = 1
    const errors: string[] = []

    for (let i = 1; i < changeOutputs.length; i++) {
      const { index: idx } = changeOutputs[i]
      try {
        await client.internalizeAction({
          tx,
          outputs: [{
            outputIndex: idx,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket,
              customInstructions: 'change',
              tags: ['change']
            }
          }],
          description: `Recover orphaned change output #${idx}`
        } as any)
        count++
      } catch (error) {
        const msg = (error as Error).message !== '' ? (error as Error).message : String(error)
        errors.push(`output #${idx}: ${msg}`)
      }
    }

    return { count, errors }
  }
}
