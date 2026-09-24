/**
 * PeerTokenClient
 *
 * Extends `MessageBoxClient` to move BSV **tokens** (classic STAS, DSTAS,
 * BSV-21) peer-to-peer over MessageBox — the token analog of PeerPayClient.
 *
 * The client is standard-agnostic: it delegates the actual transfer building
 * and acceptance to a per-standard {@link TokenSettlementAdapter}, selected by
 * the `protocol` field. Message transport, request/response flows, and HMAC
 * proofs reuse the same machinery PeerPayClient uses for satoshi payments.
 */
import { createNonce } from '@bsv/sdk/auth/utils/createNonce'
import { PublicKey } from '@bsv/sdk/primitives'
import { normalizeBRC100ByteArray, stringifyBRC100 } from '@bsv/sdk/wallet/BRC100ByteEncoding'
import type {
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '@bsv/sdk/wallet/Wallet.interfaces'
import { validateBase64String } from '@bsv/sdk/wallet/validationHelpers'
import { MessageBoxClient } from './MessageBoxClient.js'
import type {
  TokenAdapterContext,
  TokenSettlementAdapter,
  TokenSourceRef
} from './TokenSettlementAdapter.js'
import type {
  IncomingToken,
  IncomingTokenRequest,
  PeerMessage,
  TokenRequestMessage,
  TokenRequestResponse,
  TokenToken
} from './types.js'
import * as Logger from './Utils/logger.js'

function hexToBytes(hex: string): number[] {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new TypeError('HMAC proof must be a non-empty, even-length hexadecimal string')
  }
  return hex.match(/.{2}/g)!.map(byte => Number.parseInt(byte, 16))
}

function safeParse<T>(input: unknown): T | undefined {
  try {
    return typeof input === 'string' ? (JSON.parse(input) as T) : (input as T)
  } catch {
    Logger.error('[PT CLIENT] Failed to parse an untrusted message body')
    return undefined
  }
}

export const STANDARD_TOKEN_MESSAGEBOX = 'token_inbox'
export const TOKEN_REQUESTS_MESSAGEBOX = 'token_requests'
export const TOKEN_REQUEST_RESPONSES_MESSAGEBOX = 'token_request_responses'
const MAX_INCOMING_TOKENS = 1_000
const MAX_INCOMING_TOKEN_PAGES = 10
const MAX_TOKEN_TRANSACTION_BYTES = 64 * 1024 * 1024
const MAX_TOKEN_TEXT_BYTES = 1_024
const MAX_TOKEN_REQUEST_DESCRIPTION_BYTES = 2_000

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

function boundedTokenText(value: unknown, name: string, maximum = MAX_TOKEN_TEXT_BYTES): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`Token ${name} is invalid`)
  }
  return value
}

function canonicalIdentityKey(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Token identity key is invalid')
  }
  try {
    if (PublicKey.fromString(value).toString() !== value) {
      throw new TypeError('Token identity key is invalid')
    }
  } catch {
    throw new TypeError('Token identity key is invalid')
  }
  return value
}

function canonicalTokenAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,77}$/.test(value)) {
    throw new TypeError('Token amount must be a positive canonical integer')
  }
  return value
}

function normalizeTokenToken(value: unknown): TokenToken {
  const token = dataRecord(value)
  const customInstructions = dataRecord(token?.customInstructions)
  if (token == null || customInstructions == null) {
    throw new TypeError('Token settlement is invalid')
  }
  const transaction = normalizeBRC100ByteArray(token.transaction)
  if (
    transaction == null ||
    transaction.length === 0 ||
    transaction.length > MAX_TOKEN_TRANSACTION_BYTES
  ) {
    throw new TypeError('Token settlement transaction is invalid')
  }
  const outputIndex = token.outputIndex ?? 0
  if (
    typeof outputIndex !== 'number' ||
    !Number.isSafeInteger(outputIndex) ||
    outputIndex < 0 ||
    outputIndex > 0xffffffff
  ) {
    throw new TypeError('Token settlement output index is invalid')
  }
  const txid = token.txid == null ? undefined : boundedTokenText(token.txid, 'transaction ID', 128)
  return {
    protocol: boundedTokenText(token.protocol, 'protocol', 128),
    assetId: boundedTokenText(token.assetId, 'asset ID'),
    amount: canonicalTokenAmount(token.amount),
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
    outputIndex,
    ...(txid == null ? {} : { txid })
  }
}

function normalizeIncomingToken(value: unknown): IncomingToken {
  const incoming = dataRecord(value)
  if (incoming == null) throw new TypeError('Incoming token is invalid')
  return {
    messageId: boundedTokenText(incoming.messageId, 'message ID'),
    sender: canonicalIdentityKey(incoming.sender),
    token: normalizeTokenToken(incoming.token)
  }
}

function tokenFromMessage(value: unknown): IncomingToken | null {
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
  const token = dataRecord(body)
  if (token == null || (token.sender != null && token.sender !== message.sender)) return null
  try {
    return normalizeIncomingToken({
      messageId: boundedTokenText(message.messageId, 'message ID'),
      sender: canonicalIdentityKey(message.sender),
      token: normalizeTokenToken(token)
    })
  } catch {
    return null
  }
}

function normalizeSendTokenParams(value: unknown): SendTokenParams {
  const transfer = dataRecord(value)
  const source = dataRecord(transfer?.source)
  if (transfer == null || source == null) {
    throw new TypeError('Invalid token transfer')
  }
  if (Object.keys(source).length > 64) {
    throw new TypeError('Token source contains too many fields')
  }
  const recipient = canonicalIdentityKey(transfer.recipient)
  const protocol = boundedTokenText(transfer.protocol, 'protocol', 128)
  const assetId = boundedTokenText(source.assetId, 'asset ID')
  const sourceProtocol = boundedTokenText(source.protocol, 'source protocol', 128)
  if (sourceProtocol !== protocol) throw new TypeError('Token source protocol does not match')
  const amount = canonicalTokenAmount(transfer.amount)
  return {
    recipient,
    protocol,
    source: { ...source, protocol: sourceProtocol, assetId } as TokenSourceRef,
    amount
  }
}

type AuthenticatedTokenRequest = IncomingTokenRequest & { requestProof: string }

function tokenRequestFromMessage(value: unknown): AuthenticatedTokenRequest | null {
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
  const request = dataRecord(body)
  if (request == null || request.cancelled === true) return null
  try {
    const sender = canonicalIdentityKey(message.sender)
    if (request.senderIdentityKey !== sender) return null
    const expiresAt = request.expiresAt
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      return null
    }
    const requestProof = request.requestProof
    if (typeof requestProof !== 'string' || !/^[0-9a-f]{64}$/.test(requestProof)) return null
    return {
      messageId: boundedTokenText(message.messageId, 'request message ID'),
      sender,
      requestId: boundedTokenText(request.requestId, 'request ID'),
      protocol: boundedTokenText(request.protocol, 'request protocol', 128),
      assetId: boundedTokenText(request.assetId, 'request asset ID'),
      amount: canonicalTokenAmount(request.amount),
      description: boundedTokenText(
        request.description,
        'request description',
        MAX_TOKEN_REQUEST_DESCRIPTION_BYTES
      ),
      expiresAt,
      requestProof
    }
  } catch {
    return null
  }
}

function normalizeTokenRequestResponse(value: unknown): TokenRequestResponse | null {
  const response = dataRecord(value)
  if (response == null) return null
  try {
    const requestId = boundedTokenText(response.requestId, 'response request ID')
    if (response.status !== 'sent' && response.status !== 'declined') return null
    const note =
      response.note == null
        ? undefined
        : boundedTokenText(response.note, 'response note', MAX_TOKEN_REQUEST_DESCRIPTION_BYTES)
    if (response.status === 'declined') {
      return { requestId, status: 'declined', ...(note == null ? {} : { note }) }
    }
    return {
      requestId,
      status: 'sent',
      protocol: boundedTokenText(response.protocol, 'response protocol', 128),
      assetId: boundedTokenText(response.assetId, 'response asset ID'),
      amountSent: canonicalTokenAmount(response.amountSent),
      ...(note == null ? {} : { note })
    }
  } catch {
    return null
  }
}

export interface PeerTokenClientConfig {
  messageBoxHost?: string
  messageBox?: string
  walletClient: WalletInterface
  /** One adapter per token standard, keyed by its `protocol` discriminator. */
  adapters: TokenSettlementAdapter[]
  enableLogging?: boolean
  originator?: OriginatorDomainNameStringUnder250Bytes
}

/** Parameters to send a token transfer. */
export interface SendTokenParams {
  recipient: string
  /** Standard discriminator (e.g. 'stas', 'dstas', 'bsv-21'); selects the adapter. */
  protocol: string
  /** The token UTXO the sender controls and wishes to transfer. */
  source: TokenSourceRef
  /** Token units to send, as a string. */
  amount: string
}

export class PeerTokenClient extends MessageBoxClient {
  private readonly peerTokenWalletClient: WalletInterface
  private readonly messageBox: string
  private readonly adapters: Map<string, TokenSettlementAdapter>
  private readonly activeTokenRequestMutations = new Set<string>()
  /**
   * The configured MessageBox host, threaded explicitly through every token
   * transport call. On mainnet the `ls_messagebox` overlay (SLAP) has no
   * advertised hosts, so overlay-resolving calls fail; passing the host
   * directly (and using listMessagesLite for reads) bypasses that lookup.
   */
  private readonly tokenHost?: string

  constructor(config: PeerTokenClientConfig) {
    const {
      messageBoxHost = 'https://message-box-us-1.bsvb.tech',
      walletClient,
      enableLogging = false,
      originator
    } = config
    super({ host: messageBoxHost, walletClient, enableLogging, originator })

    this.messageBox = config.messageBox ?? STANDARD_TOKEN_MESSAGEBOX
    this.tokenHost = messageBoxHost
    this.peerTokenWalletClient = walletClient
    this.originator = originator
    if (!Array.isArray(config.adapters) || config.adapters.length > 64) {
      throw new TypeError('Token adapters must be a bounded array')
    }
    this.adapters = new Map()
    for (const adapter of config.adapters) {
      const protocol = boundedTokenText(adapter?.protocol, 'adapter protocol', 128)
      if (
        this.adapters.has(protocol) ||
        typeof adapter.buildTokenSettlement !== 'function' ||
        typeof adapter.acceptTokenSettlement !== 'function'
      ) {
        throw new TypeError('Token adapter configuration is invalid')
      }
      this.adapters.set(protocol, adapter)
    }
  }

  private adapterFor(protocol: string): TokenSettlementAdapter {
    const adapter = this.adapters.get(protocol)
    if (adapter == null) {
      throw new Error(`No token settlement adapter registered for protocol '${protocol}'`)
    }
    return adapter
  }

  private adapterContext(dryRun = false): TokenAdapterContext {
    return {
      wallet: this.peerTokenWalletClient,
      originator: this.originator,
      logger: Logger,
      dryRun
    }
  }

  /**
   * Builds a transferable token artifact for a recipient by delegating to the
   * adapter for the requested protocol. With `dryRun`, the adapter derives and
   * validates only — no signing, no broadcast (mainnet rehearsal).
   */
  async createTokenToken(params: SendTokenParams, dryRun = false): Promise<TokenToken> {
    if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean')
    const normalizedParams = normalizeSendTokenParams(params)
    const adapter = this.adapterFor(normalizedParams.protocol)
    const result = dataRecord(
      await adapter.buildTokenSettlement(normalizedParams, this.adapterContext(dryRun))
    )
    if (result?.action !== 'settle') {
      const termination = dataRecord(result?.termination)
      if (result?.action === 'terminate' && termination != null) {
        throw new Error(boundedTokenText(termination.message, 'termination message', 2_000))
      }
      throw new Error('Token settlement adapter did not produce a settlement')
    }
    const artifact = normalizeTokenToken(result.artifact)
    if (
      artifact.protocol !== normalizedParams.protocol ||
      artifact.assetId !== normalizedParams.source.assetId ||
      artifact.amount !== normalizedParams.amount
    ) {
      throw new Error('Token settlement adapter changed the requested token authority')
    }
    return artifact
  }

  /** Sends a token to a recipient over HTTP. Returns the sent token (incl. txid). */
  async sendToken(params: SendTokenParams, hostOverride?: string): Promise<TokenToken> {
    const normalizedParams = normalizeSendTokenParams(params)
    const token = await this.createTokenToken(normalizedParams)
    await this.sendMessage(
      {
        recipient: normalizedParams.recipient,
        messageBox: this.messageBox,
        body: stringifyBRC100(token)
      },
      hostOverride ?? this.tokenHost
    )
    return token
  }

  /** Sends a token over WebSocket, falling back to HTTP if the socket fails. Returns the sent token. */
  async sendLiveToken(params: SendTokenParams, overrideHost?: string): Promise<TokenToken> {
    const normalizedParams = normalizeSendTokenParams(params)
    const token = await this.createTokenToken(normalizedParams)
    const host = overrideHost ?? this.tokenHost
    try {
      await this.sendLiveMessage(
        {
          recipient: normalizedParams.recipient,
          messageBox: this.messageBox,
          body: stringifyBRC100(token)
        },
        host
      )
    } catch {
      Logger.warn('[PT CLIENT] Live send failed; falling back to HTTP')
      await this.sendMessage(
        {
          recipient: normalizedParams.recipient,
          messageBox: this.messageBox,
          body: stringifyBRC100(token)
        },
        host
      )
    }
    return token
  }

  /** Listens for incoming tokens in real time over WebSocket. */
  async listenForLiveTokens({
    onToken,
    overrideHost
  }: {
    onToken: (token: IncomingToken) => void
    overrideHost?: string
  }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: this.messageBox,
      overrideHost: overrideHost ?? this.tokenHost,
      onMessage: (message: PeerMessage) => {
        const incoming = tokenFromMessage(message)
        if (incoming == null) return
        onToken(incoming)
      }
    })
  }

  /**
   * Accepts an incoming token by delegating to the adapter for its protocol,
   * then acknowledges the transport message.
   */
  async acceptToken(incoming: IncomingToken): Promise<any> {
    const messageId = boundedTokenText(incoming?.messageId, 'message ID')
    return await this.withTokenMutation(messageId, async () => {
      const fresh = await this.resolveFreshIncomingToken(messageId)
      const adapter = this.adapterFor(fresh.token.protocol)
      const result = dataRecord(
        await adapter.acceptTokenSettlement(
          {
            sender: fresh.sender,
            settlement: {
              customInstructions: { ...fresh.token.customInstructions },
              transaction: Array.from(fresh.token.transaction),
              protocol: fresh.token.protocol,
              assetId: fresh.token.assetId,
              amount: fresh.token.amount,
              outputIndex: fresh.token.outputIndex ?? 0,
              ...(fresh.token.txid == null ? {} : { txid: fresh.token.txid })
            }
          },
          this.adapterContext()
        )
      )
      if (result?.action !== 'accept') {
        const termination = dataRecord(result?.termination)
        if (result?.action === 'terminate' && termination != null) {
          throw new Error(boundedTokenText(termination.message, 'termination message', 2_000))
        }
        throw new Error('Token settlement adapter did not accept the token')
      }
      try {
        await this.acknowledgeMessage({ messageIds: [fresh.messageId], host: this.tokenHost })
      } catch {
        Logger.warn('[PT CLIENT] Token was accepted but acknowledgement failed')
      }
      return { incoming: fresh, receiptData: result.receiptData }
    })
  }

  private async withTokenMutation<T>(messageId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeTokenRequestMutations.has(messageId)) {
      throw new Error('Token message is already being processed by this client')
    }
    this.activeTokenRequestMutations.add(messageId)
    try {
      return await operation()
    } finally {
      this.activeTokenRequestMutations.delete(messageId)
    }
  }

  private async resolveFreshIncomingToken(messageId: unknown): Promise<IncomingToken> {
    const requestedMessageId = boundedTokenText(messageId, 'message ID')
    const matches = (await this.listIncomingTokens()).filter(
      candidate => candidate.messageId === requestedMessageId
    )
    if (matches.length !== 1) {
      throw new Error('Incoming token is not present exactly once in the authenticated inbox')
    }
    return normalizeIncomingToken(matches[0])
  }

  /** Lists pending incoming tokens from the token message box. */
  async listIncomingTokens(overrideHost?: string): Promise<IncomingToken[]> {
    // listMessagesLite talks to the host directly and skips overlay (SLAP)
    // resolution, which has no advertised ls_messagebox hosts on mainnet.
    const messages = await this.listMessagesLite({
      messageBox: this.messageBox,
      host: overrideHost ?? this.tokenHost,
      limit: MAX_INCOMING_TOKENS,
      pageSize: 100,
      maxPages: MAX_INCOMING_TOKEN_PAGES
    })
    if (!Array.isArray(messages) || messages.length > MAX_INCOMING_TOKENS) {
      throw new Error('Incoming token collection exceeds the configured limit')
    }
    return messages.flatMap(message => {
      const token = tokenFromMessage(message)
      return token == null ? [] : [token]
    })
  }

  // ── Token request flow (mirrors PeerPayClient's payment requests) ──────────

  /**
   * Requests a token transfer from a payer. Generates a unique requestId and an
   * HMAC proof tying the request to the sender, then posts it to the requests box.
   */
  async requestToken(
    params: {
      recipient: string
      protocol: string
      assetId: string
      amount: string
      description: string
      expiresAt: number
    },
    hostOverride?: string
  ): Promise<{ requestId: string; requestProof: string }> {
    const request = dataRecord(params)
    if (request == null) throw new TypeError('Token request is invalid')
    const recipient = canonicalIdentityKey(request.recipient)
    const protocol = boundedTokenText(request.protocol, 'request protocol', 128)
    const assetId = boundedTokenText(request.assetId, 'request asset ID')
    const amount = canonicalTokenAmount(request.amount)
    const description = boundedTokenText(
      request.description,
      'request description',
      MAX_TOKEN_REQUEST_DESCRIPTION_BYTES
    )
    if (
      typeof request.expiresAt !== 'number' ||
      !Number.isSafeInteger(request.expiresAt) ||
      request.expiresAt <= Date.now()
    ) {
      throw new TypeError('Token request expiry must be a future safe-integer timestamp')
    }
    const requestId = await createNonce(this.peerTokenWalletClient, 'self', this.originator)
    const normalizedRequestId = boundedTokenText(requestId, 'request ID')
    const senderIdentityKey = canonicalIdentityKey(await this.getIdentityKey())

    const proofData = Array.from(new TextEncoder().encode(normalizedRequestId + recipient))
    const { hmac } = await this.peerTokenWalletClient.createHmac(
      {
        data: proofData,
        protocolID: [2, 'token request auth'],
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
      throw new Error('Wallet returned an invalid token request proof')
    }
    const requestProof = hmac.map((b: number) => b.toString(16).padStart(2, '0')).join('')

    const body: TokenRequestMessage = {
      requestId: normalizedRequestId,
      protocol,
      assetId,
      amount,
      description,
      expiresAt: request.expiresAt,
      senderIdentityKey,
      requestProof
    }

    await this.sendMessage(
      {
        recipient,
        messageBox: TOKEN_REQUESTS_MESSAGEBOX,
        body: stringifyBRC100(body)
      },
      hostOverride ?? this.tokenHost
    )

    return { requestId: normalizedRequestId, requestProof }
  }

  /** Listens for incoming token requests in real time over WebSocket. */
  async listenForLiveTokenRequests({
    onRequest,
    overrideHost
  }: {
    onRequest: (request: IncomingTokenRequest) => void
    overrideHost?: string
  }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: TOKEN_REQUESTS_MESSAGEBOX,
      overrideHost: overrideHost ?? this.tokenHost,
      onMessage: (message: PeerMessage) => {
        const request = tokenRequestFromMessage(message)
        if (request == null || request.expiresAt <= Date.now()) return
        return this.verifyTokenRequestProof(request).then(valid => {
          if (valid) onRequest(request)
        })
      }
    })
  }

  /** Lists bounded, authenticated, unexpired token requests. */
  async listIncomingTokenRequests(overrideHost?: string): Promise<IncomingTokenRequest[]> {
    const messages = await this.listMessagesLite({
      messageBox: TOKEN_REQUESTS_MESSAGEBOX,
      host: overrideHost ?? this.tokenHost,
      limit: MAX_INCOMING_TOKENS,
      pageSize: 100,
      maxPages: MAX_INCOMING_TOKEN_PAGES
    })
    if (!Array.isArray(messages) || messages.length > MAX_INCOMING_TOKENS) {
      throw new Error('Incoming token request collection exceeds the configured limit')
    }
    const requests: AuthenticatedTokenRequest[] = []
    for (const message of messages) {
      const request = tokenRequestFromMessage(message)
      if (
        request != null &&
        request.expiresAt > Date.now() &&
        (await this.verifyTokenRequestProof(request))
      ) {
        requests.push(request)
      }
    }
    return requests
  }

  private async resolveFreshTokenRequest(
    messageId: unknown,
    hostOverride?: string
  ): Promise<AuthenticatedTokenRequest> {
    const requestedMessageId = boundedTokenText(messageId, 'request message ID')
    const matches = (await this.listIncomingTokenRequests(hostOverride)).filter(
      request => request.messageId === requestedMessageId
    ) as AuthenticatedTokenRequest[]
    if (matches.length !== 1) {
      throw new Error('Token request is not present exactly once in the authenticated inbox')
    }
    return matches[0]
  }

  private async withFreshTokenRequest(
    messageId: unknown,
    hostOverride: string | undefined,
    operation: (request: AuthenticatedTokenRequest) => Promise<void>
  ): Promise<void> {
    const requestedMessageId = boundedTokenText(messageId, 'request message ID')
    await this.withTokenMutation(requestedMessageId, async () => {
      await operation(await this.resolveFreshTokenRequest(requestedMessageId, hostOverride))
    })
  }

  /**
   * Fulfills an incoming token request by sending the requested token and
   * notifying the requester with a 'sent' response. Acknowledges the request.
   */
  async fulfillTokenRequest(
    params: { request: IncomingTokenRequest; source: TokenSourceRef; note?: string },
    hostOverride?: string
  ): Promise<void> {
    const fulfillment = dataRecord(params)
    const request = dataRecord(fulfillment?.request)
    const source = dataRecord(fulfillment?.source)
    if (fulfillment == null || request == null || source == null) {
      throw new TypeError('Token request fulfillment is invalid')
    }
    const normalizedNote =
      fulfillment.note == null
        ? undefined
        : boundedTokenText(fulfillment.note, 'response note', MAX_TOKEN_REQUEST_DESCRIPTION_BYTES)
    await this.withFreshTokenRequest(request.messageId, hostOverride, async fresh => {
      if (
        boundedTokenText(source.protocol, 'source protocol', 128) !== fresh.protocol ||
        boundedTokenText(source.assetId, 'source asset ID') !== fresh.assetId
      ) {
        throw new Error('Token source does not satisfy the authenticated request')
      }

      await this.sendToken(
        {
          recipient: fresh.sender,
          protocol: fresh.protocol,
          source: source as TokenSourceRef,
          amount: fresh.amount
        },
        hostOverride ?? this.tokenHost
      )

      const response: TokenRequestResponse = {
        requestId: fresh.requestId,
        status: 'sent',
        protocol: fresh.protocol,
        assetId: fresh.assetId,
        amountSent: fresh.amount,
        ...(normalizedNote != null && { note: normalizedNote })
      }

      await this.sendMessage(
        {
          recipient: fresh.sender,
          messageBox: TOKEN_REQUEST_RESPONSES_MESSAGEBOX,
          body: stringifyBRC100(response)
        },
        hostOverride ?? this.tokenHost
      )

      try {
        await this.acknowledgeMessage({
          messageIds: [fresh.messageId],
          host: hostOverride ?? this.tokenHost
        })
      } catch {
        Logger.warn('[PT CLIENT] Token request was fulfilled but acknowledgement failed')
      }
    })
  }

  /** Declines an incoming token request and acknowledges it. */
  async declineTokenRequest(
    params: { request: IncomingTokenRequest; note?: string },
    hostOverride?: string
  ): Promise<void> {
    const decline = dataRecord(params)
    const request = dataRecord(decline?.request)
    if (decline == null || request == null) {
      throw new TypeError('Token request decline is invalid')
    }
    const normalizedNote =
      decline.note == null
        ? undefined
        : boundedTokenText(decline.note, 'response note', MAX_TOKEN_REQUEST_DESCRIPTION_BYTES)
    await this.withFreshTokenRequest(request.messageId, hostOverride, async fresh => {
      const response: TokenRequestResponse = {
        requestId: fresh.requestId,
        status: 'declined',
        ...(normalizedNote != null && { note: normalizedNote })
      }
      await this.sendMessage(
        {
          recipient: fresh.sender,
          messageBox: TOKEN_REQUEST_RESPONSES_MESSAGEBOX,
          body: stringifyBRC100(response)
        },
        hostOverride ?? this.tokenHost
      )
      try {
        await this.acknowledgeMessage({
          messageIds: [fresh.messageId],
          host: hostOverride ?? this.tokenHost
        })
      } catch {
        Logger.warn('[PT CLIENT] Token request was declined but acknowledgement failed')
      }
    })
  }

  /** Cancels a previously sent token request. */
  async cancelTokenRequest(
    params: { recipient: string; requestId: string; requestProof: string },
    hostOverride?: string
  ): Promise<void> {
    const cancellation = dataRecord(params)
    if (cancellation == null) throw new TypeError('Token cancellation is invalid')
    const recipient = canonicalIdentityKey(cancellation.recipient)
    const requestId = boundedTokenText(cancellation.requestId, 'request ID')
    if (
      typeof cancellation.requestProof !== 'string' ||
      !/^[0-9a-f]{64}$/.test(cancellation.requestProof)
    ) {
      throw new TypeError('Token request proof is invalid')
    }
    const senderIdentityKey = canonicalIdentityKey(await this.getIdentityKey())
    const body: TokenRequestMessage = {
      requestId,
      senderIdentityKey,
      requestProof: cancellation.requestProof,
      cancelled: true
    }
    await this.sendMessage(
      {
        recipient,
        messageBox: TOKEN_REQUESTS_MESSAGEBOX,
        body: stringifyBRC100(body)
      },
      hostOverride ?? this.tokenHost
    )
  }

  /** Lists responses to token requests this client has sent. */
  async listTokenRequestResponses(hostOverride?: string): Promise<TokenRequestResponse[]> {
    const messages = await this.listMessagesLite({
      messageBox: TOKEN_REQUEST_RESPONSES_MESSAGEBOX,
      host: hostOverride ?? this.tokenHost,
      limit: MAX_INCOMING_TOKENS,
      pageSize: 100,
      maxPages: MAX_INCOMING_TOKEN_PAGES
    })
    if (!Array.isArray(messages) || messages.length > MAX_INCOMING_TOKENS) {
      throw new Error('Token request response collection exceeds the configured limit')
    }
    return messages.flatMap(message => {
      const response = normalizeTokenRequestResponse(safeParse(message.body))
      return response == null ? [] : [response]
    })
  }

  /**
   * Verifies the HMAC proof on an incoming token request, confirming it came
   * from the claimed sender. Mirrors PeerPayClient's request-proof check.
   */
  async verifyTokenRequestProof(request: {
    requestId: string
    sender: string
    requestProof: string
  }): Promise<boolean> {
    try {
      const normalizedRequest = dataRecord(request)
      if (normalizedRequest == null) return false
      const requestId = boundedTokenText(normalizedRequest.requestId, 'request ID')
      const sender = canonicalIdentityKey(normalizedRequest.sender)
      if (
        typeof normalizedRequest.requestProof !== 'string' ||
        !/^[0-9a-f]{64}$/.test(normalizedRequest.requestProof)
      ) {
        return false
      }
      const myIdentityKey = canonicalIdentityKey(await this.getIdentityKey())
      const proofData = Array.from(new TextEncoder().encode(requestId + myIdentityKey))
      const result = dataRecord(
        await this.peerTokenWalletClient.verifyHmac(
          {
            data: proofData,
            hmac: hexToBytes(normalizedRequest.requestProof),
            protocolID: [2, 'token request auth'],
            keyID: requestId,
            counterparty: sender
          },
          this.originator
        )
      )
      return result?.valid === true
    } catch {
      return false
    }
  }
}
