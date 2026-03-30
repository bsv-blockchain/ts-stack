import { f as SessionInfo, h as RequestLogEntry, g as WalletMethodName, j as WalletResponse } from './types-UY3FlsXl.cjs';

interface WalletRelayClientOptions {
    /** Base URL for the relay API. Default: '/api' */
    apiUrl?: string;
    /** Session status polling interval in ms. Default: 3000 */
    pollInterval?: number;
    /** Called whenever the session state changes (including on creation). */
    onSessionChange?: (session: SessionInfo) => void;
    /** Called when the request log changes. */
    onLogChange?: (log: RequestLogEntry[]) => void;
    /** Called when an error occurs during session creation. */
    onError?: (error: string) => void;
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
    private readonly _onSessionChange?;
    private readonly _onLogChange?;
    private readonly _onError?;
    private _session;
    private _log;
    private _error;
    private _pollTimer;
    private _expiredCount;
    constructor(options?: WalletRelayClientOptions);
    get session(): SessionInfo | null;
    get log(): RequestLogEntry[];
    get error(): string | null;
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
    private _addLogEntry;
    private _resolveLogEntry;
}

export { WalletRelayClient as W, type WalletRelayClientOptions as a };
