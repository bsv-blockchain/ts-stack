import type { Request, Response } from 'express'
import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Minimal Express-compatible router interface.
 * Using a structural duck-type instead of the nominal `Express` type avoids
 * conflicts in monorepos where two separate node_modules trees resolve different
 * copies of @types/express-serve-static-core.
 */
type RouterLike = {
  get(path: string, handler: (req: Request, res: Response) => void): unknown
  post(path: string, handler: (req: Request, res: Response) => void): unknown
  delete(path: string, handler: (req: Request, res: Response) => void): unknown
}
import { PROTOCOL_ID, WALLET_METHOD_NAMES } from '../types.js'
import type { WalletLike, WireEnvelope, RpcResponse } from '../types.js'
import { WebSocketRelay } from './WebSocketRelay.js'
import type { SocketCloseInfo } from './WebSocketRelay.js'
import { QRSessionManager } from './QRSessionManager.js'
import { secureTokenEqual } from './secureTokenEqual.js'
import { WalletRequestHandler } from './WalletRequestHandler.js'
import { buildPairingUri } from '../shared/pairingUri.js'
import { encryptEnvelope, decryptEnvelope } from '../shared/crypto.js'
import { bytesToBase64url } from '../shared/encoding.js'
import { compileOriginMatcher, type AllowedOrigins } from '../shared/originMatcher.js'
import {
  assertSafeWalletValue,
  snapshotWalletResultRequest,
  validateWalletResult
} from '@bsv/sdk/wallet/WalletResultValidation'
import {
  normalizeBRC100WalletByteFields,
  stringifyBRC100
} from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { validateWalletArgs } from '@bsv/sdk/wallet/WalletArgumentValidation'
import {
  normalizeHttpOrigin,
  normalizeRelayUrl,
  parseRpcMessage,
  requireBoundedString,
  requirePlainRecord,
  requirePublicKey,
  requireSessionId,
  requireSafeSequence
} from '../shared/validation.js'

export interface WalletRelayServiceOptions {
  /**
   * Express app — when provided, REST routes are registered automatically.
   * Omit when using Next.js (or any other framework): call createSession(),
   * getSession(), and sendRequest() from your own route handlers instead.
   */
  app?: RouterLike
  /** HTTP server — WebSocket upgrade handler is attached here. */
  server: Server
  /** Path the WebSocket relay claims. Default '/ws'. Forwarded to WebSocketRelay. */
  path?: string
  /**
   * When true, the relay attaches no 'upgrade' listener. Call
   * `service.handleUpgrade(req, socket, head)` from your own dispatcher.
   */
  noServer?: boolean
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
   * WebSocket base URL of this server. Production URLs require wss://;
   * ws:// is accepted only for loopback development.
   * Defaults to the `RELAY_URL` environment variable, then `ws://localhost:3000`.
   */
  relayUrl?: string
  /**
   * Default http(s):// URL of the desktop frontend — embedded in the QR pairing
   * URI when `createSession()` is called without a per-session origin override.
   * Defaults to the `ORIGIN` environment variable, then `http://localhost:5173`.
   *
   * For multi-app deployments (one relay shared by N webapps) leave this unset
   * or set it to a sensible fallback, and pass `origin` per-call to
   * `createSession({ origin })` instead. Use `allowedOrigins` to restrict which
   * origins are accepted.
   */
  origin?: string
  /**
   * Origin allowlist — controls (a) which origins may be claimed by callers of
   * `createSession({ origin })`, and (b) which browser origins may open a
   * desktop-role WebSocket connection.
   *
   * Accepts a string, string[], RegExp, or predicate function. An explicitly
   * supplied constructor `origin` remains a legacy single-origin allowlist.
   * When neither option is supplied, origin validation is disabled so the relay
   * remains usable as a public multi-application service. The `ORIGIN`
   * environment variable is only the QR fallback and does not silently enable
   * an allowlist.
   */
  allowedOrigins?: AllowedOrigins
  /** Called when a mobile completes pairing and the session transitions to 'connected'. */
  onSessionConnected?: (sessionId: string) => void
  /** Called when a connected mobile disconnects (session transitions to 'disconnected'). */
  onSessionDisconnected?: (sessionId: string) => void
  /**
   * Called for every accepted WebSocket that closes, both roles, with the close code,
   * the cause (client, heartbeat or server) and how long it was open. Fires before the
   * session bookkeeping that drives `onSessionDisconnected`. Intended for logging so a
   * dropped phone can be diagnosed from server logs. Thrown errors and rejected promises
   * are contained so logging cannot prevent session cleanup.
   */
  onSocketClosed?: (info: SocketCloseInfo) => void
  /** Heartbeat ping interval in ms. Integer 1–2 147 483 647. Forwarded to WebSocketRelay. Default 30 000. */
  heartbeatIntervalMs?: number
  /**
   * Consecutive missed pongs tolerated before a socket is terminated. Forwarded to
   * WebSocketRelay. Default 2; set 1 for the pre-0.5 terminate-on-first-miss behaviour.
   */
  maxMissedHeartbeats?: number
  /**
   * Deadline for every newly opened mobile socket to prove possession of its
   * identity key by sending a valid encrypted pairing_approved message.
   * Default 15 000 ms. Primarily configurable for tests and constrained links.
   */
  mobileAuthTimeoutMs?: number
  /**
   * Maximum number of sessions held in memory at once.
   * Requests for new sessions beyond this limit are rejected with HTTP 429.
   * Default: 1000.
   */
  maxSessions?: number
  /** Maximum new pairing sessions per service minute. Default: 120. */
  maxSessionCreationsPerMinute?: number
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
  seq: number
  method: string
  params: unknown
  resolve: (response: RpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000
const MOBILE_AUTH_TIMEOUT_MS = 15_000
const MAX_ACTIVE_REQUESTS_PER_SESSION = 100
const DEFAULT_MAX_SESSION_CREATIONS_PER_MINUTE = 120
const MAX_DECLARED_MOBILE_METHODS = 100

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
 * // In GET    /api/session:        relay.createSession()
 * // In GET    /api/session/:id:    relay.getSession(id)
 * // In POST   /api/request/:id:   relay.sendRequest(id, method, params)
 * // In DELETE /api/session/:id:   relay.deleteSession(id, desktopToken)
 * ```
 *
 * Express auto-registered routes:
 *   GET    /api/session        — create session, return { sessionId, status, qrDataUrl }
 *   GET    /api/session/:id    — return { sessionId, status, relay, backendIdentityKey }
 *   POST   /api/request/:id    — body { method, params } — relay to mobile, return RpcResponse
 *   DELETE /api/session/:id    — terminate session; closes mobile WebSocket, marks expired
 */
export class WalletRelayService {
  private readonly sessions: QRSessionManager
  private readonly relay: WebSocketRelay
  private readonly handler = new WalletRequestHandler()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly mobileAuthTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly outboundQueues = new Map<string, Promise<void>>()
  private readonly activeRequestCounts = new Map<string, number>()
  private stopped = false
  private stopSignalResolve!: () => void
  private readonly stopSignal = new Promise<void>(resolve => {
    this.stopSignalResolve = resolve
  })
  private sessionCreationWindowStartedAt = Date.now()
  private sessionCreationsInWindow = 0

  // Resolved options — always defined after construction
  private readonly wallet: WalletLike
  private readonly relayUrl: string
  private readonly origin: string
  private readonly schema: string
  private readonly signQrCodes: boolean
  private readonly mobileAuthTimeoutMs: number
  private readonly maxSessionCreationsPerMinute: number
  /** Compiled allowlist used for both per-session origin claims and WS upgrades. */
  private readonly isOriginAllowed: ((origin: string) => boolean) | null

  constructor(private readonly opts: WalletRelayServiceOptions) {
    this.wallet = opts.wallet
    this.relayUrl = normalizeRelayUrl(
      opts.relayUrl ?? process.env['RELAY_URL'] ?? 'ws://localhost:3000'
    )
    this.origin = normalizeHttpOrigin(
      opts.origin ?? process.env['ORIGIN'] ?? 'http://localhost:5173'
    )
    this.schema = opts.schema ?? process.env['PAIRING_SCHEMA'] ?? 'bsv-browser'
    if (!/^[a-z][a-z0-9+.-]{0,31}$/iu.test(this.schema)) {
      throw new TypeError('Pairing schema is invalid')
    }
    this.signQrCodes = opts.signQrCodes ?? true
    this.mobileAuthTimeoutMs = opts.mobileAuthTimeoutMs ?? MOBILE_AUTH_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.mobileAuthTimeoutMs) ||
      this.mobileAuthTimeoutMs < 1 ||
      this.mobileAuthTimeoutMs > 120_000
    ) {
      throw new RangeError('mobileAuthTimeoutMs must be an integer from 1 to 120000')
    }
    this.maxSessionCreationsPerMinute =
      opts.maxSessionCreationsPerMinute ?? DEFAULT_MAX_SESSION_CREATIONS_PER_MINUTE
    if (
      !Number.isSafeInteger(this.maxSessionCreationsPerMinute) ||
      this.maxSessionCreationsPerMinute < 1 ||
      this.maxSessionCreationsPerMinute > 100_000
    ) {
      throw new RangeError('maxSessionCreationsPerMinute must be an integer from 1 to 100000')
    }

    // Compile the allowlist. Precedence: explicit `allowedOrigins` → legacy
    // single `origin` (when explicitly provided) → null (no validation).
    // We deliberately do NOT fall back to the env-var-derived `this.origin`
    // here, so a default localhost ORIGIN doesn't accidentally lock multi-app
    // setups out via the WS allowlist.
    const matcherSource =
      opts.allowedOrigins ?? (opts.origin === undefined ? undefined : this.origin)
    this.isOriginAllowed = compileOriginMatcher(matcherSource)

    this.sessions = new QRSessionManager({ maxSessions: opts.maxSessions })
    this.relay = new WebSocketRelay(opts.server, {
      allowedOrigins: matcherSource,
      path: opts.path,
      noServer: opts.noServer,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      maxMissedHeartbeats: opts.maxMissedHeartbeats,
      maxTopics: opts.maxSessions,
      // Desktop-role socket traffic reaches a phone only after its pairing_approved decrypts.
      holdDesktopTrafficUntilAccepted: true
    })

    if (opts.onSocketClosed) this.relay.onSocketClose(opts.onSocketClosed)

    // B6: clean up relay topic when a session is GC'd
    this.sessions.onSessionExpired(id => {
      this.relay.removeTopic(id)
      this.rejectPendingForSession(id)
    })

    // B5: reject WS connections for unknown/expired sessions
    this.relay.onValidateTopic(topic => {
      const s = this.sessions.getSession(topic)
      return s !== null && s.status !== 'expired'
    })

    // Require a valid desktopToken for role=desktop connections
    this.relay.onValidateDesktopToken((topic, token) => {
      const s = this.sessions.getSession(topic)
      return s !== null && secureTokenEqual(s.desktopToken, token)
    })

    // When mobile WS opens: lock the session against race-expiry and start auth timer
    this.relay.onMobileConnect(topic => {
      const s = this.sessions.getSession(topic)
      if (!s) return
      // Lock pending sessions so a pairing_approved in-flight doesn't lose to a lazy
      // expiry check on the next poll (grace window in QRSessionManager.getSession).
      this.sessions.setPairingStarted(topic)
      const existingTimer = this.mobileAuthTimers.get(topic)
      if (existingTimer) clearTimeout(existingTimer)
      const timer = setTimeout(() => {
        this.mobileAuthTimers.delete(topic)
        this.relay.disconnectMobile(topic)
      }, this.mobileAuthTimeoutMs)
      this.mobileAuthTimers.set(topic, timer)
    })

    this.relay.onIncoming((topic, envelope, role, connectionId) => {
      if (role === 'mobile') {
        void this.handleMobileMessage(topic, envelope, connectionId).catch(() => {
          this.relay.disconnectMobile(topic)
        })
      }
    })

    // Reject in-flight requests immediately when the mobile disconnects
    this.relay.onDisconnect((topic, role) => {
      if (role === 'mobile') {
        const authTimer = this.mobileAuthTimers.get(topic)
        if (authTimer) {
          clearTimeout(authTimer)
          this.mobileAuthTimers.delete(topic)
        }
        // Skip if already expired — this was a deliberate deleteSession(), not an unexpected drop
        if (this.sessions.getSession(topic)?.status === 'expired') return
        this.sessions.setStatus(topic, 'disconnected')
        this.rejectPendingForSession(topic)
        this.opts.onSessionDisconnected?.(topic)
      }
    })

    if (opts.app) this.registerRoutes(opts.app)
  }

  /**
   * Create a session and return its QR data URL, pairing URI, and desktop token.
   *
   * Pass `options.origin` to embed a per-session origin in the QR (multi-app
   * deployments where the caller's URL — not the relay's — is the trust anchor).
   * When omitted, falls back to the constructor `origin`.
   *
   * If an allowlist is configured, the per-session origin must match — otherwise
   * a malicious caller could mint QRs claiming to be any domain.
   */
  async createSession(options?: { origin?: string }): Promise<{
    sessionId: string
    status: string
    qrDataUrl: string
    pairingUri: string
    desktopToken: string
  }> {
    this.ensureRunning()
    const origin = normalizeHttpOrigin(options?.origin ?? this.origin)

    // Validate caller-claimed origin against the allowlist (when set).
    if (options?.origin !== undefined && this.isOriginAllowed && !this.isOriginAllowed(origin)) {
      throw new Error(`Origin '${options.origin}' is not in the allowedOrigins list`)
    }

    this.reserveSessionCreation()
    const session = this.sessions.createSession()
    try {
      const publicKeyResult = validateWalletResult(
        'getPublicKey',
        await this.whileRunning(this.wallet.getPublicKey({ identityKey: true })),
        { identityKey: true }
      )
      const backendIdentityKey = publicKeyResult.publicKey
      this.sessions.setBackendIdentityKey(session.id, backendIdentityKey)

      // Pre-compute expiry so the same value is used in both the signature and the URI.
      const expiry = Math.floor((Date.now() + 120_000) / 1000)

      let sig: string | undefined
      if (this.signQrCodes) {
        const data = Array.from(
          new TextEncoder().encode(`${session.id}|${backendIdentityKey}|${origin}|${expiry}`)
        )
        const signatureResult = await this.whileRunning(
          this.wallet.createSignature({
            data,
            protocolID: [0, 'qr pairing'],
            keyID: session.id,
            counterparty: 'anyone'
          })
        )
        const ownedSignatureResult = validateWalletResult('createSignature', signatureResult)
        sig = bytesToBase64url(ownedSignatureResult.signature)
      }

      const uri = buildPairingUri({
        sessionId: session.id,
        backendIdentityKey,
        protocolID: stringifyBRC100(PROTOCOL_ID),
        origin,
        expiry,
        sig,
        schema: this.schema
      })
      const qrDataUrl = await this.whileRunning(this.sessions.generateQRCode(uri))
      return {
        sessionId: session.id,
        status: session.status,
        qrDataUrl,
        pairingUri: uri,
        desktopToken: session.desktopToken
      }
    } catch (error) {
      this.sessions.deleteSession(session.id)
      throw error
    }
  }

  /**
   * Return session status, relay URL and the backend identity key embedded in the
   * session's QR, or null if not found. Serve this unchanged from `GET /api/session/:id`:
   * the phone requires `backendIdentityKey` to equal the key in the QR it scanned.
   */
  getSession(
    id: string
  ): { sessionId: string; status: string; relay: string; backendIdentityKey?: string } | null {
    const s = this.sessions.getSession(id)
    if (!s) return null
    const info: { sessionId: string; status: string; relay: string; backendIdentityKey?: string } =
      { sessionId: s.id, status: s.status, relay: this.relayUrl }
    if (s.backendIdentityKey !== undefined) info.backendIdentityKey = s.backendIdentityKey
    return info
  }

  /**
   * Dispatch a WS upgrade to the relay. Use when constructed with `noServer`
   * and routing multiple WS services from your own 'upgrade' handler.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.relay.handleUpgrade(req, socket, head)
  }

  /**
   * Encrypt an RPC call, relay it to the mobile, and await the response.
   * Rejects if the session is not connected or if the mobile doesn't respond within 30 s.
   */
  async sendRequest(
    sessionId: string,
    method: string,
    params: unknown,
    desktopToken?: string
  ): Promise<RpcResponse> {
    this.ensureRunning()
    requireSessionId(sessionId)
    requireBoundedString(method, 'wallet relay method', 1, 100)
    const session = this.sessions.getSession(sessionId)
    if (session?.status !== 'connected' || !session.mobileIdentityKey) {
      const status = session?.status ?? 'not found'
      throw new Error(`Session is ${status}`)
    }
    // Validate desktop token — ensures only the client that created the session
    // can send requests, even if another client knows the session ID.
    if (!secureTokenEqual(session.desktopToken, desktopToken)) {
      throw new Error('Invalid desktop token')
    }
    let requestParams: unknown
    let bindingParams: unknown
    try {
      requestParams = assertSafeWalletValue(params, 'wallet relay request')
      if ((WALLET_METHOD_NAMES as readonly string[]).includes(method)) {
        const walletMethod = method as (typeof WALLET_METHOD_NAMES)[number]
        validateWalletArgs(walletMethod, requestParams)
        bindingParams = snapshotWalletResultRequest(walletMethod, requestParams)
      } else {
        bindingParams = requestParams
      }
    } catch (error) {
      const invalidRequest = new Error(
        error instanceof Error ? error.message : 'Invalid wallet request'
      ) as Error & { code: number }
      invalidRequest.code = 400
      throw invalidRequest
    }

    this.reserveRequestSlot(sessionId)
    try {
      const { response } = await this.withOutboundTurn(sessionId, async () => {
        // A queued request may outlive the connection it was authorized against.
        const current = this.sessions.getSession(sessionId)
        if (current?.status !== 'connected' || !current.mobileIdentityKey) {
          throw new Error(`Session is ${current?.status ?? 'not found'}`)
        }
        if (!secureTokenEqual(current.desktopToken, desktopToken)) {
          throw new Error('Invalid desktop token')
        }
        this.ensureRunning()

        // Assign the sequence inside the per-session send turn so encryption
        // completion order can never reorder replay-protected requests.
        const rpc = this.handler.createRequest(method, requestParams)
        if (this.pending.has(rpc.id)) throw new Error('RPC identifier collision')
        const ciphertext = await this.whileRunning(
          encryptEnvelope(
            this.wallet,
            { protocolID: PROTOCOL_ID, keyID: sessionId, counterparty: current.mobileIdentityKey },
            stringifyBRC100(rpc)
          )
        )
        this.ensureRunning()
        const response = new Promise<RpcResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(rpc.id)
            reject(new Error('Request timed out'))
          }, REQUEST_TIMEOUT_MS)
          this.pending.set(rpc.id, {
            sessionId,
            seq: rpc.seq,
            method,
            params: bindingParams,
            resolve,
            reject,
            timer
          })
          try {
            this.relay.sendToMobile(sessionId, { topic: sessionId, ciphertext })
          } catch (error) {
            clearTimeout(timer)
            this.pending.delete(rpc.id)
            reject(error instanceof Error ? error : new Error('Failed to send wallet request'))
          }
        })
        return { response }
      })
      return await response
    } finally {
      this.releaseRequestSlot(sessionId)
    }
  }

  /**
   * Terminate a session from the desktop side: closes the mobile's WebSocket,
   * rejects in-flight requests, and marks the session expired.
   * Throws if the session is not found or the token is invalid.
   */
  deleteSession(sessionId: string, desktopToken: string): void {
    const session = this.sessions.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if (!secureTokenEqual(session.desktopToken, desktopToken))
      throw new Error('Invalid desktop token')
    this.relay.disconnectMobile(sessionId)
    this.rejectPendingForSession(sessionId)
    this.sessions.setStatus(sessionId, 'expired')
  }

  /** Stop the GC timer, close the WebSocket server, and reject all in-flight requests. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.stopSignalResolve()
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
        pending.reject(
          new Error(sessionId === null ? 'Server shutting down' : 'Session disconnected')
        )
      }
    }
  }

  private ensureRunning(): void {
    if (this.stopped) throw new Error('Server shutting down')
  }

  private reserveSessionCreation(): void {
    const now = Date.now()
    if (
      now < this.sessionCreationWindowStartedAt ||
      now - this.sessionCreationWindowStartedAt >= 60_000
    ) {
      this.sessionCreationWindowStartedAt = now
      this.sessionCreationsInWindow = 0
    }
    if (this.sessionCreationsInWindow >= this.maxSessionCreationsPerMinute) {
      const error = new Error('Session creation rate limit reached') as Error & { code: number }
      error.code = 429
      throw error
    }
    this.sessionCreationsInWindow += 1
  }

  private async whileRunning<T>(operation: Promise<T>): Promise<T> {
    const stopped = this.stopSignal.then(() => {
      throw new Error('Server shutting down')
    })
    return Promise.race([operation, stopped])
  }

  private reserveRequestSlot(sessionId: string): void {
    const active = this.activeRequestCounts.get(sessionId) ?? 0
    if (active >= MAX_ACTIVE_REQUESTS_PER_SESSION) {
      const error = new Error('Too many active wallet requests') as Error & { code: number }
      error.code = 429
      throw error
    }
    this.activeRequestCounts.set(sessionId, active + 1)
  }

  private releaseRequestSlot(sessionId: string): void {
    const active = this.activeRequestCounts.get(sessionId) ?? 0
    if (active <= 1) this.activeRequestCounts.delete(sessionId)
    else this.activeRequestCounts.set(sessionId, active - 1)
  }

  /** Serialize only sequence assignment, encryption, waiter registration, and send. */
  private async withOutboundTurn<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.outboundQueues.get(sessionId) ?? Promise.resolve()
    const ready = previous.catch(() => undefined)
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = ready.then(() => gate)
    this.outboundQueues.set(sessionId, tail)
    await ready
    try {
      return await action()
    } finally {
      release()
      if (this.outboundQueues.get(sessionId) === tail) this.outboundQueues.delete(sessionId)
    }
  }

  // ── Route registration ────────────────────────────────────────────────────────

  private registerRoutes(app: RouterLike): void {
    app.get('/api/session', (req: Request, res: Response) => {
      this.markNoStore(res)
      // Browsers automatically attach the `Origin` header on cross-origin requests.
      // We forward it as the per-session claimed origin so the QR points back at
      // the calling webapp rather than the relay's own URL. createSession()
      // validates the claim against the allowlist before embedding it.
      const claimedOrigin = req.headers.origin as string | undefined
      void this.createSession(claimedOrigin ? { origin: claimedOrigin } : undefined)
        .then(info => res.json(info))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Failed'
          const code = (err as { code?: number }).code
          let status = 500
          if (code === 429) {
            status = 429
          } else if (msg.includes('allowedOrigins')) {
            status = 403
          }
          res.status(status).json({ error: msg })
        })
    })

    app.get('/api/session/:id', (req: Request, res: Response) => {
      this.markNoStore(res)
      const info = this.getSession(req.params['id'] as string)
      if (!info) {
        res.status(404).json({ error: 'Session not found' })
        return
      }
      res.json(info)
    })

    app.post('/api/request/:id', (req: Request, res: Response) => {
      this.markNoStore(res)
      let body: Record<string, unknown>
      try {
        body = requirePlainRecord(req.body, 'wallet relay request body')
      } catch {
        res.status(400).json({ error: 'request body must be an object' })
        return
      }
      const { method, params } = body
      if (typeof method !== 'string') {
        res.status(400).json({ error: 'method is required' })
        return
      }
      const methodBytes = new TextEncoder().encode(method).length
      if (methodBytes < 1 || methodBytes > 100) {
        res.status(400).json({ error: 'method is required' })
        return
      }
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
          } else if ((err as { code?: number }).code === 400) {
            status = 400
          } else if ((err as { code?: number }).code === 429) {
            status = 429
          }
          res.status(status).json({ error: msg })
        })
    })

    app.delete('/api/session/:id', (req: Request, res: Response) => {
      this.markNoStore(res)
      const token = req.headers['x-desktop-token'] as string | undefined
      if (!token) {
        res.status(401).json({ error: 'Missing desktop token' })
        return
      }
      try {
        this.deleteSession(req.params['id'] as string, token)
        res.status(204).end()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed'
        let status = 500
        if (msg === 'Invalid desktop token') {
          status = 401
        } else if (msg === 'Session not found') {
          status = 404
        }
        res.status(status).json({ error: msg })
      }
    })
  }

  private markNoStore(res: Response): void {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
  }

  // ── Inbound message handling ──────────────────────────────────────────────────

  private async handleMobileMessage(
    topic: string,
    envelope: WireEnvelope,
    connectionId: number
  ): Promise<void> {
    const session = this.sessions.getSession(topic)
    if (!session) return

    // pairing_approved — mobileIdentityKey in outer envelope (bootstrap)
    if (envelope.mobileIdentityKey && session.status !== 'expired') {
      // B3: lock session to the first device that paired — disconnect impostor immediately
      if (session.mobileIdentityKey && session.mobileIdentityKey !== envelope.mobileIdentityKey) {
        this.relay.disconnectMobile(topic)
        return
      }
      await this.handlePairingApproved(topic, envelope, connectionId)
      return
    }

    if (!session.mobileIdentityKey) return
    await this.handleMobileResponse(topic, session.mobileIdentityKey, envelope)
  }

  /** Decrypts an RPC response from a paired mobile and settles its pending request. */
  private async handleMobileResponse(
    topic: string,
    mobileIdentityKey: string,
    envelope: WireEnvelope
  ): Promise<void> {
    let plaintext: string
    try {
      plaintext = await decryptEnvelope(
        this.wallet,
        { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
        envelope.ciphertext
      )
    } catch {
      return
    }

    let msg: ReturnType<typeof parseRpcMessage>
    try {
      msg = parseRpcMessage(JSON.parse(plaintext))
    } catch {
      return
    }
    if (!this.handler.isResponse(msg)) return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    if (pending.sessionId !== topic || msg.seq !== pending.seq) {
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      pending.reject(new Error('Wallet response was not bound to its request'))
      this.relay.disconnectMobile(topic)
      return
    }
    try {
      if (Object.prototype.hasOwnProperty.call(msg, 'result')) {
        normalizeBRC100WalletByteFields(msg.result)
        const ownedResult = (WALLET_METHOD_NAMES as readonly string[]).includes(pending.method)
          ? validateWalletResult(
              pending.method as (typeof WALLET_METHOD_NAMES)[number],
              msg.result,
              pending.params
            )
          : assertSafeWalletValue(msg.result, 'wallet relay custom RPC result')
        msg = { ...msg, result: ownedResult }
      }
    } catch {
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      pending.reject(new Error('Wallet returned an invalid result'))
      this.relay.disconnectMobile(topic)
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(msg.id)
    pending.resolve(msg)
  }

  private async handlePairingApproved(
    topic: string,
    envelope: WireEnvelope,
    connectionId: number
  ): Promise<void> {
    const mobileIdentityKey = requirePublicKey(
      envelope.mobileIdentityKey,
      'pairing mobile identity key'
    )

    // Decrypt and verify inner payload — failure means the mobile can't prove ECDH ownership
    let plaintext: string | null = null
    try {
      plaintext = await decryptEnvelope(
        this.wallet,
        { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
        envelope.ciphertext
      )
    } catch {
      // Handled below, once this socket is known to still hold the topic.
    }
    // A socket that closed while its proof decrypted must not act on the topic's next socket.
    if (!this.relay.isCurrentMobile(topic, connectionId)) return
    if (plaintext === null) {
      this.relay.disconnectMobile(topic)
      return
    }

    let msg: ReturnType<typeof parseRpcMessage>
    try {
      msg = parseRpcMessage(JSON.parse(plaintext))
    } catch {
      this.relay.disconnectMobile(topic)
      return
    }
    if (!('method' in msg) || msg.method !== 'pairing_approved') {
      this.relay.disconnectMobile(topic)
      return
    }
    requireSafeSequence(msg.seq, 'pairing approval sequence')
    const params = requirePlainRecord(msg.params, 'pairing approval parameters')
    if (params.mobileIdentityKey !== mobileIdentityKey) {
      this.relay.disconnectMobile(topic)
      return
    }
    assertSafeWalletValue(params.walletMeta ?? {}, 'pairing wallet metadata')
    if (params.permissions !== undefined) {
      if (
        !Array.isArray(params.permissions) ||
        params.permissions.length > MAX_DECLARED_MOBILE_METHODS
      ) {
        this.relay.disconnectMobile(topic)
        return
      }
      try {
        const methods = params.permissions.map((permission, index) =>
          requireBoundedString(permission, `pairing permission ${index}`, 1, 100)
        )
        if (new Set(methods).size !== methods.length) throw new Error('Duplicate permission')
      } catch {
        this.relay.disconnectMobile(topic)
        return
      }
    }

    // Encrypt pairing_ack before changing any state, so no await separates the socket
    // check below from the state it guards.
    const ack = this.handler.createProtocolMessage('pairing_ack', { topic })
    const ciphertext = await encryptEnvelope(
      this.wallet,
      { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
      stringifyBRC100(ack)
    )
    if (!this.relay.isCurrentMobile(topic, connectionId)) return

    // Auth succeeded — cancel the proof timer
    const timer = this.mobileAuthTimers.get(topic)
    if (timer) {
      clearTimeout(timer)
      this.mobileAuthTimers.delete(topic)
    }

    this.sessions.setMobileIdentityKey(topic, mobileIdentityKey)
    this.sessions.setStatus(topic, 'connected')
    this.opts.onSessionConnected?.(topic)

    // Send pairing_ack to confirm the session is live
    this.relay.sendToMobile(topic, { topic, ciphertext })
    // Only now may desktop-role socket traffic reach this mobile socket.
    this.relay.acceptMobile(topic, connectionId)
  }
}
