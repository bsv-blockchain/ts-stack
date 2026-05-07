import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { WireEnvelope } from '../types.js'

const HEARTBEAT_INTERVAL_MS = 30_000
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
export type MessageHandler    = (topic: string, envelope: WireEnvelope, role: Role) => void
export type TopicValidator    = (topic: string) => boolean
export type TokenValidator    = (topic: string, token: string | null) => boolean
export type ConnectHandler    = (topic: string) => void
export type DisconnectHandler = (topic: string, role: Role) => void

/**
 * Topic-keyed WebSocket relay. Mounts at /ws.
 *
 * Connections: ws://host/ws?topic=<sessionId>&role=desktop|mobile
 *
 * - Messages from mobile  → forwarded to desktop (or buffered)
 * - Messages from desktop → forwarded to mobile  (or buffered)
 * - Buffered messages are flushed when the other side connects
 * - Heartbeat pings every 30 s; non-responsive sockets are terminated
 * - Origin header validated against allowedOrigin when present (browser clients only)
 * - role=desktop connections validated via onValidateDesktopToken callback when set
 */
export class WebSocketRelay {
  private readonly wss: WebSocketServer
  private readonly topics = new Map<string, TopicEntry>()
  private onMessage: MessageHandler | null = null
  private validateTopic: TopicValidator | null = null
  private validateDesktopToken: TokenValidator | null = null
  private onDisconnectCb: DisconnectHandler | null = null
  private onMobileConnectCb: ConnectHandler | null = null
  private readonly allowedOrigin: string | null = null
  private readonly heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(server: Server, options?: { allowedOrigin?: string }) {
    this.allowedOrigin = options?.allowedOrigin ?? null
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS)
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

  /** Register a callback invoked when a mobile socket connects (before proof). */
  onMobileConnect(handler: ConnectHandler): void {
    this.onMobileConnectCb = handler
  }

  /** Forcibly close the mobile socket for a topic (e.g. auth timeout or proof failure). */
  disconnectMobile(topic: string): void {
    const entry = this.topics.get(topic)
    if (entry?.mobile) {
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
      entry.mobile.send(JSON.stringify(envelope))
    } else {
      this.buffer(topic, envelope)
    }
  }

  /** Push an envelope to the desktop socket (or buffer if disconnected). */
  sendToDesktop(topic: string, envelope: WireEnvelope): void {
    const entry = this.topics.get(topic)
    if (entry?.desktop?.readyState === WebSocket.OPEN) {
      entry.desktop.send(JSON.stringify(envelope))
    } else {
      this.buffer(topic, envelope)
    }
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.wss.close()
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '', 'http://localhost')
    const topic = url.searchParams.get('topic')
    const role  = url.searchParams.get('role') as Role | null
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
      if (origin && this.allowedOrigin && origin !== this.allowedOrigin) {
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
    if (role === 'desktop' && this.validateDesktopToken && !this.validateDesktopToken(topic, token)) {
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
      ws.send(JSON.stringify(envelope))
    }

    ;(ws as WebSocket & { isAlive: boolean }).isAlive = true
    ws.on('pong', () => { (ws as WebSocket & { isAlive: boolean }).isAlive = true })

    ws.on('message', (data) => {
      try {
        const envelope = JSON.parse(`${data}`) as WireEnvelope
        if (!envelope.topic || !envelope.ciphertext) return

        // Route to the other side
        const other = role === 'mobile' ? entry.desktop : entry.mobile
        if (other?.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify(envelope))
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

    ws.on('close', () => {
      if (entry[role] === ws) {
        entry[role] = null
        this.onDisconnectCb?.(topic, role)
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
      const ext = ws as WebSocket & { isAlive: boolean }
      if (!ext.isAlive) { ws.terminate(); continue }
      ext.isAlive = false
      ws.ping()
    }
  }
}
