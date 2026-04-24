import type { WalletInterface } from '@bsv/sdk'
import type { SessionInfo, WalletRequest, WalletResponse, RequestLogEntry, WalletMethodName } from '../types.js'
import { WALLET_METHOD_NAMES } from '../types.js'

export interface WalletRelayClientOptions {
  /**
   * Base URL for the relay API. Can be the bare host (`http://localhost:3001`)
   * or include the `/api` prefix — `/api` is appended automatically if missing.
   * Default: '/api'
   */
  apiUrl?: string
  /** Session status polling interval in ms while waiting for mobile to connect. Default: 3000 */
  pollInterval?: number
  /** Session status polling interval in ms once the mobile is connected. Default: 10000 */
  connectedPollInterval?: number
  /**
   * Persist the active session to sessionStorage so a page refresh resumes the
   * existing session rather than creating a new one. Default: true.
   * Disable if you want every mount to start a fresh session.
   */
  persistSession?: boolean
  /**
   * sessionStorage key used to store the session. Defaults to a key namespaced
   * by apiUrl so multiple relay instances on the same page don't collide.
   */
  sessionStorageKey?: string
  /**
   * How long a persisted session is considered resumable (ms). After this
   * the stored entry is discarded without a network request. Default: 86400000 (24 h).
   * The server is still the authority — an expired server session is detected on
   * the first poll and cleared regardless of this value.
   */
  sessionStorageTtl?: number
  /** Called whenever the session state changes (including on creation). */
  onSessionChange?: (session: SessionInfo) => void
  /** Called when the request log changes. */
  onLogChange?: (log: RequestLogEntry[]) => void
  /** Called when an error occurs during session creation. */
  onError?: (error: string) => void
}

export type WalletRelayErrorCode =
  | 'SESSION_NOT_CONNECTED'  // no active session or session not in connected state
  | 'REQUEST_TIMEOUT'        // mobile did not respond within 30 s
  | 'SESSION_DISCONNECTED'   // mobile dropped while the request was in-flight
  | 'INVALID_TOKEN'          // desktopToken mismatch — likely a client config issue
  | 'NETWORK_ERROR'          // fetch failed or unexpected HTTP error

export class WalletRelayError extends Error {
  constructor(message: string, public readonly code: WalletRelayErrorCode) {
    super(message)
    this.name = 'WalletRelayError'
  }
}

interface PersistedSession {
  sessionId:    string
  desktopToken: string
  qrDataUrl?:   string
  pairingUri?:  string
  status:       string
  savedAt:      number
}

/**
 * Frontend counterpart to WalletRelayService.
 *
 * Manages session creation, status polling, and RPC requests against the
 * relay HTTP API. Framework-agnostic — use directly with callbacks or via
 * `useWalletRelayClient` for React state integration.
 *
 * ```ts
 * const client = new WalletRelayClient({
 *   onSessionChange: (s) => render(s),
 * })
 * await client.createSession()
 * const res = await client.sendRequest('getPublicKey', { identityKey: true })
 * // On teardown:
 * client.destroy()
 * ```
 */
export class WalletRelayClient {
  private readonly _apiUrl: string
  private readonly _pollInterval: number
  private readonly _connectedPollInterval: number
  private readonly _persistSession: boolean
  private readonly _storageKey: string
  private readonly _sessionStorageTtl: number
  private readonly _onSessionChange?: (session: SessionInfo) => void
  private readonly _onLogChange?: (log: RequestLogEntry[]) => void
  private readonly _onError?: (error: string) => void

  private _session: SessionInfo | null = null
  private _desktopToken: string | null = null
  private _log: RequestLogEntry[] = []
  private _error: string | null = null
  private _pollTimer: ReturnType<typeof setInterval> | null = null
  private _expiredCount = 0
  private _walletProxy: Pick<WalletInterface, WalletMethodName> | null = null

  constructor(options?: WalletRelayClientOptions) {
    const raw = (options?.apiUrl ?? '/api').replace(/\/$/, '')
    this._apiUrl = raw.endsWith('/api') ? raw : `${raw}/api`
    this._pollInterval = options?.pollInterval ?? 3000
    this._connectedPollInterval = options?.connectedPollInterval ?? 10000
    this._persistSession = options?.persistSession ?? true
    this._storageKey = options?.sessionStorageKey ?? `wallet-relay-session:${this._apiUrl}`
    this._sessionStorageTtl = options?.sessionStorageTtl ?? 24 * 60 * 60 * 1000
    this._onSessionChange = options?.onSessionChange
    this._onLogChange = options?.onLogChange
    this._onError = options?.onError
  }

  get session(): SessionInfo | null { return this._session }
  get log(): RequestLogEntry[] { return this._log }
  get error(): string | null { return this._error }

  /**
   * A wallet-interface-compatible proxy that forwards each method call to the
   * connected mobile wallet via the relay. Drop this in anywhere a `WalletClient`
   * is expected — no conditional code paths needed at call sites.
   *
   * ```ts
   * const wallet = client.wallet
   * const { publicKey } = await wallet.getPublicKey({ identityKey: true })
   * const { certificates } = await wallet.listCertificates({ certifiers: [...] })
   * ```
   *
   * Throws if no session is active or if the mobile returns an error.
   * The proxy is created once and reused across calls.
   */
  get wallet(): Pick<WalletInterface, WalletMethodName> {
    if (!this._walletProxy) {
      const entries = WALLET_METHOD_NAMES.map(method => [
        method,
        (params: unknown): Promise<unknown> =>
          this.sendRequest(method, params).then(res => {
            if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code })
            return res.result
          }),
      ])
      this._walletProxy = Object.fromEntries(entries) as unknown as Pick<WalletInterface, WalletMethodName>
    }
    return this._walletProxy!
  }

  /**
   * Attempt to resume a previously persisted session from sessionStorage.
   * Verifies the session is still alive on the server and restarts polling.
   * Returns the resumed SessionInfo, or null if nothing to resume or session expired.
   *
   * Call this before `createSession()` when you want to survive page refreshes:
   * ```ts
   * const session = await client.resumeSession() ?? await client.createSession()
   * ```
   */
  async resumeSession(): Promise<SessionInfo | null> {
    const stored = this._loadFromStorage()
    if (!stored) return null

    try {
      const res = await fetch(`${this._apiUrl}/session/${stored.sessionId}`)
      if (!res.ok) { this._clearStorage(); return null }
      const data = (await res.json()) as SessionInfo
      if (data.status === 'expired') { this._clearStorage(); return null }

      this._desktopToken = stored.desktopToken
      // Merge stored QR data (not returned by status polls) back into session
      const session: SessionInfo = { ...data, qrDataUrl: stored.qrDataUrl, pairingUri: stored.pairingUri }
      this._setSession(session)
      const interval = data.status === 'connected' ? this._connectedPollInterval : this._pollInterval
      this._startPolling(stored.sessionId, interval)
      return session
    } catch {
      return null
    }
  }

  /**
   * Create a new pairing session and start polling for status changes.
   * Any previously active poll loop is stopped and replaced.
   */
  async createSession(): Promise<SessionInfo> {
    this._stopPolling()
    this._expiredCount = 0
    this._error = null
    this._desktopToken = null
    this._clearStorage()

    try {
      const res = await fetch(`${this._apiUrl}/session`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as SessionInfo
      this._desktopToken = data.desktopToken ?? null
      this._setSession(data)
      this._startPolling(data.sessionId)
      return data
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create session'
      this._error = msg
      this._onError?.(msg)
      throw new Error(msg)
    }
  }

  /**
   * Send an RPC request to the connected mobile wallet.
   * Appends the request (and eventually its response) to the log.
   * Throws if there is no active session.
   */
  async sendRequest(method: WalletMethodName, params: unknown = {}): Promise<WalletResponse> {
    if (!this._session) throw new WalletRelayError('No active session', 'SESSION_NOT_CONNECTED')

    const requestId = crypto.randomUUID()
    const request: WalletRequest = { requestId, method, params, timestamp: Date.now() }
    this._addLogEntry({ request, pending: true })

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this._desktopToken) headers['X-Desktop-Token'] = this._desktopToken
      const res = await fetch(`${this._apiUrl}/request/${this._session.sessionId}`, {
        method:  'POST',
        headers,
        body:    JSON.stringify({ method, params }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        const msg = body.error ?? `HTTP ${res.status}`
        let code: WalletRelayErrorCode
        switch (res.status) {
          case 401:  code = 'INVALID_TOKEN'; break
          case 400:  code = 'SESSION_NOT_CONNECTED'; break
          case 504:  code = msg.toLowerCase().includes('disconnect') ? 'SESSION_DISCONNECTED' : 'REQUEST_TIMEOUT'; break
          default:   code = 'NETWORK_ERROR'
        }
        throw new WalletRelayError(msg, code)
      }

      const rpc = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
      const response: WalletResponse = {
        requestId,
        result:    rpc.result,
        error:     rpc.error,
        timestamp: Date.now(),
      }
      this._resolveLogEntry(requestId, response)
      return response
    } catch (err) {
      const relayErr = err instanceof WalletRelayError
        ? err
        : new WalletRelayError(err instanceof Error ? err.message : 'Request failed', 'NETWORK_ERROR')
      this._resolveLogEntry(requestId, {
        requestId,
        error:     { code: 500, message: relayErr.message },
        timestamp: Date.now(),
      })
      throw relayErr
    }
  }

  /** Stop polling and clean up resources. Call this on component unmount. */
  destroy(): void {
    this._stopPolling()
    this._desktopToken = null
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _startPolling(sessionId: string, interval = this._pollInterval): void {
    // Two consecutive 'expired' polls required — the backend grace window means
    // a session at the 120 s boundary can still flip to 'connected' first.
    this._pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${this._apiUrl}/session/${sessionId}`)
        if (!res.ok) return
        const prevStatus = this._session?.status
        const updated = (await res.json()) as SessionInfo
        this._setSession({ ...this._session!, ...updated })
        if (updated.status === 'expired') {
          if (++this._expiredCount >= 2) { this._stopPolling(); this._clearStorage() }
        } else {
          this._expiredCount = 0
          // Slow down once connected; speed back up if mobile disconnects
          if (updated.status === 'connected' && prevStatus !== 'connected') {
            this._stopPolling()
            this._startPolling(sessionId, this._connectedPollInterval)
          } else if (updated.status === 'disconnected' && prevStatus === 'connected') {
            this._stopPolling()
            this._startPolling(sessionId, this._pollInterval)
          }
        }
      } catch {
        // Ignore transient network errors — next poll will retry
      }
    }, interval)
  }

  private _stopPolling(): void {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  }

  private _setSession(session: SessionInfo): void {
    this._session = session
    this._saveToStorage()
    this._onSessionChange?.(session)
  }

  private _saveToStorage(): void {
    if (!this._persistSession || !this._session) return
    try {
      const entry: PersistedSession = {
        sessionId:    this._session.sessionId,
        desktopToken: this._desktopToken ?? '',
        qrDataUrl:    this._session.qrDataUrl,
        pairingUri:   this._session.pairingUri,
        status:       this._session.status,
        savedAt:      Date.now(),
      }
      sessionStorage.setItem(this._storageKey, JSON.stringify(entry))
    } catch { /* SSR or storage unavailable */ }
  }

  private _clearStorage(): void {
    try { sessionStorage.removeItem(this._storageKey) } catch {}
  }

  private _loadFromStorage(): PersistedSession | null {
    try {
      const raw = sessionStorage.getItem(this._storageKey)
      if (!raw) return null
      const entry = JSON.parse(raw) as PersistedSession
      if (Date.now() - entry.savedAt > this._sessionStorageTtl) {
        this._clearStorage()
        return null
      }
      return entry
    } catch { return null }
  }

  private _addLogEntry(entry: RequestLogEntry): void {
    this._log = [entry, ...this._log]
    this._onLogChange?.(this._log)
  }

  private _resolveLogEntry(requestId: string, response: WalletResponse): void {
    this._log = this._log.map(e =>
      e.request.requestId === requestId ? { ...e, response, pending: false } : e
    )
    this._onLogChange?.(this._log)
  }
}
