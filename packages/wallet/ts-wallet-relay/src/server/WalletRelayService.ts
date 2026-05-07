import type { Request, Response } from 'express'
import type { Server } from 'node:http'

/**
 * Minimal Express-compatible router interface.
 * Using a structural duck-type instead of the nominal `Express` type avoids
 * conflicts in monorepos where two separate node_modules trees resolve different
 * copies of @types/express-serve-static-core.
 */
type RouterLike = {
  get(path: string, handler: (req: Request, res: Response) => void): unknown
  post(path: string, handler: (req: Request, res: Response) => void): unknown
}
import { PROTOCOL_ID } from '../types.js'
import type { WalletLike, WireEnvelope, RpcResponse } from '../types.js'
import { WebSocketRelay } from './WebSocketRelay.js'
import { QRSessionManager } from './QRSessionManager.js'
import { WalletRequestHandler } from './WalletRequestHandler.js'
import { buildPairingUri } from '../shared/pairingUri.js'
import { encryptEnvelope, decryptEnvelope } from '../shared/crypto.js'
import { bytesToBase64url } from '../shared/encoding.js'

export interface WalletRelayServiceOptions {
  /**
   * Express app — when provided, REST routes are registered automatically.
   * Omit when using Next.js (or any other framework): call createSession(),
   * getSession(), and sendRequest() from your own route handlers instead.
   */
  app?: RouterLike
  /** HTTP server — WebSocket upgrade handler is attached here. */
  server: Server
  /**
   * Backend wallet used to encrypt/decrypt messages with mobile.
   * Use `ProtoWallet` with a private key stored in an environment variable:
   * ```ts
   * import { ProtoWallet, PrivateKey } from '@bsv/sdk'
   * wallet: new ProtoWallet(PrivateKey.fromWif(process.env['WALLET_WIF']!))
   * ```
   * The same key must be used across restarts — the mobile's ECDH shared secret
   * is derived from the backend's identity key embedded in the QR code.
   */
  wallet: WalletLike
  /**
   * ws(s):// base URL of this server — embedded in the QR pairing URI.
   * Defaults to the `RELAY_URL` environment variable, then `ws://localhost:3000`.
   */
  relayUrl?: string
  /**
   * http(s):// URL of the desktop frontend — used for CORS and the pairing URI.
   * Defaults to the `ORIGIN` environment variable, then `http://localhost:5173`.
   */
  origin?: string
  /** Called when a mobile completes pairing and the session transitions to 'connected'. */
  onSessionConnected?: (sessionId: string) => void
  /** Called when a connected mobile disconnects (session transitions to 'disconnected'). */
  onSessionDisconnected?: (sessionId: string) => void
  /**
   * Maximum number of sessions held in memory at once.
   * Requests for new sessions beyond this limit are rejected with HTTP 429.
   * Default: unlimited.
   */
  maxSessions?: number
  /**
   * URI scheme used in the generated QR pairing URI (e.g. `'bsv-browser'`, `'my-app'`).
   * Defaults to `'bsv-browser'`. Must match the deep-link scheme registered by the
   * wallet app that will scan the QR code.
   */
  schema?: string
  /**
   * Sign the QR pairing URI with the backend wallet key.
   * When `true` (the default), `createSession()` embeds a `sig` parameter in the
   * pairing URI; the mobile can call `verifyPairingSignature()` to authenticate
   * the QR before connecting.
   * Set to `false` to disable for testing or legacy compatibility.
   */
  signQrCodes?: boolean
}

interface PendingRequest {
  sessionId: string
  resolve: (response: RpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000
const MOBILE_AUTH_TIMEOUT_MS = 15_000

/**
 * High-level facade that wires together the relay, session manager,
 * and RPC handler into a ready-to-use WebSocket service.
 *
 * Express usage (routes registered automatically):
 * ```ts
 * const relay = new WalletRelayService({ app, server, wallet, relayUrl, origin })
 * ```
 *
 * Next.js / custom framework (omit `app`, call methods from your route handlers):
 * ```ts
 * const relay = new WalletRelayService({ server, wallet, relayUrl, origin })
 * // In GET /api/session:        relay.createSession()
 * // In GET /api/session/:id:    relay.getSession(id)
 * // In POST /api/request/:id:   relay.sendRequest(id, method, params)
 * ```
 *
 * Express auto-registered routes:
 *   GET  /api/session        — create session, return { sessionId, status, qrDataUrl }
 *   GET  /api/session/:id    — return { sessionId, status, relay }
 *   POST /api/request/:id    — body { method, params } — relay to mobile, return RpcResponse
 */
export class WalletRelayService {
  private readonly sessions: QRSessionManager
  private readonly relay: WebSocketRelay
  private readonly handler = new WalletRequestHandler()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly mobileAuthTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Resolved options — always defined after construction
  private readonly wallet: WalletLike
  private readonly relayUrl: string
  private readonly origin: string
  private readonly schema: string
  private readonly signQrCodes: boolean

  constructor(private readonly opts: WalletRelayServiceOptions) {
    this.wallet      = opts.wallet
    this.relayUrl    = opts.relayUrl ?? process.env['RELAY_URL'] ?? 'ws://localhost:3000'
    this.origin      = opts.origin   ?? process.env['ORIGIN']   ?? 'http://localhost:5173'
    this.schema      = opts.schema   ?? process.env['PAIRING_SCHEMA'] ?? 'bsv-browser'
    this.signQrCodes = opts.signQrCodes ?? true

    this.sessions = new QRSessionManager({ maxSessions: opts.maxSessions })
    this.relay = new WebSocketRelay(opts.server, { allowedOrigin: this.origin })

    // B6: clean up relay topic when a session is GC'd
    this.sessions.onSessionExpired(id => this.relay.removeTopic(id))

    // B5: reject WS connections for unknown/expired sessions
    this.relay.onValidateTopic(topic => {
      const s = this.sessions.getSession(topic)
      return s !== null && s.status !== 'expired'
    })

    // Require a valid desktopToken for role=desktop connections
    this.relay.onValidateDesktopToken((topic, token) => {
      const s = this.sessions.getSession(topic)
      return s !== null && token !== null && token === s.desktopToken
    })

    // When mobile WS opens: lock the session against race-expiry and start auth timer
    this.relay.onMobileConnect(topic => {
      const s = this.sessions.getSession(topic)
      if (!s) return
      // Lock pending sessions so a pairing_approved in-flight doesn't lose to a lazy
      // expiry check on the next poll (grace window in QRSessionManager.getSession).
      this.sessions.setPairingStarted(topic)
      if (s.mobileIdentityKey) return  // already authenticated — no auth timer needed
      const timer = setTimeout(() => {
        this.mobileAuthTimers.delete(topic)
        this.relay.disconnectMobile(topic)
      }, MOBILE_AUTH_TIMEOUT_MS)
      this.mobileAuthTimers.set(topic, timer)
    })

    this.relay.onIncoming((topic, envelope, role) => {
      if (role === 'mobile') void this.handleMobileMessage(topic, envelope)
    })

    // Reject in-flight requests immediately when the mobile disconnects
    this.relay.onDisconnect((topic, role) => {
      if (role === 'mobile') {
        const authTimer = this.mobileAuthTimers.get(topic)
        if (authTimer) { clearTimeout(authTimer); this.mobileAuthTimers.delete(topic) }
        this.sessions.setStatus(topic, 'disconnected')
        this.rejectPendingForSession(topic)
        this.opts.onSessionDisconnected?.(topic)
      }
    })

    if (opts.app) this.registerRoutes(opts.app)
  }

  /** Create a session and return its QR data URL, pairing URI, and desktop WebSocket token. */
  async createSession(): Promise<{ sessionId: string; status: string; qrDataUrl: string; pairingUri: string; desktopToken: string }> {
    const session = this.sessions.createSession()
    const { publicKey: backendIdentityKey } = await this.wallet.getPublicKey({ identityKey: true })

    // Pre-compute expiry so the same value is used in both the signature and the URI.
    const expiry = Math.floor((Date.now() + 120_000) / 1000)

    let sig: string | undefined
    if (this.signQrCodes) {
      const data = Array.from(
        new TextEncoder().encode(`${session.id}|${backendIdentityKey}|${this.origin}|${expiry}`)
      )
      const { signature } = await this.wallet.createSignature({
        data,
        protocolID:   [0, 'qr pairing'],
        keyID:        session.id,
        counterparty: 'anyone',
      })
      sig = bytesToBase64url(signature)
    }

    const uri = buildPairingUri({
      sessionId: session.id,
      backendIdentityKey,
      protocolID: JSON.stringify(PROTOCOL_ID),
      origin: this.origin,
      expiry,
      sig,
      schema: this.schema,
    })
    const qrDataUrl = await this.sessions.generateQRCode(uri)
    return { sessionId: session.id, status: session.status, qrDataUrl, pairingUri: uri, desktopToken: session.desktopToken }
  }

  /** Return session status and relay URL, or null if not found. */
  getSession(id: string): { sessionId: string; status: string; relay: string } | null {
    const s = this.sessions.getSession(id)
    return s ? { sessionId: s.id, status: s.status, relay: this.relayUrl } : null
  }

  /**
   * Encrypt an RPC call, relay it to the mobile, and await the response.
   * Rejects if the session is not connected or if the mobile doesn't respond within 30 s.
   */
  async sendRequest(sessionId: string, method: string, params: unknown, desktopToken?: string): Promise<RpcResponse> {
    const session = this.sessions.getSession(sessionId)
    if (!session || session.status !== 'connected' || !session.mobileIdentityKey) {
      const status = session?.status ?? 'not found'
      throw new Error(`Session is ${status}`)
    }
    // Validate desktop token — ensures only the client that created the session
    // can send requests, even if another client knows the session ID.
    if (desktopToken !== session.desktopToken) {
      throw new Error('Invalid desktop token')
    }

    const rpc = this.handler.createRequest(method, params)
    const ciphertext = await encryptEnvelope(
      this.wallet,
      { protocolID: PROTOCOL_ID, keyID: sessionId, counterparty: session.mobileIdentityKey },
      JSON.stringify(rpc)
    )
    this.relay.sendToMobile(sessionId, { topic: sessionId, ciphertext })

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpc.id)
        reject(new Error('Request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(rpc.id, { sessionId, resolve, reject, timer })
    })
  }

  /** Stop the GC timer, close the WebSocket server, and reject all in-flight requests. */
  stop(): void {
    for (const timer of this.mobileAuthTimers.values()) clearTimeout(timer)
    this.mobileAuthTimers.clear()
    this.rejectPendingForSession(null)
    this.sessions.stop()
    this.relay.close()
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Reject all pending requests belonging to a session.
   * Pass null to reject every pending request (used on full shutdown).
   */
  private rejectPendingForSession(sessionId: string | null): void {
    for (const [id, pending] of this.pending) {
      if (sessionId === null || pending.sessionId === sessionId) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(new Error(sessionId === null ? 'Server shutting down' : 'Session disconnected'))
      }
    }
  }

  // ── Route registration ────────────────────────────────────────────────────────

  private registerRoutes(app: RouterLike): void {
    app.get('/api/session', (req: Request, res: Response) => {
      void this.createSession()
        .then(info => res.json(info))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Failed'
          const status = (err as { code?: number }).code === 429 ? 429 : 500
          res.status(status).json({ error: msg })
        })
    })

    app.get('/api/session/:id', (req: Request, res: Response) => {
      const info = this.getSession(req.params['id'] as string)
      if (!info) { res.status(404).json({ error: 'Session not found' }); return }
      res.json(info)
    })

    app.post('/api/request/:id', (req: Request, res: Response) => {
      const { method, params } = req.body as { method: string; params: unknown }
      if (!method) { res.status(400).json({ error: 'method is required' }); return }
      const token = req.headers['x-desktop-token'] as string | undefined
      void this.sendRequest(req.params['id'] as string, method, params, token)
        .then(response => res.json(response))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Request failed'
          let status = 504
          if (msg === 'Invalid desktop token') {
            status = 401
          } else if (msg.startsWith('Session is')) {
            status = 400
          }
          res.status(status).json({ error: msg })
        })
    })
  }

  // ── Inbound message handling ──────────────────────────────────────────────────

  private async handleMobileMessage(topic: string, envelope: WireEnvelope): Promise<void> {
    const session = this.sessions.getSession(topic)
    if (!session) return

    // pairing_approved — mobileIdentityKey in outer envelope (bootstrap)
    if (envelope.mobileIdentityKey && session.status !== 'expired') {
      // B3: lock session to the first device that paired — disconnect impostor immediately
      if (session.mobileIdentityKey && session.mobileIdentityKey !== envelope.mobileIdentityKey) {
        this.relay.disconnectMobile(topic)
        return
      }
      await this.handlePairingApproved(topic, envelope)
      return
    }

    if (!session.mobileIdentityKey) return

    // RPC response from mobile
    let plaintext: string
    try {
      plaintext = await decryptEnvelope(
        this.wallet,
        { protocolID: PROTOCOL_ID, keyID: topic, counterparty: session.mobileIdentityKey },
        envelope.ciphertext
      )
    } catch { return }

    const msg = this.handler.parseMessage(plaintext)
    if (this.handler.isResponse(msg)) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(msg.id)
        pending.resolve(msg)
      }
    }
  }

  private async handlePairingApproved(topic: string, envelope: WireEnvelope): Promise<void> {
    const mobileIdentityKey = envelope.mobileIdentityKey!

    // Decrypt and verify inner payload — failure means the mobile can't prove ECDH ownership
    let plaintext: string
    try {
      plaintext = await decryptEnvelope(
        this.wallet,
        { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
        envelope.ciphertext
      )
    } catch {
      this.relay.disconnectMobile(topic)
      return
    }

    const msg = this.handler.parseMessage(plaintext) as { params?: { mobileIdentityKey?: string } }
    if (msg.params?.mobileIdentityKey && msg.params.mobileIdentityKey !== mobileIdentityKey) {
      this.relay.disconnectMobile(topic)
      return
    }

    // Auth succeeded — cancel the proof timer
    const timer = this.mobileAuthTimers.get(topic)
    if (timer) { clearTimeout(timer); this.mobileAuthTimers.delete(topic) }

    this.sessions.setMobileIdentityKey(topic, mobileIdentityKey)
    this.sessions.setStatus(topic, 'connected')
    this.opts.onSessionConnected?.(topic)

    // Send pairing_ack to confirm the session is live
    const ack = this.handler.createProtocolMessage('pairing_ack', { topic })
    const ciphertext = await encryptEnvelope(
      this.wallet,
      { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
      JSON.stringify(ack)
    )
    this.relay.sendToMobile(topic, { topic, ciphertext })
  }
}
