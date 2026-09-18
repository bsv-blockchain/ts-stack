import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WireEnvelope } from '../types.js'
import { stringifyBRC100 } from '@bsv/sdk'
import { compileOriginMatcher, type AllowedOrigins } from '../shared/originMatcher.js'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const MAX_HEARTBEAT_INTERVAL_MS = 2_147_483_647
// A phone on a mobile network misses single pongs routinely. Terminating on the
// first miss ended live sessions 30 to 60 s after the last pong; two consecutive
// misses is the smallest tolerance that survives one dropped frame.
const DEFAULT_MAX_MISSED_HEARTBEATS = 2
const BUFFER_TTL_MS = 60_000
const BUFFER_MAX_PER_TOPIC = 50

interface TopicEntry {
  desktop: WebSocket | null
  mobile: WebSocket | null
  buffer: BufferedMessage[]
}

interface BufferedMessage {
  envelope: WireEnvelope
  expiresAt: number
}

export type Role = 'desktop' | 'mobile'
export type MessageHandler = (topic: string, envelope: WireEnvelope, role: Role) => void
export type TopicValidator = (topic: string) => boolean
export type TokenValidator = (topic: string, token: string | null) => boolean
export type ConnectHandler = (topic: string) => void
/**
 * Invoked when a socket that held a topic slot closes. `info` is additive; existing
 * two-argument handlers keep working.
 */
export type DisconnectHandler = (topic: string, role: Role, info: SocketCloseInfo) => void
export type SocketCloseHandler = (info: SocketCloseInfo) => void

/**
 * Why a socket went away.
 * - `client`: the peer closed it, or the transport dropped (code 1006).
 * - `heartbeat`: this relay terminated it for missing too many pongs.
 * - `server`: this relay closed it deliberately (auth timeout, proof failure, deleteSession).
 */
export type SocketCloseCause = 'client' | 'heartbeat' | 'server'

/** One record per accepted socket close, for logging and diagnostics. */
export interface SocketCloseInfo {
  topic: string
  role: Role
  /** WebSocket close code: 1006 for an abnormal drop, 1005 when the peer sent none. */
  code: number
  /** Close reason string, empty when none was sent. */
  reason: string
  cause: SocketCloseCause
  /** Milliseconds between the upgrade being accepted and the close event. */
  connectedForMs: number
  /** Consecutive missed pongs at the moment of close. */
  missedPongs: number
}

/** Per-socket bookkeeping. Kept off the WebSocket object so the type stays honest. */
interface SocketState {
  topic: string
  role: Role
  connectedAt: number
  missedPongs: number
  closeCause: SocketCloseCause
}

export interface WebSocketRelayOptions {
  /**
   * Legacy single-string origin allowlist. Kept for backward compatibility —
   * prefer `allowedOrigins` for richer matching (arrays, regex, predicates).
   * If both are set, `allowedOrigins` takes precedence.
   */
  allowedOrigin?: string
  /**
   * Origin allowlist used to gate browser WS upgrades (role=desktop). Accepts
   * a single string, an array, a RegExp, or a custom predicate function.
   * When unset and `allowedOrigin` is also unset, no origin validation runs.
   */
  allowedOrigins?: AllowedOrigins
  /** Path this relay claims. Default '/ws'. */
  path?: string
  /**
   * When true, attach NO 'upgrade' listener to the server. Call
   * `handleUpgrade(req, socket, head)` from your own dispatcher instead.
   * Use when routing multiple WS services on one HTTP server.
   */
  noServer?: boolean
  /** How often to ping every socket, in ms. Integer 1–2 147 483 647, default 30 000. */
  heartbeatIntervalMs?: number
  /**
   * Consecutive missed pongs tolerated before a socket is terminated. Default 2, so a
   * socket that goes quiet lives between two and three intervals. Set to 1 for the
   * pre-0.5 behaviour of terminating on the first miss. Any inbound message also
   * resets the counter: a peer that is sending us data is alive whatever its pong timing.
   */
  maxMissedHeartbeats?: number
}

/**
 * Topic-keyed WebSocket relay. Mounts at /ws.
 *
 * Connections: ws://host/ws?topic=<sessionId>&role=desktop|mobile
 *
 * - Messages from mobile  → forwarded to desktop (or buffered)
 * - Messages from desktop → forwarded to mobile  (or buffered)
 * - Buffered messages are flushed when the other side connects
 * - Heartbeat pings every `heartbeatIntervalMs` (30 s); a socket is terminated once it
 *   has missed `maxMissedHeartbeats` (2) consecutive pongs without sending anything
 * - Every accepted socket close is reported through onSocketClose with code, cause and duration
 * - Origin header validated against allowedOrigins (or legacy allowedOrigin)
 *   when present — browser clients only; native mobile clients are exempt
 * - role=desktop connections validated via onValidateDesktopToken callback when set
 */
export class WebSocketRelay {
  private readonly wss: WebSocketServer
  private readonly topics = new Map<string, TopicEntry>()
  private onMessage: MessageHandler | null = null
  private validateTopic: TopicValidator | null = null
  private validateDesktopToken: TokenValidator | null = null
  private onDisconnectCb: DisconnectHandler | null = null
  private onSocketCloseCb: SocketCloseHandler | null = null
  private onMobileConnectCb: ConnectHandler | null = null
  private readonly socketState = new WeakMap<WebSocket, SocketState>()
  private readonly maxMissedHeartbeats: number
  private readonly isOriginAllowed: ((origin: string) => boolean) | null
  private readonly heartbeatTimer: ReturnType<typeof setInterval>
  private readonly server: Server
  private readonly path: string
  private readonly upgradeListener:
    ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null

  constructor(server: Server, options?: WebSocketRelayOptions) {
    // `allowedOrigins` (new) wins over `allowedOrigin` (legacy) when both set.
    this.isOriginAllowed = compileOriginMatcher(options?.allowedOrigins ?? options?.allowedOrigin)
    const maxMissed = options?.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED_HEARTBEATS
    if (!Number.isInteger(maxMissed) || maxMissed < 1) {
      throw new RangeError(`maxMissedHeartbeats must be an integer >= 1, got ${maxMissed}`)
    }
    this.maxMissedHeartbeats = maxMissed
    const interval = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_HEARTBEAT_INTERVAL_MS) {
      throw new RangeError(
        `heartbeatIntervalMs must be an integer between 1 and ${MAX_HEARTBEAT_INTERVAL_MS}, got ${interval}`
      )
    }
    this.server = server
    this.path = options?.path ?? '/ws'
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))

    // Default mode: claim our path only, ignore everything else so other
    // upgrade listeners on this server can handle their own routes.
    if (!options?.noServer) {
      this.upgradeListener = (req, socket, head) => {
        const { pathname } = new URL(req.url ?? '', 'http://localhost')
        if (pathname !== this.path) return
        this.handleUpgrade(req, socket, head)
      }
      this.server.on('upgrade', this.upgradeListener)
    }

    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), interval)
  }

  /**
   * Perform the WS upgrade for this relay. Called by the built-in listener in
   * default mode; call it yourself from a custom dispatcher when `noServer` is
   * set. Does not re-check the path — the caller has already routed by path.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req))
  }

  /** Register a callback for every inbound message from either side. */
  onIncoming(handler: MessageHandler): void {
    this.onMessage = handler
  }

  /** Register a validator called on each new connection to verify the topic exists. */
  onValidateTopic(validator: TopicValidator): void {
    this.validateTopic = validator
  }

  /**
   * Register a validator for role=desktop connections.
   * Receives the topic and the `token` query parameter (null if absent).
   * Return false to reject the connection with close code 1008.
   */
  onValidateDesktopToken(validator: TokenValidator): void {
    this.validateDesktopToken = validator
  }

  /**
   * Register a callback invoked when a socket disconnects.
   * Use this to react to mobile disconnects (e.g. reject in-flight requests).
   */
  onDisconnect(handler: DisconnectHandler): void {
    this.onDisconnectCb = handler
  }

  /**
   * Register a callback invoked for every accepted socket that closes, whether or not
   * it still held its topic slot. Unlike onDisconnect this also fires for a socket that
   * was replaced by a newer connection on the same topic and role. Intended for logging.
   * Thrown errors and rejected promises are contained; diagnostics cannot prevent cleanup.
   */
  onSocketClose(handler: SocketCloseHandler): void {
    this.onSocketCloseCb = handler
  }

  /** Register a callback invoked when a mobile socket connects (before proof). */
  onMobileConnect(handler: ConnectHandler): void {
    this.onMobileConnectCb = handler
  }

  /** Forcibly close the mobile socket for a topic (e.g. auth timeout or proof failure). */
  disconnectMobile(topic: string): void {
    const entry = this.topics.get(topic)
    if (entry?.mobile) {
      const state = this.socketState.get(entry.mobile)
      if (state) state.closeCause = 'server'
      entry.mobile.close(1008, 'Authentication failed')
      entry.mobile = null
    }
  }

  /** Remove a topic entry — call when its session is garbage-collected. */
  removeTopic(topic: string): void {
    this.topics.delete(topic)
  }

  /** Push an envelope to the mobile socket (or buffer if disconnected). */
  sendToMobile(topic: string, envelope: WireEnvelope): void {
    const entry = this.topics.get(topic)
    if (entry?.mobile?.readyState === WebSocket.OPEN) {
      entry.mobile.send(stringifyBRC100(envelope))
    } else {
      this.buffer(topic, envelope)
    }
  }

  /** Push an envelope to the desktop socket (or buffer if disconnected). */
  sendToDesktop(topic: string, envelope: WireEnvelope): void {
    const entry = this.topics.get(topic)
    if (entry?.desktop?.readyState === WebSocket.OPEN) {
      entry.desktop.send(stringifyBRC100(envelope))
    } else {
      this.buffer(topic, envelope)
    }
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.upgradeListener) this.server.removeListener('upgrade', this.upgradeListener)
    this.wss.close()
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private reportSocketClose(info: SocketCloseInfo): void {
    try {
      void Promise.resolve(this.onSocketCloseCb?.(info)).catch(() => {
        // Diagnostic delivery is best effort; asynchronous logging must not disrupt the relay.
      })
    } catch {
      // A logging callback must not prevent topic cleanup or disconnect notification.
    }
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '', 'http://localhost')
    const topic = url.searchParams.get('topic')
    const role = url.searchParams.get('role') as Role | null
    const token = url.searchParams.get('token')

    if (!topic || !role || (role !== 'desktop' && role !== 'mobile')) {
      ws.close(1008, 'Missing or invalid topic/role')
      return
    }

    // Origin check — browsers always send this header and cannot spoof it.
    // Only enforce for role=desktop (browser clients). Mobile clients are native
    // apps whose WebSocket implementations may send unexpected Origin values
    // (e.g. React Native on iOS sends "http://localhost" without a port).
    if (role === 'desktop') {
      const origin = req.headers.origin
      if (origin && this.isOriginAllowed && !this.isOriginAllowed(origin)) {
        ws.close(1008, 'Origin not allowed')
        return
      }
    }

    if (this.validateTopic && !this.validateTopic(topic)) {
      ws.close(1008, 'Unknown or expired session')
      return
    }

    // Desktop token — prevents unauthorized clients from squatting the desktop
    // slot and receiving ciphertext traffic.
    if (
      role === 'desktop' &&
      this.validateDesktopToken &&
      !this.validateDesktopToken(topic, token)
    ) {
      ws.close(1008, 'Invalid or missing desktop token')
      return
    }

    const entry = this.getOrCreateTopic(topic)
    entry[role] = ws

    if (role === 'mobile') this.onMobileConnectCb?.(topic)

    // Flush any messages buffered while this side was disconnected
    const now = Date.now()
    const toFlush = entry.buffer.filter(m => m.expiresAt > now)
    entry.buffer = []
    for (const { envelope } of toFlush) {
      ws.send(stringifyBRC100(envelope))
    }

    const state: SocketState = {
      topic,
      role,
      connectedAt: Date.now(),
      missedPongs: 0,
      closeCause: 'client'
    }
    this.socketState.set(ws, state)
    ws.on('pong', () => {
      state.missedPongs = 0
    })

    ws.on('message', data => {
      state.missedPongs = 0
      try {
        const envelope = JSON.parse(`${data}`) as WireEnvelope
        if (!envelope.topic || !envelope.ciphertext) return

        // Route to the other side
        const other = role === 'mobile' ? entry.desktop : entry.mobile
        if (other?.readyState === WebSocket.OPEN) {
          other.send(stringifyBRC100(envelope))
        } else if (role === 'desktop') {
          // Only buffer desktop→mobile messages. Mobile→desktop messages are
          // handled by the onMessage callback; buffering them here would cause
          // re-delivery to mobile on reconnect (inflating lastSeq on mobile).
          this.buffer(topic, envelope)
        }

        // Notify service layer (e.g. to process pairing_approved)
        this.onMessage?.(topic, envelope, role)
      } catch {
        // Malformed message — drop silently
      }
    })

    ws.on('close', (code, reason) => {
      const info: SocketCloseInfo = {
        topic,
        role,
        code,
        reason: reason.toString(),
        cause: state.closeCause,
        connectedForMs: Date.now() - state.connectedAt,
        missedPongs: state.missedPongs
      }
      this.socketState.delete(ws)
      this.reportSocketClose(info)
      if (entry[role] === ws) {
        entry[role] = null
        this.onDisconnectCb?.(topic, role, info)
      }
    })
  }

  private getOrCreateTopic(topic: string): TopicEntry {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, { desktop: null, mobile: null, buffer: [] })
    }
    return this.topics.get(topic)!
  }

  private buffer(topic: string, envelope: WireEnvelope): void {
    const entry = this.getOrCreateTopic(topic)
    const now = Date.now()
    entry.buffer = entry.buffer.filter(m => m.expiresAt > now)
    if (entry.buffer.length >= BUFFER_MAX_PER_TOPIC) {
      entry.buffer.shift()
    }
    entry.buffer.push({ envelope, expiresAt: now + BUFFER_TTL_MS })
  }

  private runHeartbeat(): void {
    for (const ws of this.wss.clients) {
      const state = this.socketState.get(ws)
      if (!state) continue // rejected before acceptance; ws closes it itself
      if (state.missedPongs >= this.maxMissedHeartbeats) {
        state.closeCause = 'heartbeat'
        ws.terminate()
        continue
      }
      state.missedPongs += 1
      ws.ping()
    }
  }
}
