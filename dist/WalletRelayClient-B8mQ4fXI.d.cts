import { WalletInterface } from '@bsv/sdk';
import { f as SessionInfo, h as RequestLogEntry, g as WalletMethodName, k as WalletResponse } from './types-ClLaGPT6.cjs';

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
    private readonly _connectedPollInterval;
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
