import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { DESKTOP_TOKEN_PROTOCOL_PREFIX, DESKTOP_WS_PROTOCOL, type WireEnvelope } from '../types.js'
import { stringifyBRC100 } from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { compileOriginMatcher, type AllowedOrigins } from '../shared/originMatcher.js'
import {
  DEFAULT_MAX_SESSIONS,
  encodedWireSize,
  MAX_CONFIGURED_SESSIONS,
  MAX_WIRE_PAYLOAD_BYTES,
  parseWireEnvelope
} from '../shared/validation.js'

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
  /** Sent by a role=desktop socket, as opposed to the server's own sendToMobile/sendToDesktop. */
  fromDesktop: boolean
}

export type Role = 'desktop' | 'mobile'
/**
 * Invoked for every inbound message. `connectionId` identifies the sending socket; pass it
 * to `acceptMobile` to accept that mobile socket. Handlers declared with three parameters keep
 * working; code that calls a MessageHandler itself must pass the fourth argument.
 */
export type MessageHandler = (
  topic: string,
  envelope: WireEnvelope,
  role: Role,
  connectionId: number
) => void
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
  connectionId: number
  /** Mobile only: set by acceptMobile. With the hold enabled, desktop traffic waits for it. */
  accepted: boolean
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
  /** Maximum live/buffered topics. Default 1,000. */
  maxTopics?: number
  /**
   * When true, messages from a role=desktop socket, live or buffered, reach a mobile socket
   * only after `acceptMobile(topic, connectionId)` accepted that socket. Held messages are
   * flushed on acceptance and discarded when an unaccepted mobile socket leaves; each new
   * mobile socket starts unaccepted. `sendToMobile` is never held. Default false, which keeps
   * the relay a plain forwarder. `WalletRelayService` enables it and accepts a mobile socket
   * once its pairing_approved message decrypts.
   *
   * Held messages reach the phone after anything the backend sent before `acceptMobile`
   * (e.g. pairing_ack), so they need sequence numbers above the backend's. A role=desktop
   * socket that connects while messages are held receives the buffer, its own held messages
   * included, and those messages are then no longer delivered to the phone.
   */
  holdDesktopTrafficUntilAccepted?: boolean
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
 * - With `holdDesktopTrafficUntilAccepted`, desktop messages wait for `acceptMobile`
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
  private readonly maxTopics: number
  private readonly holdDesktopTraffic: boolean
  private nextConnectionId = 0
  private closed = false
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
    this.maxTopics = options?.maxTopics ?? DEFAULT_MAX_SESSIONS
    if (
      !Number.isSafeInteger(this.maxTopics) ||
      this.maxTopics < 1 ||
      this.maxTopics > MAX_CONFIGURED_SESSIONS
    ) {
      throw new RangeError(`maxTopics must be an integer from 1 to ${MAX_CONFIGURED_SESSIONS}`)
    }
    const interval = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_HEARTBEAT_INTERVAL_MS) {
      throw new RangeError(
        `heartbeatIntervalMs must be an integer between 1 and ${MAX_HEARTBEAT_INTERVAL_MS}, got ${interval}`
      )
    }
    this.holdDesktopTraffic = options?.holdDesktopTrafficUntilAccepted === true
    this.server = server
    this.path = options?.path ?? '/ws'
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 64 * 1024,
      handleProtocols: protocols => {
        // Never echo the bearer-bearing protocol. Select the stable protocol
        // name when offered, while preserving legacy arbitrary subprotocols.
        if (protocols.has(DESKTOP_WS_PROTOCOL)) return DESKTOP_WS_PROTOCOL
        if ([...protocols].some(protocol => protocol.startsWith(DESKTOP_TOKEN_PROTOCOL_PREFIX))) {
          return false
        }
        return protocols.values().next().value ?? false
      }
    })
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
    if (this.closed) {
      socket.destroy()
      return
    }
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

  /**
   * Accept the mobile socket identified by `connectionId` (from the onIncoming handler) and
   * deliver the desktop messages held for it. Returns false, and accepts nothing, when that
   * socket is no longer the topic's open mobile socket.
   */
  acceptMobile(topic: string, connectionId: number): boolean {
    if (!this.isCurrentMobile(topic, connectionId)) return false
    const entry = this.topics.get(topic)!
    const mobile = entry.mobile!
    this.socketState.get(mobile)!.accepted = true
    const now = Date.now()
    const held = entry.buffer.filter(m => m.fromDesktop && m.expiresAt > now)
    entry.buffer = entry.buffer.filter(m => !m.fromDesktop)
    for (const { envelope } of held) {
      mobile.send(stringifyBRC100(envelope))
    }
    return true
  }

  /**
   * True while the socket identified by `connectionId` (from the onIncoming handler) is the
   * topic's open mobile socket. Check it after any asynchronous work started by a mobile
   * message, before acting on the topic: the socket may have closed or been replaced since.
   */
  isCurrentMobile(topic: string, connectionId: number): boolean {
    const mobile = this.topics.get(topic)?.mobile
    if (mobile?.readyState !== WebSocket.OPEN) return false
    return this.socketState.get(mobile)?.connectionId === connectionId
  }

  /** Forcibly close the mobile socket for a topic (e.g. auth timeout or proof failure). */
  disconnectMobile(topic: string): void {
    const entry = this.topics.get(topic)
    if (entry?.mobile) {
      const state = this.socketState.get(entry.mobile)
      if (state) state.closeCause = 'server'
      if (this.isHeldFrom(entry.mobile)) this.dropHeld(entry)
      entry.mobile.close(1008, 'Authentication failed')
      entry.mobile = null
    }
  }

  /** Revoke a topic, close both role sockets, and discard buffered traffic. */
  removeTopic(topic: string): void {
    const entry = this.topics.get(topic)
    if (entry) {
      const sockets = [entry.desktop, entry.mobile]
      entry.desktop = null
      entry.mobile = null
      entry.buffer = []
      for (const ws of sockets) {
        if (!ws) continue
        const state = this.socketState.get(ws)
        if (state) state.closeCause = 'server'
        ws.close(1008, 'Session expired')
      }
    }
    this.topics.delete(topic)
  }

  /** Push an envelope to the mobile socket (or buffer if disconnected). */
  sendToMobile(topic: string, envelope: WireEnvelope): void {
    if (this.closed) throw new Error('WebSocket relay is closed')
    const normalized = parseWireEnvelope(envelope, topic)
    if (encodedWireSize(normalized) > MAX_WIRE_PAYLOAD_BYTES) {
      throw new RangeError('Wire envelope exceeds 64 KiB')
    }
    const entry = this.topics.get(topic)
    if (entry?.mobile?.readyState === WebSocket.OPEN) {
      entry.mobile.send(stringifyBRC100(normalized))
    } else {
      this.buffer(topic, normalized)
    }
  }

  /** Push an envelope to the desktop socket (or buffer if disconnected). */
  sendToDesktop(topic: string, envelope: WireEnvelope): void {
    if (this.closed) throw new Error('WebSocket relay is closed')
    const normalized = parseWireEnvelope(envelope, topic)
    if (encodedWireSize(normalized) > MAX_WIRE_PAYLOAD_BYTES) {
      throw new RangeError('Wire envelope exceeds 64 KiB')
    }
    const entry = this.topics.get(topic)
    if (entry?.desktop?.readyState === WebSocket.OPEN) {
      entry.desktop.send(stringifyBRC100(normalized))
    } else {
      this.buffer(topic, normalized)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeatTimer)
    if (this.upgradeListener) this.server.removeListener('upgrade', this.upgradeListener)
    for (const entry of this.topics.values()) {
      entry.desktop = null
      entry.mobile = null
      entry.buffer = []
    }
    this.topics.clear()
    for (const ws of this.wss.clients) {
      const state = this.socketState.get(ws)
      if (state) state.closeCause = 'server'
      ws.terminate()
    }
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
    const queryToken = url.searchParams.get('token')
    const offeredProtocols = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map(protocol => protocol.trim())
      .filter(Boolean)
    const protocolTokens = offeredProtocols
      .filter(protocol => protocol.startsWith(DESKTOP_TOKEN_PROTOCOL_PREFIX))
      .map(protocol => protocol.slice(DESKTOP_TOKEN_PROTOCOL_PREFIX.length))
    const protocolToken =
      offeredProtocols.includes(DESKTOP_WS_PROTOCOL) && protocolTokens.length === 1
        ? protocolTokens[0]!
        : null
    if (protocolToken !== null && queryToken !== null && protocolToken !== queryToken) {
      ws.close(1008, 'Conflicting desktop tokens')
      return
    }
    const token = protocolToken ?? queryToken

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

    if (!this.isTopicValid(topic)) {
      ws.close(1008, 'Unknown or expired session')
      return
    }

    // Desktop token — prevents unauthorized clients from squatting the desktop
    // slot and receiving ciphertext traffic.
    if (
      role === 'desktop' &&
      this.validateDesktopToken &&
      !this.isDesktopTokenValid(topic, token)
    ) {
      ws.close(1008, 'Invalid or missing desktop token')
      return
    }

    let entry: TopicEntry
    try {
      entry = this.getOrCreateTopic(topic)
    } catch {
      ws.close(1013, 'Relay topic limit reached')
      return
    }
    const existing = entry[role]
    if (existing?.readyState === WebSocket.OPEN) {
      if (role === 'mobile') {
        ws.close(1008, 'A mobile connection is already active')
        return
      }
      const existingState = this.socketState.get(existing)
      if (existingState) existingState.closeCause = 'server'
      existing.close(1008, 'Replaced by a newer authenticated desktop connection')
    }
    entry[role] = ws

    if (role === 'mobile') {
      try {
        this.onMobileConnectCb?.(topic)
      } catch {
        entry.mobile = null
        ws.close(1011, 'Mobile connection setup failed')
        return
      }
    }

    const state: SocketState = {
      topic,
      role,
      connectionId: ++this.nextConnectionId,
      accepted: false,
      connectedAt: Date.now(),
      missedPongs: 0,
      closeCause: 'client'
    }
    this.socketState.set(ws, state)

    // Flush any messages buffered while this side was disconnected. Desktop messages
    // stay held for a mobile socket that has not been accepted yet.
    const now = Date.now()
    const live = entry.buffer.filter(m => m.expiresAt > now)
    const hold = role === 'mobile' && this.holdDesktopTraffic
    entry.buffer = hold ? live.filter(m => m.fromDesktop) : []
    for (const { envelope } of hold ? live.filter(m => !m.fromDesktop) : live) {
      ws.send(stringifyBRC100(envelope))
    }
    ws.on('pong', () => {
      state.missedPongs = 0
    })

    ws.on('message', data => {
      state.missedPongs = 0
      try {
        // A replaced or revoked socket must lose forwarding authority
        // immediately, without waiting for its close handshake to finish.
        if (entry[role] !== ws) return
        if (!this.isTopicValid(topic)) {
          state.closeCause = 'server'
          ws.close(1008, 'Unknown or expired session')
          return
        }
        const envelope = parseWireEnvelope(JSON.parse(`${data}`), topic)

        // Route to the other side
        const other = role === 'mobile' ? entry.desktop : entry.mobile
        const held = role === 'desktop' && other !== null && this.isHeldFrom(other)
        if (other?.readyState === WebSocket.OPEN && !held) {
          other.send(stringifyBRC100(envelope))
        } else if (role === 'desktop') {
          // Only buffer desktop→mobile messages. Mobile→desktop messages are
          // handled by the onMessage callback; buffering them here would cause
          // re-delivery to mobile on reconnect (inflating lastSeq on mobile).
          this.buffer(topic, envelope, true)
        }

        // Notify service layer (e.g. to process pairing_approved)
        this.onMessage?.(topic, envelope, role, state.connectionId)
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
        if (role === 'mobile' && this.holdDesktopTraffic && !state.accepted) this.dropHeld(entry)
        entry[role] = null
        try {
          this.onDisconnectCb?.(topic, role, info)
        } catch {
          // Application callbacks must not escape the WebSocket close event.
        }
      }
      if (entry.desktop === null && entry.mobile === null && entry.buffer.length === 0) {
        this.topics.delete(topic)
      }
    })
  }

  private getOrCreateTopic(topic: string): TopicEntry {
    if (this.closed) throw new Error('WebSocket relay is closed')
    if (!this.topics.has(topic)) {
      if (this.topics.size >= this.maxTopics) throw new Error('Relay topic limit reached')
      this.topics.set(topic, { desktop: null, mobile: null, buffer: [] })
    }
    return this.topics.get(topic)!
  }

  private isTopicValid(topic: string): boolean {
    if (!this.validateTopic) return true
    try {
      return this.validateTopic(topic) === true
    } catch {
      return false
    }
  }

  private isDesktopTokenValid(topic: string, token: string | null): boolean {
    if (!this.validateDesktopToken) return true
    try {
      return this.validateDesktopToken(topic, token) === true
    } catch {
      return false
    }
  }

  private buffer(topic: string, envelope: WireEnvelope, fromDesktop = false): void {
    const entry = this.getOrCreateTopic(topic)
    const now = Date.now()
    entry.buffer = entry.buffer.filter(m => m.expiresAt > now)
    if (entry.buffer.length >= BUFFER_MAX_PER_TOPIC) {
      entry.buffer.shift()
    }
    entry.buffer.push({ envelope, expiresAt: now + BUFFER_TTL_MS, fromDesktop })
  }

  /** True when desktop messages must not reach this mobile socket yet. */
  private isHeldFrom(mobile: WebSocket): boolean {
    return this.holdDesktopTraffic && this.socketState.get(mobile)?.accepted !== true
  }

  /** Discard desktop messages held for a mobile socket that was never accepted. */
  private dropHeld(entry: TopicEntry): void {
    entry.buffer = entry.buffer.filter(m => !m.fromDesktop)
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
    const now = Date.now()
    for (const [topic, entry] of this.topics) {
      entry.buffer = entry.buffer.filter(message => message.expiresAt > now)
      if (entry.desktop === null && entry.mobile === null && entry.buffer.length === 0) {
        this.topics.delete(topic)
      }
    }
  }
}
