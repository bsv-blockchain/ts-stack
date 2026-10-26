import {
  normalizeBRC100WalletByteFields,
  stringifyBRC100
} from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { validateWalletArgs } from '@bsv/sdk/wallet/WalletArgumentValidation'
import { validateWalletResult } from '@bsv/sdk/wallet/WalletResultValidation'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import type {
  SessionInfo,
  WalletRequest,
  WalletResponse,
  RequestLogEntry,
  WalletMethodName
} from '../types.js'
import { WALLET_METHOD_NAMES } from '../types.js'
import {
  fetchBoundedJson,
  parseRpcMessage,
  plainTransportRejection,
  requireBoundedString,
  requireDesktopToken,
  requireOptionalBoolean,
  requirePairingUri,
  requirePlainRecord,
  requireQrDataUrl,
  requireSessionId,
  validateSessionInfo
} from '../shared/validation.js'

export interface WalletRelayClientOptions {
  /**
   * Base URL for the relay API. Absolute URLs require HTTPS except on loopback
   * (or private-network IP addresses with `allowLocalNetworkHttp`); same-origin
   * root-relative paths are also accepted. The URL can include the
   * `/api` prefix — `/api` is appended automatically if missing.
   * Default: '/api'
   */
  apiUrl?: string
  /**
   * Accept an `http://` apiUrl on a private-network IP address (10.0.0.0/8,
   * 172.16.0.0/12, 192.168.0.0/16, fc00::/7) and a `ws://` relay URL on one in
   * session responses, for same-LAN development. Set it whenever the backend
   * runs with `allowLocalNetworkHttp`. Over HTTP the desktop token and wallet
   * RPC payloads travel in cleartext; never enable it in production.
   * Default: false.
   */
  allowLocalNetworkHttp?: boolean
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
  /** Maximum in-memory request-log entries. Set 0 to disable retention. Default: 100. */
  maxLogEntries?: number
  /**
   * Called when session creation fails, or when a resumed or polled session
   * response fails validation (polling stops). Transient poll network errors
   * are retried silently.
   */
  onError?: (error: string) => void
}

export type WalletRelayErrorCode =
  | 'SESSION_NOT_CONNECTED' // no active session or session not in connected state
  | 'REQUEST_TIMEOUT' // mobile did not respond within 30 s
  | 'SESSION_DISCONNECTED' // mobile dropped while the request was in-flight
  | 'INVALID_TOKEN' // desktopToken mismatch — likely a client config issue
  | 'REQUEST_CANCELLED' // lifecycle changed while session creation was in flight
  | 'NETWORK_ERROR' // fetch failed or unexpected HTTP error

export class WalletRelayError extends Error {
  constructor(
    message: string,
    public readonly code: WalletRelayErrorCode
  ) {
    super(message)
    this.name = 'WalletRelayError'
  }
}

interface PersistedSession {
  sessionId: string
  desktopToken: string
  qrDataUrl?: string
  pairingUri?: string
  status: string
  savedAt: number
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

function normalizeRelayApiUrl(apiUrl: string, allowLocalNetworkHttp: boolean): string {
  let normalized: string
  if (apiUrl.startsWith('/') && !apiUrl.startsWith('//')) {
    if (apiUrl.includes('\\') || apiUrl.includes('?') || apiUrl.includes('#')) {
      throw new TypeError('Relay API path cannot include backslashes, query, or fragment.')
    }
    normalized = trimTrailingSlashes(apiUrl)
  } else {
    let parsed: URL
    try {
      parsed = new URL(apiUrl)
    } catch {
      throw new TypeError('Relay API URL must be absolute or a root-relative path.')
    }
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new TypeError('Relay API URL cannot include credentials, query, or fragment.')
    }
    const rejection = plainTransportRejection(parsed, 'https:', allowLocalNetworkHttp, true)
    if (rejection !== null) throw new TypeError(`Relay API URL requires ${rejection}.`)
    parsed.pathname = trimTrailingSlashes(parsed.pathname)
    normalized = trimTrailingSlashes(parsed.toString())
  }
  return normalized.endsWith('/api') ? normalized : `${normalized}/api`
}

function boundedInterval(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 10 || resolved > 24 * 60 * 60 * 1_000) {
    throw new RangeError(`${name} must be an integer from 10 to 86400000 ms`)
  }
  return resolved
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
  /** Transport policy for session responses; errors name `allowLocalNetworkHttp`. */
  private readonly _transport: { allowLocalNetworkHttp: boolean; developerHint: boolean }
  private readonly _pollInterval: number
  private readonly _connectedPollInterval: number
  private readonly _persistSession: boolean
  private readonly _storageKey: string
  private readonly _sessionStorageTtl: number
  private readonly _onSessionChange?: (session: SessionInfo) => void
  private readonly _onLogChange?: (log: RequestLogEntry[]) => void
  private readonly _onError?: (error: string) => void
  private readonly _maxLogEntries: number

  private _session: SessionInfo | null = null
  private _desktopToken: string | null = null
  private _log: RequestLogEntry[] = []
  private _error: string | null = null
  private _pollTimer: ReturnType<typeof setInterval> | null = null
  private _pollInFlight = false
  private _pollEpoch = 0
  private _lifecycleEpoch = 0
  private _expiredCount = 0
  private _walletProxy: Pick<WalletInterface, WalletMethodName> | null = null

  constructor(options?: WalletRelayClientOptions) {
    const allowLocalNetworkHttp = requireOptionalBoolean(
      options?.allowLocalNetworkHttp,
      'allowLocalNetworkHttp'
    )
    this._transport = { allowLocalNetworkHttp, developerHint: true }
    this._apiUrl = normalizeRelayApiUrl(options?.apiUrl ?? '/api', allowLocalNetworkHttp)
    this._pollInterval = boundedInterval(options?.pollInterval, 3000, 'pollInterval')
    this._connectedPollInterval = boundedInterval(
      options?.connectedPollInterval,
      10000,
      'connectedPollInterval'
    )
    this._persistSession = options?.persistSession ?? true
    this._storageKey = options?.sessionStorageKey ?? `wallet-relay-session:${this._apiUrl}`
    this._sessionStorageTtl = boundedInterval(
      options?.sessionStorageTtl,
      24 * 60 * 60 * 1000,
      'sessionStorageTtl'
    )
    this._onSessionChange = options?.onSessionChange
    this._onLogChange = options?.onLogChange
    this._onError = options?.onError
    this._maxLogEntries = options?.maxLogEntries ?? 100
    if (
      !Number.isSafeInteger(this._maxLogEntries) ||
      this._maxLogEntries < 0 ||
      this._maxLogEntries > 10_000
    ) {
      throw new RangeError('maxLogEntries must be an integer from 0 to 10000')
    }
  }

  get session(): SessionInfo | null {
    return this._session
  }
  get log(): RequestLogEntry[] {
    return [...this._log]
  }
  get error(): string | null {
    return this._error
  }

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
            if (res.error)
              throw Object.assign(new Error(res.error.message), { code: res.error.code })
            return res.result
          })
      ])
      this._walletProxy = Object.fromEntries(entries) as unknown as Pick<
        WalletInterface,
        WalletMethodName
      >
    }
    return this._walletProxy
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
    const epoch = ++this._lifecycleEpoch

    try {
      const { response, value } = await fetchBoundedJson(
        `${this._apiUrl}/session/${stored.sessionId}`,
        { cache: 'no-store' },
        'wallet relay session response'
      )
      // A newer lifecycle owns the session and its storage; touch neither.
      if (epoch !== this._lifecycleEpoch) return null
      if (!response.ok) {
        this._clearStorage()
        return null
      }
      let data: SessionInfo
      try {
        data = validateSessionInfo(value, {
          ...this._transport,
          expectedId: stored.sessionId
        })
      } catch (err) {
        // A response this client rejects will not change on retry.
        this._clearStorage()
        this._reportError(err)
        return null
      }
      if (data.status === 'expired') {
        this._clearStorage()
        return null
      }

      this._desktopToken = stored.desktopToken
      // Merge stored QR data (not returned by status polls) back into session
      const session: SessionInfo = {
        ...data,
        qrDataUrl: stored.qrDataUrl,
        pairingUri: stored.pairingUri
      }
      this._setSession(session)
      const interval =
        data.status === 'connected' ? this._connectedPollInterval : this._pollInterval
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
    const epoch = ++this._lifecycleEpoch
    this._expiredCount = 0
    this._error = null
    this._desktopToken = null
    this._clearStorage()

    try {
      const { response, value } = await fetchBoundedJson(
        `${this._apiUrl}/session`,
        { cache: 'no-store' },
        'wallet relay session response'
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = validateSessionInfo(value, {
        ...this._transport,
        requireCreationSecrets: true
      })
      if (epoch !== this._lifecycleEpoch) {
        void this._retireCreatedSession(data)
        throw new WalletRelayError('Session creation was cancelled', 'REQUEST_CANCELLED')
      }
      this._desktopToken = data.desktopToken ?? null
      this._setSession(data)
      this._startPolling(data.sessionId)
      return data
    } catch (err) {
      if (err instanceof WalletRelayError && err.code === 'REQUEST_CANCELLED') throw err
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
    if (!(WALLET_METHOD_NAMES as readonly string[]).includes(method)) {
      throw new TypeError('Unsupported wallet relay method')
    }
    validateWalletArgs(method, params)

    const requestId = crypto.randomUUID()
    const request: WalletRequest = { requestId, method, params, timestamp: Date.now() }
    this._addLogEntry({ request, pending: true })

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this._desktopToken) headers['X-Desktop-Token'] = this._desktopToken
      const { response: res, value } = await fetchBoundedJson(
        `${this._apiUrl}/request/${this._session.sessionId}`,
        {
          method: 'POST',
          headers,
          body: stringifyBRC100({ method, params })
        },
        'wallet relay RPC response'
      )

      if (!res.ok) {
        const body =
          value == null || typeof value !== 'object' || Array.isArray(value)
            ? {}
            : (value as { error?: unknown })
        const msg =
          typeof body.error === 'string' && body.error.length <= 1_000
            ? body.error
            : `HTTP ${res.status}`
        let code: WalletRelayErrorCode
        switch (res.status) {
          case 401:
            code = 'INVALID_TOKEN'
            break
          case 400:
            code = 'SESSION_NOT_CONNECTED'
            break
          case 504:
            code = msg.toLowerCase().includes('disconnect')
              ? 'SESSION_DISCONNECTED'
              : 'REQUEST_TIMEOUT'
            break
          default:
            code = 'NETWORK_ERROR'
        }
        throw new WalletRelayError(msg, code)
      }

      const rpc = parseRpcMessage(value)
      if ('method' in rpc)
        throw new TypeError('Wallet relay returned a request instead of a response')
      if (rpc.error !== undefined) {
        requireBoundedString(rpc.error.message, 'wallet relay error message', 1, 1_000)
      } else {
        normalizeBRC100WalletByteFields(rpc.result)
        rpc.result = validateWalletResult(method, rpc.result, params)
      }
      const response: WalletResponse = {
        requestId,
        result: rpc.result,
        error: rpc.error,
        timestamp: Date.now()
      }
      this._resolveLogEntry(requestId, response)
      return response
    } catch (err) {
      let relayErr: WalletRelayError
      if (err instanceof WalletRelayError) {
        relayErr = err
      } else {
        relayErr = new WalletRelayError(
          err instanceof Error ? err.message : 'Request failed',
          'NETWORK_ERROR'
        )
      }
      this._resolveLogEntry(requestId, {
        requestId,
        error: { code: 500, message: relayErr.message },
        timestamp: Date.now()
      })
      throw relayErr
    }
  }

  /**
   * Terminate the session server-side (closes the mobile's WebSocket, marks session
   * expired), then clean up locally. Fire-and-forget safe — errors are swallowed so
   * local teardown always completes.
   *
   * Prefer this over `destroy()` when you want the mobile app to be notified.
   */
  async disconnect(): Promise<void> {
    this._lifecycleEpoch += 1
    this._stopPolling()
    if (this._session?.sessionId && this._desktopToken) {
      try {
        await fetchBoundedJson(
          `${this._apiUrl}/session/${this._session.sessionId}`,
          {
            method: 'DELETE',
            headers: { 'X-Desktop-Token': this._desktopToken }
          },
          'wallet relay disconnect response'
        )
      } catch {
        /* ignore — local teardown proceeds regardless */
      }
    }
    this._desktopToken = null
    this._session = null
    this._clearStorage()
  }

  /** Stop polling and clean up resources. Call this on component unmount. */
  destroy(): void {
    this._lifecycleEpoch += 1
    this._stopPolling()
    this._desktopToken = null
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _startPolling(sessionId: string, interval = this._pollInterval): void {
    // Two consecutive 'expired' polls required — the backend grace window means
    // a session at the 120 s boundary can still flip to 'connected' first.
    const epoch = ++this._pollEpoch
    this._pollTimer = setInterval(async () => {
      if (this._pollInFlight) return
      this._pollInFlight = true
      try {
        const { response, value } = await fetchBoundedJson(
          `${this._apiUrl}/session/${sessionId}`,
          { cache: 'no-store' },
          'wallet relay session response'
        )
        if (epoch !== this._pollEpoch) return
        if (!response.ok) return
        const prevStatus = this._session?.status
        let updated: SessionInfo
        try {
          updated = validateSessionInfo(value, {
            ...this._transport,
            expectedId: sessionId
          })
        } catch (err) {
          // A response this client rejects will not change on retry.
          this._stopPolling()
          this._reportError(err)
          return
        }
        this._setSession({ ...this._session!, ...updated })
        if (updated.status === 'expired') {
          if (++this._expiredCount >= 2) {
            this._stopPolling()
            this._clearStorage()
          }
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
      } finally {
        this._pollInFlight = false
      }
    }, interval)
  }

  private async _retireCreatedSession(session: SessionInfo): Promise<void> {
    if (session.desktopToken === undefined) return
    try {
      await fetchBoundedJson(
        `${this._apiUrl}/session/${session.sessionId}`,
        {
          method: 'DELETE',
          headers: { 'X-Desktop-Token': session.desktopToken }
        },
        'wallet relay cancelled-session response'
      )
    } catch {
      // Best effort: the server's short pending-session TTL remains the fallback.
    }
  }

  private _reportError(err: unknown): void {
    this._error = err instanceof Error ? err.message : 'Invalid session response'
    this._onError?.(this._error)
  }

  private _stopPolling(): void {
    this._pollEpoch += 1
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
        sessionId: this._session.sessionId,
        desktopToken: this._desktopToken ?? '',
        qrDataUrl: this._session.qrDataUrl,
        pairingUri: this._session.pairingUri,
        status: this._session.status,
        savedAt: Date.now()
      }
      sessionStorage.setItem(this._storageKey, stringifyBRC100(entry))
    } catch {
      /* SSR or storage unavailable */
    }
  }

  private _clearStorage(): void {
    try {
      sessionStorage.removeItem(this._storageKey)
    } catch {}
  }

  private _loadFromStorage(): PersistedSession | null {
    try {
      const raw = sessionStorage.getItem(this._storageKey)
      if (!raw) return null
      const value = requirePlainRecord(JSON.parse(raw), 'persisted wallet relay session')
      const entry: PersistedSession = {
        sessionId: requireSessionId(value.sessionId),
        desktopToken: requireDesktopToken(value.desktopToken),
        status: requireBoundedString(value.status, 'persisted session status', 1, 20),
        savedAt: value.savedAt as number,
        ...(value.qrDataUrl === undefined
          ? {}
          : { qrDataUrl: requireQrDataUrl(value.qrDataUrl, 'persisted QR data URL') }),
        ...(value.pairingUri === undefined
          ? {}
          : { pairingUri: requirePairingUri(value.pairingUri, 'persisted pairing URI') })
      }
      if (!Number.isSafeInteger(entry.savedAt) || entry.savedAt < 0 || entry.savedAt > Date.now()) {
        this._clearStorage()
        return null
      }
      if (Date.now() - entry.savedAt > this._sessionStorageTtl) {
        this._clearStorage()
        return null
      }
      return entry
    } catch {
      this._clearStorage()
      return null
    }
  }

  private _addLogEntry(entry: RequestLogEntry): void {
    this._log = this._maxLogEntries === 0 ? [] : [entry, ...this._log].slice(0, this._maxLogEntries)
    this._onLogChange?.([...this._log])
  }

  private _resolveLogEntry(requestId: string, response: WalletResponse): void {
    this._log = this._log.map(e =>
      e.request.requestId === requestId ? { ...e, response, pending: false } : e
    )
    this._onLogChange?.([...this._log])
  }
}
