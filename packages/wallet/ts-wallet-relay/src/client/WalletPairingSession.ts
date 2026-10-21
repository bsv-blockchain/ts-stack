import { assertSafeWalletValue, validateWalletResult } from '@bsv/sdk/wallet/WalletResultValidation'
import {
  normalizeBRC100WalletByteFields,
  stringifyBRC100
} from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { validateWalletArgs } from '@bsv/sdk/wallet/WalletArgumentValidation'
import type { WalletProtocol } from '@bsv/sdk/wallet/Wallet.interfaces'
import type {
  WalletLike,
  PairingParams,
  WireEnvelope,
  RpcRequest,
  RpcResponse,
  WalletMethodName
} from '../types.js'
import { encryptEnvelope, decryptEnvelope, type CryptoParams } from '../shared/crypto.js'
import { verifyPairingSignature } from '../shared/pairingUri.js'
import {
  fetchBoundedJson,
  normalizeRelayUrl,
  parseRpcMessage,
  parseWireEnvelope,
  requireBoundedString,
  requireProtocolId,
  requirePublicKey,
  validateSessionInfo
} from '../shared/validation.js'
import { WALLET_METHOD_NAMES } from '../types.js'

export type PairingSessionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

/**
 * The wallet methods implemented by the BSV Browser mobile app.
 * Used as the default for `WalletPairingSessionOptions.implementedMethods`.
 */
export const DEFAULT_IMPLEMENTED_METHODS: ReadonlySet<WalletMethodName> = new Set<WalletMethodName>(
  [
    'getPublicKey',
    'listOutputs',
    'createAction',
    'signAction',
    'createSignature',
    'verifySignature',
    'listActions',
    'internalizeAction',
    'acquireCertificate',
    'relinquishCertificate',
    'listCertificates',
    'revealCounterpartyKeyLinkage',
    'createHmac',
    'verifyHmac',
    'encrypt',
    'decrypt'
  ]
)

/**
 * Methods approved without user interaction by default.
 * Used as the default for `WalletPairingSessionOptions.autoApproveMethods`.
 */
export const DEFAULT_AUTO_APPROVE_METHODS: ReadonlySet<WalletMethodName> =
  new Set<WalletMethodName>(['getPublicKey'])

const MAX_DECLARED_METHODS = 100
const MAX_ACTIVE_MOBILE_REQUESTS = 32

function snapshotMethods(value: ReadonlySet<string>, context: string): ReadonlySet<string> {
  const methods = Array.from(value)
  if (methods.length > MAX_DECLARED_METHODS) {
    throw new RangeError(`${context} may contain at most ${MAX_DECLARED_METHODS} methods`)
  }
  for (const method of methods) requireBoundedString(method, `${context} method`, 1, 100)
  return new Set(methods)
}

/** Return a result or an error string — used for the onRequest handler. */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>

export interface WalletPairingSessionOptions {
  /**
   * Methods your handler actually implements.
   * Requests for any other method receive a 501 without invoking onRequest or onApprovalRequired.
   * Defaults to {@link DEFAULT_IMPLEMENTED_METHODS} (the full BSV Browser method set).
   */
  implementedMethods?: ReadonlySet<string>

  /**
   * Subset of implementedMethods that are executed without calling onApprovalRequired.
   * Defaults to {@link DEFAULT_AUTO_APPROVE_METHODS} (`getPublicKey` only).
   */
  autoApproveMethods?: ReadonlySet<string>

  /**
   * Called for every implemented method that is not in autoApproveMethods.
   * Return true to approve, false to send a 4001 User Rejected response.
   * If omitted, methods outside autoApproveMethods are rejected.
   */
  onApprovalRequired?: (method: string, params: unknown) => Promise<boolean>

  /**
   * Additional metadata sent inside the pairing_approved inner payload.
   * Useful for identifying the wallet to the desktop.
   */
  walletMeta?: Record<string, unknown>

  /**
   * Require the origin's session lookup to report `backendIdentityKey`.
   * `resolveRelay()` always rejects a reported key that differs from the QR's key. A server
   * older than @bsv/wallet-relay 0.6.0 does not report the key; by default such a lookup is
   * accepted for compatibility. Set true to reject it instead. Default false; a future minor
   * release will default it to true.
   */
  requireOriginBoundKey?: boolean
}

/**
 * Manages the full mobile-side WS pairing lifecycle:
 *   1. Connects to the relay as `role=mobile`
 *   2. Encrypts and sends `pairing_approved`
 *   3. Decrypts inbound messages with replay-protection (seq tracking)
 *   4. Transitions to `connected` on the first successfully decrypted message
 *   5. Dispatches RPC requests through the registered handler
 *   6. Handles `pairing_ack` (no-op — just confirms the session is live)
 *
 * Fresh pairing:
 * ```ts
 * const session = new WalletPairingSession(wallet, pairingParams, {
 *   implementedMethods: new Set(['getPublicKey', 'listOutputs']),
 *   autoApproveMethods: new Set(['getPublicKey']),
 *   onApprovalRequired: async (method, params) => await showApprovalModal(method, params),
 * })
 *
 * session.onRequest(async (method, params) => wallet[method](params))
 * session.on('connected', () => ...).on('disconnected', () => ...).on('error', msg => ...)
 * await session.connect()
 * ```
 *
 * Resuming a previous session (e.g. after network drop):
 * ```ts
 * const lastSeq = await SecureStore.getItemAsync(`lastseq_${topic}`)
 * await session.reconnect(Number(lastSeq))
 * ```
 */
export class WalletPairingSession {
  private ws: WebSocket | null = null
  private _status: PairingSessionStatus = 'idle'
  private connected = false
  private _lastSeq = 0
  private _resolvedRelay: string | null = null
  private readonly protocolID: WalletProtocol
  private mobileIdentityKey: string | null = null
  private requestHandler: RequestHandler | null = null
  private readonly implementedMethods: ReadonlySet<string>
  private readonly autoApproveMethods: ReadonlySet<string>
  private readonly walletMeta: Record<string, unknown>
  private pairingVerified = false
  private lifecycleEpoch = 0
  private inboundTurn: Promise<void> = Promise.resolve()
  private activeRequestCount = 0

  private readonly listeners: {
    connected: Array<() => void>
    disconnected: Array<() => void>
    error: Array<(msg: string) => void>
  } = { connected: [], disconnected: [], error: [] }

  constructor(
    private readonly wallet: WalletLike,
    private readonly params: PairingParams,
    private readonly options: WalletPairingSessionOptions = {}
  ) {
    this.protocolID = requireProtocolId(params.protocolID) as WalletProtocol
    this.implementedMethods = snapshotMethods(
      options.implementedMethods ?? DEFAULT_IMPLEMENTED_METHODS,
      'implementedMethods'
    )
    this.autoApproveMethods = snapshotMethods(
      options.autoApproveMethods ?? DEFAULT_AUTO_APPROVE_METHODS,
      'autoApproveMethods'
    )
    for (const method of this.autoApproveMethods) {
      if (!this.implementedMethods.has(method)) {
        throw new TypeError('autoApproveMethods must be a subset of implementedMethods')
      }
    }
    this.walletMeta = assertSafeWalletValue(options.walletMeta ?? {}, 'pairing wallet metadata')
  }

  get status(): PairingSessionStatus {
    return this._status
  }

  /**
   * The highest seq value received from the backend in this connection.
   * Persist this before disconnecting so you can pass it to `reconnect(lastSeq)`.
   *
   * ```ts
   * session.on('disconnected', () => {
   *   SecureStore.setItemAsync('lastseq_' + topic, String(session.lastSeq))
   * })
   * ```
   */
  get lastSeq(): number {
    return this._lastSeq
  }

  // ── Event registration ───────────────────────────────────────────────────────

  on(event: 'connected', handler: () => void): this
  on(event: 'disconnected', handler: () => void): this
  on(event: 'error', handler: (msg: string) => void): this
  on(event: string, handler: unknown): this {
    const bucket = this.listeners[event as keyof typeof this.listeners]
    if (bucket)
      (bucket as Array<(...args: unknown[]) => void>).push(handler as (...args: unknown[]) => void)
    return this
  }

  /** Register the handler that executes approved RPC methods. */
  onRequest(handler: RequestHandler): this {
    this.requestHandler = handler
    return this
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Fetch the relay WebSocket URL from the origin server.
   *
   * Must be called before `connect()`. Returns the relay URL so the app can
   * display it to the user for approval before proceeding.
   *
   * The fetch goes to `params.origin` over HTTPS — the origin's TLS certificate
   * is the trust anchor. Always show `params.origin` to the user before calling
   * this method so they can confirm they are connecting to the intended service.
   *
   * The origin's response binds the QR to the origin: when it reports
   * `backendIdentityKey`, that key must equal `params.backendIdentityKey` or this
   * method throws and nothing connects. A response without the key (a server older
   * than 0.6.0) is accepted unless `requireOriginBoundKey` is set.
   *
   * ```ts
   * const { params } = parsePairingUri(qrString)
   * // Show params.origin to the user and wait for approval, then:
   * const relay = await session.resolveRelay()
   * // Optionally show relay to the user, then:
   * await session.connect()
   * ```
   */
  async resolveRelay(): Promise<string> {
    await this.verifyPairingBoundary()
    const target = new URL(`/api/session/${this.params.topic}`, this.params.origin).toString()
    const { response, value } = await fetchBoundedJson(target, {}, 'pairing relay response')
    if (!response.ok) {
      throw new Error(`Failed to resolve relay from origin: HTTP ${response.status}`)
    }
    const data = validateSessionInfo(value, {
      expectedId: this.params.topic,
      canonicalId: false
    })
    if (data.relay === undefined) throw new Error('Origin server did not return a relay URL')
    if (data.backendIdentityKey === undefined) {
      if (this.options.requireOriginBoundKey === true) {
        throw new Error('Origin server did not report its backend identity key')
      }
    } else if (
      data.backendIdentityKey.toLowerCase() !== this.params.backendIdentityKey.toLowerCase()
    ) {
      throw new Error("Origin server's backend identity key does not match the pairing key")
    }
    this._resolvedRelay = normalizeRelayUrl(data.relay)
    return this._resolvedRelay
  }

  /** Enforces the signed HTTPS pairing boundary before making any network request. */
  private async verifyPairingBoundary(): Promise<void> {
    if (this.pairingVerified) return

    let origin: URL
    try {
      origin = new URL(this.params.origin)
    } catch {
      throw new Error('Pairing origin is invalid')
    }
    const isLoopback =
      origin.hostname === 'localhost' ||
      origin.hostname === '127.0.0.1' ||
      origin.hostname === '[::1]'
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopback)) {
      throw new Error(
        'Pairing origin must use HTTPS (HTTP is allowed only for loopback development)'
      )
    }
    if (!(await verifyPairingSignature(this.params))) {
      throw new Error('Pairing signature is missing or invalid')
    }
    this.pairingVerified = true
  }

  /**
   * Open the WebSocket connection and start a fresh pairing handshake.
   * Requires `resolveRelay()` to have been called first.
   */
  async connect(): Promise<void> {
    if (!this._resolvedRelay) throw new Error('Call resolveRelay() before connect()')
    await this.openConnection(0)
  }

  /**
   * Re-open the WS connection using a stored seq baseline.
   * Replay protection resumes from `lastSeq` — messages with seq ≤ lastSeq are dropped.
   * Use this after a network drop when the session is still valid on the backend.
   * Requires `resolveRelay()` to have been called (relay URL is retained between calls).
   *
   * @param lastSeq - The highest seq received in the previous connection (from persistent storage).
   */
  async reconnect(lastSeq: number): Promise<void> {
    if (!this._resolvedRelay) throw new Error('Call resolveRelay() before reconnect()')
    await this.openConnection(lastSeq)
  }

  /** Close the WebSocket connection. */
  disconnect(): void {
    this.lifecycleEpoch += 1
    const ws = this.ws
    this.ws = null
    this.connected = false
    if (this._status !== 'idle') this._status = 'disconnected'
    ws?.close()
  }

  private async openConnection(initialSeq: number): Promise<void> {
    if (!Number.isSafeInteger(initialSeq) || initialSeq < 0) {
      throw new TypeError('lastSeq must be a non-negative safe integer')
    }
    const epoch = ++this.lifecycleEpoch
    const previous = this.ws
    this.ws = null
    previous?.close()
    this._status = 'connecting'
    this.connected = false
    this._lastSeq = initialSeq
    this.inboundTurn = Promise.resolve()

    const publicKeyResult = await this.wallet.getPublicKey({ identityKey: true })
    if (epoch !== this.lifecycleEpoch) throw new Error('Connection attempt was cancelled')
    const ownedPublicKeyResult = validateWalletResult('getPublicKey', publicKeyResult, {
      identityKey: true
    })
    const publicKey = requirePublicKey(ownedPublicKeyResult.publicKey, 'mobile wallet identity key')
    this.mobileIdentityKey = publicKey

    const { topic, backendIdentityKey } = this.params
    const cryptoParams: CryptoParams = {
      protocolID: this.protocolID,
      keyID: topic,
      counterparty: backendIdentityKey
    }

    const relayUrl = new URL(normalizeRelayUrl(this._resolvedRelay))
    relayUrl.pathname = `${relayUrl.pathname.replace(/\/$/u, '')}/ws`
    relayUrl.searchParams.set('topic', topic)
    relayUrl.searchParams.set('role', 'mobile')
    const ws = new WebSocket(relayUrl.toString())
    this.ws = ws

    ws.onopen = async () => {
      try {
        if (epoch !== this.lifecycleEpoch || this.ws !== ws) return
        const payload = stringifyBRC100({
          id: crypto.randomUUID(),
          seq: this._lastSeq + 1,
          method: 'pairing_approved',
          params: {
            mobileIdentityKey: publicKey,
            walletMeta: this.walletMeta,
            permissions: Array.from(this.implementedMethods)
          }
        })
        const ciphertext = await encryptEnvelope(this.wallet, cryptoParams, payload)
        if (epoch !== this.lifecycleEpoch || this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
          return
        }
        const envelope: WireEnvelope = { topic, mobileIdentityKey: publicKey, ciphertext }
        ws.send(stringifyBRC100(envelope))
      } catch (err) {
        if (epoch === this.lifecycleEpoch && this.ws === ws) {
          this.emitError(err instanceof Error ? err.message : 'Failed to send pairing message')
        }
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      if (epoch !== this.lifecycleEpoch || this.ws !== ws) return
      this.inboundTurn = this.inboundTurn.then(async () => {
        if (epoch !== this.lifecycleEpoch || this.ws !== ws) return
        await this.handleInboundMessage(event, ws, cryptoParams, topic)
      })
    }

    ws.onerror = () => {
      if (epoch !== this.lifecycleEpoch || this.ws !== ws) return
      this.emitError('WebSocket connection failed')
    }

    ws.onclose = () => {
      // disconnect() and a newer connection both invalidate this epoch.
      if (epoch !== this.lifecycleEpoch || this.ws !== ws) return

      this.ws = null // clear stale ref
      if (this.connected) {
        this._status = 'disconnected'
        this.listeners.disconnected.forEach(h => h())
      } else {
        this.emitError('Could not reach the relay — check that the desktop tab is still open')
      }
    }
  }

  private async handleInboundMessage(
    event: MessageEvent,
    ws: WebSocket,
    cryptoParams: CryptoParams,
    topic: string
  ): Promise<void> {
    try {
      if (typeof event.data !== 'string') return
      const envelope = parseWireEnvelope(JSON.parse(event.data), topic)

      let plaintext: string
      try {
        plaintext = await decryptEnvelope(this.wallet, cryptoParams, envelope.ciphertext)
      } catch (err) {
        console.warn('[WalletPairingSession] decryptEnvelope failed:', err)
        return // tampered or wrong key — drop
      }

      const msg = parseRpcMessage(JSON.parse(plaintext))

      // M4: Replay protection — drop anything not strictly greater than last seq
      if (msg.seq <= this._lastSeq) {
        console.warn(
          '[WalletPairingSession] dropping message: seq',
          msg.seq,
          '<= lastSeq',
          this._lastSeq
        )
        return
      }
      this._lastSeq = msg.seq

      // Any successfully decrypted message confirms the session is live.
      // This handles both the pairing_ack path and any race where ack is missed
      // but an RPC request arrives first.
      if (!this.connected) {
        this.connected = true
        this._status = 'connected'
        this.listeners.connected.forEach(h => h())
      }

      // pairing_ack — just a confirmation, no further processing
      if ('method' in msg && msg.method === 'pairing_ack') return

      // Inbound RPC request
      if ('method' in msg && msg.id) {
        void this.handleRpc(msg, ws).catch(err => {
          this.emitError(err instanceof Error ? err.message : 'Failed to handle wallet request')
        })
      }
    } catch {
      // silently drop malformed messages
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private emitError(msg: string): void {
    this._status = 'error'
    this.listeners.error.forEach(h => h(msg))
  }

  private async handleRpc(request: RpcRequest, ws: WebSocket): Promise<void> {
    const { topic, backendIdentityKey } = this.params
    const cryptoParams: CryptoParams = {
      protocolID: this.protocolID,
      keyID: topic,
      counterparty: backendIdentityKey
    }

    const sendResponse = async (response: RpcResponse): Promise<void> => {
      const ciphertext = await encryptEnvelope(this.wallet, cryptoParams, stringifyBRC100(response))
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
        ws.send(stringifyBRC100({ topic, ciphertext } satisfies WireEnvelope))
      }
    }

    let requestParams: unknown
    try {
      normalizeBRC100WalletByteFields(request.params)
      requestParams = assertSafeWalletValue(request.params, 'wallet relay request parameters')
      if ((WALLET_METHOD_NAMES as readonly string[]).includes(request.method)) {
        validateWalletArgs(request.method as WalletMethodName, requestParams)
      }
    } catch {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 400, message: 'Invalid wallet request' }
      })
      return
    }

    // Unknown method — reject immediately without showing approval UI
    if (!this.implementedMethods.has(request.method)) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 501, message: `Method "${request.method}" is not implemented` }
      })
      return
    }

    if (this.activeRequestCount >= MAX_ACTIVE_MOBILE_REQUESTS) {
      ws.close(1013, 'Too many active wallet requests')
      return
    }
    this.activeRequestCount += 1

    try {
      // Approval gate
      const needsApproval = !this.autoApproveMethods.has(request.method)
      if (needsApproval) {
        const approvalHandler = this.options.onApprovalRequired
        if (!approvalHandler) {
          await sendResponse({
            id: request.id,
            seq: request.seq,
            error: {
              code: 4001,
              message: 'Approval required but no approval handler is configured'
            }
          })
          return
        }
        const approved = await approvalHandler(
          request.method,
          assertSafeWalletValue(requestParams, 'wallet relay approval parameters')
        )
        if (approved !== true) {
          await sendResponse({
            id: request.id,
            seq: request.seq,
            error: { code: 4001, message: 'User rejected' }
          })
          return
        }
      }

      // Dispatch to handler
      if (!this.requestHandler) {
        await sendResponse({
          id: request.id,
          seq: request.seq,
          error: { code: 501, message: 'No request handler registered' }
        })
        return
      }

      try {
        const result = await this.requestHandler(
          request.method,
          assertSafeWalletValue(requestParams, 'wallet relay handler parameters')
        )
        const ownedResult = (WALLET_METHOD_NAMES as readonly string[]).includes(request.method)
          ? validateWalletResult(
              request.method as (typeof WALLET_METHOD_NAMES)[number],
              result,
              requestParams
            )
          : assertSafeWalletValue(result, 'wallet relay custom RPC result')
        await sendResponse({ id: request.id, seq: request.seq, result: ownedResult })
      } catch (err) {
        await sendResponse({
          id: request.id,
          seq: request.seq,
          error: { code: 500, message: err instanceof Error ? err.message : 'Handler error' }
        })
      }
    } finally {
      this.activeRequestCount -= 1
    }
  }
}
