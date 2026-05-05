/**
 * @file MessageBoxClient.ts
 * @description
 * Provides the `MessageBoxClient` class — a secure client library for sending and receiving messages
 * via a Message Box Server over HTTP and WebSocket. Messages are authenticated, optionally encrypted,
 * and routed using identity-based addressing based on BRC-2/BRC-42/BRC-43 protocols.
 *
 * Core Features:
 * - Authenticated message transport using identity keys
 * - Deterministic message ID generation via HMAC (BRC-2)
 * - AES-256-GCM encryption using ECDH shared secrets derived via BRC-42/BRC-43
 * - Support for sending messages to self (`counterparty: 'self'`)
 * - Live message streaming using WebSocket rooms
 * - Optional plaintext messaging with `skipEncryption`
 * - Overlay host discovery and advertisement broadcasting via SHIP
 * - MessageBox-based organization and acknowledgment system
 *
 * See BRC-2 for details on the encryption scheme: https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md
 *
 * @module MessageBoxClient
 * @author BSV Blockchain Association
 * @license Open BSV License
 */

import {
  WalletClient,
  AuthFetch,
  LookupResolver,
  TopicBroadcaster,
  Utils,
  Transaction,
  PushDrop,
  PubKeyHex,
  P2PKH,
  PublicKey,
  CreateActionOutput,
  WalletInterface,
  ProtoWallet,
  InternalizeOutput,
  Random,
  OriginatorDomainNameStringUnder250Bytes,
  Beef,
} from '@bsv/sdk'
import { AuthSocketClient } from '@bsv/authsocket-client'
import * as Logger from './Utils/logger.js'
import { AcknowledgeMessageParams, AdvertisementToken, EncryptedMessage, ListMessagesParams, MessageBoxClientOptions, Payment, PeerMessage, SendMessageParams, SendMessageResponse, DeviceRegistrationParams, DeviceRegistrationResponse, RegisteredDevice, ListDevicesResponse } from './types.js'
import {
  SetMessageBoxPermissionParams,
  GetMessageBoxPermissionParams,
  MessageBoxPermission,
  MessageBoxMultiQuote,
  MessageBoxQuote,
  ListPermissionsParams,
  GetQuoteParams,
  SendListParams,
  SendListResult
} from './types/permissions.js'

const DEFAULT_MAINNET_HOST = 'https://message-box-us-1.bsvb.tech'
const DEFAULT_TESTNET_HOST = DEFAULT_MAINNET_HOST

type MessageBoxRecipientQuote = MessageBoxMultiQuote['quotesByRecipient'][number]
type MessageBoxQuoteStatus = MessageBoxRecipientQuote['status']

interface MessageBoxMultiQuoteAccumulator {
  quotesByRecipient: MessageBoxRecipientQuote[]
  blockedRecipients: Set<PubKeyHex>
  deliveryAgentIdentityKeyByHost: Record<string, string>
  deliveryFees: number
  recipientFees: number
}

/**
 * @class MessageBoxClient
 * @description
 * A secure client for sending and receiving authenticated, encrypted messages
 * through a MessageBox server over HTTP and WebSocket.
 *
 * Core Features:
 * - Identity-authenticated message transport (BRC-2)
 * - AES-256-GCM end-to-end encryption with BRC-42/BRC-43 key derivation
 * - HMAC-based message ID generation for deduplication
 * - Live WebSocket messaging with room-based subscription management
 * - Overlay network discovery and host advertisement broadcasting (SHIP protocol)
 * - Fallback to HTTP messaging when WebSocket is unavailable
 *
 * **Important:**
 * The MessageBoxClient automatically calls `await init()` if needed.
 * Manual initialization is optional but still supported.
 *
 * You may call `await init()` manually for explicit control, but you can also use methods
 * like `sendMessage()` or `listenForLiveMessages()` directly — the client will initialize itself
 * automatically if not yet ready.
 *
 * @example
 * const client = new MessageBoxClient({ walletClient, enableLogging: true })
 * await client.init() // <- Required before using the client
 * await client.sendMessage({ recipient, messageBox: 'payment_inbox', body: 'Hello world' })
 */
export class MessageBoxClient {
  private host: string
  public readonly authFetch: AuthFetch
  private readonly walletClient: WalletInterface
  private socket?: ReturnType<typeof AuthSocketClient>
  private myIdentityKey?: string
  private readonly joinedRooms: Set<string> = new Set()
  private readonly lookupResolver: LookupResolver
  private readonly networkPreset: 'local' | 'mainnet' | 'testnet'
  private initialized = false
  private socketAuthenticated = false
  private connectionInitPromise?: Promise<void>
  protected originator?: OriginatorDomainNameStringUnder250Bytes
  /**
   * @constructor
   * @param {Object} options - Initialization options for the MessageBoxClient.
   * @param {string} [options.host] - The base URL of the MessageBox server. If omitted, defaults to mainnet/testnet hosts.
   * @param {WalletInterface} options.walletClient - Wallet instance used for authentication, signing, and encryption.
   * @param {boolean} [options.enableLogging=false] - Whether to enable detailed debug logging to the console.
   * @param {'local' | 'mainnet' | 'testnet'} [options.networkPreset='mainnet'] - Overlay network preset used for routing and advertisement lookup.
   *
   * @description
   * Constructs a new MessageBoxClient.
   *
   * **Note:**
   * Passing a `host` during construction sets the default server.
   * If you do not manually call `await init()`, the client will automatically initialize itself on first use.
   *
   * @example
   * const client = new MessageBoxClient({
   *   host: 'https://messagebox.example',
   *   walletClient,
   *   enableLogging: true,
   *   networkPreset: 'testnet'
   * })
   * await client.init()
   */
  constructor(options: MessageBoxClientOptions = {}) {
    const {
      host,
      walletClient,
      enableLogging = false,
      networkPreset = 'mainnet',
      originator = undefined
    } = options

    const defaultHost =
      networkPreset === 'testnet'
        ? DEFAULT_TESTNET_HOST
        : DEFAULT_MAINNET_HOST

    this.host = host?.trim() ?? defaultHost
    this.originator = originator
    this.walletClient = walletClient ?? new WalletClient('auto', originator)
    this.authFetch = new AuthFetch(this.walletClient, undefined, undefined, originator)
    this.networkPreset = networkPreset

    this.lookupResolver = new LookupResolver({
      networkPreset
    })

    if (enableLogging) {
      Logger.enable()
    }
  }

  /**
   * @method init
   * @async
   * @param {string} [targetHost] - Optional host to set or override the default host.
   * @returns {Promise<void>}
   *
   * @description
   * Initializes the MessageBoxClient by verifying wallet connectivity and setting the active host.
   *
   * - If the client was constructed with a host, it uses that unless a different targetHost is provided.
   * - After calling init(), the client becomes ready to send, receive, and acknowledge messages.
   * - To advertise your host on the overlay network, call `anointHost()` explicitly.
   *
   * This method can be called manually for explicit control,
   * but will be automatically invoked if omitted.
   * @throws {Error} If no valid host is provided, or wallet is unreachable.
   *
   * @example
   * const client = new MessageBoxClient({ host: 'https://mybox.example', walletClient })
   * await client.init()
   * // Optionally advertise your host on the overlay:
   * await client.anointHost('https://mybox.example')
   * await client.sendMessage({ recipient, messageBox: 'inbox', body: 'Hello' })
   */
  async init(targetHost: string = this.host): Promise<void> {
    const normalizedHost = targetHost?.trim()
    if (normalizedHost === '') {
      throw new Error('Cannot initialize: No valid host provided')
    }

    // Check if this is an override host
    if (normalizedHost !== this.host) {
      this.initialized = false
      this.host = normalizedHost
    }

    if (this.initialized) return

    // Verify wallet is reachable
    await this.getIdentityKey()
    this.initialized = true
  }

  /**
   * @method assertInitialized
   * @private
   * @description
   * Ensures that the MessageBoxClient has completed initialization before performing sensitive operations
   * like sending, receiving, or acknowledging messages.
   *
   * If the client is not yet initialized, it will automatically call `await init()` to complete setup.
   *
   * Used automatically by all public methods that require initialization.
   */
  private async assertInitialized(): Promise<void> {
    if (!this.initialized || this.host == null || this.host.trim() === '') {
      await this.init()
    }
  }

  /**
   * @method getJoinedRooms
   * @returns {Set<string>} A set of currently joined WebSocket room IDs
   * @description
   * Returns a live list of WebSocket rooms the client is subscribed to.
   * Useful for inspecting state or ensuring no duplicates are joined.
   */
  public getJoinedRooms(): Set<string> {
    return this.joinedRooms
  }

  /**
 * @method getIdentityKey
 * @param {string} [originator] - Optional originator to use for identity key lookup
 * @returns {Promise<string>} The identity public key of the user
 * @description
 * Returns the client's identity key, used for signing, encryption, and addressing.
 * If not already loaded, it will fetch and cache it.
 */
  public async getIdentityKey(): Promise<string> {
    if (this.myIdentityKey != null && this.myIdentityKey.trim() !== '') {
      return this.myIdentityKey
    }

    Logger.log('[MB CLIENT] Fetching identity key...')
    try {
      const keyResult = await this.walletClient.getPublicKey({ identityKey: true }, this.originator)
      this.myIdentityKey = keyResult.publicKey
      Logger.log(`[MB CLIENT] Identity key fetched: ${this.myIdentityKey}`)
      return this.myIdentityKey
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to fetch identity key:', error)
      throw new Error('Identity key retrieval failed')
    }
  }

  /**
   * @property testSocket
   * @readonly
   * @returns {AuthSocketClient | undefined} The internal WebSocket client (or undefined if not connected).
   * @description
   * Exposes the underlying Authenticated WebSocket client used for live messaging.
   * This is primarily intended for debugging, test frameworks, or direct inspection.
   *
   * Note: Do not interact with the socket directly unless necessary.
   * Use the provided `sendLiveMessage`, `listenForLiveMessages`, and related methods.
   */
  public get testSocket(): ReturnType<typeof AuthSocketClient> | undefined {
    return this.socket
  }

  /**
   * @method initializeConnection
   * @param {string} [originator] - Optional originator to use for authentication.
   * @async
   * @returns {Promise<void>}
   * @description
   * Establishes an authenticated WebSocket connection to the configured MessageBox server.
   * Enables live message streaming via room-based channels tied to identity keys.
   *
   * This method:
   * 1. Retrieves the user’s identity key if not already set
   * 2. Initializes a secure AuthSocketClient WebSocket connection
   * 3. Authenticates the connection using the identity key
   * 4. Waits up to 5 seconds for authentication confirmation
   *
   * If authentication fails or times out, the connection is rejected.
   *
   * @throws {Error} If the identity key is unavailable or authentication fails
   *
   * @example
   * const mb = new MessageBoxClient({ walletClient })
   * await mb.initializeConnection()
   * // WebSocket is now ready for use
   */
  async initializeConnection(overrideHost?: string): Promise<void> {
    Logger.log('[MB CLIENT] initializeConnection() STARTED')

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      await this.getIdentityKey()
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      Logger.error('[MB CLIENT ERROR] Identity key is still missing after retrieval!')
      throw new Error('Identity key is missing')
    }

    Logger.log('[MB CLIENT] Setting up WebSocket connection...')

    if (this.socketAuthenticated && this.socket != null) {
      return
    }

    if (this.connectionInitPromise != null) {
      await this.connectionInitPromise
      return
    }

    if (this.socket == null) {
      const targetHost = overrideHost ?? this.host
      if (typeof targetHost !== 'string' || targetHost.trim() === '') {
        throw new Error('Cannot initialize WebSocket: No valid host provided')
      }
      this.socket = AuthSocketClient(targetHost, { wallet: this.walletClient, originator: this.originator })

      this.socket.on('connect', () => {
        Logger.log('[MB CLIENT] Connected to WebSocket.')

        Logger.log('[MB CLIENT] Sending authentication data:', this.myIdentityKey)
        if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
          Logger.error('[MB CLIENT ERROR] Cannot send authentication: Identity key is missing!')
        } else {
          this.socket?.emit('authenticated', { identityKey: this.myIdentityKey })
        }
      })

      // Listen for authentication success from the server
      this.socket.on('authenticationSuccess', (data) => {
        Logger.log(`[MB CLIENT] WebSocket authentication successful: ${JSON.stringify(data)}`)
        this.socketAuthenticated = true
      })

      // Handle authentication failures
      this.socket.on('authenticationFailed', (data) => {
        Logger.error(`[MB CLIENT ERROR] WebSocket authentication failed: ${JSON.stringify(data)}`)
        this.socketAuthenticated = false
      })

      this.socket.on('disconnect', () => {
        Logger.log('[MB CLIENT] Disconnected from MessageBox server')
        this.socket = undefined
        this.socketAuthenticated = false
      })

      this.socket.on('error', (error) => {
        Logger.error('[MB CLIENT ERROR] WebSocket error:', error)
      })
    }

    if (this.socket?.connected && !this.socketAuthenticated) {
      this.socket.emit('authenticated', { identityKey: this.myIdentityKey })
    }

    this.connectionInitPromise = new Promise<void>((resolve, reject) => {
      const socketAny = this.socket as any
      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const finalizeResolve = (): void => {
        if (settled) return
        settled = true
        if (timeoutId != null) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        if (typeof socketAny?.off === 'function') {
          socketAny.off('authenticationSuccess', onSuccess)
          socketAny.off('authenticationFailed', onFailed)
          socketAny.off('disconnect', onDisconnectBeforeAuth)
        }
        this.connectionInitPromise = undefined
        Logger.log('[MB CLIENT] WebSocket fully authenticated and ready!')
        resolve()
      }

      const finalizeReject = (error: Error): void => {
        if (settled) return
        settled = true
        if (timeoutId != null) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        if (typeof socketAny?.off === 'function') {
          socketAny.off('authenticationSuccess', onSuccess)
          socketAny.off('authenticationFailed', onFailed)
          socketAny.off('disconnect', onDisconnectBeforeAuth)
        }
        this.connectionInitPromise = undefined
        reject(error)
      }

      const onSuccess = (): void => {
        this.socketAuthenticated = true
        finalizeResolve()
      }

      const onFailed = (): void => {
        this.socketAuthenticated = false
        finalizeReject(new Error('[MB CLIENT ERROR] WebSocket authentication failed!'))
      }

      const onDisconnectBeforeAuth = (): void => {
        this.socketAuthenticated = false
      }

      if (this.socketAuthenticated) {
        finalizeResolve()
        return
      }

      socketAny?.on('authenticationSuccess', onSuccess)
      socketAny?.on('authenticationFailed', onFailed)
      socketAny?.on('disconnect', onDisconnectBeforeAuth)

      timeoutId = setTimeout(() => {
        if (this.socketAuthenticated) {
          finalizeResolve()
        } else {
          finalizeReject(new Error('[MB CLIENT ERROR] WebSocket authentication timed out!'))
        }
      }, 5000)
    })

    await this.connectionInitPromise
  }

  /**
   * @method resolveHostForRecipient
   * @async
   * @param {string} identityKey - The public identity key of the intended recipient.
   * @param {string} [originator] - The originator to use for the WalletClient.
   * @returns {Promise<string>} - A fully qualified host URL for the recipient's MessageBox server.
   *
   * @description
   * Attempts to resolve the most recently anointed MessageBox host for the given identity key
   * using the BSV overlay network and the `ls_messagebox` LookupResolver.
   *
   * If no advertisements are found, or if resolution fails, the client will fall back
   * to its own configured `host`. This allows seamless operation in both overlay and non-overlay environments.
   *
   * This method guarantees a non-null return value and should be used directly when routing messages.
   *
   * @example
   * const host = await resolveHostForRecipient('028d...') // → returns either overlay host or this.host
   */
  async resolveHostForRecipient(identityKey: string): Promise<string> {
    const advertisementTokens = await this.queryAdvertisements(identityKey, undefined)
    if (advertisementTokens.length === 0) {
      Logger.warn(`[MB CLIENT] No advertisements for ${identityKey}, using default host ${this.host}`)
      return this.host
    }
    // Return the first host found
    return advertisementTokens[0].host
  }

  /**
   * Core lookup: ask the LookupResolver (optionally filtered by host),
   * decode every PushDrop output, and collect all the host URLs you find.
   *
   * @param identityKey  the recipient’s public key
   * @param host?        if passed, only look for adverts anointed at that host
   * @returns            0-length array if nothing valid was found
   */
  async queryAdvertisements(
    identityKey?: string,
    host?: string
  ): Promise<AdvertisementToken[]> {
    const hosts: AdvertisementToken[] = []
    try {
      const query: Record<string, string> = { identityKey: identityKey ?? await this.getIdentityKey() }
      if (host != null && host.trim() !== '') query.host = host

      const result = await this.lookupResolver.query({
        service: 'ls_messagebox',
        query
      })
      if (result.type !== 'output-list') {
        throw new Error(`Unexpected result type: ${String(result.type)}`)
      }

      for (const output of result.outputs) {
        try {
          const tx = Transaction.fromBEEF(output.beef)
          const script = tx.outputs[output.outputIndex].lockingScript
          const token = PushDrop.decode(script)
          const [, hostBuf] = token.fields

          if (hostBuf == null || hostBuf.length === 0) {
            throw new Error('Empty host field')
          }

          hosts.push({
            host: Utils.toUTF8(hostBuf),
            txid: tx.id('hex'),
            outputIndex: output.outputIndex,
            lockingScript: script,
            beef: output.beef
          })
        } catch {
          // skip any malformed / non-PushDrop outputs
        }
      }
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] _queryAdvertisements failed:', err)
    }
    return hosts.filter(item => {
      const h = item.host.trim().toLowerCase()
      if (!h) return false
      try {
        const url = new URL(h)
        if (url.protocol !== 'https:') return false
        const hostname = url.hostname
        if (
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '0.0.0.0' ||
          hostname === '::1' ||
          hostname.endsWith('.local') ||
          hostname.endsWith('.example.com') ||
          hostname.endsWith('.test') ||
          hostname.endsWith('.invalid') ||
          hostname.endsWith('.localhost')
        ) return false
        return true
      } catch {
        return false
      }
    })
  }

  /**
   * @method joinRoom
   * @async
   * @param {string} messageBox - The name of the WebSocket room to join (e.g., "payment_inbox").
   * @returns {Promise<void>}
   *
   * @description
   * Joins a WebSocket room that corresponds to the user’s identity key and the specified message box.
   * This is required to receive real-time messages via WebSocket for a specific type of communication.
   *
   * If the WebSocket connection is not already established, this method will first initialize the connection.
   * It also ensures the room is only joined once, and tracks all joined rooms in an internal set.
   *
   * Room ID format: `${identityKey}-${messageBox}`
   *
   * @example
   * await client.joinRoom('payment_inbox')
   * // Now listening for real-time messages in room '028d...-payment_inbox'
   */
  async joinRoom(messageBox: string, overrideHost?: string): Promise<void> {
    Logger.log(`[MB CLIENT] Attempting to join WebSocket room: ${messageBox}`)

    // Ensure WebSocket connection is established first
    if (this.socket == null) {
      Logger.log('[MB CLIENT] No WebSocket connection. Initializing...')
      await this.initializeConnection(overrideHost)
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is not defined')
    }

    const roomId = `${this.myIdentityKey ?? ''}-${messageBox}`

    if (this.joinedRooms.has(roomId)) {
      Logger.log(`[MB CLIENT] Already joined WebSocket room: ${roomId}`)
      return
    }

    try {
      Logger.log(`[MB CLIENT] Joining WebSocket room: ${roomId}`)
      await this.socket?.emit('joinRoom', roomId)
      this.joinedRooms.add(roomId)
      Logger.log(`[MB CLIENT] Successfully joined room: ${roomId}`)
    } catch (error) {
      Logger.error(`[MB CLIENT ERROR] Failed to join WebSocket room: ${roomId}`, error)
    }
  }

  /**
   * @method listenForLiveMessages
   * @async
   * @param {Object} params - Configuration for the live message listener.
   * @param {function} params.onMessage - A callback function that will be triggered when a new message arrives.
   * @param {string} params.messageBox - The messageBox name (e.g., `payment_inbox`) to listen for.
   * @returns {Promise<void>}
   *
   * @description
   * Subscribes the client to live messages over WebSocket for a specific messageBox.
   *
   * This method:
   * - Ensures the WebSocket connection is initialized and authenticated.
   * - Joins the correct room formatted as `${identityKey}-${messageBox}`.
   * - Listens for messages broadcast to the room.
   * - Automatically attempts to parse and decrypt message bodies.
   * - Emits the final message (as a `PeerMessage`) to the supplied `onMessage` handler.
   *
   * If the incoming message is encrypted, the client decrypts it using AES-256-GCM via
   * ECDH shared secrets derived from identity keys as defined in [BRC-2](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md).
   * Messages sent by the client to itself are decrypted using `counterparty = 'self'`.
   *
   * @example
   * await client.listenForLiveMessages({
   *   messageBox: 'payment_inbox',
   *   onMessage: (msg) => console.log('Received live message:', msg)
   * })
   */
  async listenForLiveMessages({
    onMessage,
    messageBox,
    overrideHost
  }: {
    onMessage: (message: PeerMessage) => void
    messageBox: string
    overrideHost?: string
  }): Promise<void> {
    Logger.log(`[MB CLIENT] Setting up listener for WebSocket room: ${messageBox}`)

    // Ensure WebSocket connection is established first
    if (this.socket == null) {
      Logger.log('[MB CLIENT] No WebSocket connection. Initializing...')
      await this.initializeConnection(overrideHost)
    }

    // Join the room
    await this.joinRoom(messageBox, this.originator)

    // Ensure identity key is available before creating roomId
    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is missing. Cannot construct room ID.')
    }

    const roomId = `${this.myIdentityKey}-${messageBox}`

    Logger.log(`[MB CLIENT] Listening for messages in room: ${roomId}`)

    this.socket?.on(`sendMessage-${roomId}`, (message: PeerMessage) => {
      void (async () => {
        Logger.log(`[MB CLIENT] Received message in room ${roomId}:`, message)

        try {
          let parsedBody: unknown = message.body

          if (typeof parsedBody === 'string') {
            try {
              parsedBody = JSON.parse(parsedBody)
            } catch {
              // Leave it as-is (plain text)
            }
          }

          if (
            parsedBody != null &&
            typeof parsedBody === 'object' &&
            typeof (parsedBody as any).encryptedMessage === 'string'
          ) {
            Logger.log(`[MB CLIENT] Decrypting message from ${String(message.sender)}...`)
            const decrypted = await this.walletClient.decrypt({
              protocolID: [1, 'messagebox'],
              keyID: '1',
              counterparty: message.sender,
              ciphertext: Utils.toArray((parsedBody as any).encryptedMessage, 'base64')
            }, this.originator)

            message.body = Utils.toUTF8(decrypted.plaintext)
          } else {
            Logger.log('[MB CLIENT] Message is not encrypted.')
            message.body = typeof parsedBody === 'string'
              ? parsedBody
              : (() => { try { return JSON.stringify(parsedBody) } catch { return '[Error: Unstringifiable message]' } })()
          }
        } catch (err) {
          Logger.error('[MB CLIENT ERROR] Failed to parse or decrypt live message:', err)
          message.body = '[Error: Failed to decrypt or parse message]'
        }

        onMessage(message)
      })()
    })
  }

  /**
   * @method sendLiveMessage
   * @async
   * @param {SendMessageParams} param0 - The message parameters including recipient, box name, body, and options.
   * @returns {Promise<SendMessageResponse>} A success response with the generated messageId.
   *
   * @description
   * Sends a message in real time using WebSocket with authenticated delivery and overlay fallback.
   *
   * This method:
   * - Ensures the WebSocket connection is open and joins the correct room.
   * - Derives a unique message ID using an HMAC of the message body and counterparty identity key.
   * - Encrypts the message body using AES-256-GCM based on the ECDH shared secret between derived keys, per [BRC-2](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md),
   *   unless `skipEncryption` is explicitly set to `true`.
   * - Sends the message to a WebSocket room in the format `${recipient}-${messageBox}`.
   * - Waits for acknowledgment (`sendMessageAck-${roomId}`).
   * - If no acknowledgment is received within 10 seconds, falls back to `sendMessage()` over HTTP.
   *
   * This hybrid delivery strategy ensures reliability in both real-time and offline-capable environments.
   *
   * @throws {Error} If message validation fails, HMAC generation fails, or both WebSocket and HTTP fail to deliver.
   *
   * @example
   * await client.sendLiveMessage({
   *   recipient: '028d...',
   *   messageBox: 'payment_inbox',
   *   body: { amount: 1000 }
   * })
   */
  async sendLiveMessage({
    recipient,
    messageBox,
    body,
    messageId,
    skipEncryption,
    checkPermissions
  }: SendMessageParams, overrideHost?: string): Promise<SendMessageResponse> {
    if (recipient == null || recipient.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Recipient identity key is required')
    }
    if (messageBox == null || messageBox.trim() === '') {
      throw new Error('[MB CLIENT ERROR] MessageBox is required')
    }
    if (body == null || (typeof body === 'string' && body.trim() === '')) {
      throw new Error('[MB CLIENT ERROR] Message body cannot be empty')
    }

    // Ensure room is joined before sending
    await this.joinRoom(messageBox, this.originator)

    // Fallback to HTTP if WebSocket is not connected
    if (this.socket == null || !this.socket.connected) {
      Logger.warn('[MB CLIENT WARNING] WebSocket not connected, falling back to HTTP')
      return await this.sendMessage({ recipient, messageBox, body, messageId, skipEncryption, checkPermissions }, overrideHost)
    }

    let finalMessageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(body))),
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: recipient
      }, this.originator)
      finalMessageId = messageId ?? Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to generate HMAC:', error)
      throw new Error('Failed to generate message identifier.')
    }

    const roomId = `${recipient}-${messageBox}`
    Logger.log(`[MB CLIENT] Sending WebSocket message to room: ${roomId}`)

    let outgoingBody: string
    if (skipEncryption === true) {
      outgoingBody = typeof body === 'string' ? body : JSON.stringify(body)
    } else {
      const encryptedMessage = await this.walletClient.encrypt({
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: recipient,
        plaintext: Utils.toArray(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
      }, this.originator)

      outgoingBody = JSON.stringify({
        encryptedMessage: Utils.toBase64(encryptedMessage.ciphertext)
      })
    }

    return await new Promise((resolve, reject) => {
      const ackEvent = `sendMessageAck-${roomId}`
      let handled = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const ackHandler = (response?: SendMessageResponse): void => {
        if (handled) return
        handled = true
        if (timeoutId != null) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }

        const socketAny = this.socket as any
        if (typeof socketAny?.off === 'function') {
          socketAny.off(ackEvent, ackHandler)
        }

        Logger.log('[MB CLIENT] Received WebSocket acknowledgment:', response)

        if (response == null || response.status !== 'success') {
          Logger.warn('[MB CLIENT] WebSocket message failed or returned unexpected response. Falling back to HTTP.')
          const fallbackMessage: SendMessageParams = {
            recipient,
            messageBox,
            body,
            messageId: finalMessageId,
            skipEncryption,
            checkPermissions
          }

          this.sendMessage(fallbackMessage, overrideHost)
            .then(resolve)
            .catch(reject)
        } else {
          Logger.log('[MB CLIENT] Message sent successfully via WebSocket:', response)
          resolve(response)
        }
      }

      // Attach acknowledgment listener
      this.socket?.on(ackEvent, ackHandler)

      // Emit message to room
      this.socket?.emit('sendMessage', {
        roomId,
        message: {
          messageId: finalMessageId,
          recipient,
          body: outgoingBody
        }
      })

      // Timeout: Fallback to HTTP if no acknowledgment received
      timeoutId = setTimeout(() => {
        if (!handled) {
          handled = true
          timeoutId = undefined
          const socketAny = this.socket as any
          if (typeof socketAny?.off === 'function') {
            socketAny.off(ackEvent, ackHandler)
          }
          Logger.warn('[CLIENT] WebSocket acknowledgment timed out, falling back to HTTP')
          const fallbackMessage: SendMessageParams = {
            recipient,
            messageBox,
            body,
            messageId: finalMessageId,
            skipEncryption,
            checkPermissions
          }

          this.sendMessage(fallbackMessage, overrideHost)
            .then(resolve)
            .catch(reject)
        }
      }, 10000)
    })
  }

  /**
   * @method leaveRoom
   * @async
   * @param {string} messageBox - The name of the WebSocket room to leave (e.g., `payment_inbox`).
   * @returns {Promise<void>}
   *
   * @description
   * Leaves a previously joined WebSocket room associated with the authenticated identity key.
   * This helps reduce unnecessary message traffic and memory usage.
   *
   * If the WebSocket is not connected or the identity key is missing, the method exits gracefully.
   *
   * @example
   * await client.leaveRoom('payment_inbox')
   */
  async leaveRoom(messageBox: string): Promise<void> {
    await this.assertInitialized()
    if (this.socket == null) {
      Logger.warn('[MB CLIENT] Attempted to leave a room but WebSocket is not connected.')
      return
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is not defined')
    }

    const roomId = `${this.myIdentityKey}-${messageBox}`
    Logger.log(`[MB CLIENT] Leaving WebSocket room: ${roomId}`)
    this.socket.emit('leaveRoom', roomId)

    // Ensure the room is removed from tracking
    this.joinedRooms.delete(roomId)
  }

  /**
   * @method disconnectWebSocket
   * @async
   * @returns {Promise<void>} Resolves when the WebSocket connection is successfully closed.
   *
   * @description
   * Gracefully disconnects the WebSocket connection to the MessageBox server.
   * This should be called when the client is shutting down, logging out, or no longer
   * needs real-time communication to conserve system resources.
   *
   * @example
   * await client.disconnectWebSocket()
   */
  async disconnectWebSocket(): Promise<void> {
    await this.assertInitialized()
    if (this.socket != null) {
      Logger.log('[MB CLIENT] Closing WebSocket connection...')
      this.socket.disconnect()
      this.socket = undefined
    } else {
      Logger.log('[MB CLIENT] No active WebSocket connection to close.')
    }
  }

  /**
   * @method sendMessage
   * @async
   * @param {SendMessageParams} message - Contains recipient, messageBox name, message body, optional messageId, and skipEncryption flag.
   * @param {string} [overrideHost] - Optional host to override overlay resolution (useful for testing or private routing).
   * @returns {Promise<SendMessageResponse>} - Resolves with `{ status, messageId }` on success.
   *
   * @description
   * Sends a message over HTTP to a recipient's messageBox. This method:
   *
   * - Derives a deterministic `messageId` using an HMAC of the message body and recipient key.
   * - Encrypts the message body using AES-256-GCM, derived from a shared secret using BRC-2-compliant key derivation and ECDH, unless `skipEncryption` is set to true.
   * - Automatically resolves the host via overlay LookupResolver unless an override is provided.
   * - Authenticates the request using the current identity key with `AuthFetch`.
   *
   * This is the fallback mechanism for `sendLiveMessage` when WebSocket delivery fails.
   * It is also used for message types that do not require real-time delivery.
   *
   * @throws {Error} If validation, encryption, HMAC, or network request fails.
   *
   * @example
   * await client.sendMessage({
   *   recipient: '03abc...',
   *   messageBox: 'notifications',
   *   body: { type: 'ping' }
   * })
   */
  async sendMessage(
    message: SendMessageParams,
    overrideHost?: string
  ): Promise<SendMessageResponse> {
    await this.assertInitialized()
    if (message.recipient == null || message.recipient.trim() === '') {
      throw new Error('You must provide a message recipient!')
    }
    if (message.messageBox == null || message.messageBox.trim() === '') {
      throw new Error('You must provide a messageBox to send this message into!')
    }
    if (message.body == null || (typeof message.body === 'string' && message.body.trim().length === 0)) {
      throw new Error('Every message must have a body!')
    }

    // Optional permission checking for backwards compatibility
    let paymentData: Payment | undefined
    if (message.checkPermissions === true) {
      try {
        Logger.log('[MB CLIENT] Checking permissions and fees for message...')

        // Get quote to check if payment is required
        const quote = await this.getMessageBoxQuote({
          recipient: message.recipient,
          messageBox: message.messageBox
        }, overrideHost) as MessageBoxQuote

        if (quote.recipientFee === -1) {
          throw new Error('You have been blocked from sending messages to this recipient.')
        }

        if (quote.recipientFee > 0 || quote.deliveryFee > 0) {
          const requiredPayment = quote.recipientFee + quote.deliveryFee

          if (requiredPayment > 0) {
            Logger.log(`[MB CLIENT] Creating payment of ${requiredPayment} sats for message...`)

            // Create payment using helper method
            paymentData = await this.createMessagePayment(
              message.recipient,
              quote,
              overrideHost
            )

            Logger.log('[MB CLIENT] Payment data prepared:', paymentData)
          }
        }
      } catch (error) {
        throw new Error(`Permission check failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    let messageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(message.body))),
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: message.recipient
      }, this.originator)
      messageId = message.messageId ?? Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to generate HMAC:', error)
      throw new Error('Failed to generate message identifier.')
    }

    let finalBody: string | EncryptedMessage
    if (message.skipEncryption === true) {
      finalBody = typeof message.body === 'string' ? message.body : JSON.stringify(message.body)
    } else {
      const encryptedMessage = await this.walletClient.encrypt({
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: message.recipient,
        plaintext: Utils.toArray(typeof message.body === 'string' ? message.body : JSON.stringify(message.body), 'utf8')
      }, this.originator)

      finalBody = JSON.stringify({ encryptedMessage: Utils.toBase64(encryptedMessage.ciphertext) })
    }

    const requestBody = {
      message: {
        ...message,
        messageId,
        body: finalBody
      },
      ...(paymentData != null && { payment: paymentData })
    }

    try {
      const finalHost = overrideHost ?? await this.resolveHostForRecipient(message.recipient)

      Logger.log('[MB CLIENT] Sending HTTP request to:', `${finalHost}/sendMessage`)
      Logger.log('[MB CLIENT] Request Body:', JSON.stringify(requestBody, null, 2))

      if (this.myIdentityKey == null || this.myIdentityKey === '') {
        try {
          const keyResult = await this.walletClient.getPublicKey({ identityKey: true }, this.originator)
          this.myIdentityKey = keyResult.publicKey
          Logger.log(`[MB CLIENT] Fetched identity key before sending request: ${this.myIdentityKey}`)
        } catch (error) {
          Logger.error('[MB CLIENT ERROR] Failed to fetch identity key:', error)
          throw new Error('Identity key retrieval failed')
        }
      }

      const response = await this.authFetch.fetch(`${finalHost}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      })

      if (response.bodyUsed) {
        throw new Error('[MB CLIENT ERROR] Response body has already been used!')
      }

      const parsedResponse = await response.json()
      Logger.log('[MB CLIENT] Raw Response Body:', parsedResponse)

      if (!response.ok) {
        Logger.error(`[MB CLIENT ERROR] Failed to send message. HTTP ${response.status}: ${response.statusText}`)
        throw new Error(`Message sending failed: HTTP ${response.status} - ${response.statusText}`)
      }

      if (parsedResponse.status !== 'success') {
        Logger.error(`[MB CLIENT ERROR] Server returned an error: ${String(parsedResponse.description)}`)
        throw new Error(parsedResponse.description ?? 'Unknown error from server.')
      }

      Logger.log('[MB CLIENT] Message successfully sent.')
      return { ...parsedResponse, messageId }
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Network or timeout error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to send message: ${errorMessage}`)
    }
  }

  /**
 * Multi-recipient sender. Uses the multi-quote route to:
 *  - identify blocked recipients
 *  - compute per-recipient payment
 * Then sends to the allowed recipients with payment attached.
 */
  async sendMesagetoRecepients(
    params: SendListParams,
    overrideHost?: string
  ): Promise<SendListResult> {
    await this.assertInitialized()

    const { recipients, messageBox, body } = params
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error('You must provide at least one recipient!')
    }
    if (!messageBox || messageBox.trim() === '') {
      throw new Error('You must provide a messageBox to send this message into!')
    }
    if (body == null || (typeof body === 'string' && body.trim().length === 0)) {
      throw new Error('Every message must have a body!')
    }

    // 1) Multi-quote for all recipients
    const quoteResponse = await this.getMessageBoxQuote({
      recipient: recipients,
      messageBox
    }, overrideHost) as MessageBoxMultiQuote

    const quotesByRecipient = Array.isArray(quoteResponse?.quotesByRecipient)
      ? quoteResponse.quotesByRecipient
      : []

    const blocked = (quoteResponse?.blockedRecipients ?? [])
    const totals = quoteResponse?.totals

    // 2) Filter allowed recipients
    const allowedRecipients = recipients.filter(r => !blocked.includes(r))
    if (allowedRecipients.length === 0) {
      return {
        status: 'error',
        description: `All ${recipients.length} recipients are blocked.`,
        sent: [],
        blocked,
        failed: recipients.map(r => ({ recipient: r, error: 'blocked' })),
        totals
      }
    }

    // 3) Map recipient -> fees
    const perRecipientQuotes = new Map<string, { recipientFee: number, deliveryFee: number }>()
    for (const q of quotesByRecipient) {
      perRecipientQuotes.set(q.recipient, { recipientFee: q.recipientFee, deliveryFee: q.deliveryFee })
    }

    // 4) One delivery agent only (batch goes to one server)
    const { deliveryAgentIdentityKeyByHost } = quoteResponse
    if (!deliveryAgentIdentityKeyByHost || Object.keys(deliveryAgentIdentityKeyByHost).length === 0) {
      throw new Error('Missing delivery agent identity keys in quote response.')
    }
    if (Object.keys(deliveryAgentIdentityKeyByHost).length > 1 && !overrideHost) {
      // To keep the single-POST invariant, we require all recipients to share a host
      throw new Error('Recipients resolve to multiple hosts. Use overrideHost to force a single server or split by host.')
    }

    // pick the host to POST to
    let finalHost = overrideHost ?? await this.resolveHostForRecipient(allowedRecipients[0])
    while (finalHost.endsWith('/')) {
      finalHost = finalHost.slice(0, -1)
    }
    const singleDeliveryKey = deliveryAgentIdentityKeyByHost[finalHost] ??
      Object.values(deliveryAgentIdentityKeyByHost)[0]

    if (!singleDeliveryKey) {
      throw new Error('Could not determine server delivery agent identity key.')
    }

    // 5) Identity key (sender)
    if (!this.myIdentityKey) {
      const keyResult = await this.walletClient.getPublicKey({ identityKey: true }, this.originator)
      this.myIdentityKey = keyResult.publicKey
    }

    // 6) Build per-recipient messageIds (HMAC), same order as allowedRecipients
    const bodyBytes = Array.from(new TextEncoder().encode(JSON.stringify(body)))
    const messageIds: string[] = await this.mapWithConcurrency(allowedRecipients, 8, async (r) => {
      const hmac = await this.walletClient.createHmac({
        data: bodyBytes,
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: r
      }, this.originator)
      return Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    })

    // 7) Body: for batch route the server expects a single shared body.
    // Per-recipient encryption requires a different server payload shape.
    const finalBody = typeof body === 'string' ? body : JSON.stringify(body)

    // 8) ONE batch payment with server output at index 0
    const paymentData = await this.createMessagePaymentBatch(
      allowedRecipients,
      perRecipientQuotes,
      singleDeliveryKey
    )

    // 9) Single POST to /sendMessage with recipients[] + messageId[]
    const requestBody = {
      message: {
        recipients: allowedRecipients,
        messageBox,
        messageId: messageIds, // aligned by index with recipients
        body: finalBody
      },
      payment: paymentData
    }

    Logger.log('[MB CLIENT] Sending HTTP request to:', `${finalHost}/sendMessage`)
    Logger.log('[MB CLIENT] Request Body (batch):', JSON.stringify({ ...requestBody, payment: { ...paymentData, tx: '<omitted>' } }, null, 2))

    try {
      const response = await this.authFetch.fetch(`${finalHost}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      })

      const parsed = await response.json().catch(() => ({} as any))
      if (!response.ok || parsed.status !== 'success') {
        const msg = !response.ok ? `HTTP ${response.status} - ${response.statusText}` : (parsed.description ?? 'Unknown server error')
        throw new Error(msg)
      }

      // server returns { results: [{ recipient, messageId }] }
      const sent = Array.isArray(parsed.results) ? parsed.results : []
      const failed: Array<{ recipient: string, error: string }> = [] // handled server-side now

      const status: SendListResult['status'] =
        sent.length === allowedRecipients.length
          ? 'success'
          : sent.length > 0
            ? 'partial'
            : 'error'

      const description =
        status === 'success'
          ? `Sent to ${sent.length} recipients.`
          : status === 'partial'
            ? `Sent to ${sent.length} recipients; ${allowedRecipients.length - sent.length} failed; ${blocked.length} blocked.`
            : `Failed to send to ${allowedRecipients.length} allowed recipients. ${blocked.length} blocked.`

      return { status, description, sent, blocked, failed, totals }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return {
        status: 'error',
        description: `Batch send failed: ${msg}`,
        sent: [],
        blocked,
        failed: allowedRecipients.map(r => ({ recipient: r, error: msg })),
        totals
      }
    }
  }

  /**
   * @method anointHost
   * @async
   * @param {string} host - The full URL of the server you want to designate as your MessageBox host (e.g., "https://mybox.com").
   * @returns {Promise<{ txid: string }>} - The transaction ID of the advertisement broadcast to the overlay network.
   *
   * @description
   * Broadcasts a signed overlay advertisement using a PushDrop output under the `tm_messagebox` topic.
   * This advertisement announces that the specified `host` is now authorized to receive and route
   * messages for the sender’s identity key.
   *
   * The broadcasted message includes:
   * - The identity key
   * - The chosen host URL
   *
   * This is essential for enabling overlay-based message delivery via SHIP and LookupResolver.
   * The recipient’s host must advertise itself for message routing to succeed in a decentralized manner.
   *
   * @throws {Error} If the URL is invalid, the PushDrop creation fails, or the overlay broadcast does not succeed.
   *
   * @example
   * const { txid } = await client.anointHost('https://my-messagebox.io')
   */
  async anointHost(host: string): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting anointHost...')
    if (!host.startsWith('http')) throw new Error('Invalid host URL')

    const identityKey = await this.getIdentityKey()
    const overlayTokens = await this.queryAdvertisements(identityKey)
    Logger.log(`[MB CLIENT] Found ${overlayTokens.length} existing advertisement(s) on overlay`)

    // Fetch ALL spendable wallet basket outputs and cross-reference with overlay tokens.
    // Only overlay tokens the wallet considers spendable are safe to spend as inputs.
    // This prevents stale overlay tokens (spent externally) from breaking the combined tx.
    const basketResult = await this.walletClient.listOutputs({
      basket: 'overlay advertisements',
      limit: 10000
    }, this.originator)
    const spendableOutpoints = new Set(
      basketResult.outputs.filter(o => o.spendable).map(o => o.outpoint)
    )
    const tokensToSpend = overlayTokens.filter(t => spendableOutpoints.has(`${t.txid}.${t.outputIndex}`))
    const skipped = overlayTokens.length - tokensToSpend.length
    if (skipped > 0) {
      Logger.log(`[MB CLIENT] Skipping ${skipped} overlay token(s) not in spendable wallet basket`)
    }
    Logger.log(`[MB CLIENT] Revoking ${tokensToSpend.length} spendable token(s) in combined tx`)

    const fields: number[][] = [
      Utils.toArray(identityKey, 'hex'),
      Utils.toArray(host, 'utf8')
    ]
    const pushdrop = new PushDrop(this.walletClient, this.originator)
    const script = await pushdrop.lock(
      fields,
      [1, 'messagebox advertisement'],
      '1',
      'anyone',
      true
    )
    Logger.log('[MB CLIENT] PushDrop script:', script.toASM())

    try {
      let inputBEEF: number[] | undefined
      if (tokensToSpend.length > 0) {
        const mergedBeef = Beef.fromBinary(tokensToSpend[0].beef)
        for (let i = 1; i < tokensToSpend.length; i++) {
          mergedBeef.mergeBeef(Beef.fromBinary(tokensToSpend[i].beef))
        }
        inputBEEF = mergedBeef.toBinary()
      }

      const { signableTransaction, tx: directTx, txid: directTxid } = await this.walletClient.createAction({
        description: 'Anoint host for overlay routing',
        ...(inputBEEF !== undefined && {
          inputBEEF,
          inputs: tokensToSpend.map(token => ({
            outpoint: `${token.txid}.${token.outputIndex}`,
            unlockingScriptLength: 73,
            inputDescription: `Revoking advertisement for ${token.host}`
          }))
        }),
        outputs: [{
          basket: 'overlay advertisements',
          lockingScript: script.toHex(),
          satoshis: 1,
          outputDescription: 'Overlay advertisement output'
        }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      }, this.originator)

      if (signableTransaction === undefined) {
        if (directTx === undefined) throw new Error('Anoint failed: no transaction returned')
        Logger.log('[MB CLIENT] Transaction created (no inputs to sign):', directTxid)
        const broadcaster = new TopicBroadcaster(['tm_messagebox'], { networkPreset: this.networkPreset })
        const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(directTx))
        Logger.log('[MB CLIENT] Advertisement broadcast succeeded. TXID:', result.txid)
        if (typeof result.txid !== 'string') throw new Error('Anoint failed: broadcast did not return a txid')
        return { txid: result.txid }
      }

      const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
      const spends: Record<number, { unlockingScript: string }> = {}

      for (let i = 0; i < tokensToSpend.length; i++) {
        const token = tokensToSpend[i]
        const sourceTx = Transaction.fromBEEF(token.beef)
        const sourceSatoshis = sourceTx.outputs[token.outputIndex]?.satoshis ?? 1
        const unlocker = pushdrop.unlock(
          [1, 'messagebox advertisement'],
          '1',
          'anyone',
          'all',
          false,
          sourceSatoshis,
          token.lockingScript
        )
        const finalUnlockScript = await unlocker.sign(partialTx, i)
        spends[i] = { unlockingScript: finalUnlockScript.toHex() }
      }

      const { tx: signedTx, txid: signedTxid } = await this.walletClient.signAction({
        reference: signableTransaction.reference,
        spends,
        options: { acceptDelayedBroadcast: false }
      }, this.originator)

      if (signedTx === undefined) throw new Error('Anoint failed: signing did not return a transaction')
      Logger.log('[MB CLIENT] Transaction created:', signedTxid)

      const broadcaster = new TopicBroadcaster(['tm_messagebox'], { networkPreset: this.networkPreset })
      const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(signedTx))
      Logger.log('[MB CLIENT] Advertisement broadcast succeeded. TXID:', result.txid)

      if (typeof result.txid !== 'string') throw new Error('Anoint failed: broadcast did not return a txid')
      return { txid: result.txid }
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] anointHost threw:', err)
      throw err
    }
  }

  /**
   * @method revokeHostAdvertisement
   * @async
   * @param {AdvertisementToken} advertisementToken - The advertisement token containing the messagebox host to revoke.
   * @param {string} [originator] - Optional originator to use with walletClient.
   * @returns {Promise<{ txid: string }>} - The transaction ID of the revocation broadcast to the overlay network.
   *
   * @description
   * Broadcasts a signed revocation transaction indicating the advertisement token should be removed
   * and no longer tracked by lookup services.
   *
   * @example
   * const { txid } = await client.revokeHost('https://my-messagebox.io')
   */
  async revokeHostAdvertisement(advertisementToken: AdvertisementToken): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting revokeHost...')
    const outpoint = `${advertisementToken.txid}.${advertisementToken.outputIndex}`
    try {
      const { signableTransaction } = await this.walletClient.createAction({
        description: 'Revoke MessageBox host advertisement',
        inputBEEF: advertisementToken.beef,
        inputs: [
          {
            outpoint,
            unlockingScriptLength: 73,
            inputDescription: 'Revoking host advertisement token'
          }
        ]
      }, this.originator)

      if (signableTransaction === undefined) {
        throw new Error('Failed to create signable transaction.')
      }

      const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)

      // Get the source satoshis from the BEEF so the sighash preimage is correct
      const sourceTx = Transaction.fromBEEF(advertisementToken.beef)
      const sourceSatoshis = sourceTx.outputs[advertisementToken.outputIndex]?.satoshis ?? 1

      // Prepare the unlocker
      const pushdrop = new PushDrop(this.walletClient, this.originator)
      const unlocker = pushdrop.unlock(
        [1, 'messagebox advertisement'],
        '1',
        'anyone',
        'all',
        false,
        sourceSatoshis,
        advertisementToken.lockingScript
      )

      // Convert to Transaction, apply signature
      const finalUnlockScript = await unlocker.sign(partialTx, 0)

      // Complete signing with the final unlock script
      const { tx: signedTx } = await this.walletClient.signAction({
        reference: signableTransaction.reference,
        spends: {
          0: {
            unlockingScript: finalUnlockScript.toHex()
          }
        },
        options: {
          acceptDelayedBroadcast: false
        }
      }, this.originator)

      if (signedTx === undefined) {
        throw new Error('Failed to finalize the transaction signature.')
      }

      const broadcaster = new TopicBroadcaster(['tm_messagebox'], {
        networkPreset: this.networkPreset
      })

      const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(signedTx))
      Logger.log('[MB CLIENT] Revocation broadcast succeeded. TXID:', result.txid)

      if (typeof result.txid !== 'string') {
        throw new Error('Revoke failed: broadcast did not return a txid')
      }

      return { txid: result.txid }
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] revokeHost threw:', err)
      throw err
    }
  }

  /**
   * @method listMessages
   * @async
   * @param {ListMessagesParams} params - Contains the name of the messageBox to read from.
   * @returns {Promise<PeerMessage[]>} - Returns an array of decrypted `PeerMessage` objects.
   *
   * @description
   * Retrieves all messages from the specified `messageBox` assigned to the current identity key.
   * Unless a host override is provided, messages are fetched from the resolved overlay host (via LookupResolver) or the default host if no advertisement is found.
   *
   * Each message is:
   * - Parsed and, if encrypted, decrypted using AES-256-GCM via BRC-2-compliant ECDH key derivation and symmetric encryption.
   * - Automatically processed for payments: if the message includes recipient fee payments, they are internalized using `walletClient.internalizeAction()`.
   * - Returned as a normalized `PeerMessage` with readable string body content.
   *
   * Payment Processing:
   * - Detects messages that include payment data (from paid message delivery).
   * - Automatically internalizes recipient payment outputs, allowing you to receive payments without additional API calls.
   * - Only recipient payments are stored with messages - delivery fees are already processed by the server.
   * - Continues processing messages even if payment internalization fails.
   *
   * Decryption automatically derives a shared secret using the sender's identity key and the receiver's child private key.
   * If the sender is the same as the recipient, the `counterparty` is set to `'self'`.
   *
   * @throws {Error} If no messageBox is specified, the request fails, or the server returns an error.
   *
   * @example
   * const messages = await client.listMessages({ messageBox: 'inbox' })
   * messages.forEach(msg => console.log(msg.sender, msg.body))
   * // Payments included with messages are automatically received
   */
  async listMessages({ messageBox, host, acceptPayments }: ListMessagesParams): Promise<PeerMessage[]> {
    if (typeof acceptPayments !== 'boolean') {
      acceptPayments = true
    }
    if (messageBox.trim() === '') {
      throw new Error('MessageBox cannot be empty')
    }

    let hosts: string[] = host != null ? [host] : []
    if (hosts.length === 0) {
      const advertisedHosts = await this.queryAdvertisements(
        await this.getIdentityKey(),
        undefined
      )
      hosts = Array.from(new Set([this.host, ...advertisedHosts.map(h => h.host)]))
    }

    // Query each host in parallel
    const fetchFromHost = async (host: string): Promise<PeerMessage[]> => {
      try {
        Logger.log(`[MB CLIENT] Listing messages from ${host}…`)
        const res = await this.authFetch.fetch(`${host}/listMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageBox })
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        const data = await res.json()
        if (data.status === 'error') throw new Error(data.description ?? 'Unknown server error')
        return data.messages as PeerMessage[]
      } catch (err) {
        Logger.log(`[MB CLIENT DEBUG] listMessages failed for ${host}:`, err)
        throw err // re-throw to be caught in the settled promise
      }
    }

    const settled = await Promise.allSettled(hosts.map(fetchFromHost))

    // 3. Split successes / failures
    const messagesByHost: PeerMessage[][] = []
    const errors: any[] = []

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        messagesByHost.push(r.value)
      } else {
        errors.push(r.reason)
      }
    }

    // 4. If *every* host failed – throw aggregated error
    if (messagesByHost.length === 0) {
      throw new Error('Failed to retrieve messages from any host')
    }

    // 5. Merge & de‑duplicate (first‑seen wins)
    const dedupMap = new Map<string, PeerMessage>()
    for (const messageList of messagesByHost) {
      for (const m of messageList) {
        if (!dedupMap.has(m.messageId)) dedupMap.set(m.messageId, m)
      }
    }

    // 6. Early‑out: no messages but at least one host succeeded → []
    if (dedupMap.size === 0) return []

    const messages: PeerMessage[] = Array.from(dedupMap.values())

    const parsed = messages.map(message => {
      const parsedBody: unknown =
        typeof message.body === 'string' ? this.tryParse(message.body) : message.body

      let messageContent: any = parsedBody
      let paymentData: Payment | undefined

      if (
        parsedBody != null &&
        typeof parsedBody === 'object' &&
        'message' in parsedBody
      ) {
        const wrappedMessage = (parsedBody as any).message
        messageContent = typeof wrappedMessage === 'string'
          ? this.tryParse(wrappedMessage)
          : wrappedMessage
        paymentData = (parsedBody as any).payment
      }

      return { message, parsedBody, messageContent, paymentData }
    })

    if (acceptPayments) {
      const paymentJobs = parsed
        .filter(p => p.paymentData?.tx != null && p.paymentData.outputs != null)

      await this.mapWithConcurrency(paymentJobs, 2, async (p) => {
        try {
          Logger.log(
            `[MB CLIENT] Processing recipient payment in message from ${String(p.message.sender)}…`
          )

          const recipientOutputs = (p.paymentData as Payment).outputs.filter(
            output => output.protocol === 'wallet payment'
          )

          if (recipientOutputs.length > 0) {
            Logger.log(
              `[MB CLIENT] Internalizing ${recipientOutputs.length} recipient payment output(s)…`
            )

            const internalizeResult = await this.walletClient.internalizeAction({
              tx: (p.paymentData as Payment).tx,
              outputs: recipientOutputs,
              description: (p.paymentData as Payment).description ?? 'MessageBox recipient payment'
            }, this.originator)

            if (internalizeResult.accepted) {
              Logger.log(
                '[MB CLIENT] Successfully internalized recipient payment'
              )
            } else {
              Logger.warn(
                '[MB CLIENT] Recipient payment internalization was not accepted'
              )
            }
          } else {
            Logger.log(
              '[MB CLIENT] No wallet payment outputs found in payment data'
            )
          }
        } catch (paymentError) {
          Logger.error(
            '[MB CLIENT ERROR] Failed to internalize recipient payment:',
            paymentError
          )
        }
        return null
      })
    }

    await this.mapWithConcurrency(parsed, 4, async (p) => {
      try {
        if (
          p.messageContent != null &&
          typeof p.messageContent === 'object' &&
          typeof (p.messageContent).encryptedMessage === 'string'
        ) {
          Logger.log(
            `[MB CLIENT] Decrypting message from ${String(p.message.sender)}…`
          )

          const decrypted = await this.walletClient.decrypt({
            protocolID: [1, 'messagebox'],
            keyID: '1',
            counterparty: p.message.sender,
            ciphertext: Utils.toArray(
              (p.messageContent).encryptedMessage,
              'base64'
            )
          }, this.originator)

          const decryptedText = Utils.toUTF8(decrypted.plaintext)
          p.message.body = this.tryParse(decryptedText)
        } else {
          p.message.body = p.messageContent ?? p.parsedBody
        }
      } catch (err) {
        Logger.error(
          '[MB CLIENT ERROR] Failed to parse or decrypt message in list:',
          err
        )
        p.message.body = '[Error: Failed to decrypt or parse message]'
      }
      return null
    })

    // Sort newest‑first for a deterministic order
    messages.sort(
      (a, b) =>
        Number((b as any).timestamp ?? 0) - Number((a as any).timestamp ?? 0)
    )

    return messages
  }

  /**
   * @method listMessagesLite
   * @async
   * @param {ListMessagesParams} params - Contains the `messageBox` to read from and the `host` to query.
   * @returns {Promise<PeerMessage[]>} - Returns an array of decrypted `PeerMessage` objects with minimal processing.
   *
   * @description
   * A lightweight variant of {@link listMessages} that fetches and decrypts messages
   * from a specific host without performing:
   * - Overlay host resolution
   * - Payment acceptance or internalization
   * - Cross-host deduplication
   *
   * This method:
   * - Sends a direct POST request to the specified host's `/listMessages` endpoint.
   * - Parses message bodies as JSON when possible.
   * - Decrypts messages if they contain an `encryptedMessage` field, using AES-256-GCM via BRC-2-compliant ECDH key derivation.
   * - Returns messages in the order provided by the host.
   *
   * This is intended for cases where you already know the host and need faster,
   * simpler retrieval without the additional processing overhead of `listMessages`.
   *
   * @throws {Error} If the host returns an error status or decryption fails.
   *
   * @example
   * const messages = await client.listMessagesLite({
   *   messageBox: 'notifications',
   *   host: 'https://message-box-us-1.bsvb.tech'
   * })
   * console.log(messages)
   */
  async listMessagesLite({ messageBox, host }: ListMessagesParams): Promise<PeerMessage[]> {
    const res = await this.authFetch.fetch(`${host as string}/listMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageBox })
    })
    const data = await res.json()
    if (data.status === 'error') throw new Error(data.description ?? 'Unknown server error')
    const messages = data.messages as PeerMessage[]
    const tryParse = (raw: string): any => {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }

    await this.mapWithConcurrency(messages, 4, async (message) => {
      try {
        const parsedBody: unknown =
          typeof message.body === 'string' ? tryParse(message.body) : message.body
        let messageContent: any = parsedBody
        if (
          parsedBody != null &&
          typeof parsedBody === 'object' &&
          'message' in parsedBody
        ) {
          const wrappedMessage = (parsedBody as any).message
          messageContent = typeof wrappedMessage === 'string'
            ? tryParse(wrappedMessage)
            : wrappedMessage
        }
        if (
          messageContent != null &&
          typeof messageContent === 'object' &&
          typeof messageContent.encryptedMessage === 'string'
        ) {
          const decrypted = await this.walletClient.decrypt({
            protocolID: [1, 'messagebox'],
            keyID: '1',
            counterparty: message.sender,
            ciphertext: Utils.toArray(
              messageContent.encryptedMessage,
              'base64'
            )
          })
          const decryptedText = Utils.toUTF8(decrypted.plaintext)
          message.body = tryParse(decryptedText)
        } else {
          message.body = messageContent ?? parsedBody
        }
      } catch (err) {
        Logger.error(
          '[MB CLIENT ERROR] Failed to parse or decrypt message in list:',
          err
        )
        message.body = '[Error: Failed to decrypt or parse message]'
      }
      return null
    })
    return messages
  }

  /**
   * @method tryParse
   * @private
   * @param {string} raw - A raw string value that may contain JSON.
   * @returns {any} - The parsed JavaScript object if valid JSON, or the original string if parsing fails.
   *
   * @description
   * Attempts to parse a string as JSON. If the string is valid JSON, returns the parsed object;
   * otherwise returns the original string unchanged.
   *
   * This method is used throughout the client to safely handle message bodies that may or may not be
   * JSON-encoded without throwing parsing errors.
   *
   * @example
   * tryParse('{"hello":"world"}') // → { hello: "world" }
   * tryParse('plain text')        // → "plain text"
   */
  tryParse(raw: string): any {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    if (items.length === 0) return []
    if (!Number.isFinite(limit) || limit >= items.length) {
      return await Promise.all(items.map((item, index) => fn(item, index)))
    }

    const workerCount = Math.max(1, Math.min(limit, items.length))
    const results: R[] = new Array(items.length)
    let nextIndex = 0

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex
        nextIndex++
        if (currentIndex >= items.length) return
        results[currentIndex] = await fn(items[currentIndex], currentIndex)
      }
    })

    await Promise.all(workers)
    return results
  }

  /**
   * @method acknowledgeNotification
   * @async
   * @param {PeerMessage} message - The peer message object to acknowledge.
   * @returns {Promise<boolean>} - Resolves to `true` if the message included a recipient payment and it was successfully internalized, otherwise `false`.
   *
   * @description
   * Acknowledges receipt of a specific notification message and, if applicable, processes any recipient
   * payment contained within it.
   *
   * This method:
   * 1. Calls `acknowledgeMessage()` to remove the message from the server's queue.
   * 2. Checks the message body for embedded payment data.
   * 3. If a recipient payment exists, attempts to internalize it into the wallet.
   *
   * This is a convenience wrapper for acknowledgment and payment handling specifically for messages
   * representing notifications.
   *
   * @example
   * const success = await client.acknowledgeNotification(message)
   * console.log(success ? 'Payment received' : 'No payment or failed')
   */
  async acknowledgeNotification(message: PeerMessage): Promise<boolean> {
    await this.acknowledgeMessage({ messageIds: [message.messageId] })

    const parsedBody: unknown =
      typeof message.body === 'string' ? this.tryParse(message.body) : message.body

    let paymentData: Payment | undefined

    if (
      parsedBody != null &&
      typeof parsedBody === 'object' &&
      'message' in parsedBody
    ) {
      paymentData = (parsedBody as any).payment
    }

    // Process payment if present - server now only stores recipient payments
    if (paymentData?.tx != null && paymentData.outputs != null) {
      try {
        Logger.log(
          `[MB CLIENT] Processing recipient payment in message from ${String(message.sender)}…`
        )

        // All outputs in the stored payment data are for the recipient
        // (delivery fees are already processed by the server)
        const recipientOutputs = paymentData.outputs.filter(
          output => output.protocol === 'wallet payment'
        )

        if (recipientOutputs.length < 1) {
          Logger.log(
            '[MB CLIENT] No wallet payment outputs found in payment data'
          )
          return false
        }

        Logger.log(
          `[MB CLIENT] Internalizing ${recipientOutputs.length} recipient payment output(s)…`
        )

        const internalizeResult = await this.walletClient.internalizeAction({
          tx: paymentData.tx,
          outputs: recipientOutputs,
          description: paymentData.description ?? 'MessageBox recipient payment'
        })

        if (internalizeResult.accepted) {
          Logger.log(
            '[MB CLIENT] Successfully internalized recipient payment'
          )
          return true
        } else {
          Logger.warn(
            '[MB CLIENT] Recipient payment internalization was not accepted'
          )
          return false
        }
      } catch (paymentError) {
        Logger.error(
          '[MB CLIENT ERROR] Failed to internalize recipient payment:',
          paymentError
        )
        return false
      }
    }
    return false
  }

  /**
   * @method acknowledgeMessage
   * @async
   * @param {AcknowledgeMessageParams} params - An object containing an array of message IDs to acknowledge.
   * @returns {Promise<string>} - A string indicating the result, typically `'success'`.
   *
   * @description
   * Notifies the MessageBox server(s) that one or more messages have been
   * successfully received and processed by the client. Once acknowledged, these messages are removed
   * from the recipient's inbox on the server(s).
   *
   * This operation is essential for proper message lifecycle management and prevents duplicate
   * processing or delivery.
   *
   * Acknowledgment supports providing a host override, or will use overlay routing to find the appropriate server the received the given message.
   *
   * @throws {Error} If the message ID array is missing or empty, or if the request to the server fails.
   *
   * @example
   * await client.acknowledgeMessage({ messageIds: ['msg123', 'msg456'] })
   */
  async acknowledgeMessage({ messageIds, host }: AcknowledgeMessageParams): Promise<string> {
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error('Message IDs array cannot be empty')
    }

    Logger.log(`[MB CLIENT] Acknowledging messages ${JSON.stringify(messageIds)}…`)

    let hosts: string[] = host != null ? [host] : []
    if (hosts.length === 0) {
      // 1. Determine all hosts (advertised + default)
      const identityKey = await this.getIdentityKey()
      const advertisedHosts = await this.queryAdvertisements(identityKey, undefined)
      hosts = Array.from(new Set([this.host, ...advertisedHosts.map(h => h.host)]))
    }

    // 2. Dispatch parallel acknowledge requests
    const ackFromHost = async (host: string): Promise<string | null> => {
      try {
        const res = await this.authFetch.fetch(`${host}/acknowledgeMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds })
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data.status === 'error') throw new Error(data.description)
        Logger.log(`[MB CLIENT] Acknowledged on ${host}`)
        return data.status as string
      } catch (err) {
        Logger.warn(`[MB CLIENT WARN] acknowledgeMessage failed for ${host}:`, err)
        return null
      }
    }

    const settled = await Promise.allSettled(hosts.map(ackFromHost))

    const successes = settled.filter(
      (r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled'
    )

    const firstSuccess = successes.find(s => s.value != null)?.value

    if (firstSuccess != null) {
      return firstSuccess
    }

    // No host accepted the acknowledgement
    const errs: any[] = []
    for (const r of settled) {
      if (r.status === 'rejected') errs.push(r.reason)
    }
    throw new Error(
      `Failed to acknowledge messages on all hosts: ${errs.map(e => String(e)).join('; ')}`
    )
  }

  // ===========================
  // PERMISSION MANAGEMENT METHODS
  // ===========================

  /**
   * @method setMessageBoxPermission
   * @async
   * @param {SetMessageBoxPermissionParams} params - Permission configuration
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<void>} Permission status after setting
   *
   * @description
   * Sets permission for receiving messages in a specific messageBox.
   * Can set sender-specific permissions or box-wide defaults.
   *
   * @example
   * // Set box-wide default: allow notifications for 10 sats
   * await client.setMessageBoxPermission({ messageBox: 'notifications', recipientFee: 10 })
   *
   * // Block specific sender
   * await client.setMessageBoxPermission({
   *   messageBox: 'notifications',
   *   sender: '03abc123...',
   *   recipientFee: -1
   * })
   */
  async setMessageBoxPermission(
    params: SetMessageBoxPermissionParams,
    overrideHost?: string
  ): Promise<void> {
    const finalHost = overrideHost ?? this.host

    Logger.log('[MB CLIENT] Setting messageBox permission...')

    const response = await this.authFetch.fetch(`${finalHost}/permissions/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageBox: params.messageBox,
        recipientFee: params.recipientFee,
        ...(params.sender != null && { sender: params.sender })
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Failed to set permission: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`)
    }

    const { status, description } = await response.json()
    if (status === 'error') {
      throw new Error(description ?? 'Failed to set permission')
    }
  }

  /**
   * @method getMessageBoxPermission
   * @async
   * @param {GetMessageBoxPermissionParams} params - Permission query parameters
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<MessageBoxPermission | null>} Permission data (null if not set)
   *
   * @description
   * Gets current permission data for a sender/messageBox combination.
   * Returns null if no permission is set.
   *
   * @example
   * const status = await client.getMessageBoxPermission({
   *   recipient: '03def456...',
   *   messageBox: 'notifications',
   *   sender: '03abc123...'
   * })
   */
  async getMessageBoxPermission(
    params: GetMessageBoxPermissionParams,
    overrideHost?: string
  ): Promise<MessageBoxPermission | null> {
    const finalHost = overrideHost ?? await this.resolveHostForRecipient(params.recipient)
    const queryParams = new URLSearchParams({
      recipient: params.recipient,
      messageBox: params.messageBox,
      ...(params.sender != null && { sender: params.sender })
    })

    Logger.log('[MB CLIENT] Getting messageBox permission...')

    const response = await this.authFetch.fetch(`${finalHost}/permissions/get?${queryParams.toString()}`, {
      method: 'GET'
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Failed to get permission: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`)
    }

    const data = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to get permission')
    }

    return data.permission
  }

  /**
   * @method getMessageBoxQuote
   * @async
   * @param {GetQuoteParams} params - Quote request parameters
   * @returns {Promise<MessageBoxQuote>} Fee quote and permission status
   *
   * @description
   * Gets a fee quote for sending a message, including delivery and recipient fees.
   *
   * @example
   * const quote = await client.getMessageBoxQuote({
   *   recipient: '03def456...',
   *   messageBox: 'notifications'
   * })
   */
  async getMessageBoxQuote(
    params: GetQuoteParams,
    overrideHost?: string
  ): Promise<MessageBoxQuote | MessageBoxMultiQuote> {
    if (Array.isArray(params.recipient)) {
      return this.getMultiMessageBoxQuote(params.recipient, params.messageBox, overrideHost)
    }

    return this.getSingleMessageBoxQuote(params.recipient, params.messageBox, overrideHost)
  }

  private async getSingleMessageBoxQuote(
    recipient: string,
    messageBox: string,
    overrideHost?: string
  ): Promise<MessageBoxQuote> {
    const finalHost = overrideHost ?? await this.resolveHostForRecipient(recipient)
    const queryParams = new URLSearchParams({
      recipient,
      messageBox
    })

    Logger.log('[MB CLIENT] Getting messageBox quote (single)...')
    console.log('HELP IM QUOTING', `${finalHost}/permissions/quote?${queryParams.toString()}`)
    const response = await this.authFetch.fetch(
      `${finalHost}/permissions/quote?${queryParams.toString()}`,
      { method: 'GET' }
    )
    console.log('server response from getquote]', response)
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `Failed to get quote: HTTP ${response.status} - ${typeof errorData.description === 'string' ? errorData.description : response.statusText}`
      )
    }

    const { status, description, quote } = await response.json()
    if (status === 'error') {
      throw new Error(description ?? 'Failed to get quote')
    }

    const deliveryAgentIdentityKey = response.headers.get('x-bsv-auth-identity-key')
    console.log('deliveryAgentIdentityKey', deliveryAgentIdentityKey)
    if (deliveryAgentIdentityKey == null) {
      throw new Error('Failed to get quote: Delivery agent did not provide their identity key')
    }

    return {
      recipientFee: quote.recipientFee,
      deliveryFee: quote.deliveryFee,
      deliveryAgentIdentityKey
    }
  }

  private async getMultiMessageBoxQuote(
    recipients: PubKeyHex[],
    messageBox: string,
    overrideHost?: string
  ): Promise<MessageBoxMultiQuote> {
    if (recipients.length === 0) {
      throw new Error('At least one recipient is required.')
    }

    Logger.log('[MB CLIENT] Getting messageBox quotes (multi)...')
    console.log('[MB CLIENT] Getting messageBox quotes (multi)...')
    const hostGroups = await this.groupQuoteRecipientsByHost(recipients, overrideHost)
    const accumulator = this.createMultiQuoteAccumulator()

    await Promise.all(Array.from(hostGroups.entries()).map(async ([host, group]) => {
      const payload = await this.fetchQuotePayloadForHost(host, group, messageBox, accumulator)
      this.mergeQuotePayload(payload, host, group, messageBox, accumulator)
    }))

    const { deliveryFees, recipientFees } = accumulator

    return {
      quotesByRecipient: accumulator.quotesByRecipient,
      totals: {
        deliveryFees,
        recipientFees,
        totalForPayableRecipients: deliveryFees + recipientFees
      },
      blockedRecipients: Array.from(accumulator.blockedRecipients),
      deliveryAgentIdentityKeyByHost: accumulator.deliveryAgentIdentityKeyByHost
    }
  }

  private createMultiQuoteAccumulator(): MessageBoxMultiQuoteAccumulator {
    return {
      quotesByRecipient: [],
      blockedRecipients: new Set(),
      deliveryAgentIdentityKeyByHost: {},
      deliveryFees: 0,
      recipientFees: 0
    }
  }

  private async groupQuoteRecipientsByHost(
    recipients: PubKeyHex[],
    overrideHost?: string
  ): Promise<Map<string, PubKeyHex[]>> {
    const resolvedHosts = overrideHost != null
      ? recipients.map(() => overrideHost)
      : await this.mapWithConcurrency(recipients, 8, (recipient) => this.resolveHostForRecipient(recipient))
    const hostGroups = new Map<string, PubKeyHex[]>()

    for (let i = 0; i < recipients.length; i++) {
      const host = resolvedHosts[i]
      const list = hostGroups.get(host) ?? []
      list.push(recipients[i])
      hostGroups.set(host, list)
    }

    return hostGroups
  }

  private async fetchQuotePayloadForHost(
    host: string,
    groupRecipients: PubKeyHex[],
    messageBox: string,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): Promise<unknown> {
    const qp = new URLSearchParams()
    for (const recipient of groupRecipients) qp.append('recipient', recipient)
    qp.set('messageBox', messageBox)

    const url = `${host}/permissions/quote?${qp.toString()}`
    Logger.log('[MB CLIENT] Multi-quote GET:', url)

    const response = await this.authFetch.fetch(url, { method: 'GET' })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `Failed to get quote (host ${host}): HTTP ${response.status} - ${typeof errorData.description === 'string' ? errorData.description : response.statusText}`
      )
    }

    const deliveryAgentKey = response.headers.get('x-bsv-auth-identity-key')
    if (deliveryAgentKey == null) {
      throw new Error(`Failed to get quote (host ${host}): missing delivery agent identity key`)
    }
    accumulator.deliveryAgentIdentityKeyByHost[host] = deliveryAgentKey

    return response.json()
  }

  private mergeQuotePayload(
    payload: unknown,
    host: string,
    groupRecipients: PubKeyHex[],
    messageBox: string,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    if (this.isMultiQuotePayload(payload)) {
      this.mergeRecipientQuotes(payload, accumulator)
      return
    }

    if (this.isSingleQuotePayload(payload)) {
      this.mergeSingleQuotePayload(payload, groupRecipients, messageBox, accumulator)
      return
    }

    throw new Error(`Unexpected quote response shape from host ${host}`)
  }

  private isMultiQuotePayload(payload: unknown): payload is {
    quotesByRecipient: MessageBoxRecipientQuote[]
    blockedRecipients?: PubKeyHex[]
  } {
    return typeof payload === 'object' &&
      payload != null &&
      Array.isArray((payload as { quotesByRecipient?: unknown }).quotesByRecipient)
  }

  private isSingleQuotePayload(payload: unknown): payload is {
    quote: Pick<MessageBoxRecipientQuote, 'deliveryFee' | 'recipientFee'>
  } {
    return typeof payload === 'object' &&
      payload != null &&
      (payload as { quote?: unknown }).quote != null
  }

  private mergeRecipientQuotes(
    payload: { quotesByRecipient: MessageBoxRecipientQuote[], blockedRecipients?: PubKeyHex[] },
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    for (const quote of payload.quotesByRecipient) {
      accumulator.quotesByRecipient.push({
        recipient: quote.recipient,
        messageBox: quote.messageBox,
        deliveryFee: quote.deliveryFee,
        recipientFee: quote.recipientFee,
        status: quote.status
      })
      accumulator.deliveryFees += quote.deliveryFee
      this.addRecipientFee(quote.recipient, quote.recipientFee, accumulator)
    }

    for (const recipient of payload.blockedRecipients ?? []) {
      accumulator.blockedRecipients.add(recipient)
    }
  }

  private mergeSingleQuotePayload(
    payload: { quote: Pick<MessageBoxRecipientQuote, 'deliveryFee' | 'recipientFee'> },
    groupRecipients: PubKeyHex[],
    messageBox: string,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    const { deliveryFee, recipientFee } = payload.quote
    const status = this.statusForRecipientFee(recipientFee)

    for (const recipient of groupRecipients) {
      accumulator.quotesByRecipient.push({
        recipient,
        messageBox,
        deliveryFee,
        recipientFee,
        status
      })
      accumulator.deliveryFees += deliveryFee
      this.addRecipientFee(recipient, recipientFee, accumulator)
    }
  }

  private addRecipientFee(
    recipient: PubKeyHex,
    recipientFee: number,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    if (recipientFee === -1) {
      accumulator.blockedRecipients.add(recipient)
      return
    }

    accumulator.recipientFees += recipientFee
  }

  private statusForRecipientFee(recipientFee: number): MessageBoxQuoteStatus {
    if (recipientFee === -1) return 'blocked'
    return recipientFee === 0 ? 'always_allow' : 'payment_required'
  }

  /**
   * @method listMessageBoxPermissions
   * @async
   * @param {ListPermissionsParams} [params] - Optional filtering and pagination parameters
   * @returns {Promise<MessageBoxPermission[]>} List of current permissions
   *
   * @description
   * Lists permissions for the authenticated user's messageBoxes with optional pagination.
   *
   * @example
   * // List all permissions
   * const all = await client.listMessageBoxPermissions()
   *
   * // List only notification permissions with pagination
   * const notifications = await client.listMessageBoxPermissions({
   *   messageBox: 'notifications',
   *   limit: 50,
   *   offset: 0
   * })
   */
  async listMessageBoxPermissions(params?: ListPermissionsParams, overrideHost?: string): Promise<MessageBoxPermission[]> {
    const finalHost = overrideHost ?? this.host
    const queryParams = new URLSearchParams()

    if (params?.messageBox != null) {
      queryParams.set('message_box', params.messageBox)
    }
    if (params?.limit !== undefined) {
      queryParams.set('limit', params.limit.toString())
    }
    if (params?.offset !== undefined) {
      queryParams.set('offset', params.offset.toString())
    }

    Logger.log('[MB CLIENT] Listing messageBox permissions with params:', queryParams.toString())

    const response = await this.authFetch.fetch(`${finalHost}/permissions/list?${queryParams.toString()}`, {
      method: 'GET'
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Failed to list permissions: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`)
    }

    const data = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to list permissions')
    }

    return data.permissions.map((p: any) => ({
      sender: p.sender,
      messageBox: p.message_box,
      recipientFee: p.recipient_fee,
      status: MessageBoxClient.getStatusFromFee(p.recipient_fee),
      createdAt: p.created_at,
      updatedAt: p.updated_at
    }))
  }

  // ===========================
  // NOTIFICATION CONVENIENCE METHODS
  // ===========================

  /**
   * @method allowNotificationsFromPeer
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to allow
   * @param {number} [recipientFee=0] - Fee to charge (0 for always allow)
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<void>} Permission status after allowing
   *
   * @description
   * Convenience method to allow notifications from a specific peer.
   *
   * @example
   * await client.allowNotificationsFromPeer('03abc123...') // Always allow
   * await client.allowNotificationsFromPeer('03def456...', 5) // Allow for 5 sats
   */
  async allowNotificationsFromPeer(identityKey: PubKeyHex, recipientFee: number = 0, overrideHost?: string): Promise<void> {
    await this.setMessageBoxPermission({
      messageBox: 'notifications',
      sender: identityKey,
      recipientFee
    }, overrideHost)
  }

  /**
   * @method denyNotificationsFromPeer
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to block
   * @returns {Promise<void>} Permission status after denying
   *
   * @description
   * Convenience method to block notifications from a specific peer.
   *
   * @example
   * await client.denyNotificationsFromPeer('03spam123...')
   */
  async denyNotificationsFromPeer(identityKey: PubKeyHex, overrideHost?: string): Promise<void> {
    await this.setMessageBoxPermission({
      messageBox: 'notifications',
      sender: identityKey,
      recipientFee: -1
    }, overrideHost)
  }

  /**
   * @method checkPeerNotificationStatus
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to check
   * @returns {Promise<MessageBoxPermission>} Current permission status
   *
   * @description
   * Convenience method to check notification permission for a specific peer.
   *
   * @example
   * const status = await client.checkPeerNotificationStatus('03abc123...')
   * console.log(status.allowed) // true/false
   */
  async checkPeerNotificationStatus(identityKey: PubKeyHex, overrideHost?: string): Promise<MessageBoxPermission | null> {
    const myIdentityKey = await this.getIdentityKey()
    return await this.getMessageBoxPermission({
      recipient: myIdentityKey,
      messageBox: 'notifications',
      sender: identityKey
    }, overrideHost)
  }

  /**
   * @method listPeerNotifications
   * @async
   * @returns {Promise<MessageBoxPermission[]>} List of notification permissions
   *
   * @description
   * Convenience method to list all notification permissions.
   *
   * @example
   * const notifications = await client.listPeerNotifications()
   */
  async listPeerNotifications(overrideHost?: string): Promise<MessageBoxPermission[]> {
    return await this.listMessageBoxPermissions({ messageBox: 'notifications' }, overrideHost)
  }

  /**
   * @method sendNotification
   * @async
   * @param {PubKeyHex} recipient - Recipient's identity key
   * @param {string | object} body - Notification content
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<SendMessageResponse>} Send result
   *
   * @description
   * Convenience method to send a notification with automatic quote fetching and payment handling.
   * Automatically determines the required payment amount and creates the payment if needed.
   *
   * @example
   * // Send notification (auto-determines payment needed)
   * await client.sendNotification('03def456...', 'Hello!')
   *
   * // Send with maximum payment limit for safety
   * await client.sendNotification('03def456...', { title: 'Alert', body: 'Important update' }, 50)
   */
  async sendNotification(
    recipient: PubKeyHex | PubKeyHex[],
    body: string | object,
    overrideHost?: string
  ): Promise<SendMessageResponse | SendListResult> {
    await this.assertInitialized()

    // Single recipient → keep original flow
    if (!Array.isArray(recipient)) {
      return await this.sendMessage({
        recipient,
        messageBox: 'notifications',
        body,
        checkPermissions: true
      }, overrideHost)
    }

    // Multiple recipients → new flow
    return await this.sendMesagetoRecepients({
      recipients: recipient,
      messageBox: 'notifications',
      body
    }, overrideHost)
  }

  /**
   * Register a device for FCM push notifications.
   *
   * @async
   * @param {DeviceRegistrationParams} params - Device registration parameters
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<DeviceRegistrationResponse>} Registration response
   *
   * @description
   * Registers a device with the message box server to receive FCM push notifications.
   * The FCM token is obtained from Firebase SDK on the client side.
   *
   * @example
   * const result = await client.registerDevice({
   *   fcmToken: 'eBo8F...',
   *   platform: 'ios',
   *   deviceId: 'iPhone15Pro'
   * })
   */
  async registerDevice(
    params: DeviceRegistrationParams,
    overrideHost?: string
  ): Promise<DeviceRegistrationResponse> {
    if (params.fcmToken == null || params.fcmToken.trim() === '') {
      throw new Error('fcmToken is required and must be a non-empty string')
    }

    // Validate platform if provided
    const validPlatforms = ['ios', 'android', 'web']
    if (params.platform != null && !validPlatforms.includes(params.platform)) {
      throw new Error('platform must be one of: ios, android, web')
    }

    const finalHost = overrideHost ?? this.host

    Logger.log('[MB CLIENT] Registering device for FCM notifications...')

    const response = await this.authFetch.fetch(`${finalHost}/registerDevice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fcmToken: params.fcmToken.trim(),
        deviceId: params.deviceId?.trim() ?? undefined,
        platform: params.platform ?? undefined
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const description = typeof errorData.description === 'string' ? errorData.description : response.statusText
      throw new Error(`Failed to register device: HTTP ${response.status} - ${description}`)
    }

    const data = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to register device')
    }

    Logger.log('[MB CLIENT] Device registered successfully')
    return {
      status: data.status,
      message: data.message,
      deviceId: data.deviceId
    }
  }

  /**
   * List all registered devices for push notifications.
   *
   * @async
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<RegisteredDevice[]>} Array of registered devices
   *
   * @description
   * Retrieves all devices registered by the authenticated user for FCM push notifications.
   * Only shows devices belonging to the current user (authenticated via AuthFetch).
   *
   * @example
   * const devices = await client.listRegisteredDevices()
   * console.log(`Found ${devices.length} registered devices`)
   * devices.forEach(device => {
   *   console.log(`Device: ${device.platform} - ${device.fcmToken}`)
   * })
   */
  async listRegisteredDevices(
    overrideHost?: string
  ): Promise<RegisteredDevice[]> {
    const finalHost = overrideHost ?? this.host

    Logger.log('[MB CLIENT] Listing registered devices...')

    const response = await this.authFetch.fetch(`${finalHost}/devices`, {
      method: 'GET'
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const description = typeof errorData.description === 'string' ? errorData.description : response.statusText
      throw new Error(`Failed to list devices: HTTP ${response.status} - ${description}`)
    }

    const data: ListDevicesResponse = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to list devices')
    }

    Logger.log(`[MB CLIENT] Found ${data.devices.length} registered devices`)
    return data.devices
  }

  // ===========================
  // PRIVATE HELPER METHODS
  // ===========================

  private static getStatusFromFee(fee: number): 'always_allow' | 'blocked' | 'payment_required' {
    if (fee === -1) return 'blocked'
    if (fee === 0) return 'always_allow'
    return 'payment_required'
  }

  /**
  * @method createMessagePayment
  * @private
  * @param {string} recipient - Recipient's identity key.
  * @param {MessageBoxQuote} quote - Quote object containing recipient and delivery fees.
  * @param {string} [description='MessageBox delivery payment'] - Description for the payment action.
  * @param {string} [originator] - Optional originator to use for wallet operations.
  * @returns {Promise<Payment>} - Payment data including the transaction and remittance outputs.
  *
  * @description
  * Constructs and signs a payment transaction covering both delivery and recipient fees for
  * message delivery, based on a previously obtained quote.
  *
  * The transaction includes:
  * - An optional delivery fee output for the MessageBox server.
  * - An optional recipient fee output for the message recipient.
  *
  * Payment remittance metadata (derivation prefix/suffix, sender identity) is embedded to allow
  * the payee to derive their private key and spend the output.
  *
  * @throws {Error} If no payment is required, key derivation fails, or the action creation fails.
  *
  * @example
  * const payment = await client.createMessagePayment(recipientKey, quote)
  * await client.sendMessage({ recipient, messageBox, body, payment })
  */
  private async createMessagePayment(
    recipient: string,
    quote: MessageBoxQuote,
    description: string = 'MessageBox delivery payment'
  ): Promise<Payment> {
    if (quote.recipientFee <= 0 && quote.deliveryFee <= 0) {
      throw new Error('No payment required')
    }

    Logger.log(`[MB CLIENT] Creating payment transaction for ${quote.recipientFee} sats (delivery: ${quote.deliveryFee}, recipient: ${quote.recipientFee})`)

    const outputs: InternalizeOutput[] = []
    const createActionOutputs: CreateActionOutput[] = []

    // Get sender identity key for remittance data
    const senderIdentityKey = await this.getIdentityKey()

    // Add server delivery fee output if > 0
    let outputIndex = 0
    if (quote.deliveryFee > 0) {
      const derivationPrefix = Utils.toBase64(Random(32))
      const derivationSuffix = Utils.toBase64(Random(32))

      // Get host's derived public key
      console.log('delivery agent:', quote.deliveryAgentIdentityKey)
      const { publicKey: derivedKeyResult } = await this.walletClient.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: quote.deliveryAgentIdentityKey
      }, this.originator)

      // Create locking script using host's public key
      const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKeyResult).toAddress()).toHex()

      // Add to createAction outputs
      createActionOutputs.push({
        satoshis: quote.deliveryFee,
        lockingScript,
        outputDescription: 'MessageBox server delivery fee',
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: quote.deliveryAgentIdentityKey
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey
        }
      })
    }

    // Add recipient fee output if > 0
    if (quote.recipientFee > 0) {
      const derivationPrefix = Utils.toBase64(Random(32))
      const derivationSuffix = Utils.toBase64(Random(32))
      // Get a derived public key for the recipient that "anyone" can verify
      const anyoneWallet = new ProtoWallet('anyone')
      const { publicKey: derivedKeyResult } = await anyoneWallet.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: recipient
      })

      if (derivedKeyResult == null || derivedKeyResult.trim() === '') {
        throw new Error('Failed to derive recipient\'s public key')
      }

      // Create locking script using recipient's public key
      const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKeyResult).toAddress()).toHex()

      // Add to createAction outputs
      createActionOutputs.push({
        satoshis: quote.recipientFee,
        lockingScript,
        outputDescription: 'Recipient message fee',
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: recipient
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: (await anyoneWallet.getPublicKey({ identityKey: true })).publicKey
        }
      })
    }

    const { tx } = await this.walletClient.createAction({
      description,
      outputs: createActionOutputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)

    if (tx == null) {
      throw new Error('Failed to create payment transaction')
    }

    return {
      tx,
      outputs,
      description
      // labels
    }
  }

  private async createMessagePaymentBatch(
    recipients: string[],
    perRecipientQuotes: Map<string, { recipientFee: number, deliveryFee: number }>,
    // server (delivery agent) identity key to pay the delivery fee to
    serverIdentityKey: string,
    description = 'MessageBox delivery payment (batch)'
  ): Promise<Payment> {
    const outputs: InternalizeOutput[] = []
    const createActionOutputs: CreateActionOutput[] = []

    // figure out the per-request delivery fee (take it from any quoted recipient)
    const deliveryFeeOnce =
      recipients.reduce<number | undefined>((acc, r) => {
        const q = perRecipientQuotes.get(r)
        return (q != null) ? (acc ?? q.deliveryFee) : acc
      }, undefined) ?? 0

    const senderIdentityKey = await this.getIdentityKey()
    let outputIndex = 0

    // index 0: server delivery fee (if any)
    if (deliveryFeeOnce > 0) {
      const derivationPrefix = Utils.toBase64(Random(32))
      const derivationSuffix = Utils.toBase64(Random(32))

      const { publicKey: agentDerived } = await this.walletClient.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: serverIdentityKey
      }, this.originator)

      const lockingScript = new P2PKH().lock(PublicKey.fromString(agentDerived).toAddress()).toHex()

      createActionOutputs.push({
        satoshis: deliveryFeeOnce,
        lockingScript,
        outputDescription: 'MessageBox server delivery fee (batch)',
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: serverIdentityKey
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
      })
    }

    // recipient outputs start at index 1 (or 0 if no delivery fee)
    const anyoneWallet = new ProtoWallet('anyone')
    const anyoneIdKey = (await anyoneWallet.getPublicKey({ identityKey: true })).publicKey

    for (const r of recipients) {
      const q = perRecipientQuotes.get(r)
      if ((q == null) || q.recipientFee <= 0) continue

      const derivationPrefix = Utils.toBase64(Random(32))
      const derivationSuffix = Utils.toBase64(Random(32))

      const { publicKey: recipientDerived } = await anyoneWallet.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: r
      })

      const lockingScript = new P2PKH().lock(PublicKey.fromString(recipientDerived).toAddress()).toHex()

      createActionOutputs.push({
        satoshis: q.recipientFee,
        lockingScript,
        outputDescription: `Recipient message fee (${r.slice(0, 8)}…)`,
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: r
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: anyoneIdKey
        }
      })
    }

    const { tx } = await this.walletClient.createAction({
      description,
      outputs: createActionOutputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)

    if (tx == null) throw new Error('Failed to create payment transaction')

    return { tx, outputs, description }
  }
}
