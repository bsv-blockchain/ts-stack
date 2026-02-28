/**
 * SSE (Server-Sent Events) client for Arcade transaction status updates.
 *
 * Connects to Arcade's `GET /events?callbackToken=<token>` endpoint
 * and receives real-time status updates for transactions submitted
 * with the matching `X-CallbackToken` header.
 *
 * Supports pause/resume for mobile app lifecycle (background/foreground)
 * with automatic catchup via the `Last-Event-ID` mechanism.
 */

export interface ArcSSEEvent {
  txid: string
  txStatus: string
  timestamp: string
}

export interface ArcSSEClientOptions {
  /** Base URL of the Arcade instance (e.g. "https://arcade-us-1.bsvb.tech") */
  baseUrl: string
  /** Stable per-wallet token matching the X-CallbackToken sent on broadcast */
  callbackToken: string
  /** Called for each status event received */
  onEvent: (event: ArcSSEEvent) => void
  /** Called when a connection error occurs */
  onError?: (error: Event) => void
  /** Called when connection is established */
  onConnected?: () => void
  /** Called when connection is lost */
  onDisconnected?: () => void
  /** Initial lastEventId for catchup on first connect */
  lastEventId?: string
}

export class ArcSSEClient {
  private eventSource: EventSource | null = null
  private _lastEventId: string | undefined
  private reconnectAttempts = 0
  private readonly maxReconnectDelay = 30000
  private readonly baseReconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _closed = false

  constructor(private readonly options: ArcSSEClientOptions) {
    this._lastEventId = options.lastEventId
  }

  get lastEventId(): string | undefined {
    return this._lastEventId
  }

  get connected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN
  }

  connect(): void {
    if (this._closed) return
    this.clearReconnectTimer()
    this.closeEventSource()

    const url = this.buildUrl()
    this.eventSource = new EventSource(url)

    this.eventSource.addEventListener('status', (e: MessageEvent) => {
      this.handleEvent(e)
    })

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0
      this.options.onConnected?.()
    }

    this.eventSource.onerror = (e: Event) => {
      this.options.onDisconnected?.()
      this.options.onError?.(e)
      // EventSource auto-reconnects on its own, but if it transitions to CLOSED
      // we need to handle reconnection ourselves with backoff
      if (this.eventSource?.readyState === EventSource.CLOSED) {
        this.scheduleReconnect()
      }
    }
  }

  disconnect(): void {
    this._closed = true
    this.clearReconnectTimer()
    this.closeEventSource()
  }

  /** Close the SSE connection but preserve lastEventId for later catchup */
  pause(): void {
    this.clearReconnectTimer()
    this.closeEventSource()
  }

  /** Reopen the SSE connection; server replays missed events via Last-Event-ID */
  resume(): void {
    if (this._closed) return
    this.reconnectAttempts = 0
    this.connect()
  }

  private buildUrl(): string {
    const base = this.options.baseUrl.replace(/\/+$/, '')
    let url = `${base}/events?callbackToken=${encodeURIComponent(this.options.callbackToken)}`
    // EventSource automatically sends Last-Event-ID from the most recent event's id field.
    // However, on initial connect (or after pause/resume), we may need to set it manually
    // via a query param since EventSource only sends it on auto-reconnect.
    if (this._lastEventId) {
      url += `&lastEventId=${encodeURIComponent(this._lastEventId)}`
    }
    return url
  }

  private handleEvent(e: MessageEvent): void {
    try {
      // Update lastEventId from the event's id field
      if (e.lastEventId) {
        this._lastEventId = e.lastEventId
      }
      const data: ArcSSEEvent = JSON.parse(e.data)
      this.options.onEvent(data)
    } catch {
      // Ignore malformed events
    }
  }

  private scheduleReconnect(): void {
    if (this._closed) return
    const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private closeEventSource(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
  }
}
