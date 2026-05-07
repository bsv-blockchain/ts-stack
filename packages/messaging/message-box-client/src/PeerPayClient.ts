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

import { MessageBoxClient } from './MessageBoxClient.js'
import { PeerMessage, PaymentRequestMessage, PaymentRequestResponse, IncomingPaymentRequest, PaymentRequestLimits, DEFAULT_PAYMENT_REQUEST_MIN_AMOUNT, DEFAULT_PAYMENT_REQUEST_MAX_AMOUNT } from './types.js'
import { WalletInterface, AtomicBEEF, AuthFetch, Base64String, OriginatorDomainNameStringUnder250Bytes, Brc29RemittanceModule, createNonce } from '@bsv/sdk'

import * as Logger from './Utils/logger.js'

function toNumberArray (tx: AtomicBEEF): number[] {
  return Array.isArray(tx) ? tx : Array.from(tx)
}

function hexToBytes (hex: string): number[] {
  const matches = hex.match(/.{1,2}/g)
  return (matches ?? []).map(byte => Number.parseInt(byte, 16))
}

function safeParse<T> (input: any): T | undefined {
  try {
    return typeof input === 'string' ? JSON.parse(input) : input
  } catch (e) {
    Logger.error('[PP CLIENT] Failed to parse input in safeParse:', input)
    return undefined
  }
}

/**
 * Validates that a parsed object has the required fields for a PaymentRequestMessage.
 * Returns true for both new requests (has amount, description, expiresAt) and cancellations (has cancelled: true).
 */
function isValidPaymentRequestMessage (obj: any): obj is PaymentRequestMessage {
  if (typeof obj !== 'object' || obj === null) return false
  if (typeof obj.requestId !== 'string') return false
  if (typeof obj.senderIdentityKey !== 'string') return false
  if (typeof obj.requestProof !== 'string') return false
  if (obj.cancelled === true) return true
  return typeof obj.amount === 'number' && typeof obj.description === 'string' && typeof obj.expiresAt === 'number'
}

export const STANDARD_PAYMENT_MESSAGEBOX = 'payment_inbox'
export const PAYMENT_REQUESTS_MESSAGEBOX = 'payment_requests'
export const PAYMENT_REQUEST_RESPONSES_MESSAGEBOX = 'payment_request_responses'
const STANDARD_PAYMENT_OUTPUT_INDEX = 0

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

  constructor (config: PeerPayClientConfig) {
    const { messageBoxHost = 'https://message-box-us-1.bsvb.tech', walletClient, enableLogging = false, originator } = config

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

  private get authFetchInstance (): AuthFetch {
    this._authFetchInstance ??= new AuthFetch(this.peerPayWalletClient, undefined, undefined, this.originator)
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
  async allowPaymentRequestsFrom ({ identityKey }: { identityKey: string }): Promise<void> {
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
  async blockPaymentRequestsFrom ({ identityKey }: { identityKey: string }): Promise<void> {
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
  async listPaymentRequestPermissions (): Promise<Array<{ identityKey: string, allowed: boolean }>> {
    const permissions = await this.listMessageBoxPermissions({ messageBox: PAYMENT_REQUESTS_MESSAGEBOX })
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
  async createPaymentToken (payment: PaymentParams): Promise<PaymentToken> {
    if (payment.amount <= 0) {
      throw new Error('Invalid payment details: recipient and valid amount are required')
    };

    const result = await this.settlementModule.buildSettlement(
      {
        threadId: 'peerpay',
        option: {
          amountSatoshis: payment.amount,
          payee: payment.recipient,
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

    if (result.action === 'terminate') {
      if (result.termination.code === 'brc29.public_key_missing') {
        throw new Error('Failed to derive recipient’s public key')
      }
      throw new Error(result.termination.message)
    }

    Logger.log('[PP CLIENT] Payment Action Settlement Artifact:', result.artifact)

    return {
      customInstructions: {
        derivationPrefix: result.artifact.customInstructions.derivationPrefix,
        derivationSuffix: result.artifact.customInstructions.derivationSuffix
      },
      transaction: result.artifact.transaction as AtomicBEEF,
      amount: result.artifact.amountSatoshis
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
  async sendPayment (payment: PaymentParams, hostOverride?: string): Promise<any> {
    if (payment.recipient == null || payment.recipient.trim() === '' || payment.amount <= 0) {
      throw new Error('Invalid payment details: recipient and valid amount are required')
    }

    const paymentToken = await this.createPaymentToken(payment)

    // Ensure the recipient is included before sendings
    await this.sendMessage({
      recipient: payment.recipient,
      messageBox: this.messageBox,
      body: JSON.stringify(paymentToken)
    }, hostOverride)
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
  async sendLivePayment (payment: PaymentParams, overrideHost?: string): Promise<void> {
    const paymentToken = await this.createPaymentToken(payment)

    try {
      // Attempt WebSocket first
      await this.sendLiveMessage({
        recipient: payment.recipient,
        messageBox: this.messageBox,
        body: JSON.stringify(paymentToken)
      }, overrideHost)
    } catch (err) {
      Logger.warn('[PP CLIENT] sendLiveMessage failed, falling back to HTTP:', err)

      // Fallback to HTTP if WebSocket fails
      await this.sendMessage({
        recipient: payment.recipient,
        messageBox: this.messageBox,
        body: JSON.stringify(paymentToken)
      }, overrideHost)
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
  async listenForLivePayments ({
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
        Logger.log('[MB CLIENT] Received Live Payment:', message)
        const token = safeParse<PaymentToken>(message.body)
        if (token == null) return
        const incomingPayment: IncomingPayment = {
          messageId: message.messageId,
          sender: message.sender,
          token
        }
        Logger.log('[PP CLIENT] Converted PeerMessage to IncomingPayment:', incomingPayment)
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
  async acceptPayment (payment: IncomingPayment): Promise<any> {
    try {
      Logger.log(`[PP CLIENT] Processing payment: ${JSON.stringify(payment, null, 2)}`)

      const acceptResult = await this.settlementModule.acceptSettlement(
        {
          threadId: 'peerpay',
          sender: payment.sender,
          settlement: {
            customInstructions: {
              derivationPrefix: payment.token.customInstructions.derivationPrefix,
              derivationSuffix: payment.token.customInstructions.derivationSuffix
            },
            transaction: toNumberArray(payment.token.transaction),
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

      if (acceptResult.action === 'terminate') {
        throw new Error(acceptResult.termination.message)
      }

      const paymentResult = acceptResult.receiptData?.internalizeResult

      Logger.log(`[PP CLIENT] Payment internalized successfully: ${JSON.stringify(paymentResult, null, 2)}`)
      Logger.log(`[PP CLIENT] Acknowledging payment with messageId: ${payment.messageId}`)

      await this.acknowledgeMessage({ messageIds: [payment.messageId] })

      return { payment, paymentResult }
    } catch (error) {
      Logger.error(`[PP CLIENT] Error accepting payment: ${String(error)}`)
      return 'Unable to receive payment!'
    }
  }

  /**
   * Rejects an incoming Bitcoin payment by refunding it to the sender, minus a fee.
   *
   * If the payment amount is too small (less than 1000 satoshis after deducting the fee),
   * the payment is simply acknowledged and ignored. Otherwise, the function first accepts
   * the payment, then sends a new transaction refunding the sender.
   *
   * @param {IncomingPayment} payment - The payment object containing transaction details.
   * @returns {Promise<void>} Resolves when the payment is either acknowledged or refunded.
   */
  async rejectPayment (payment: IncomingPayment): Promise<void> {
    Logger.log(`[PP CLIENT] Rejecting payment: ${JSON.stringify(payment, null, 2)}`)

    if (payment.token.amount - 1000 < 1000) {
      Logger.log('[PP CLIENT] Payment amount too small after fee, just acknowledging.')

      try {
        Logger.log(`[PP CLIENT] Attempting to acknowledge message ${payment.messageId}...`)
        if (this.authFetch === null || this.authFetch === undefined) {
          Logger.warn('[PP CLIENT] Warning: authFetch is undefined! Ensure PeerPayClient is initialized correctly.')
        }
        Logger.log('[PP CLIENT] authFetch instance:', this.authFetch)
        const response = await this.acknowledgeMessage({ messageIds: [payment.messageId] })
        Logger.log(`[PP CLIENT] Acknowledgment response: ${response}`)
      } catch (error: any) {
        if (
          error != null &&
          typeof error === 'object' &&
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string' &&
          (error as { message: string }).message.includes('401')
        ) {
          Logger.warn(`[PP CLIENT] Authentication issue while acknowledging: ${(error as { message: string }).message}`)
        } else {
          Logger.error(`[PP CLIENT] Error acknowledging message: ${(error as { message: string }).message}`)
          throw error // Only throw if it's another type of error
        }
      }

      return
    }

    Logger.log('[PP CLIENT] Accepting payment before refunding...')
    await this.acceptPayment(payment)

    Logger.log(`[PP CLIENT] Sending refund of ${payment.token.amount - 1000} to ${payment.sender}...`)
    await this.sendPayment({
      recipient: payment.sender,
      amount: payment.token.amount - 1000 // Deduct fee
    })

    Logger.log('[PP CLIENT] Payment successfully rejected and refunded.')

    try {
      Logger.log(`[PP CLIENT] Acknowledging message ${payment.messageId} after refunding...`)
      await this.acknowledgeMessage({ messageIds: [payment.messageId] })
      Logger.log('[PP CLIENT] Acknowledgment after refund successful.')
    } catch (error: any) {
      Logger.error(`[PP CLIENT] Error acknowledging message after refund: ${(error as { message: string }).message}`)
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
  async listIncomingPayments (overrideHost?: string): Promise<IncomingPayment[]> {
    const messages = await this.listMessages({ messageBox: this.messageBox, host: overrideHost })
    return messages.map((msg: any) => {
      const parsedToken = safeParse<PaymentToken>(msg.body)
      if (parsedToken == null) return null

      return {
        messageId: msg.messageId,
        sender: msg.sender,
        token: parsedToken
      }
    }).filter((p): p is IncomingPayment => p != null)
  }

  /**
   * Lists all responses to payment requests from the payment_request_responses message box.
   *
   * Retrieves messages and parses each as a PaymentRequestResponse.
   *
   * @param {string} [hostOverride] - Optional host override for the message box server.
   * @returns {Promise<PaymentRequestResponse[]>} Resolves with an array of payment request responses.
   */
  async listPaymentRequestResponses (hostOverride?: string): Promise<PaymentRequestResponse[]> {
    const messages = await this.listMessages({ messageBox: PAYMENT_REQUEST_RESPONSES_MESSAGEBOX, host: hostOverride })
    return messages.map((msg: any) => safeParse<PaymentRequestResponse>(msg.body))
      .filter((r): r is PaymentRequestResponse => r != null)
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
  async listenForLivePaymentRequests ({
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
        const body = safeParse<PaymentRequestMessage>(message.body)
        if (body == null || body.cancelled === true) return // Skip cancellations and parse failures
        const request: IncomingPaymentRequest = {
          messageId: message.messageId,
          sender: message.sender,
          requestId: body.requestId,
          amount: body.amount,
          description: body.description,
          expiresAt: body.expiresAt
        }
        onRequest(request)
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
  async listenForLivePaymentRequestResponses ({
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
        const response = safeParse<PaymentRequestResponse>(message.body)
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
  async fulfillPaymentRequest (
    params: { request: IncomingPaymentRequest, note?: string },
    hostOverride?: string
  ): Promise<void> {
    const { request, note } = params

    await this.sendPayment({ recipient: request.sender, amount: request.amount }, hostOverride)

    const response: PaymentRequestResponse = {
      requestId: request.requestId,
      status: 'paid',
      amountPaid: request.amount,
      ...(note != null && { note })
    }

    await this.sendMessage({
      recipient: request.sender,
      messageBox: PAYMENT_REQUEST_RESPONSES_MESSAGEBOX,
      body: JSON.stringify(response)
    }, hostOverride)

    await this.acknowledgeMessage({ messageIds: [request.messageId], host: hostOverride })
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
  async declinePaymentRequest (
    params: { request: IncomingPaymentRequest, note?: string },
    hostOverride?: string
  ): Promise<void> {
    const { request, note } = params

    const response: PaymentRequestResponse = {
      requestId: request.requestId,
      status: 'declined',
      ...(note != null && { note })
    }

    await this.sendMessage({
      recipient: request.sender,
      messageBox: PAYMENT_REQUEST_RESPONSES_MESSAGEBOX,
      body: JSON.stringify(response)
    }, hostOverride)

    await this.acknowledgeMessage({ messageIds: [request.messageId], host: hostOverride })
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
  async requestPayment (
    params: { recipient: string, amount: number, description: string, expiresAt: number },
    hostOverride?: string
  ): Promise<{ requestId: string, requestProof: string }> {
    if (params.amount <= 0) {
      throw new Error('Invalid payment request: amount must be greater than 0')
    }

    const requestId = await createNonce(this.peerPayWalletClient, 'self', this.originator)
    const senderIdentityKey = await this.getIdentityKey()

    const proofData = Array.from(new TextEncoder().encode(requestId + params.recipient))
    const { hmac } = await this.peerPayWalletClient.createHmac({
      data: proofData,
      protocolID: [2, 'payment request auth'],
      keyID: requestId,
      counterparty: params.recipient
    }, this.originator)
    const requestProof = Array.from(hmac).map(b => b.toString(16).padStart(2, '0')).join('')

    const body: PaymentRequestMessage = {
      requestId,
      amount: params.amount,
      description: params.description,
      expiresAt: params.expiresAt,
      senderIdentityKey,
      requestProof
    }

    try {
      await this.sendMessage({
        recipient: params.recipient,
        messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
        body: JSON.stringify(body)
      }, hostOverride)
    } catch (err: any) {
      // Translate HTTP 403 (permission denied) into a user-friendly message.
      if (typeof err?.message === 'string' && err.message.includes('403')) {
        throw new Error('Payment request blocked — you are not on the recipient\'s whitelist.')
      }
      throw err
    }

    return { requestId, requestProof }
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
  async listIncomingPaymentRequests (
    hostOverride?: string,
    limits?: PaymentRequestLimits
  ): Promise<IncomingPaymentRequest[]> {
    const messages = await this.listMessages({ messageBox: PAYMENT_REQUESTS_MESSAGEBOX, host: hostOverride })
    const myIdentityKey = await this.getIdentityKey()
    const now = Date.now()

    // Parse and validate all messages, collecting malformed ones for ack
    const malformedMessageIds: string[] = []
    const parsed: Array<{ messageId: string, sender: string, body: PaymentRequestMessage }> = []

    for (const msg of messages) {
      const body = safeParse<PaymentRequestMessage>(msg.body)
      if (body != null && isValidPaymentRequestMessage(body)) {
        parsed.push({ messageId: msg.messageId, sender: msg.sender, body })
      } else {
        malformedMessageIds.push(msg.messageId)
      }
    }

    // Collect cancelled requestIds — verify HMAC proof before accepting
    const cancelledRequests = new Map<string, string>() // requestId → sender
    const cancelMessageIds: string[] = []
    for (const item of parsed) {
      if (item.body.cancelled === true) {
        // Verify cancellation HMAC proof
        try {
          const proofData = Array.from(new TextEncoder().encode(item.body.requestId + myIdentityKey))
          await this.peerPayWalletClient.verifyHmac({
            data: proofData,
            hmac: hexToBytes(item.body.requestProof),
            protocolID: [2, 'payment request auth'],
            keyID: item.body.requestId,
            counterparty: item.sender
          }, this.originator)
          cancelledRequests.set(item.body.requestId, item.sender)
          cancelMessageIds.push(item.messageId)
        } catch {
          Logger.warn(`[PP CLIENT] Invalid cancellation proof for requestId=${item.body.requestId}, discarding`)
          malformedMessageIds.push(item.messageId)
        }
      }
    }

    const expiredMessageIds: string[] = []
    const outOfRangeMessageIds: string[] = []
    const cancelledOriginalMessageIds: string[] = []
    const active: IncomingPaymentRequest[] = []

    for (const item of parsed) {
      // Skip cancellation messages themselves (already collected above)
      if (item.body.cancelled === true) continue

      const { requestId, amount, description, expiresAt } = item.body

      // Filter expired
      if (expiresAt < now) {
        expiredMessageIds.push(item.messageId)
        continue
      }

      // Filter cancelled originals — only if cancellation came from the same sender
      if (cancelledRequests.has(requestId) && cancelledRequests.get(requestId) === item.sender) {
        cancelledOriginalMessageIds.push(item.messageId)
        continue
      }

      // Filter out-of-range — apply defaults for any missing limit fields
      const effectiveMin = limits?.minAmount ?? DEFAULT_PAYMENT_REQUEST_MIN_AMOUNT
      const effectiveMax = limits?.maxAmount ?? DEFAULT_PAYMENT_REQUEST_MAX_AMOUNT
      if (amount < effectiveMin || amount > effectiveMax) {
        outOfRangeMessageIds.push(item.messageId)
        continue
      }

      // Verify HMAC proof — ensures message came from claimed sender
      try {
        const proofData = Array.from(new TextEncoder().encode(requestId + myIdentityKey))
        await this.peerPayWalletClient.verifyHmac({
          data: proofData,
          hmac: hexToBytes(item.body.requestProof),
          protocolID: [2, 'payment request auth'],
          keyID: requestId,
          counterparty: item.sender
        }, this.originator)
      } catch {
        Logger.warn(`[PP CLIENT] Invalid requestProof for requestId=${requestId}, discarding`)
        malformedMessageIds.push(item.messageId)
        continue
      }

      active.push({
        messageId: item.messageId,
        sender: item.sender,
        requestId,
        amount,
        description,
        expiresAt
      })
    }

    // Acknowledge expired
    if (expiredMessageIds.length > 0) {
      await this.acknowledgeMessage({ messageIds: expiredMessageIds, host: hostOverride })
    }

    // Acknowledge cancelled originals + cancel messages together
    const cancelAckIds = [...cancelledOriginalMessageIds, ...cancelMessageIds]
    if (cancelAckIds.length > 0) {
      await this.acknowledgeMessage({ messageIds: cancelAckIds, host: hostOverride })
    }

    // Acknowledge out-of-range
    if (outOfRangeMessageIds.length > 0) {
      await this.acknowledgeMessage({ messageIds: outOfRangeMessageIds, host: hostOverride })
    }

    // Acknowledge malformed messages so they don't reappear
    if (malformedMessageIds.length > 0) {
      await this.acknowledgeMessage({ messageIds: malformedMessageIds, host: hostOverride })
    }

    return active
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
  async cancelPaymentRequest (
    params: { recipient: string, requestId: string, requestProof: string },
    hostOverride?: string
  ): Promise<void> {
    const senderIdentityKey = await this.getIdentityKey()

    const body: PaymentRequestMessage = {
      requestId: params.requestId,
      senderIdentityKey,
      requestProof: params.requestProof,
      cancelled: true
    }

    await this.sendMessage({
      recipient: params.recipient,
      messageBox: PAYMENT_REQUESTS_MESSAGEBOX,
      body: JSON.stringify(body)
    }, hostOverride)
  }
}
