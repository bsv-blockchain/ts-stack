import { WalletInterface } from '@bsv/sdk';
import { f as SessionInfo, h as RequestLogEntry, g as WalletMethodName, k as WalletResponse } from './types-Vae71cT7.js';

interface WalletRelayClientOptions {
    /**
     * Base URL for the relay API. Can be the bare host (`http://localhost:3001`)
     * or include the `/api` prefix — `/api` is appended automatically if missing.
     * Default: '/api'
     */
    apiUrl?: string;
    /** Session status polling interval in ms while waiting for mobile to connect. Default: 3000 */
    pollInterval?: number;
    /** Session status polling interval in ms once the mobile is connected. Default: 10000 */
    connectedPollInterval?: number;
    /**
     * Persist the active session to sessionStorage so a page refresh resumes the
     * existing session rather than creating a new one. Default: true.
     * Disable if you want every mount to start a fresh session.
     */
    persistSession?: boolean;
    /**
     * sessionStorage key used to store the session. Defaults to a key namespaced
     * by apiUrl so multiple relay instances on the same page don't collide.
     */
    sessionStorageKey?: string;
    /**
     * How long a persisted session is considered resumable (ms). After this
     * the stored entry is discarded without a network request. Default: 86400000 (24 h).
     * The server is still the authority — an expired server session is detected on
     * the first poll and cleared regardless of this value.
     */
    sessionStorageTtl?: number;
    /** Called whenever the session state changes (including on creation). */
    onSessionChange?: (session: SessionInfo) => void;
    /** Called when the request log changes. */
    onLogChange?: (log: RequestLogEntry[]) => void;
    /** Called when an error occurs during session creation. */
    onError?: (error: string) => void;
}
type WalletRelayErrorCode = 'SESSION_NOT_CONNECTED' | 'REQUEST_TIMEOUT' | 'SESSION_DISCONNECTED' | 'INVALID_TOKEN' | 'NETWORK_ERROR';
declare class WalletRelayError extends Error {
    readonly code: WalletRelayErrorCode;
    constructor(message: string, code: WalletRelayErrorCode);
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
declare class WalletRelayClient {
    private readonly _apiUrl;
    private readonly _pollInterval;
    private readonly _connectedPollInterval;
    private readonly _persistSession;
    private readonly _storageKey;
    private readonly _sessionStorageTtl;
    private readonly _onSessionChange?;
    private readonly _onLogChange?;
    private readonly _onError?;
    private _session;
    private _desktopToken;
    private _log;
    private _error;
    private _pollTimer;
    private _expiredCount;
    private _walletProxy;
    constructor(options?: WalletRelayClientOptions);
    get session(): SessionInfo | null;
    get log(): RequestLogEntry[];
    get error(): string | null;
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
    get wallet(): Pick<WalletInterface, WalletMethodName>;
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
    resumeSession(): Promise<SessionInfo | null>;
    /**
     * Create a new pairing session and start polling for status changes.
     * Any previously active poll loop is stopped and replaced.
     */
    createSession(): Promise<SessionInfo>;
    /**
     * Send an RPC request to the connected mobile wallet.
     * Appends the request (and eventually its response) to the log.
     * Throws if there is no active session.
     */
    sendRequest(method: WalletMethodName, params?: unknown): Promise<WalletResponse>;
    /** Stop polling and clean up resources. Call this on component unmount. */
    destroy(): void;
    private _startPolling;
    private _stopPolling;
    private _setSession;
    private _saveToStorage;
    private _clearStorage;
    private _loadFromStorage;
    private _addLogEntry;
    private _resolveLogEntry;
}

export { WalletRelayClient as W, type WalletRelayClientOptions as a, WalletRelayError as b, type WalletRelayErrorCode as c };
