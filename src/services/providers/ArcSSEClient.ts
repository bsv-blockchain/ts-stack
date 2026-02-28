/**
 * Client for Arcade transaction status updates.
 *
 * Uses react-native-sse EventSource to connect to Arcade's
 * `GET /events?callbackToken=<token>` endpoint for real-time
 * status updates via SSE.
 *
 * Supports on-demand fetching via fetchEvents() for use on
 * app open, balance refresh, transaction list view, etc.
 * The EventSource stays connected between fetches for live updates.
 */

const TAG = '[ArcSSE]'

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
  onError?: (error: Error) => void
  /** Initial lastEventId for catchup */
  lastEventId?: string
  /** Called whenever lastEventId changes, for persistence to storage */
  onLastEventIdChanged?: (lastEventId: string) => void
  /** The react-native-sse EventSource class — passed in to avoid import from wallet-toolbox */
  EventSourceClass: any
}

export class ArcSSEClient {
  private _lastEventId: string | undefined
  private es: any | null = null
  private readonly url: string
  private connected = false

  constructor(private readonly options: ArcSSEClientOptions) {
    this._lastEventId = options.lastEventId
    const base = options.baseUrl.replace(/\/+$/, '')
    this.url = `${base}/events?callbackToken=${encodeURIComponent(options.callbackToken)}`
  }

  get lastEventId(): string | undefined {
    return this._lastEventId
  }

  /**
   * Open the SSE connection. Events will be dispatched via onEvent as they arrive.
   */
  connect(): void {
    if (this.es) {
      console.log(`${TAG} already connected`)
      return
    }

    const ESClass = this.options.EventSourceClass
    const headers: Record<string, string> = {
      'Last-Event-ID': this._lastEventId || '0'
    }

    console.log(`${TAG} connecting to ${this.url} (Last-Event-ID: ${headers['Last-Event-ID']})`)

    this.es = new ESClass(this.url, {
      headers,
      debug: true,
      pollingInterval: 0 // Don't auto-reconnect on close — we manage lifecycle
    })

    this.es.addEventListener('open', () => {
      this.connected = true
      console.log(`${TAG} connected`)
    })

    this.es.addEventListener('status', (event: any) => {
      try {
        const data: ArcSSEEvent = JSON.parse(event.data)
        console.log(`${TAG} event: txid=${data.txid} status=${data.txStatus}`)

        if (event.lastEventId) {
          this._lastEventId = event.lastEventId
          this.options.onLastEventIdChanged?.(event.lastEventId)
        }

        this.options.onEvent(data)
      } catch {
        console.log(`${TAG} malformed event: ${String(event.data).substring(0, 200)}`)
      }
    })

    this.es.addEventListener('error', (event: any) => {
      console.log(`${TAG} error:`, JSON.stringify(event))
      this.connected = false
      this.options.onError?.(new Error(event.message || 'SSE error'))
    })
  }

  /** Close the connection and clean up */
  close(): void {
    if (this.es) {
      console.log(`${TAG} closing`)
      this.es.close()
      this.es = null
      this.connected = false
    }
  }

  /**
   * Ensure connection is open. If already connected, this is a no-op.
   * If not connected, opens a new connection with catchup from lastEventId.
   * Returns immediately — events arrive asynchronously via onEvent callback.
   */
  async fetchEvents(): Promise<number> {
    if (!this.es || !this.connected) {
      this.close() // Clean up any stale connection
      this.connect()
    }
    // Events arrive asynchronously — return 0 since we can't know the count synchronously
    return 0
  }
}
