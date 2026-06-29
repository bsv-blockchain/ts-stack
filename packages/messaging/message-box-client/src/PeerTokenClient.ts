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
import { MessageBoxClient } from './MessageBoxClient.js'
import {
  PeerMessage, TokenToken, IncomingToken, TokenRequestMessage, TokenRequestResponse,
  IncomingTokenRequest
} from './types.js'
import {
  TokenSettlementAdapter, TokenSourceRef, TokenAdapterContext
} from './TokenSettlementAdapter.js'
import { WalletInterface, OriginatorDomainNameStringUnder250Bytes, createNonce } from '@bsv/sdk'

import * as Logger from './Utils/logger.js'

function hexToBytes (hex: string): number[] {
  const matches = hex.match(/.{1,2}/g)
  return (matches ?? []).map(byte => Number.parseInt(byte, 16))
}

function safeParse<T> (input: any): T | undefined {
  try {
    return typeof input === 'string' ? JSON.parse(input) : input
  } catch (_parseError) {
    Logger.error('[PT CLIENT] Failed to parse input in safeParse:', input)
    return undefined
  }
}

export const STANDARD_TOKEN_MESSAGEBOX = 'token_inbox'
export const TOKEN_REQUESTS_MESSAGEBOX = 'token_requests'
export const TOKEN_REQUEST_RESPONSES_MESSAGEBOX = 'token_request_responses'

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
  /**
   * The configured MessageBox host, threaded explicitly through every token
   * transport call. On mainnet the `ls_messagebox` overlay (SLAP) has no
   * advertised hosts, so overlay-resolving calls fail; passing the host
   * directly (and using listMessagesLite for reads) bypasses that lookup.
   */
  private readonly tokenHost?: string

  constructor (config: PeerTokenClientConfig) {
    const { messageBoxHost = 'https://message-box-us-1.bsvb.tech', walletClient, enableLogging = false, originator } = config
    super({ host: messageBoxHost, walletClient, enableLogging, originator })

    this.messageBox = config.messageBox ?? STANDARD_TOKEN_MESSAGEBOX
    this.tokenHost = messageBoxHost
    this.peerTokenWalletClient = walletClient
    this.originator = originator
    this.adapters = new Map(config.adapters.map(a => [a.protocol, a]))
  }

  private adapterFor (protocol: string): TokenSettlementAdapter {
    const adapter = this.adapters.get(protocol)
    if (adapter == null) {
      throw new Error(`No token settlement adapter registered for protocol '${protocol}'`)
    }
    return adapter
  }

  private adapterContext (dryRun = false): TokenAdapterContext {
    return { wallet: this.peerTokenWalletClient, originator: this.originator, logger: Logger, dryRun }
  }

  /**
   * Builds a transferable token artifact for a recipient by delegating to the
   * adapter for the requested protocol. With `dryRun`, the adapter derives and
   * validates only — no signing, no broadcast (mainnet rehearsal).
   */
  async createTokenToken (params: SendTokenParams, dryRun = false): Promise<TokenToken> {
    const adapter = this.adapterFor(params.protocol)
    const result = await adapter.buildTokenSettlement(
      { recipient: params.recipient, source: params.source, amount: params.amount },
      this.adapterContext(dryRun)
    )
    if (result.action === 'terminate') {
      throw new Error(result.termination.message)
    }
    const { artifact } = result
    return {
      protocol: artifact.protocol,
      assetId: artifact.assetId,
      amount: artifact.amount,
      customInstructions: artifact.customInstructions,
      transaction: artifact.transaction,
      outputIndex: artifact.outputIndex,
      txid: artifact.txid
    }
  }

  /** Sends a token to a recipient over HTTP. Returns the sent token (incl. txid). */
  async sendToken (params: SendTokenParams, hostOverride?: string): Promise<TokenToken> {
    if (params.recipient == null || params.recipient.trim() === '') {
      throw new Error('Invalid token transfer: recipient is required')
    }
    const token = await this.createTokenToken(params)
    await this.sendMessage({
      recipient: params.recipient,
      messageBox: this.messageBox,
      body: JSON.stringify(token)
    }, hostOverride ?? this.tokenHost)
    return token
  }

  /** Sends a token over WebSocket, falling back to HTTP if the socket fails. Returns the sent token. */
  async sendLiveToken (params: SendTokenParams, overrideHost?: string): Promise<TokenToken> {
    const token = await this.createTokenToken(params)
    const host = overrideHost ?? this.tokenHost
    try {
      await this.sendLiveMessage({
        recipient: params.recipient,
        messageBox: this.messageBox,
        body: JSON.stringify(token)
      }, host)
    } catch (err) {
      Logger.warn('[PT CLIENT] sendLiveMessage failed, falling back to HTTP:', err)
      await this.sendMessage({
        recipient: params.recipient,
        messageBox: this.messageBox,
        body: JSON.stringify(token)
      }, host)
    }
    return token
  }

  /** Listens for incoming tokens in real time over WebSocket. */
  async listenForLiveTokens ({
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
        const token = safeParse<TokenToken>(message.body)
        if (token == null) return
        onToken({ messageId: message.messageId, sender: message.sender, token })
      }
    })
  }

  /**
   * Accepts an incoming token by delegating to the adapter for its protocol,
   * then acknowledges the transport message.
   */
  async acceptToken (incoming: IncomingToken): Promise<any> {
    try {
      const adapter = this.adapterFor(incoming.token.protocol)
      const result = await adapter.acceptTokenSettlement(
        {
          sender: incoming.sender,
          settlement: {
            customInstructions: incoming.token.customInstructions,
            transaction: incoming.token.transaction,
            protocol: incoming.token.protocol,
            assetId: incoming.token.assetId,
            amount: incoming.token.amount,
            outputIndex: incoming.token.outputIndex ?? 0
          }
        },
        this.adapterContext()
      )
      if (result.action === 'terminate') {
        throw new Error(result.termination.message)
      }
      await this.acknowledgeMessage({ messageIds: [incoming.messageId], host: this.tokenHost })
      return { incoming, receiptData: result.receiptData }
    } catch (error) {
      Logger.error(`[PT CLIENT] Error accepting token: ${String(error)}`)
      return 'Unable to receive token!'
    }
  }

  /** Lists pending incoming tokens from the token message box. */
  async listIncomingTokens (overrideHost?: string): Promise<IncomingToken[]> {
    // listMessagesLite talks to the host directly and skips overlay (SLAP)
    // resolution, which has no advertised ls_messagebox hosts on mainnet.
    const messages = await this.listMessagesLite({ messageBox: this.messageBox, host: overrideHost ?? this.tokenHost })
    return messages.map((msg: any) => {
      const token = safeParse<TokenToken>(msg.body)
      if (token == null) return null
      return { messageId: msg.messageId, sender: msg.sender, token }
    }).filter((t): t is IncomingToken => t != null)
  }

  // ── Token request flow (mirrors PeerPayClient's payment requests) ──────────

  /**
   * Requests a token transfer from a payer. Generates a unique requestId and an
   * HMAC proof tying the request to the sender, then posts it to the requests box.
   */
  async requestToken (
    params: { recipient: string, protocol: string, assetId: string, amount: string, description: string, expiresAt: number },
    hostOverride?: string
  ): Promise<{ requestId: string, requestProof: string }> {
    const requestId = await createNonce(this.peerTokenWalletClient, 'self', this.originator)
    const senderIdentityKey = await this.getIdentityKey()

    const proofData = Array.from(new TextEncoder().encode(requestId + params.recipient))
    const { hmac } = await this.peerTokenWalletClient.createHmac({
      data: proofData,
      protocolID: [2, 'token request auth'],
      keyID: requestId,
      counterparty: params.recipient
    }, this.originator)
    const requestProof = Array.from(hmac).map(b => b.toString(16).padStart(2, '0')).join('')

    const body: TokenRequestMessage = {
      requestId,
      protocol: params.protocol,
      assetId: params.assetId,
      amount: params.amount,
      description: params.description,
      expiresAt: params.expiresAt,
      senderIdentityKey,
      requestProof
    }

    await this.sendMessage({
      recipient: params.recipient,
      messageBox: TOKEN_REQUESTS_MESSAGEBOX,
      body: JSON.stringify(body)
    }, hostOverride ?? this.tokenHost)

    return { requestId, requestProof }
  }

  /** Listens for incoming token requests in real time over WebSocket. */
  async listenForLiveTokenRequests ({
    onRequest,
    overrideHost
  }: {
    onRequest: (request: IncomingTokenRequest) => void
    overrideHost?: string
  }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: TOKEN_REQUESTS_MESSAGEBOX,
      overrideHost,
      onMessage: (message: PeerMessage) => {
        const body = safeParse<TokenRequestMessage>(message.body)
        if (body == null || body.cancelled === true) return
        onRequest({
          messageId: message.messageId,
          sender: message.sender,
          requestId: body.requestId,
          protocol: body.protocol,
          assetId: body.assetId,
          amount: body.amount,
          description: body.description,
          expiresAt: body.expiresAt
        })
      }
    })
  }

  /**
   * Fulfills an incoming token request by sending the requested token and
   * notifying the requester with a 'sent' response. Acknowledges the request.
   */
  async fulfillTokenRequest (
    params: { request: IncomingTokenRequest, source: TokenSourceRef, note?: string },
    hostOverride?: string
  ): Promise<void> {
    const { request, source, note } = params

    await this.sendToken({
      recipient: request.sender,
      protocol: request.protocol,
      source,
      amount: request.amount
    }, hostOverride ?? this.tokenHost)

    const response: TokenRequestResponse = {
      requestId: request.requestId,
      status: 'sent',
      protocol: request.protocol,
      assetId: request.assetId,
      amountSent: request.amount,
      ...(note != null && { note })
    }

    await this.sendMessage({
      recipient: request.sender,
      messageBox: TOKEN_REQUEST_RESPONSES_MESSAGEBOX,
      body: JSON.stringify(response)
    }, hostOverride ?? this.tokenHost)

    await this.acknowledgeMessage({ messageIds: [request.messageId], host: hostOverride ?? this.tokenHost })
  }

  /** Declines an incoming token request and acknowledges it. */
  async declineTokenRequest (
    params: { request: IncomingTokenRequest, note?: string },
    hostOverride?: string
  ): Promise<void> {
    const { request, note } = params
    const response: TokenRequestResponse = {
      requestId: request.requestId,
      status: 'declined',
      ...(note != null && { note })
    }
    await this.sendMessage({
      recipient: request.sender,
      messageBox: TOKEN_REQUEST_RESPONSES_MESSAGEBOX,
      body: JSON.stringify(response)
    }, hostOverride ?? this.tokenHost)
    await this.acknowledgeMessage({ messageIds: [request.messageId], host: hostOverride ?? this.tokenHost })
  }

  /** Cancels a previously sent token request. */
  async cancelTokenRequest (
    params: { recipient: string, requestId: string, requestProof: string },
    hostOverride?: string
  ): Promise<void> {
    const senderIdentityKey = await this.getIdentityKey()
    const body: TokenRequestMessage = {
      requestId: params.requestId,
      senderIdentityKey,
      requestProof: params.requestProof,
      cancelled: true
    }
    await this.sendMessage({
      recipient: params.recipient,
      messageBox: TOKEN_REQUESTS_MESSAGEBOX,
      body: JSON.stringify(body)
    }, hostOverride ?? this.tokenHost)
  }

  /** Lists responses to token requests this client has sent. */
  async listTokenRequestResponses (hostOverride?: string): Promise<TokenRequestResponse[]> {
    const messages = await this.listMessagesLite({ messageBox: TOKEN_REQUEST_RESPONSES_MESSAGEBOX, host: hostOverride ?? this.tokenHost })
    return messages.map((msg: any) => safeParse<TokenRequestResponse>(msg.body))
      .filter((r): r is TokenRequestResponse => r != null)
  }

  /**
   * Verifies the HMAC proof on an incoming token request, confirming it came
   * from the claimed sender. Mirrors PeerPayClient's request-proof check.
   */
  async verifyTokenRequestProof (request: { requestId: string, sender: string, requestProof: string }): Promise<boolean> {
    const myIdentityKey = await this.getIdentityKey()
    try {
      const proofData = Array.from(new TextEncoder().encode(request.requestId + myIdentityKey))
      await this.peerTokenWalletClient.verifyHmac({
        data: proofData,
        hmac: hexToBytes(request.requestProof),
        protocolID: [2, 'token request auth'],
        keyID: request.requestId,
        counterparty: request.sender
      }, this.originator)
      return true
    } catch {
      return false
    }
  }
}
