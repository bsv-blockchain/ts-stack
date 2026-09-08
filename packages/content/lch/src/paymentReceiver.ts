import { P2PKH, PublicKey, Transaction, type AtomicBEEF, type WalletInterface } from '@bsv/sdk'
import { LCHPayee, validatePaymentDelivery, validatePaymentDemand } from './acquisition.js'
import { lchAssert } from './errors.js'
import { fromHex, toBase64Url, toHex } from './hash.js'
import { BRC29_PAYMENT_PROTOCOL } from './walletPayment.js'
import type { LCHSignatureVerifier, LCHSigner, SignedObject } from './types.js'

export type PaymentClaimStatus = 'new' | 'same' | 'conflict'

export interface PaymentLedgerEntry {
  fingerprint: string
  receipt?: SignedObject
}

export interface PaymentLedger {
  claim(demandId: string, fingerprint: string): Promise<PaymentClaimStatus>
  get(demandId: string): Promise<PaymentLedgerEntry | undefined>
  complete(demandId: string, fingerprint: string, receipt: SignedObject): Promise<void>
}

export class MemoryPaymentLedger implements PaymentLedger {
  private readonly entries = new Map<string, PaymentLedgerEntry>()

  constructor(private readonly maximumEntries = 100_000) {
    lchAssert(
      Number.isSafeInteger(maximumEntries) && maximumEntries > 0,
      'ERR_LCH_PAYMENT',
      'Payment ledger capacity is invalid'
    )
  }

  async claim(demandId: string, fingerprint: string): Promise<PaymentClaimStatus> {
    const existing = this.entries.get(demandId)
    if (existing !== undefined) return existing.fingerprint === fingerprint ? 'same' : 'conflict'
    lchAssert(
      this.entries.size < this.maximumEntries,
      'ERR_LCH_PAYMENT',
      'Payment ledger capacity is exhausted'
    )
    this.entries.set(demandId, { fingerprint })
    return 'new'
  }

  async get(demandId: string): Promise<PaymentLedgerEntry | undefined> {
    return this.entries.get(demandId)
  }

  async complete(demandId: string, fingerprint: string, receipt: SignedObject): Promise<void> {
    const existing = this.entries.get(demandId)
    lchAssert(
      existing?.fingerprint === fingerprint,
      'ERR_LCH_PAYMENT',
      'Payment ledger claim changed before completion'
    )
    this.entries.set(demandId, { fingerprint, receipt })
  }
}

export interface WalletPaymentReceiverOptions {
  wallet: Pick<WalletInterface, 'getPublicKey' | 'internalizeAction'>
  signer: LCHSigner
  ledger?: PaymentLedger
  verifier?: LCHSignatureVerifier
  now?: () => bigint
  allowInsecureLocalOrigins?: readonly string[]
}

export class WalletPaymentReceiver {
  private readonly payee: LCHPayee
  private readonly ledger: PaymentLedger
  private readonly now: () => bigint

  constructor(private readonly options: WalletPaymentReceiverOptions) {
    this.payee = new LCHPayee(options.signer)
    this.ledger = options.ledger ?? new MemoryPaymentLedger()
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  }

  async preflight(demand: SignedObject): Promise<void> {
    await validatePaymentDemand(demand, this.options.verifier, {
      allowInsecureLocalOrigins: this.options.allowInsecureLocalOrigins
    })
    const payee = bytes(demand.body.payee, 33, 'Demand payee')
    lchAssert(
      toHex(payee) === toHex(this.options.signer.identityKey),
      'ERR_LCH_AUTHORITY',
      'Payment Demand belongs to another payee'
    )
    lchAssert(
      this.now() < integer(demand.body.expiresAt, 'Demand expiry'),
      'ERR_LCH_QUOTE',
      'Payment Demand has expired'
    )
  }

  async receive(demand: SignedObject, delivery: SignedObject): Promise<SignedObject> {
    const demandId = await validatePaymentDemand(demand, this.options.verifier, {
      allowInsecureLocalOrigins: this.options.allowInsecureLocalOrigins
    })
    await validatePaymentDelivery(delivery, this.options.verifier)
    const payee = bytes(demand.body.payee, 33, 'Demand payee')
    lchAssert(
      toHex(payee) === toHex(this.options.signer.identityKey),
      'ERR_LCH_AUTHORITY',
      'Payment Demand belongs to another payee'
    )
    equal(delivery.body.demandId, demandId, 'Payment Delivery Demand ID')
    equal(delivery.body.requestId, demand.body.requestId, 'Payment Delivery Request ID')
    equal(delivery.body.derivationPrefix, demand.body.derivationPrefix, 'Derivation prefix')
    lchAssert(
      this.now() < integer(demand.body.recoveryUntil, 'Demand recovery deadline'),
      'ERR_LCH_PAYMENT',
      'Payment recovery deadline has passed'
    )

    const buyer = bytes(delivery.body.buyer, 33, 'Buyer identity')
    equal(buyer, demand.body.buyer, 'Payment Delivery buyer identity')
    const atomicBeef = bytes(delivery.body.atomicBeef, undefined, 'Atomic BEEF')
    const outputIndex = index(delivery.body.outputIndex)
    const prefix = bytes(delivery.body.derivationPrefix, 32, 'Derivation prefix')
    const suffix = bytes(delivery.body.derivationSuffix, 32, 'Derivation suffix')
    const transaction = parseAtomicBeef(atomicBeef)
    const output = transaction.outputs[outputIndex]
    lchAssert(output?.satoshis !== undefined, 'ERR_LCH_PAYMENT', 'Payment output is absent')
    const satoshis = integer(demand.body.satoshis, 'Demand amount')
    lchAssert(
      BigInt(output.satoshis) === satoshis,
      'ERR_LCH_PAYMENT',
      'Payment output amount does not match the Demand'
    )
    const keyID = `${toBase64Url(prefix)} ${toBase64Url(suffix)}`
    const { publicKey } = await this.options.wallet.getPublicKey({
      protocolID: [...BRC29_PAYMENT_PROTOCOL],
      keyID,
      counterparty: toHex(buyer),
      forSelf: true
    })
    const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toUint8Array()
    lchAssert(
      toHex(output.lockingScript.toUint8Array()) === toHex(expected),
      'ERR_LCH_PAYMENT',
      'Payment output locking script does not match the Demand remittance'
    )

    const txidHex = transaction.id('hex')
    const fingerprint = `${txidHex}:${outputIndex}:${toHex(buyer)}`
    const demandIdHex = toHex(demandId)
    const claim = await this.ledger.claim(demandIdHex, fingerprint)
    lchAssert(claim !== 'conflict', 'ERR_LCH_PAYMENT', 'Payment Demand was reused')
    const existing = await this.ledger.get(demandIdHex)
    if (existing?.receipt !== undefined) return existing.receipt

    const result = (await this.options.wallet.internalizeAction({
      tx: Array.from(atomicBeef),
      outputs: [
        {
          outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: toBase64Url(prefix),
            derivationSuffix: toBase64Url(suffix),
            senderIdentityKey: toHex(buyer)
          }
        }
      ],
      description: `LCH payment ${demandIdHex}`
    })) as { accepted?: boolean; isMerge?: boolean }
    lchAssert(
      result.accepted === true || (claim === 'same' && result.isMerge === true),
      'ERR_LCH_PAYMENT',
      'Receiving wallet did not accept the Payment Demand output'
    )
    const receipt = await this.payee.createReceipt({
      demandId,
      requestId: bytes(demand.body.requestId, 32, 'Request ID'),
      txid: fromHex(txidHex),
      outputIndex,
      satoshis,
      receivedAt: this.now()
    })
    await this.ledger.complete(demandIdHex, fingerprint, receipt)
    return receipt
  }
}

function parseAtomicBeef(bytes: Uint8Array): Transaction {
  try {
    return Transaction.fromAtomicBEEF(bytes as AtomicBEEF)
  } catch (error) {
    throw new Error('Atomic BEEF could not be parsed', { cause: error })
  }
}

function bytes(value: unknown, length: number | undefined, name: string): Uint8Array {
  lchAssert(
    value instanceof Uint8Array &&
      value.length > 0 &&
      (length === undefined || value.length === length),
    'ERR_LCH_PAYMENT',
    `${name} is invalid`
  )
  return value
}

function integer(value: unknown, name: string): bigint {
  lchAssert(
    typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)),
    'ERR_LCH_PAYMENT',
    `${name} is not an exact integer`
  )
  const result = BigInt(value)
  lchAssert(result >= 0n, 'ERR_LCH_PAYMENT', `${name} is negative`)
  return result
}

function index(value: unknown): number {
  lchAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'ERR_LCH_PAYMENT',
    'Payment output index is invalid'
  )
  return value
}

function equal(value: unknown, expected: unknown, name: string): void {
  lchAssert(
    value instanceof Uint8Array &&
      expected instanceof Uint8Array &&
      toHex(value) === toHex(expected),
    'ERR_LCH_PAYMENT',
    `${name} does not match`
  )
}
