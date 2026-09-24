import type { ModuleContext, RemittanceOptionId, Termination } from '../types.js'
import type { RemittanceModule } from '../RemittanceModule.js'
import type {
  WalletInterface,
  WalletCounterparty,
  PubKeyHex,
  OriginatorDomainNameStringUnder250Bytes,
  WalletProtocol
} from '../../wallet/Wallet.interfaces.js'
import { createNonce } from '../../auth/utils/createNonce.js'
import P2PKH from '../../script/templates/P2PKH.js'
import PublicKey from '../../primitives/PublicKey.js'
import { toBRC100PortableByteArray } from '../../wallet/BRC100ByteEncoding.js'
import { completeBoundAction } from '../../wallet/completeBoundAction.js'
import { validateWalletResult } from '../../wallet/WalletResultValidation.js'
import Transaction from '../../transaction/Transaction.js'

const MAX_SATOSHIS = 21e14
const MAX_SETTLEMENT_TRANSACTION_BYTES = 4 * 1024 * 1024
const MAX_IDENTIFIER_LENGTH = 4096
const MAX_NOTE_LENGTH = 64 * 1024
const MAX_LABELS = 100
const MAX_LABEL_LENGTH = 300
const MAX_PROTOCOL_NAME_LENGTH = 400

/**
 * BRC-29-like payment option terms.
 *
 * This module intentionally keeps option terms minimal:
 * - Amount is taken from the invoice total (and validated as satoshis)
 * - The payer derives the payee's per-payment public key using wallet.getPublicKey with a stable protocolID
 */
export interface Brc29OptionTerms {
  /** Payment amount in satoshis. */
  amountSatoshis: number
  /** The recipient of the payment */
  payee: PubKeyHex
  /** Which output index to internalize, default 0. */
  outputIndex?: number
  /** Optionally override the protocolID used in getPublicKey. */
  protocolID?: WalletProtocol
  /** Optional labels for createAction. */
  labels?: string[]
  /** Optional description for createAction. */
  description?: string
}

/**
 * Settlement artifact carried in the settlement message.
 */
export interface Brc29SettlementArtifact {
  customInstructions: {
    derivationPrefix: string
    derivationSuffix: string
    /** Protocol used for derivation. Optional only for legacy default-protocol artifacts. */
    protocolID?: WalletProtocol
  }
  transaction: number[]
  amountSatoshis: number
  outputIndex?: number
}

/**
 * Receipt data for BRC-29 settlements.
 */
export interface Brc29ReceiptData {
  /** Result returned from wallet.internalizeAction, if accepted. */
  internalizeResult?: unknown
  /** Human-readable rejection reason, if rejected. */
  rejectedReason?: string
  /** If rejected with refund, contains the refund payment token. */
  refund?: {
    token: Brc29SettlementArtifact
    feeSatoshis: number
  }
}

export interface NonceProvider {
  createNonce: (
    wallet: WalletInterface,
    scope: WalletCounterparty,
    originator?: unknown
  ) => Promise<string>
}

export interface LockingScriptProvider {
  /** Converts a public key string to a P2PKH locking script hex. */
  pubKeyToP2PKHLockingScript: (publicKey: string) => Promise<string> | string
}

/**
 * Default nonce provider using SDK createNonce.
 */
export const DefaultNonceProvider: NonceProvider = {
  async createNonce(wallet, scope, originator) {
    const origin = originator as OriginatorDomainNameStringUnder250Bytes | undefined
    return await createNonce(wallet, scope, origin)
  }
}

/**
 * Default locking script provider using SDK P2PKH template.
 */
export const DefaultLockingScriptProvider: LockingScriptProvider = {
  async pubKeyToP2PKHLockingScript(publicKey: string) {
    const address = PublicKey.fromString(publicKey).toAddress()
    return new P2PKH().lock(address).toHex()
  }
}

export interface Brc29RemittanceModuleConfig {
  /** Default protocolID to use with wallet.getPublicKey. */
  protocolID?: WalletProtocol
  /** Labels applied to created actions. */
  labels?: string[]
  /** Description applied to created actions. */
  description?: string
  /** Output description for created actions. */
  outputDescription?: string

  /**
   * Fee charged on refunds, in satoshis.
   */
  refundFeeSatoshis?: number

  /**
   * Minimum refund to issue. If refund would be smaller, module will reject without refund.
   */
  minRefundSatoshis?: number

  /**
   * @deprecated BRC-29 settlements must be internalized as `wallet payment`.
   * `basket insertion` never supplied the required insertion remittance and,
   * more importantly, would classify recipient funds as custom application
   * outputs that the wallet's automatic BRC-29 signer cannot spend.
   *
   * The property remains in the input type for source compatibility, but the
   * constructor rejects `basket insertion` with an actionable error.
   */
  internalizeProtocol?: 'wallet payment' | 'basket insertion'

  nonceProvider?: NonceProvider
  lockingScriptProvider?: LockingScriptProvider
}

/**
 * BRC-29-based remittance module.
 * - payer creates a payment action to a derived P2PKH output
 * - payer sends { tx, derivationPrefix, derivationSuffix } as settlement artifact
 * - payee internalizes the tx output using wallet.internalizeAction
 * - optional rejection can include a refund token embedded in the termination details
 *
 * Wallet-created transactions are completed through a deferred-signing boundary that verifies
 * the requested amount and locking script before signing. Recipients independently derive the
 * expected key and require the selected transaction output to pay that exact script and amount
 * before internalization.
 */
export class Brc29RemittanceModule implements RemittanceModule<
  Brc29OptionTerms,
  Brc29SettlementArtifact,
  Brc29ReceiptData
> {
  readonly id: RemittanceOptionId = 'brc29.p2pkh'
  readonly name = 'BSV (BRC-29 derived P2PKH)'
  readonly allowUnsolicitedSettlements = true

  private readonly protocolID: WalletProtocol
  private readonly labels: string[]
  private readonly description: string
  private readonly outputDescription: string
  private readonly refundFeeSatoshis: number
  private readonly minRefundSatoshis: number
  private readonly internalizeProtocol: 'wallet payment'
  private readonly nonceProvider: NonceProvider
  private readonly lockingScriptProvider: LockingScriptProvider

  constructor(cfg: Brc29RemittanceModuleConfig = {}) {
    // BRC-29 Protocol.
    this.protocolID = copyProtocolID(cfg.protocolID ?? [2, '3241645161d8'])
    this.labels = copyLabels(cfg.labels ?? ['brc29'])
    this.description = boundedText(cfg.description ?? 'BRC-29 payment', 'description')
    this.outputDescription = boundedText(
      cfg.outputDescription ?? 'Payment for remittance invoice',
      'outputDescription'
    )
    this.refundFeeSatoshis = satoshis(cfg.refundFeeSatoshis ?? 1000, 'refundFeeSatoshis', true)
    this.minRefundSatoshis = satoshis(cfg.minRefundSatoshis ?? 1000, 'minRefundSatoshis', true)
    const legacyInternalizeProtocol = (
      cfg as { internalizeProtocol?: 'wallet payment' | 'basket insertion' }
    ).internalizeProtocol
    if (legacyInternalizeProtocol === 'basket insertion') {
      throw new TypeError(
        'BRC-29 settlements cannot be internalized as basket insertions. ' +
          'Use wallet payment for spendable wallet balance, or implement a separate custom-output protocol with insertionRemittance.'
      )
    }
    this.internalizeProtocol = 'wallet payment'
    this.nonceProvider = cfg.nonceProvider ?? DefaultNonceProvider
    if (typeof this.nonceProvider?.createNonce !== 'function') {
      throw new TypeError('nonceProvider must implement createNonce')
    }
    this.lockingScriptProvider = cfg.lockingScriptProvider ?? DefaultLockingScriptProvider
    if (typeof this.lockingScriptProvider?.pubKeyToP2PKHLockingScript !== 'function') {
      throw new TypeError('lockingScriptProvider must implement pubKeyToP2PKHLockingScript')
    }
  }

  async buildSettlement(
    args: { threadId: string; option: Brc29OptionTerms; note?: string },
    ctx: ModuleContext
  ): Promise<
    | { action: 'settle'; artifact: Brc29SettlementArtifact }
    | { action: 'terminate'; termination: Termination }
  > {
    const { wallet, originator } = ctx
    const threadId = boundedIdentifier(args.threadId, 'threadId')
    const note = optionalBoundedText(args.note, 'note', MAX_NOTE_LENGTH)

    let option: Brc29OptionTerms
    try {
      option = ensureValidOption(args.option)
    } catch {
      // Options are peer-controlled. Do not reflect parser diagnostics, which
      // can contain wallet/runtime details, into a signed termination.
      return terminate('brc29.invalid_option', 'The selected BRC-29 option is invalid.')
    }

    const amountSatoshis = option.amountSatoshis
    const origin = originator as OriginatorDomainNameStringUnder250Bytes | undefined

    try {
      // Create per-payment derivation values.
      const derivationPrefix = boundedDerivation(
        await this.nonceProvider.createNonce(wallet, 'self', origin),
        'derivationPrefix'
      )
      const derivationSuffix = boundedDerivation(
        await this.nonceProvider.createNonce(wallet, 'self', origin),
        'derivationSuffix'
      )
      // Derive payee public key.
      const protocolID = copyProtocolID(option.protocolID ?? this.protocolID)
      const keyID = `${derivationPrefix} ${derivationSuffix}`
      const keyRequest = { protocolID, keyID, counterparty: option.payee }
      let publicKey: string
      try {
        ;({ publicKey } = validateWalletResult(
          'getPublicKey',
          await wallet.getPublicKey(keyRequest, origin),
          keyRequest
        ))
      } catch {
        return terminate(
          'brc29.public_key_missing',
          'The recipient public key could not be derived safely.'
        )
      }
      const lockingScript = await validatedP2PKHScript(this.lockingScriptProvider, publicKey)
      const createArgs = {
        description: option.description ?? this.description,
        labels: option.labels ?? this.labels,
        outputs: [
          {
            satoshis: amountSatoshis,
            lockingScript,
            customInstructions: JSON.stringify({
              derivationPrefix,
              derivationSuffix,
              protocolID,
              payee: option.payee,
              threadId,
              note
            }),
            outputDescription: this.outputDescription
          }
        ],
        options: {
          randomizeOutputs: false
        }
      }
      const completed = await completeBoundAction(wallet, createArgs, {}, origin)
      const outputIndex = findBoundOutput(completed, amountSatoshis, lockingScript)
      if (option.outputIndex !== undefined && option.outputIndex !== outputIndex) {
        return terminate(
          'brc29.output_index_mismatch',
          'Wallet payment output did not occupy the explicitly requested output index.'
        )
      }
      const transaction = completed.toAtomicBEEF()
      if (transaction.length > MAX_SETTLEMENT_TRANSACTION_BYTES) {
        return terminate(
          'brc29.transaction_too_large',
          'Wallet payment transaction exceeds the remittance transport limit.'
        )
      }

      return {
        action: 'settle',
        artifact: {
          customInstructions: { derivationPrefix, derivationSuffix, protocolID },
          transaction,
          amountSatoshis,
          outputIndex
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('[Brc29RemittanceModule] Failed to build settlement', error)
      return terminate('brc29.build_failed', 'BRC-29 settlement could not be built safely.')
    }
  }

  async acceptSettlement(
    args: {
      threadId: string
      invoice?: import('../types.js').Invoice
      settlement: Brc29SettlementArtifact
      sender: PubKeyHex
    },
    ctx: ModuleContext
  ): Promise<
    | { action: 'accept'; receiptData?: Brc29ReceiptData }
    | { action: 'terminate'; termination: Termination }
  > {
    const { wallet, originator } = ctx
    const origin = originator as OriginatorDomainNameStringUnder250Bytes | undefined
    try {
      const threadId = boundedIdentifier(args.threadId, 'threadId')
      const sender = boundedIdentifier(args.sender, 'sender') as PubKeyHex
      const settlement = ensureValidSettlement(args.settlement)
      const outputIndex = settlement.outputIndex ?? 0
      const protocolID = copyProtocolID(settlement.customInstructions.protocolID ?? this.protocolID)
      if (args.invoice != null) {
        if (args.invoice.threadId !== threadId || args.invoice.payer !== sender) {
          throw new Error('BRC-29 settlement parties do not match the invoice')
        }
        const option = ensureValidOption(args.invoice.options[this.id] as Brc29OptionTerms)
        if (
          option.amountSatoshis !== settlement.amountSatoshis ||
          option.payee !== args.invoice.payee ||
          !sameProtocol(option.protocolID ?? this.protocolID, protocolID)
        ) {
          throw new Error('BRC-29 settlement does not satisfy the invoiced option')
        }
      }

      const keyID = `${settlement.customInstructions.derivationPrefix} ${settlement.customInstructions.derivationSuffix}`
      // BRC-42: the recipient derives its own child key for this sender.
      const keyRequest = { protocolID, keyID, counterparty: sender, forSelf: true }
      const { publicKey } = validateWalletResult(
        'getPublicKey',
        await wallet.getPublicKey(keyRequest, origin),
        keyRequest
      )
      const expectedScript = await validatedP2PKHScript(this.lockingScriptProvider, publicKey)
      validateSettlementOutput(
        settlement.transaction,
        outputIndex,
        settlement.amountSatoshis,
        expectedScript
      )

      const request = {
        tx: settlement.transaction,
        outputs: [
          {
            paymentRemittance: {
              derivationPrefix: settlement.customInstructions.derivationPrefix,
              derivationSuffix: settlement.customInstructions.derivationSuffix,
              senderIdentityKey: sender
            },
            outputIndex,
            protocol: this.internalizeProtocol
          }
        ],
        labels: this.labels,
        description: 'BRC-29 payment received'
      }
      validateWalletResult(
        'internalizeAction',
        await wallet.internalizeAction(request, origin),
        request
      )
      return { action: 'accept', receiptData: { internalizeResult: { accepted: true } } }
    } catch (error) {
      ctx.logger?.warn?.('[Brc29RemittanceModule] Rejected settlement', error)
      return terminate(
        'brc29.internalize_failed',
        'BRC-29 settlement failed recipient, amount, transaction, or wallet validation.'
      )
    }
  }
}

function terminate(
  code: string,
  message: string,
  details?: unknown
): { action: 'terminate'; termination: Termination } {
  return { action: 'terminate', termination: { code, message, details } }
}

function ensureValidOption(option: Brc29OptionTerms): Brc29OptionTerms {
  const source = dataRecord(option, 'BRC-29 option terms')
  const outputIndex = optionalUint32(source.outputIndex, 'outputIndex')
  const protocolID =
    source.protocolID === undefined
      ? undefined
      : copyProtocolID(source.protocolID as WalletProtocol)
  const labels = source.labels === undefined ? undefined : copyLabels(source.labels as string[])
  return {
    amountSatoshis: satoshis(source.amountSatoshis, 'amountSatoshis'),
    payee: boundedIdentifier(source.payee, 'payee') as PubKeyHex,
    outputIndex,
    protocolID,
    labels,
    description: optionalBoundedText(source.description, 'description')
  }
}

function ensureValidSettlement(settlement: Brc29SettlementArtifact): Brc29SettlementArtifact {
  const source = dataRecord(settlement, 'BRC-29 settlement artifact')
  const instructions = dataRecord(source.customInstructions, 'BRC-29 settlement customInstructions')
  const derivationPrefix = boundedDerivation(instructions.derivationPrefix, 'derivationPrefix')
  const derivationSuffix = boundedDerivation(instructions.derivationSuffix, 'derivationSuffix')
  const transaction = toPortableTransaction(source.transaction)
  if (
    transaction == null ||
    transaction.length === 0 ||
    transaction.length > MAX_SETTLEMENT_TRANSACTION_BYTES
  ) {
    throw new Error('BRC-29 settlement transaction must be a bounded byte array')
  }
  return {
    customInstructions: {
      derivationPrefix,
      derivationSuffix,
      protocolID:
        instructions.protocolID === undefined
          ? undefined
          : copyProtocolID(instructions.protocolID as WalletProtocol)
    },
    transaction: transaction.slice(),
    amountSatoshis: satoshis(source.amountSatoshis, 'amountSatoshis'),
    outputIndex: optionalUint32(source.outputIndex, 'outputIndex')
  }
}

function toPortableTransaction(tx: unknown): number[] | undefined {
  const bytes = toBRC100PortableByteArray(tx)
  return bytes != null && bytes.length > 0 ? bytes.slice() : undefined
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || descriptor == null || !('value' in descriptor)) {
      throw new TypeError(`${label} must contain only string-keyed data properties`)
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return snapshot
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError(`${label} must be a bounded non-empty identifier`)
  }
  return value
}

function boundedText(value: unknown, label: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`${label} must be a bounded non-empty string`)
  }
  return value
}

function optionalBoundedText(
  value: unknown,
  label: string,
  max = MAX_IDENTIFIER_LENGTH
): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, max)
}

function boundedDerivation(value: unknown, label: string): string {
  const derivation = boundedIdentifier(value, label)
  if (derivation.length > 399 || /\s/.test(derivation)) {
    throw new TypeError(`${label} must be a bounded non-whitespace derivation value`)
  }
  return derivation
}

function satoshis(value: unknown, label: string, allowZero = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > MAX_SATOSHIS
  ) {
    throw new TypeError(`${label} must be a valid satoshi amount`)
  }
  return value
}

function optionalUint32(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new TypeError(`${label} must be a uint32`)
  }
  return value
}

function copyProtocolID(value: WalletProtocol): WalletProtocol {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('protocolID must be a [securityLevel, protocolName] tuple')
  }
  const [securityLevel, protocolName] = value
  if (
    (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) ||
    typeof protocolName !== 'string' ||
    protocolName.length < 5 ||
    protocolName.length > MAX_PROTOCOL_NAME_LENGTH
  ) {
    throw new TypeError('protocolID must use a valid security level and bounded protocol name')
  }
  return [securityLevel, protocolName]
}

function sameProtocol(left: WalletProtocol, right: WalletProtocol): boolean {
  return left[0] === right[0] && left[1] === right[1]
}

function copyLabels(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_LABELS) {
    throw new TypeError('labels must be a bounded dense string array')
  }
  const copy: string[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || !('value' in descriptor)) {
      throw new TypeError('labels must be a bounded dense string array')
    }
    copy.push(boundedText(descriptor.value, `labels[${index}]`, MAX_LABEL_LENGTH))
  }
  return copy
}

function scriptHex(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 20_000 ||
    !/^(?:[0-9a-f]{2})+$/i.test(value)
  ) {
    throw new TypeError(`${label} must be bounded even-length hexadecimal data`)
  }
  return value.toLowerCase()
}

async function validatedP2PKHScript(
  provider: LockingScriptProvider,
  publicKey: string
): Promise<string> {
  const canonicalKey = PublicKey.fromString(publicKey).toString()
  const candidate = scriptHex(
    await provider.pubKeyToP2PKHLockingScript(canonicalKey),
    'P2PKH locking script'
  )
  const expected = scriptHex(
    await DefaultLockingScriptProvider.pubKeyToP2PKHLockingScript(canonicalKey),
    'Expected P2PKH locking script'
  )
  if (candidate !== expected) {
    throw new Error('Locking script provider substituted a non-P2PKH recipient script')
  }
  return candidate
}

function findBoundOutput(transaction: Transaction, amount: number, script: string): number {
  const matches: number[] = []
  for (let index = 0; index < transaction.outputs.length; index++) {
    const output = transaction.outputs[index]
    if (
      output.satoshis === amount &&
      output.lockingScript.toHex().toLowerCase() === script.toLowerCase()
    ) {
      matches.push(index)
    }
  }
  if (matches.length !== 1) {
    throw new Error('Wallet transaction must contain exactly one requested payment output')
  }
  return matches[0]
}

function validateSettlementOutput(
  bytes: number[],
  outputIndex: number,
  amount: number,
  script: string
): void {
  const transaction = Transaction.fromAtomicBEEF(bytes)
  const output = transaction.outputs[outputIndex]
  if (
    output == null ||
    output.satoshis !== amount ||
    output.lockingScript.toHex().toLowerCase() !== script.toLowerCase()
  ) {
    throw new Error('Settlement output does not pay the claimed amount to the derived recipient')
  }
}
