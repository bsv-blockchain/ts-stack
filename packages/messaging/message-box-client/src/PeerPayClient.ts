/**
 * PeerPayClient
 *
 * Extends `MessageBoxClient` to enable Bitcoin payments using the MetaNet identity system.
 *
 * This client handles payment token creation, message transmission over HTTP/WebSocket,
 * payment reception (including acceptance and rejection logic), and listing of pending payments.
 *
 * It uses authenticated and encrypted message transmission to ensure secure payment flows
 * between identified peers on the BSV network.
 */

import { AuthFetch } from '@bsv/sdk/auth/clients/AuthFetch'
import { createNonce } from '@bsv/sdk/auth/utils/createNonce'
import PublicKey from '@bsv/sdk/primitives/PublicKey'
import { Brc29RemittanceModule } from '@bsv/sdk/remittance/modules/BasicBRC29'
import {
  normalizeBRC100ByteArray,
  stringifyBRC100,
  toBRC100PortableByteArray
} from '@bsv/sdk/wallet/BRC100ByteEncoding'
import type {
  AtomicBEEF,
  Base64String,
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '@bsv/sdk/wallet/Wallet.interfaces'
import { validateBase64String } from '@bsv/sdk/wallet/validationHelpers'
import { MessageBoxClient } from './MessageBoxClient.js'
import {
  DEFAULT_PAYMENT_REQUEST_MAX_AMOUNT,
  DEFAULT_PAYMENT_REQUEST_MIN_AMOUNT,
  type IncomingPaymentRequest,
  type PaymentRequestLimits,
  type PaymentRequestMessage,
  type PaymentRequestResponse,
  type PeerMessage
} from './types.js'
import * as Logger from './Utils/logger.js'
import { decodePeerPayTransaction } from './Utils/peerPayTransaction.js'

function hexToBytes(hex: string): number[] {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new TypeError('Payment request proof must be a canonical 32-byte hexadecimal string')
  }
  return hex.match(/.{2}/g)!.map(byte => Number.parseInt(byte, 16))
}

function safeParse<T>(input: any): T | undefined {
  try {
    return typeof input === 'string' ? JSON.parse(input) : input
  } catch {
    Logger.error('[PP CLIENT] Failed to parse an untrusted message body')
    return undefined
  }
}

export const STANDARD_PAYMENT_MESSAGEBOX = 'payment_inbox'
export const PAYMENT_REQUESTS_MESSAGEBOX = 'payment_requests'
export const PAYMENT_REQUEST_RESPONSES_MESSAGEBOX = 'payment_request_responses'
const STANDARD_PAYMENT_OUTPUT_INDEX = 0
const MAX_INCOMING_PAYMENTS = 1_000
const MAX_INCOMING_PAYMENT_PAGES = 10
const MAX_PAYMENT_TRANSACTION_BYTES = 64 * 1024 * 1024
const MAX_MESSAGE_ID_BYTES = 1_024
const MAX_PAYMENT_REQUEST_TEXT_BYTES = 1_024
const MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES = 2_000

type PlainRecord = Record<string, unknown>

function dataRecord(value: unknown): PlainRecord | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const result = Object.create(null) as PlainRecord
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || descriptor == null || !('value' in descriptor)) return undefined
    result[key] = descriptor.value
  }
  return result
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })
}

function boundedMessageId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_MESSAGE_ID_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new TypeError('Incoming payment message ID is invalid')
  }
  return value
}

function boundedPaymentRequestText(
  value: unknown,
  name: string,
  maximum = MAX_PAYMENT_REQUEST_TEXT_BYTES
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`Payment request ${name} is invalid`)
  }
  return value
}

function canonicalIdentityKey(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Incoming payment sender is invalid')
  }
  try {
    if (PublicKey.fromString(value).toString() !== value) {
      throw new TypeError('Incoming payment sender is invalid')
    }
  } catch {
    throw new TypeError('Incoming payment sender is invalid')
  }
  return value
}

function normalizePaymentParams(value: unknown): PaymentParams {
  const payment = dataRecord(value)
  if (payment == null) throw new TypeError('Invalid payment details')
  const recipient = canonicalIdentityKey(payment.recipient)
  if (
    typeof payment.amount !== 'number' ||
    !Number.isSafeInteger(payment.amount) ||
    payment.amount <= 0
  ) {
    throw new TypeError('Invalid payment details: recipient and valid amount are required')
  }
  return { recipient, amount: payment.amount }
}

function normalizePaymentToken(value: unknown, allowBase64 = false): PaymentToken {
  const token = dataRecord(value)
  const customInstructions = dataRecord(token?.customInstructions)
  if (token == null || customInstructions == null) {
    throw new TypeError('Incoming payment token is invalid')
  }
  const transaction =
    allowBase64 && typeof token.transaction === 'string'
      ? decodePeerPayTransaction(token.transaction, MAX_PAYMENT_TRANSACTION_BYTES)
      : normalizeBRC100ByteArray(token.transaction)
  if (
    transaction == null ||
    transaction.length === 0 ||
    transaction.length > MAX_PAYMENT_TRANSACTION_BYTES
  ) {
    throw new TypeError('Incoming payment transaction is invalid')
  }
  if (
    typeof token.amount !== 'number' ||
    !Number.isSafeInteger(token.amount) ||
    token.amount <= 0
  ) {
    throw new TypeError('Incoming payment amount is invalid')
  }
  const outputIndex = token.outputIndex ?? STANDARD_PAYMENT_OUTPUT_INDEX
  if (
    typeof outputIndex !== 'number' ||
    !Number.isSafeInteger(outputIndex) ||
    outputIndex < 0 ||
    outputIndex > 0xffffffff
  ) {
    throw new TypeError('Incoming payment output index is invalid')
  }
  return {
    customInstructions: {
      derivationPrefix: validateBase64String(
        customInstructions.derivationPrefix as string,
        'derivationPrefix'
      ),
      derivationSuffix: validateBase64String(
        customInstructions.derivationSuffix as string,
        'derivationSuffix'
      )
    },
    transaction: Array.from(transaction),
    amount: token.amount,
    outputIndex
  }
}

function paymentFromMessage(value: unknown): IncomingPayment | null {
  const message = dataRecord(value)
  if (message == null) return null
  let body: unknown = message.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as unknown
    } catch {
      return null
    }
  }
  const payment = dataRecord(body)
  if (payment == null || (payment.sender != null && payment.sender !== message.sender)) return null
  try {
    return {
      messageId: boundedMessageId(message.messageId),
      sender: canonicalIdentityKey(message.sender),
      token: normalizePaymentToken(payment, true)
    }
  } catch {
    return null
  }
}

interface ParsedPaymentRequest {
  messageId: string
  sender: string
  body: PaymentRequestMessage
}

function paymentRequestFromMessage(value: unknown): ParsedPaymentRequest | null {
  const message = dataRecord(value)
  if (message == null) return null
  let body: unknown = message.body
  if (typeof body === 'string') body = safeParse(body)
  const request = dataRecord(body)
  if (request == null) return null

  try {
    const messageId = boundedMessageId(message.messageId)
    const sender = canonicalIdentityKey(message.sender)
    if (request.senderIdentityKey !== sender) return null
    const requestId = boundedPaymentRequestText(request.requestId, 'ID')
    if (typeof request.requestProof !== 'string' || !/^[0-9a-f]{64}$/.test(request.requestProof)) {
      return null
    }
    const common = {
      requestId,
      senderIdentityKey: sender,
      requestProof: request.requestProof
    }
    if (request.cancelled === true) {
      return { messageId, sender, body: { ...common, cancelled: true } }
    }
    if (request.cancelled != null && request.cancelled !== false) return null
    if (
      typeof request.amount !== 'number' ||
      !Number.isSafeInteger(request.amount) ||
      request.amount <= 0 ||
      typeof request.expiresAt !== 'number' ||
      !Number.isSafeInteger(request.expiresAt) ||
      request.expiresAt <= 0
    ) {
      return null
    }
    return {
      messageId,
      sender,
      body: {
        ...common,
        amount: request.amount,
        description: boundedPaymentRequestText(
          request.description,
          'description',
          MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES
        ),
        expiresAt: request.expiresAt
      }
    }
  } catch {
    return null
  }
}

function paymentRequestResponseFromMessage(value: unknown): PaymentRequestResponse | null {
  const message = dataRecord(value)
  if (message == null) return null
  let body: unknown = message.body
  if (typeof body === 'string') body = safeParse(body)
  const response = dataRecord(body)
  if (response == null) return null

  try {
    const messageId = boundedMessageId(message.messageId)
    const sender = canonicalIdentityKey(message.sender)
    const requestId = boundedPaymentRequestText(response.requestId, 'response request ID')
    const note =
      response.note == null
        ? undefined
        : boundedPaymentRequestText(
            response.note,
            'response note',
            MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES
          )
    if (response.status === 'declined') {
      return {
        messageId,
        sender,
        requestId,
        status: 'declined',
        ...(note == null ? {} : { note })
      }
    }
    if (
      response.status !== 'paid' ||
      typeof response.amountPaid !== 'number' ||
      !Number.isSafeInteger(response.amountPaid) ||
      response.amountPaid <= 0
    ) {
      return null
    }
    return {
      messageId,
      sender,
      requestId,
      status: 'paid',
      amountPaid: response.amountPaid,
      ...(note == null ? {} : { note })
    }
  } catch {
    return null
  }
}

function normalizePaymentRequestLimits(
  limits?: PaymentRequestLimits
): Required<PaymentRequestLimits> {
  const normalizedLimits = limits == null ? undefined : dataRecord(limits)
  if (limits != null && normalizedLimits == null) {
    throw new TypeError('Payment request limits are invalid')
  }
  const minAmount: unknown = normalizedLimits?.minAmount ?? DEFAULT_PAYMENT_REQUEST_MIN_AMOUNT
  const maxAmount: unknown = normalizedLimits?.maxAmount ?? DEFAULT_PAYMENT_REQUEST_MAX_AMOUNT
  if (
    typeof minAmount !== 'number' ||
    !Number.isSafeInteger(minAmount) ||
    minAmount < 0 ||
    typeof maxAmount !== 'number' ||
    !Number.isSafeInteger(maxAmount) ||
    maxAmount <= 0 ||
    minAmount > maxAmount
  ) {
    throw new TypeError('Payment request limits are invalid')
  }
  return { minAmount, maxAmount }
}

interface PaymentRequestClassification {
  active: IncomingPaymentRequest[]
  expiredMessageIds: string[]
  outOfRangeMessageIds: string[]
  cancelledOriginalMessageIds: string[]
  malformedMessageIds: string[]
}

/**
 * Configuration options for initializing PeerPayClient.
 */
export interface PeerPayClientConfig {
  messageBoxHost?: string
  messageBox?: string
  walletClient: WalletInterface
  enableLogging?: boolean // Added optional logging flag,
  originator?: OriginatorDomainNameStringUnder250Bytes
}

/**
 * Represents the parameters required to initiate a payment.
 */
export interface PaymentParams {
  recipient: string
  amount: number
}

/**
 * Represents a structured payment token.
 */
export interface PaymentToken {
  customInstructions: {
    derivationPrefix: Base64String
    derivationSuffix: Base64String
  }
  transaction: AtomicBEEF
  amount: number
  outputIndex?: number
}

/**
 * Represents an incoming payment received via MessageBox.
 */
export interface IncomingPayment {
  messageId: string
  sender: string
  token: PaymentToken
  outputIndex?: number
}

/**
 * PeerPayClient enables peer-to-peer Bitcoin payments using MessageBox.
 */
export class PeerPayClient extends MessageBoxClient {
  private readonly peerPayWalletClient: WalletInterface
  private _authFetchInstance?: AuthFetch
  private readonly messageBox: string
  private readonly settlementModule: Brc29RemittanceModule
  private readonly activePaymentRequestMutations = new Set<string>()

  constructor(config: PeerPayClientConfig) {
    const {
      messageBoxHost = 'https://message-box-us-1.bsvb.tech',
      walletClient,
      enableLogging = false,
      originator
    } = config

    // 🔹 Pass enableLogging to MessageBoxClient
    super({ host: messageBoxHost, walletClient, enableLogging, originator })

    this.messageBox = config.messageBox ?? STANDARD_PAYMENT_MESSAGEBOX
    this.peerPayWalletClient = walletClient
    this.originator = originator

    this.settlementModule = new Brc29RemittanceModule({
      protocolID: [2, '3241645161d8'],
      labels: ['peerpay'],
      description: 'PeerPay payment',
      outputDescription: 'Payment for PeerPay transaction',
      internalizeProtocol: 'wallet payment',
      refundFeeSatoshis: 1000,
      minRefundSatoshis: 1000
    })
  }

  private get authFetchInstance(): AuthFetch {
    this._authFetchInstance ??= new AuthFetch(
      this.peerPayWalletClient,
      undefined,
      undefined,
      this.originator
    )
    return this._authFetchInstance
  }

  /**
   * Allows payment requests from a specific identity key by setting
   * the recipientFee to 0 for the payment_requests message box.
   *
   * @param {Object} params - Parameters.
   * @param {string} params.identityKey - The identity key to allow payment requests from.
   * @returns {Promise<void>} Resolves when the permission is set.
   */
  async allowPaymentRequestsFrom({ identityKey }: { identityKey: string }): Promise<void> {
    await this.setMessageBoxPermission({
      messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
      sender: identityKey,
      recipientFee: 0
    })
  }

  /**
   * Blocks payment requests from a specific identity key by setting
   * the recipientFee to -1 for the payment_requests message box.
   *
   * @param {Object} params - Parameters.
   * @param {string} params.identityKey - The identity key to block payment requests from.
   * @returns {Promise<void>} Resolves when the permission is set.
   */
  async blockPaymentRequestsFrom({ identityKey }: { identityKey: string }): Promise<void> {
    await this.setMessageBoxPermission({
      messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
      sender: identityKey,
      recipientFee: -1
    })
  }

  /**
   * Lists all permissions for the payment_requests message box, mapped to
   * a simplified { identityKey, allowed } structure.
   *
   * A permission is considered "allowed" if recipientFee >= 0 (0 = always allow,
   * positive = payment required). A recipientFee of -1 means blocked.
   *
   * @returns {Promise<Array<{ identityKey: string, allowed: boolean }>>} Resolved with the list of permissions.
   */
  async listPaymentRequestPermissions(): Promise<Array<{ identityKey: string; allowed: boolean }>> {
    const permissions = await this.listMessageBoxPermissions({
      messageBox: PAYMENT_REQUESTS_MESSAGEBOX
    })
    // Filter to only per-sender entries (sender is not null/empty).
    // Use the status field returned by the server to determine allowed state.
    return permissions
      .filter(p => p.sender != null && p.sender !== '')
      .map(p => ({
        identityKey: p.sender ?? '',
        allowed: p.status !== 'blocked'
      }))
  }

  /**
   * Generates a valid payment token for a recipient.
   *
   * This function derives a unique public key for the recipient, constructs a P2PKH locking script,
   * and creates a payment action with the specified amount.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @returns {Promise<PaymentToken>} A valid payment token containing transaction details.
   * @throws {Error} If the recipient's public key cannot be derived.
   */
  async createPaymentToken(payment: PaymentParams): Promise<PaymentToken> {
    const normalizedPayment = normalizePaymentParams(payment)

    const settlement = dataRecord(
      await this.settlementModule.buildSettlement(
        {
          threadId: 'peerpay',
          option: {
            amountSatoshis: normalizedPayment.amount,
            payee: normalizedPayment.recipient,
            labels: ['peerpay'],
            description: 'PeerPay payment'
          }
        },
        {
          wallet: this.peerPayWalletClient,
          originator: this.originator,
          now: () => Date.now(),
          logger: Logger
        }
      )
    )

    if (settlement?.action === 'terminate') {
      const termination = dataRecord(settlement.termination)
      if (termination?.code === 'brc29.public_key_missing') {
        throw new Error('Failed to derive recipient’s public key')
      }
      throw new Error(
        boundedPaymentRequestText(
          termination?.message,
          'settlement termination message',
          MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES
        )
      )
    }
    if (settlement?.action !== 'settle') {
      throw new Error('Payment settlement module did not produce a settlement')
    }

    Logger.log('[PP CLIENT] Payment settlement artifact created')

    const artifact = dataRecord(settlement.artifact)
    const normalizedArtifact = normalizePaymentToken({
      customInstructions: artifact?.customInstructions,
      transaction: artifact?.transaction,
      amount: artifact?.amountSatoshis
    })
    return {
      customInstructions: normalizedArtifact.customInstructions,
      transaction: normalizedArtifact.transaction as AtomicBEEF,
      amount: normalizedArtifact.amount
    }
  }

  /**
   * Sends Bitcoin to a PeerPay recipient.
   *
   * This function validates the payment details and delegates the transaction
   * to `sendLivePayment` for processing.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @returns {Promise<any>} Resolves with the payment result.
   * @throws {Error} If the recipient is missing or the amount is invalid.
   */
  async sendPayment(payment: PaymentParams, hostOverride?: string): Promise<any> {
    const normalizedPayment = normalizePaymentParams(payment)

    const paymentToken = await this.createPaymentToken(normalizedPayment)

    // Ensure the recipient is included before sendings
    await this.sendMessage(
      {
        recipient: normalizedPayment.recipient,
        messageBox: this.messageBox,
        body: stringifyBRC100(paymentToken)
      },
      hostOverride
    )
  }

  /**
   * Sends Bitcoin to a PeerPay recipient over WebSockets.
   *
   * This function generates a payment token and transmits it over WebSockets
   * using `sendLiveMessage`. The recipient's identity key is explicitly included
   * to ensure proper message routing.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @param {string} [overrideHost] - Optional host override for WebSocket connection.
   * @returns {Promise<void>} Resolves when the payment has been sent.
   * @throws {Error} If payment token generation fails.
   */
  async sendLivePayment(payment: PaymentParams, overrideHost?: string): Promise<void> {
    const normalizedPayment = normalizePaymentParams(payment)
    const paymentToken = await this.createPaymentToken(normalizedPayment)

    try {
      // Attempt WebSocket first
      await this.sendLiveMessage(
        {
          recipient: normalizedPayment.recipient,
          messageBox: this.messageBox,
          body: stringifyBRC100(paymentToken)
        },
        overrideHost
      )
    } catch {
      Logger.warn('[PP CLIENT] Live send failed; falling back to HTTP')

      // Fallback to HTTP if WebSocket fails
      await this.sendMessage(
        {
          recipient: normalizedPayment.recipient,
          messageBox: this.messageBox,
          body: stringifyBRC100(paymentToken)
        },
        overrideHost
      )
    }
  }

  /**
   * Listens for incoming Bitcoin payments over WebSockets.
   *
   * This function listens for messages in the standard payment message box and
   * converts incoming `PeerMessage` objects into `IncomingPayment` objects
   * before invoking the `onPayment` callback.
   *
   * @param {Object} obj - The configuration object.
   * @param {Function} obj.onPayment - Callback function triggered when a payment is received.
   * @param {string} [obj.overrideHost] - Optional host override for WebSocket connection.
   * @returns {Promise<void>} Resolves when the listener is successfully set up.
   */
  async listenForLivePayments({
    onPayment,
    overrideHost
  }: {
    onPayment: (payment: IncomingPayment) => void
    overrideHost?: string
  }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: this.messageBox,
      overrideHost,

      // Convert PeerMessage → IncomingPayment before calling onPayment
      onMessage: (message: PeerMessage) => {
        const incomingPayment = paymentFromMessage(message)
        if (incomingPayment == null) return
        onPayment(incomingPayment)
      }
    })
  }

  /**
   * Accepts an incoming Bitcoin payment and moves it into the default wallet basket.
   *
   * This function processes a received payment by submitting it for internalization
   * using the wallet client's `internalizeAction` method. The payment details
   * are extracted from the `IncomingPayment` object.
   *
   * @param {IncomingPayment} payment - The payment object containing transaction details.
   * @returns {Promise<any>} Resolves with the payment result if successful.
   * @throws {Error} If payment processing fails.
   */
  async acceptPayment(payment: IncomingPayment): Promise<any> {
    const messageId = boundedMessageId(payment?.messageId)
    return await this.withPaymentMutation(messageId, async () => {
      const incoming = await this.resolveFreshIncomingPayment(messageId)
      const result = await this.internalizePayment(incoming)
      try {
        await this.acknowledgeMessage({ messageIds: [incoming.messageId] })
      } catch {
        // Funds are already in local custody. A later retry may acknowledge the
        // message, but must not report the completed wallet mutation as a failure.
        Logger.warn('[PP CLIENT] Payment was accepted but acknowledgement failed')
      }
      return result
    })
  }

  private async withPaymentMutation<T>(messageId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activePaymentRequestMutations.has(messageId)) {
      throw new Error('Payment message is already being processed by this client')
    }
    this.activePaymentRequestMutations.add(messageId)
    try {
      return await operation()
    } finally {
      this.activePaymentRequestMutations.delete(messageId)
    }
  }

  private async resolveFreshIncomingPayment(messageId: unknown): Promise<IncomingPayment> {
    const requestedMessageId = boundedMessageId(messageId)
    const matches = await this.findIncomingPaymentsByMessageId(requestedMessageId)
    if (matches.length !== 1) {
      throw new Error('Incoming payment is not present exactly once in the authenticated inbox')
    }
    return matches[0]
  }

  /** Performs a bounded indexed lookup instead of scanning the whole inbox. */
  async findIncomingPaymentsByMessageId(
    messageId: string,
    overrideHost?: string
  ): Promise<IncomingPayment[]> {
    const requestedMessageId = boundedMessageId(messageId)
    const messages = await this.listMessagesLite({
      messageBox: this.messageBox,
      host: overrideHost,
      messageId: requestedMessageId,
      limit: 2,
      pageSize: 2,
      maxPages: 1
    })
    return messages.flatMap(message => {
      if (message.messageId !== requestedMessageId) return []
      const payment = paymentFromMessage(message)
      return payment == null ? [] : [payment]
    })
  }

  private async internalizePayment(
    payment: IncomingPayment
  ): Promise<{ payment: IncomingPayment; paymentResult: unknown }> {
    Logger.log('[PP CLIENT] Processing an authenticated payment')

    const transaction = toBRC100PortableByteArray(payment.token.transaction)
    if (transaction == null || transaction.length === 0) {
      throw new Error('Payment transaction must be a non-empty BRC-100 byte array')
    }

    const acceptResult = dataRecord(
      await this.settlementModule.acceptSettlement(
        {
          threadId: 'peerpay',
          sender: payment.sender,
          settlement: {
            customInstructions: {
              derivationPrefix: payment.token.customInstructions.derivationPrefix,
              derivationSuffix: payment.token.customInstructions.derivationSuffix
            },
            transaction,
            amountSatoshis: payment.token.amount,
            outputIndex: payment.token.outputIndex ?? STANDARD_PAYMENT_OUTPUT_INDEX
          }
        },
        {
          wallet: this.peerPayWalletClient,
          originator: this.originator,
          now: () => Date.now(),
          logger: Logger
        }
      )
    )

    if (acceptResult?.action === 'terminate') {
      const termination = dataRecord(acceptResult.termination)
      throw new Error(
        boundedPaymentRequestText(
          termination?.message,
          'settlement termination message',
          MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES
        )
      )
    }
    if (acceptResult?.action !== 'accept') {
      throw new Error('Payment settlement module did not accept the payment')
    }

    const receiptData = dataRecord(acceptResult.receiptData)
    const paymentResult = dataRecord(receiptData?.internalizeResult)
    if (paymentResult?.accepted !== true) {
      throw new Error('Wallet did not accept the payment.')
    }

    Logger.log('[PP CLIENT] Payment internalized successfully')
    return { payment, paymentResult }
  }

  /**
   * Rejects an incoming Bitcoin payment by refunding it to the sender, minus a fee.
   *
   * If the payment amount is too small (less than 1000 satoshis after deducting the fee),
   * the payment is simply acknowledged and ignored. Otherwise, the function first accepts
   * the payment, then sends a new transaction refunding the sender, and acknowledges
   * only after the refund send succeeds. Internalization failure prevents the refund.
   * This ordering is not a durable refund journal; reconcile uncertain send outcomes
   * before retrying, because the current protocol provides no exactly-once refund guarantee.
   *
   * @param {IncomingPayment} payment - The payment object containing transaction details.
   * @returns {Promise<void>} Resolves when the payment is either acknowledged or refunded.
   */
  async rejectPayment(payment: IncomingPayment): Promise<void> {
    const messageId = boundedMessageId(payment?.messageId)
    await this.withPaymentMutation(messageId, async () => {
      await this.rejectPaymentWithoutLock(messageId)
    })
  }

  private async rejectPaymentWithoutLock(messageId: string): Promise<void> {
    const incoming = await this.resolveFreshIncomingPayment(messageId)

    if (incoming.token.amount - 1000 < 1000) {
      Logger.log('[PP CLIENT] Payment amount too small after fee, just acknowledging.')

      try {
        Logger.log('[PP CLIENT] Attempting to acknowledge a small payment message...')
        if (this.authFetch === null || this.authFetch === undefined) {
          Logger.warn(
            '[PP CLIENT] Warning: authFetch is undefined! Ensure PeerPayClient is initialized correctly.'
          )
        }
        await this.acknowledgeMessage({ messageIds: [incoming.messageId] })
        Logger.log('[PP CLIENT] Small payment message acknowledged')
      } catch (error: any) {
        if (
          error != null &&
          typeof error === 'object' &&
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string' &&
          (error as { message: string }).message.includes('401')
        ) {
          Logger.warn('[PP CLIENT] Authentication failed while acknowledging a payment')
        } else {
          Logger.error('[PP CLIENT] Error acknowledging a payment message')
          throw error // Only throw if it's another type of error
        }
      }

      return
    }

    Logger.log('[PP CLIENT] Accepting payment before refunding...')
    await this.internalizePayment(incoming)

    Logger.log('[PP CLIENT] Sending authenticated payment refund...')
    await this.sendPayment({
      recipient: incoming.sender,
      amount: incoming.token.amount - 1000 // Deduct fee
    })

    Logger.log('[PP CLIENT] Payment successfully rejected and refunded.')

    try {
      Logger.log('[PP CLIENT] Acknowledging payment message after refunding...')
      await this.acknowledgeMessage({ messageIds: [incoming.messageId] })
      Logger.log('[PP CLIENT] Acknowledgment after refund successful.')
    } catch {
      Logger.error('[PP CLIENT] Error acknowledging a refunded payment message')
    }
  }

  /**
   * Retrieves a list of incoming Bitcoin payments from the message box.
   *
   * This function queries the message box for new messages and transforms
   * them into `IncomingPayment` objects by extracting relevant fields.
   *
   * @param {string} [overrideHost] - Optional host override to list payments from
   * @returns {Promise<IncomingPayment[]>} Resolves with an array of pending payments.
   */
  async listIncomingPayments(overrideHost?: string): Promise<IncomingPayment[]> {
    const messages = await this.listMessages({
      messageBox: this.messageBox,
      host: overrideHost,
      limit: MAX_INCOMING_PAYMENTS,
      pageSize: 100,
      maxPages: MAX_INCOMING_PAYMENT_PAGES
    })
    if (!Array.isArray(messages) || messages.length > MAX_INCOMING_PAYMENTS) {
      throw new Error('Incoming payment collection exceeds the configured limit')
    }
    return messages.flatMap(message => {
      const payment = paymentFromMessage(message)
      return payment == null ? [] : [payment]
    })
  }

  /**
   * Lists all responses to payment requests from the payment_request_responses message box.
   *
   * Retrieves messages and parses each as a PaymentRequestResponse.
   *
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @returns {Promise<PaymentRequestResponse[]>} Resolves with an array of payment request responses.
   */
  async listPaymentRequestResponses(hostOverride?: string): Promise<PaymentRequestResponse[]> {
    const messages = await this.listMessages({
      messageBox: PAYMENT_REQUEST_RESPONSES_MESSAGEBOX,
      host: hostOverride,
      limit: MAX_INCOMING_PAYMENTS,
      pageSize: 100,
      maxPages: MAX_INCOMING_PAYMENT_PAGES
    })
    if (!Array.isArray(messages) || messages.length > MAX_INCOMING_PAYMENTS) {
      throw new Error('Payment request response collection exceeds the configured limit')
    }
    return messages.flatMap(message => {
      const response = paymentRequestResponseFromMessage(message)
      return response == null ? [] : [response]
    })
  }

  /**
   * Listens for incoming payment requests in real time via WebSocket.
   *
   * Wraps listenForLiveMessages on the payment_requests box and converts each
   * incoming PeerMessage into an IncomingPaymentRequest before calling onRequest.
   *
   * @param {Object} params - Listener configuration.
   * @param {Function} params.onRequest - Callback invoked when a new payment request arrives.
   * @param {string} [params.overrideHost] - Optional host override for the WebSocket connection.
   * @returns {Promise<void>} Resolves when the listener is established.
   */
  async listenForLivePaymentRequests({
    onRequest,
    overrideHost
  }: {
    onRequest: (request: IncomingPaymentRequest) => void
    overrideHost?: string
  }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
      overrideHost,
      onMessage: (message: PeerMessage) => {
        const item = paymentRequestFromMessage(message)
        if (item == null || item.body.cancelled === true || item.body.expiresAt <= Date.now())
          return
        const body = item.body
        return this.getIdentityKey().then(async identityKey => {
          try {
            await this.verifyPaymentRequestProof(item, canonicalIdentityKey(identityKey))
            const { requestId, amount, description, expiresAt } = body
            onRequest({
              messageId: item.messageId,
              sender: item.sender,
              requestId,
              amount,
              description,
              expiresAt
            })
          } catch {
            Logger.warn('[PP CLIENT] Discarding an unauthenticated live payment request')
          }
        })
      }
    })
  }

  /**
   * Listens for payment request responses in real time via WebSocket.
   *
   * Wraps listenForLiveMessages on the payment_request_responses box and converts each
   * incoming PeerMessage into a PaymentRequestResponse before calling onResponse.
   *
   * @param {Object} params - Listener configuration.
   * @param {Function} params.onResponse - Callback invoked when a new response arrives.
   * @param {string} [params.overrideHost] - Optional host override for the WebSocket connection.
   * @returns {Promise<void>} Resolves when the listener is established.
   */
  async listenForLivePaymentRequestResponses({
    onResponse,
    overrideHost
  }: {
    onResponse: (response: PaymentRequestResponse) => void
    overrideHost?: string
  }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: PAYMENT_REQUEST_RESPONSES_MESSAGEBOX,
      overrideHost,
      onMessage: (message: PeerMessage) => {
        const response = paymentRequestResponseFromMessage(message)
        if (response == null) return
        onResponse(response)
      }
    })
  }

  /**
   * Fulfills an incoming payment request by sending the requested payment and
   * notifying the requester with a 'paid' response in the payment_request_responses box.
   * Also acknowledges the original request message.
   *
   * @param {Object} params - Fulfillment parameters.
   * @param {IncomingPaymentRequest} params.request - The incoming payment request to fulfill.
   * @param {string} [params.note] - Optional note to include in the response.
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @returns {Promise<void>} Resolves when payment is sent and acknowledgment is complete.
   */
  async fulfillPaymentRequest(
    params: { request: IncomingPaymentRequest; note?: string },
    hostOverride?: string
  ): Promise<void> {
    const fulfillment = dataRecord(params)
    const requestedPayment = dataRecord(fulfillment?.request)
    if (fulfillment == null || requestedPayment == null) {
      throw new TypeError('Payment request fulfillment is invalid')
    }
    const messageId = boundedMessageId(requestedPayment.messageId)
    const note =
      fulfillment.note == null
        ? undefined
        : boundedPaymentRequestText(
            fulfillment.note,
            'response note',
            MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES
          )

    await this.withFreshPaymentRequest(messageId, hostOverride, async request => {
      await this.sendPayment({ recipient: request.sender, amount: request.amount }, hostOverride)

      const response: PaymentRequestResponse = {
        requestId: request.requestId,
        status: 'paid',
        amountPaid: request.amount,
        ...(note != null && { note })
      }

      await this.sendMessage(
        {
          recipient: request.sender,
          messageBox: PAYMENT_REQUEST_RESPONSES_MESSAGEBOX,
          body: stringifyBRC100(response)
        },
        hostOverride
      )

      try {
        await this.acknowledgeMessage({ messageIds: [request.messageId], host: hostOverride })
      } catch {
        Logger.warn('[PP CLIENT] Payment request was fulfilled but acknowledgement failed')
      }
    })
  }

  /**
   * Declines an incoming payment request by notifying the requester with a 'declined'
   * response in the payment_request_responses box and acknowledging the original request.
   *
   * @param {Object} params - Decline parameters.
   * @param {IncomingPaymentRequest} params.request - The incoming payment request to decline.
   * @param {string} [params.note] - Optional note explaining why the request was declined.
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @returns {Promise<void>} Resolves when the response is sent and request is acknowledged.
   */
  async declinePaymentRequest(
    params: { request: IncomingPaymentRequest; note?: string },
    hostOverride?: string
  ): Promise<void> {
    const decline = dataRecord(params)
    const requestedPayment = dataRecord(decline?.request)
    if (decline == null || requestedPayment == null) {
      throw new TypeError('Payment request decline is invalid')
    }
    const messageId = boundedMessageId(requestedPayment.messageId)
    const note =
      decline.note == null
        ? undefined
        : boundedPaymentRequestText(
            decline.note,
            'response note',
            MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES
          )

    await this.withFreshPaymentRequest(messageId, hostOverride, async request => {
      const response: PaymentRequestResponse = {
        requestId: request.requestId,
        status: 'declined',
        ...(note != null && { note })
      }

      await this.sendMessage(
        {
          recipient: request.sender,
          messageBox: PAYMENT_REQUEST_RESPONSES_MESSAGEBOX,
          body: stringifyBRC100(response)
        },
        hostOverride
      )

      try {
        await this.acknowledgeMessage({ messageIds: [request.messageId], host: hostOverride })
      } catch {
        Logger.warn('[PP CLIENT] Payment request was declined but acknowledgement failed')
      }
    })
  }

  /**
   * Sends a payment request to a recipient via the payment_requests message box.
   *
   * Generates a unique requestId using createNonce, looks up the caller's identity key,
   * and sends a PaymentRequestMessage to the recipient.
   *
   * @param {Object} params - Payment request parameters.
   * @param {string} params.recipient - The identity key of the intended payer.
   * @param {number} params.amount - The amount in satoshis being requested (must be > 0).
   * @param {string} params.description - Human-readable reason for the payment request.
   * @param {number} params.expiresAt - Unix timestamp (ms) when the request expires.
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @returns {Promise<{ requestId: string }>} The generated requestId for this request.
   * @throws {Error} If amount is <= 0.
   */
  async requestPayment(
    params: { recipient: string; amount: number; description: string; expiresAt: number },
    hostOverride?: string
  ): Promise<{ requestId: string; requestProof: string }> {
    const request = dataRecord(params)
    if (request == null) throw new TypeError('Payment request is invalid')
    const recipient = canonicalIdentityKey(request.recipient)
    if (
      typeof request.amount !== 'number' ||
      !Number.isSafeInteger(request.amount) ||
      request.amount <= 0
    ) {
      throw new TypeError('Invalid payment request: amount must be a positive safe integer')
    }
    const description = boundedPaymentRequestText(
      request.description,
      'description',
      MAX_PAYMENT_REQUEST_DESCRIPTION_BYTES
    )
    if (
      typeof request.expiresAt !== 'number' ||
      !Number.isSafeInteger(request.expiresAt) ||
      request.expiresAt <= Date.now()
    ) {
      throw new TypeError('Payment request expiry must be a future safe-integer timestamp')
    }

    const requestId = await createNonce(this.peerPayWalletClient, 'self', this.originator)
    const normalizedRequestId = boundedPaymentRequestText(requestId, 'ID')
    const senderIdentityKey = canonicalIdentityKey(await this.getIdentityKey())

    const proofData = Array.from(new TextEncoder().encode(normalizedRequestId + recipient))
    const { hmac } = await this.peerPayWalletClient.createHmac(
      {
        data: proofData,
        protocolID: [2, 'payment request auth'],
        keyID: normalizedRequestId,
        counterparty: recipient
      },
      this.originator
    )
    if (
      !Array.isArray(hmac) ||
      hmac.length !== 32 ||
      !hmac.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      throw new Error('Wallet returned an invalid payment request proof')
    }
    const requestProof = hmac.map(byte => byte.toString(16).padStart(2, '0')).join('')

    const body: PaymentRequestMessage = {
      requestId: normalizedRequestId,
      amount: request.amount,
      description,
      expiresAt: request.expiresAt,
      senderIdentityKey,
      requestProof
    }

    try {
      await this.sendMessage(
        {
          recipient,
          messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
          body: stringifyBRC100(body)
        },
        hostOverride
      )
    } catch (err: any) {
      // Translate HTTP 403 (permission denied) into a user-friendly message.
      if (typeof err?.message === 'string' && err.message.includes('403')) {
        throw new Error("Payment request blocked — you are not on the recipient's whitelist.")
      }
      throw err
    }

    return { requestId: normalizedRequestId, requestProof }
  }

  /**
   * Lists all incoming payment requests from the payment_requests message box.
   *
   * Automatically filters out:
   * - Expired requests (expiresAt < now), which are acknowledged and discarded.
   * - Cancelled requests (a cancellation message with the same requestId exists),
   *   both the original and cancellation messages are acknowledged and discarded.
   * - Out-of-range requests (when limits are provided), which are acknowledged and discarded.
   *
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @param {PaymentRequestLimits} [limits] - Optional min/max satoshi limits for filtering.
   * @returns {Promise<IncomingPaymentRequest[]>} Resolves with active, valid payment requests.
   */
  async listIncomingPaymentRequests(
    hostOverride?: string,
    limits?: PaymentRequestLimits
  ): Promise<IncomingPaymentRequest[]> {
    const normalizedLimits = normalizePaymentRequestLimits(limits)
    const messages = await this.listMessages({
      messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
      host: hostOverride,
      limit: MAX_INCOMING_PAYMENTS,
      pageSize: 100,
      maxPages: MAX_INCOMING_PAYMENT_PAGES
    })
    if (!Array.isArray(messages) || messages.length > MAX_INCOMING_PAYMENTS) {
      throw new Error('Incoming payment request collection exceeds the configured limit')
    }
    const myIdentityKey = canonicalIdentityKey(await this.getIdentityKey())
    const now = Date.now()
    const parsedRequests = this.parsePaymentRequestMessages(messages)
    const cancellations = await this.collectPaymentRequestCancellations(
      parsedRequests.parsed,
      myIdentityKey
    )
    const classified = await this.classifyPaymentRequests(
      parsedRequests.parsed,
      cancellations.cancelledRequests,
      myIdentityKey,
      now,
      normalizedLimits
    )
    const malformedMessageIds = [
      ...parsedRequests.malformedMessageIds,
      ...cancellations.malformedMessageIds,
      ...classified.malformedMessageIds
    ]

    await this.acknowledgePaymentRequestMessages(classified.expiredMessageIds, hostOverride)
    await this.acknowledgePaymentRequestMessages(
      [...classified.cancelledOriginalMessageIds, ...cancellations.cancelMessageIds],
      hostOverride
    )
    await this.acknowledgePaymentRequestMessages(classified.outOfRangeMessageIds, hostOverride)
    await this.acknowledgePaymentRequestMessages(malformedMessageIds, hostOverride)

    return classified.active
  }

  private parsePaymentRequestMessages(messages: PeerMessage[]): {
    parsed: ParsedPaymentRequest[]
    malformedMessageIds: string[]
  } {
    const parsed: ParsedPaymentRequest[] = []
    const malformedMessageIds: string[] = []

    for (const message of messages) {
      const item = paymentRequestFromMessage(message)
      if (item != null) {
        parsed.push(item)
        continue
      }
      try {
        const record = dataRecord(message)
        if (record != null) malformedMessageIds.push(boundedMessageId(record.messageId))
      } catch {
        // Never issue a state-changing acknowledgement for an invalid identifier.
      }
    }
    return { parsed, malformedMessageIds }
  }

  private async verifyPaymentRequestProof(
    item: ParsedPaymentRequest,
    myIdentityKey: string
  ): Promise<void> {
    const proofData = Array.from(new TextEncoder().encode(item.body.requestId + myIdentityKey))
    const result = dataRecord(
      await this.peerPayWalletClient.verifyHmac(
        {
          data: proofData,
          hmac: hexToBytes(item.body.requestProof),
          protocolID: [2, 'payment request auth'],
          keyID: item.body.requestId,
          counterparty: item.sender
        },
        this.originator
      )
    )
    if (result?.valid !== true) throw new Error('Invalid payment request proof')
  }

  private async collectPaymentRequestCancellations(
    parsed: ParsedPaymentRequest[],
    myIdentityKey: string
  ): Promise<{
    cancelledRequests: Map<string, string>
    cancelMessageIds: string[]
    malformedMessageIds: string[]
  }> {
    const cancelledRequests = new Map<string, string>()
    const cancelMessageIds: string[] = []
    const malformedMessageIds: string[] = []

    for (const item of parsed) {
      if (item.body.cancelled !== true) continue
      try {
        await this.verifyPaymentRequestProof(item, myIdentityKey)
        cancelledRequests.set(item.body.requestId, item.sender)
        cancelMessageIds.push(item.messageId)
      } catch {
        Logger.warn('[PP CLIENT] Invalid cancellation proof; discarding request')
        malformedMessageIds.push(item.messageId)
      }
    }
    return { cancelledRequests, cancelMessageIds, malformedMessageIds }
  }

  private async classifyPaymentRequests(
    parsed: ParsedPaymentRequest[],
    cancelledRequests: Map<string, string>,
    myIdentityKey: string,
    now: number,
    limits: Required<PaymentRequestLimits>
  ): Promise<PaymentRequestClassification> {
    const classification: PaymentRequestClassification = {
      active: [],
      expiredMessageIds: [],
      outOfRangeMessageIds: [],
      cancelledOriginalMessageIds: [],
      malformedMessageIds: []
    }
    const duplicateCounts = new Map<string, number>()
    for (const item of parsed) {
      if (item.body.cancelled === true) continue
      const key = `${item.sender}\0${item.body.requestId}`
      duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1)
    }

    for (const item of parsed) {
      if (item.body.cancelled === true) continue
      const { requestId, amount, description, expiresAt } = item.body

      if ((duplicateCounts.get(`${item.sender}\0${requestId}`) ?? 0) !== 1) {
        classification.malformedMessageIds.push(item.messageId)
        continue
      }

      if (expiresAt <= now) {
        classification.expiredMessageIds.push(item.messageId)
        continue
      }
      if (cancelledRequests.has(requestId) && cancelledRequests.get(requestId) === item.sender) {
        classification.cancelledOriginalMessageIds.push(item.messageId)
        continue
      }
      if (amount < limits.minAmount || amount > limits.maxAmount) {
        classification.outOfRangeMessageIds.push(item.messageId)
        continue
      }

      try {
        await this.verifyPaymentRequestProof(item, myIdentityKey)
      } catch {
        Logger.warn('[PP CLIENT] Invalid request proof; discarding request')
        classification.malformedMessageIds.push(item.messageId)
        continue
      }

      classification.active.push({
        messageId: item.messageId,
        sender: item.sender,
        requestId,
        amount,
        description,
        expiresAt
      })
    }
    return classification
  }

  private async acknowledgePaymentRequestMessages(
    messageIds: string[],
    host?: string
  ): Promise<void> {
    if (messageIds.length > 0) {
      await this.acknowledgeMessage({ messageIds, host })
    }
  }

  private async resolveFreshPaymentRequest(
    messageId: string,
    hostOverride?: string
  ): Promise<IncomingPaymentRequest> {
    const matches = (await this.listIncomingPaymentRequests(hostOverride)).filter(
      request => request.messageId === messageId
    )
    if (matches.length !== 1) {
      throw new Error('Payment request is not present exactly once in the authenticated inbox')
    }
    return matches[0]
  }

  private async withFreshPaymentRequest(
    messageId: string,
    hostOverride: string | undefined,
    operation: (request: IncomingPaymentRequest) => Promise<void>
  ): Promise<void> {
    await this.withPaymentMutation(messageId, async () => {
      await operation(await this.resolveFreshPaymentRequest(messageId, hostOverride))
    })
  }

  /**
   * Cancels a previously sent payment request by sending a cancellation message
   * with the same requestId and `cancelled: true`.
   *
   * @param {Object} params - Cancellation parameters.
   * @param {string} params.recipient - The identity key of the recipient of the original request.
   * @param {string} params.requestId - The requestId of the payment request to cancel.
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @returns {Promise<void>} Resolves when the cancellation message has been sent.
   */
  async cancelPaymentRequest(
    params: { recipient: string; requestId: string; requestProof: string },
    hostOverride?: string
  ): Promise<void> {
    const cancellation = dataRecord(params)
    if (cancellation == null) throw new TypeError('Payment request cancellation is invalid')
    const recipient = canonicalIdentityKey(cancellation.recipient)
    const requestId = boundedPaymentRequestText(cancellation.requestId, 'ID')
    if (
      typeof cancellation.requestProof !== 'string' ||
      !/^[0-9a-f]{64}$/.test(cancellation.requestProof)
    ) {
      throw new TypeError('Payment request proof is invalid')
    }
    const senderIdentityKey = canonicalIdentityKey(await this.getIdentityKey())

    const body: PaymentRequestMessage = {
      requestId,
      senderIdentityKey,
      requestProof: cancellation.requestProof,
      cancelled: true
    }

    await this.sendMessage(
      {
        recipient,
        messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
        body: stringifyBRC100(body)
      },
      hostOverride
    )
  }
}
