import type { WalletProtocol } from '@bsv/sdk'
import type { WalletLike, PairingParams, WireEnvelope, RpcRequest, RpcResponse } from '../types.js'
import { encryptEnvelope, decryptEnvelope, type CryptoParams } from '../shared/crypto.js'

export type PairingSessionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

/** Return a result or an error string — used for the onRequest handler. */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>

export interface WalletPairingSessionOptions {
  /**
   * Methods your handler actually implements.
   * Requests for any other method receive a 501 without invoking onRequest or onApprovalRequired.
   * If omitted, all methods are forwarded to onRequest.
   */
  implementedMethods?: Set<string>

  /**
   * Subset of implementedMethods that are executed without calling onApprovalRequired.
   * Useful for read-only methods like getPublicKey.
   */
  autoApproveMethods?: Set<string>

  /**
   * Called for every implemented method that is not in autoApproveMethods.
   * Return true to approve, false to send a 4001 User Rejected response.
   * If omitted, all implemented methods are auto-approved.
   */
  onApprovalRequired?: (method: string, params: unknown) => Promise<boolean>

  /**
   * Additional metadata sent inside the pairing_approved inner payload.
   * Useful for identifying the wallet to the desktop.
   */
  walletMeta?: Record<string, unknown>
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
  private protocolID: WalletProtocol
  private mobileIdentityKey: string | null = null
  private requestHandler: RequestHandler | null = null

  private listeners: {
    connected: Array<() => void>
    disconnected: Array<() => void>
    error: Array<(msg: string) => void>
  } = { connected: [], disconnected: [], error: [] }

  constructor(
    private wallet: WalletLike,
    private params: PairingParams,
    private options: WalletPairingSessionOptions = {}
  ) {
    this.protocolID = JSON.parse(params.protocolID) as WalletProtocol
  }

  get status(): PairingSessionStatus { return this._status }

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
  get lastSeq(): number { return this._lastSeq }

  // ── Event registration ───────────────────────────────────────────────────────

  on(event: 'connected', handler: () => void): this
  on(event: 'disconnected', handler: () => void): this
  on(event: 'error', handler: (msg: string) => void): this
  on(event: string, handler: unknown): this {
    const bucket = this.listeners[event as keyof typeof this.listeners]
    if (bucket) (bucket as Array<(...args: unknown[]) => void>).push(handler as (...args: unknown[]) => void)
    return this
  }

  /** Register the handler that executes approved RPC methods. */
  onRequest(handler: RequestHandler): this {
    this.requestHandler = handler
    return this
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Open the WS connection and start a fresh pairing handshake. */
  async connect(): Promise<void> {
    await this.openConnection(0)
  }

  /**
   * Re-open the WS connection using a stored seq baseline.
   * Replay protection resumes from `lastSeq` — messages with seq ≤ lastSeq are dropped.
   * Use this after a network drop when the session is still valid on the backend.
   *
   * @param lastSeq - The highest seq received in the previous connection (from persistent storage).
   */
  async reconnect(lastSeq: number): Promise<void> {
    await this.openConnection(lastSeq)
  }

  /** Close the WebSocket connection. */
  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }

  private async openConnection(initialSeq: number): Promise<void> {
    this._status = 'connecting'
    this.connected = false
    this._lastSeq = initialSeq

    const { publicKey } = await this.wallet.getPublicKey({ identityKey: true })
    this.mobileIdentityKey = publicKey

    const { topic, relay, backendIdentityKey, keyID } = this.params
    const cryptoParams: CryptoParams = { protocolID: this.protocolID, keyID, counterparty: backendIdentityKey }

    const ws = new WebSocket(`${relay}/ws?topic=${topic}&role=mobile`)
    this.ws = ws

    ws.onopen = async () => {
      try {
        const payload = JSON.stringify({
          id: crypto.randomUUID(),
          seq: this._lastSeq + 1,
          method: 'pairing_approved',
          params: {
            mobileIdentityKey: publicKey,
            walletMeta: this.options.walletMeta ?? {},
            permissions: this.options.implementedMethods
              ? Array.from(this.options.implementedMethods)
              : [],
          },
        })
        const ciphertext = await encryptEnvelope(this.wallet, cryptoParams, payload)
        const envelope: WireEnvelope = { topic, mobileIdentityKey: publicKey, ciphertext }
        ws.send(JSON.stringify(envelope))
      } catch (err) {
        this.emitError(err instanceof Error ? err.message : 'Failed to send pairing message')
      }
    }

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data as string) as WireEnvelope
        if (!envelope.ciphertext) return

        let plaintext: string
        try {
          plaintext = await decryptEnvelope(this.wallet, cryptoParams, envelope.ciphertext)
        } catch {
          return // tampered or wrong key — drop silently
        }

        const msg = JSON.parse(plaintext) as RpcRequest | RpcResponse

        // M4: Replay protection — drop anything not strictly greater than last seq
        if (typeof msg.seq !== 'number' || msg.seq <= this._lastSeq) return
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
          await this.handleRpc(msg as RpcRequest)
        }
      } catch {
        // silently drop malformed messages
      }
    }

    ws.onerror = () => {
      this.emitError('WebSocket connection failed')
    }

    ws.onclose = () => {
      if (this.connected) {
        this._status = 'disconnected'
        this.listeners.disconnected.forEach(h => h())
      } else {
        this.emitError('Could not reach the relay — check that the desktop tab is still open')
      }
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private emitError(msg: string): void {
    this._status = 'error'
    this.listeners.error.forEach(h => h(msg))
  }

  private async handleRpc(request: RpcRequest): Promise<void> {
    const { topic, keyID, backendIdentityKey } = this.params
    const cryptoParams: CryptoParams = { protocolID: this.protocolID, keyID, counterparty: backendIdentityKey }

    const sendResponse = async (response: RpcResponse): Promise<void> => {
      const ciphertext = await encryptEnvelope(this.wallet, cryptoParams, JSON.stringify(response))
      this.ws?.send(JSON.stringify({ topic, ciphertext } satisfies WireEnvelope))
    }

    // Unknown method — reject immediately without showing approval UI
    if (this.options.implementedMethods && !this.options.implementedMethods.has(request.method)) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 501, message: `Method "${request.method}" is not implemented` },
      })
      return
    }

    // Approval gate
    const needsApproval = !this.options.autoApproveMethods?.has(request.method)
    if (needsApproval && this.options.onApprovalRequired) {
      const approved = await this.options.onApprovalRequired(request.method, request.params)
      if (!approved) {
        await sendResponse({
          id: request.id,
          seq: request.seq,
          error: { code: 4001, message: 'User rejected' },
        })
        return
      }
    }

    // Dispatch to handler
    if (!this.requestHandler) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 501, message: 'No request handler registered' },
      })
      return
    }

    try {
      const result = await this.requestHandler(request.method, request.params)
      await sendResponse({ id: request.id, seq: request.seq, result })
    } catch (err) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 500, message: err instanceof Error ? err.message : 'Handler error' },
      })
    }
  }
}
