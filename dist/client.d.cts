import { g as WalletMethodName, c as WalletLike, d as PairingParams } from './types-Vae71cT7.cjs';
export { P as PROTOCOL_ID, e as ParseResult, h as RequestLogEntry, R as RpcRequest, b as RpcResponse, f as SessionInfo, a as SessionStatus, i as WALLET_METHOD_NAMES, j as WalletRequest, k as WalletResponse, W as WireEnvelope } from './types-Vae71cT7.cjs';
export { W as WalletRelayClient, a as WalletRelayClientOptions, b as WalletRelayError, c as WalletRelayErrorCode } from './WalletRelayClient-Dq8nY-qx.cjs';
export { C as CryptoParams, D as DEFAULT_ACCEPTED_SCHEMAS, b as base64urlToBytes, c as bytesToBase64url, d as decryptEnvelope, e as encryptEnvelope, p as parsePairingUri } from './encoding-BMfacFGz.cjs';
import '@bsv/sdk';

type PairingSessionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
/**
 * The wallet methods implemented by the BSV Browser mobile app.
 * Used as the default for `WalletPairingSessionOptions.implementedMethods`.
 */
declare const DEFAULT_IMPLEMENTED_METHODS: ReadonlySet<WalletMethodName>;
/**
 * Methods approved without user interaction by default.
 * Used as the default for `WalletPairingSessionOptions.autoApproveMethods`.
 */
declare const DEFAULT_AUTO_APPROVE_METHODS: ReadonlySet<WalletMethodName>;
/** Return a result or an error string — used for the onRequest handler. */
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
interface WalletPairingSessionOptions {
    /**
     * Methods your handler actually implements.
     * Requests for any other method receive a 501 without invoking onRequest or onApprovalRequired.
     * Defaults to {@link DEFAULT_IMPLEMENTED_METHODS} (the full BSV Browser method set).
     */
    implementedMethods?: ReadonlySet<string>;
    /**
     * Subset of implementedMethods that are executed without calling onApprovalRequired.
     * Defaults to {@link DEFAULT_AUTO_APPROVE_METHODS} (`getPublicKey` only).
     */
    autoApproveMethods?: ReadonlySet<string>;
    /**
     * Called for every implemented method that is not in autoApproveMethods.
     * Return true to approve, false to send a 4001 User Rejected response.
     * If omitted, all implemented methods are auto-approved.
     */
    onApprovalRequired?: (method: string, params: unknown) => Promise<boolean>;
    /**
     * Additional metadata sent inside the pairing_approved inner payload.
     * Useful for identifying the wallet to the desktop.
     */
    walletMeta?: Record<string, unknown>;
}
/**
 * Manages the full mobile-side WS pairing lifecycle:
 *   1. Connects to the relay as `role=mobile`
 *   2. Encrypts and sends `pairing_approved`
 *   3. Decrypts inbound messages with replay-protection (seq tracking)
 *   4. Transitions to `connected` on the first successfully decrypted message
 *   5. Dispatches RPC requests through the registered handler
 *   6. Handles `pairing_ack` (no-op — just confirms the session is live)
 *
 * Fresh pairing:
 * ```ts
 * const session = new WalletPairingSession(wallet, pairingParams, {
 *   implementedMethods: new Set(['getPublicKey', 'listOutputs']),
 *   autoApproveMethods: new Set(['getPublicKey']),
 *   onApprovalRequired: async (method, params) => await showApprovalModal(method, params),
 * })
 *
 * session.onRequest(async (method, params) => wallet[method](params))
 * session.on('connected', () => ...).on('disconnected', () => ...).on('error', msg => ...)
 * await session.connect()
 * ```
 *
 * Resuming a previous session (e.g. after network drop):
 * ```ts
 * const lastSeq = await SecureStore.getItemAsync(`lastseq_${topic}`)
 * await session.reconnect(Number(lastSeq))
 * ```
 */
declare class WalletPairingSession {
    private wallet;
    private params;
    private options;
    private ws;
    private _status;
    private connected;
    private _lastSeq;
    private _resolvedRelay;
    private protocolID;
    private mobileIdentityKey;
    private requestHandler;
    private readonly implementedMethods;
    private readonly autoApproveMethods;
    private listeners;
    constructor(wallet: WalletLike, params: PairingParams, options?: WalletPairingSessionOptions);
    get status(): PairingSessionStatus;
    /**
     * The highest seq value received from the backend in this connection.
     * Persist this before disconnecting so you can pass it to `reconnect(lastSeq)`.
     *
     * ```ts
     * session.on('disconnected', () => {
     *   SecureStore.setItemAsync('lastseq_' + topic, String(session.lastSeq))
     * })
     * ```
     */
    get lastSeq(): number;
    on(event: 'connected', handler: () => void): this;
    on(event: 'disconnected', handler: () => void): this;
    on(event: 'error', handler: (msg: string) => void): this;
    /** Register the handler that executes approved RPC methods. */
    onRequest(handler: RequestHandler): this;
    /**
     * Fetch the relay WebSocket URL from the origin server.
     *
     * Must be called before `connect()`. Returns the relay URL so the app can
     * display it to the user for approval before proceeding.
     *
     * The fetch goes to `params.origin` over HTTPS — the origin's TLS certificate
     * is the trust anchor. Always show `params.origin` to the user before calling
     * this method so they can confirm they are connecting to the intended service.
     *
     * ```ts
     * const { params } = parsePairingUri(qrString)
     * // Show params.origin to the user and wait for approval, then:
     * const relay = await session.resolveRelay()
     * // Optionally show relay to the user, then:
     * await session.connect()
     * ```
     */
    resolveRelay(): Promise<string>;
    /**
     * Open the WebSocket connection and start a fresh pairing handshake.
     * Requires `resolveRelay()` to have been called first.
     */
    connect(): Promise<void>;
    /**
     * Re-open the WS connection using a stored seq baseline.
     * Replay protection resumes from `lastSeq` — messages with seq ≤ lastSeq are dropped.
     * Use this after a network drop when the session is still valid on the backend.
     * Requires `resolveRelay()` to have been called (relay URL is retained between calls).
     *
     * @param lastSeq - The highest seq received in the previous connection (from persistent storage).
     */
    reconnect(lastSeq: number): Promise<void>;
    /** Close the WebSocket connection. */
    disconnect(): void;
    private openConnection;
    private emitError;
    private handleRpc;
}

export { DEFAULT_AUTO_APPROVE_METHODS, DEFAULT_IMPLEMENTED_METHODS, PairingParams, type PairingSessionStatus, type RequestHandler, WalletLike, WalletMethodName, WalletPairingSession, type WalletPairingSessionOptions };
