import PublicKey from '@bsv/sdk/primitives/PublicKey'
import P2PKH from '@bsv/sdk/script/templates/P2PKH'
import Transaction from '@bsv/sdk/transaction/Transaction'
import type { AtomicBEEF, WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import {
  LCHPayee,
  validatePaymentDelivery,
  validatePaymentDemand,
  validatePaymentReceipt
} from './acquisition.js'
import { lchAssert } from './errors.js'
import { fromHex, toBase64Url, toHex } from './hash.js'
import { BRC29_PAYMENT_PROTOCOL } from './walletPayment.js'
import { checkedSatoshis } from './payment.js'
import type { LCHSignatureVerifier, LCHSigner, SignedObject } from './types.js'
import {
  ownDataValue,
  requiredOwnDataValue,
  snapshotBytes,
  snapshotSignedObject,
  snapshotStringArray,
  snapshotStringSet
} from './boundary.js'

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
    const entry = this.entries.get(demandId)
    if (entry === undefined) return undefined
    return {
      fingerprint: entry.fingerprint,
      ...(entry.receipt === undefined
        ? {}
        : { receipt: snapshotSignedObject(entry.receipt, 'Stored Payment Receipt') })
    }
  }

  async complete(demandId: string, fingerprint: string, receipt: SignedObject): Promise<void> {
    const existing = this.entries.get(demandId)
    lchAssert(
      existing?.fingerprint === fingerprint,
      'ERR_LCH_PAYMENT',
      'Payment ledger claim changed before completion'
    )
    this.entries.set(demandId, {
      fingerprint,
      receipt: snapshotSignedObject(receipt, 'Payment Receipt')
    })
  }
}

export interface WalletPaymentReceiverOptions {
  wallet: Pick<WalletInterface, 'getPublicKey' | 'internalizeAction'>
  signer: LCHSigner
  ledger?: PaymentLedger
  verifier?: LCHSignatureVerifier
  now?: () => bigint
  allowInsecureLocalOrigins?: readonly string[]
  supportedCriticalIdentifiers?: ReadonlySet<string>
}

export class WalletPaymentReceiver {
  private readonly wallet: Pick<WalletInterface, 'getPublicKey' | 'internalizeAction'>
  private readonly signer: LCHSigner
  private readonly payee: LCHPayee
  private readonly ledger: PaymentLedger
  private readonly now: () => bigint
  private readonly verifier?: LCHSignatureVerifier
  private readonly allowInsecureLocalOrigins?: readonly string[]
  private readonly supportedCriticalIdentifiers?: ReadonlySet<string>

  constructor(options: WalletPaymentReceiverOptions) {
    const wallet = ownDataValue(options, 'wallet', 'Wallet Payment Receiver options')
    const signer = ownDataValue(options, 'signer', 'Wallet Payment Receiver options')
    const ledger = ownDataValue(options, 'ledger', 'Wallet Payment Receiver options')
    const verifier = ownDataValue(options, 'verifier', 'Wallet Payment Receiver options')
    const now = ownDataValue(options, 'now', 'Wallet Payment Receiver options')
    lchAssert(
      wallet !== null &&
        typeof wallet === 'object' &&
        typeof (wallet as Pick<WalletInterface, 'getPublicKey'>).getPublicKey === 'function' &&
        typeof (wallet as Pick<WalletInterface, 'internalizeAction'>).internalizeAction ===
          'function',
      'ERR_LCH_PAYMENT',
      'Receiving wallet is invalid'
    )
    lchAssert(
      signer !== null &&
        typeof signer === 'object' &&
        (signer as LCHSigner).identityKey instanceof Uint8Array &&
        typeof (signer as LCHSigner).sign === 'function',
      'ERR_LCH_SIGNATURE',
      'Payment Receipt signer is invalid'
    )
    lchAssert(
      ledger === undefined ||
        (ledger !== null &&
          typeof ledger === 'object' &&
          typeof (ledger as PaymentLedger).claim === 'function' &&
          typeof (ledger as PaymentLedger).get === 'function' &&
          typeof (ledger as PaymentLedger).complete === 'function'),
      'ERR_LCH_PAYMENT',
      'Payment ledger is invalid'
    )
    lchAssert(
      verifier === undefined ||
        (verifier !== null &&
          typeof verifier === 'object' &&
          typeof (verifier as LCHSignatureVerifier).verify === 'function'),
      'ERR_LCH_SIGNATURE',
      'Payment verifier is invalid'
    )
    lchAssert(
      now === undefined || typeof now === 'function',
      'ERR_LCH_PAYMENT',
      'Payment clock is invalid'
    )
    const configuredWallet = wallet as Pick<WalletInterface, 'getPublicKey' | 'internalizeAction'>
    this.wallet = {
      getPublicKey: configuredWallet.getPublicKey.bind(configuredWallet),
      internalizeAction: configuredWallet.internalizeAction.bind(configuredWallet)
    }
    const configuredSigner = signer as LCHSigner
    const sign = configuredSigner.sign.bind(configuredSigner)
    this.signer = {
      identityKey: snapshotBytes(configuredSigner.identityKey, 'Payment Receipt signer identity'),
      sign
    }
    this.payee = new LCHPayee(this.signer)
    this.ledger = (ledger as PaymentLedger | undefined) ?? new MemoryPaymentLedger()
    this.verifier = verifier as LCHSignatureVerifier | undefined
    this.now = (now as (() => bigint) | undefined) ?? (() => BigInt(Math.floor(Date.now() / 1000)))
    this.allowInsecureLocalOrigins = snapshotStringArray(
      ownDataValue(options, 'allowInsecureLocalOrigins', 'Wallet Payment Receiver options'),
      'Wallet Payment Receiver allowInsecureLocalOrigins'
    )
    this.supportedCriticalIdentifiers = snapshotStringSet(
      ownDataValue(options, 'supportedCriticalIdentifiers', 'Wallet Payment Receiver options'),
      'Wallet Payment Receiver supportedCriticalIdentifiers'
    )
  }

  async preflight(demand: SignedObject): Promise<void> {
    demand = snapshotSignedObject(demand, 'Payment Demand')
    await validatePaymentDemand(demand, this.verifier, {
      allowInsecureLocalOrigins: this.allowInsecureLocalOrigins,
      supportedCriticalIdentifiers: this.supportedCriticalIdentifiers
    })
    const payee = bytes(demand.body.payee, 33, 'Demand payee')
    lchAssert(
      toHex(payee) === toHex(this.signer.identityKey),
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
    demand = snapshotSignedObject(demand, 'Payment Demand')
    delivery = snapshotSignedObject(delivery, 'Payment Delivery')
    const demandId = await validatePaymentDemand(demand, this.verifier, {
      allowInsecureLocalOrigins: this.allowInsecureLocalOrigins,
      supportedCriticalIdentifiers: this.supportedCriticalIdentifiers
    })
    await validatePaymentDelivery(delivery, this.verifier, {
      supportedCriticalIdentifiers: this.supportedCriticalIdentifiers
    })
    const payee = bytes(demand.body.payee, 33, 'Demand payee')
    lchAssert(
      toHex(payee) === toHex(this.signer.identityKey),
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
    const satoshis = checkedSatoshis(integer(demand.body.satoshis, 'Demand amount'))
    lchAssert(
      BigInt(output.satoshis) === satoshis,
      'ERR_LCH_PAYMENT',
      'Payment output amount does not match the Demand'
    )
    const keyID = `${toBase64Url(prefix)} ${toBase64Url(suffix)}`
    const publicKey = requiredOwnDataValue(
      await this.wallet.getPublicKey({
        protocolID: [...BRC29_PAYMENT_PROTOCOL],
        keyID,
        counterparty: toHex(buyer),
        forSelf: true
      }),
      'publicKey',
      'Wallet getPublicKey result'
    )
    lchAssert(typeof publicKey === 'string', 'ERR_LCH_PAYMENT', 'Wallet public key is invalid')
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
    lchAssert(
      claim === 'new' || claim === 'same' || claim === 'conflict',
      'ERR_LCH_PAYMENT',
      'Payment ledger returned an invalid claim status'
    )
    lchAssert(claim !== 'conflict', 'ERR_LCH_PAYMENT', 'Payment Demand was reused')
    const existing = await this.ledger.get(demandIdHex)
    const storedReceipt =
      existing === undefined ? undefined : ownDataValue(existing, 'receipt', 'Payment ledger entry')
    if (storedReceipt !== undefined) {
      const receipt = snapshotSignedObject(storedReceipt, 'Stored Payment Receipt')
      await validatePaymentReceipt(receipt, this.verifier, {
        supportedCriticalIdentifiers: this.supportedCriticalIdentifiers
      })
      equal(receipt.body.demandId, demandId, 'Stored Receipt Demand ID')
      equal(receipt.body.requestId, demand.body.requestId, 'Stored Receipt Request ID')
      equal(receipt.body.payee, payee, 'Stored Receipt payee')
      equal(receipt.body.txid, fromHex(txidHex), 'Stored Receipt transaction ID')
      lchAssert(
        index(receipt.body.outputIndex) === outputIndex &&
          checkedSatoshis(integer(receipt.body.satoshis, 'Stored Receipt amount')) === satoshis,
        'ERR_LCH_PAYMENT',
        'Stored Receipt does not match the claimed payment'
      )
      return receipt
    }

    const result: unknown = await this.wallet.internalizeAction({
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
    })
    lchAssert(
      result !== null && typeof result === 'object' && !Array.isArray(result),
      'ERR_LCH_PAYMENT',
      'Receiving wallet returned an invalid result'
    )
    const accepted = ownDataValue(result, 'accepted', 'Wallet internalizeAction result')
    const isMerge = ownDataValue(result, 'isMerge', 'Wallet internalizeAction result')
    lchAssert(
      accepted === true || (claim === 'same' && isMerge === true),
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
    await this.ledger.complete(
      demandIdHex,
      fingerprint,
      snapshotSignedObject(receipt, 'Payment Receipt')
    )
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
