import { c as WalletLike, d as PairingParams } from './encoding-DvYOfZYT.js';
export { C as CryptoParams, P as PROTOCOL_ID, e as ParseResult, R as RpcRequest, b as RpcResponse, f as SessionInfo, a as SessionStatus, W as WireEnvelope, g as base64urlToBytes, i as bytesToBase64url, j as decryptEnvelope, k as encryptEnvelope, p as parsePairingUri } from './encoding-DvYOfZYT.js';
import '@bsv/sdk';

type PairingSessionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
/** Return a result or an error string — used for the onRequest handler. */
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
interface WalletPairingSessionOptions {
    /**
     * Methods your handler actually implements.
     * Requests for any other method receive a 501 without invoking onRequest or onApprovalRequired.
     * If omitted, all methods are forwarded to onRequest.
     */
    implementedMethods?: Set<string>;
    /**
     * Subset of implementedMethods that are executed without calling onApprovalRequired.
     * Useful for read-only methods like getPublicKey.
     */
    autoApproveMethods?: Set<string>;
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
 * Usage:
 * ```ts
 * const session = new WalletPairingSession(wallet, pairingParams, {
 *   implementedMethods: new Set(['getPublicKey', 'listOutputs']),
 *   autoApproveMethods: new Set(['getPublicKey']),
 *   onApprovalRequired: async (method, params) => await showApprovalModal(method, params),
 * })
 *
 * session.onRequest(async (method, params) => {
 *   return await wallet[method](params)
 * })
 *
 * session
 *   .on('connected',    () => setStatus('connected'))
 *   .on('disconnected', () => setStatus('disconnected'))
 *   .on('error',        msg => setError(msg))
 *
 * await session.connect()
 * ```
 */
declare class WalletPairingSession {
    private wallet;
    private params;
    private options;
    private ws;
    private _status;
    private connected;
    private lastSeq;
    private protocolID;
    private mobileIdentityKey;
    private requestHandler;
    private listeners;
    constructor(wallet: WalletLike, params: PairingParams, options?: WalletPairingSessionOptions);
    get status(): PairingSessionStatus;
    on(event: 'connected', handler: () => void): this;
    on(event: 'disconnected', handler: () => void): this;
    on(event: 'error', handler: (msg: string) => void): this;
    /** Register the handler that executes approved RPC methods. */
    onRequest(handler: RequestHandler): this;
    /** Open the WS connection and send pairing_approved. */
    connect(): Promise<void>;
    /** Close the WebSocket connection. */
    disconnect(): void;
    private emitError;
    private handleRpc;
}

export { PairingParams, type PairingSessionStatus, type RequestHandler, WalletPairingSession, type WalletPairingSessionOptions };
