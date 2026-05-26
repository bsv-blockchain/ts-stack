import type { Request, Response } from 'express';
import type { Server } from 'node:http';
/**
 * Minimal Express-compatible router interface.
 * Using a structural duck-type instead of the nominal `Express` type avoids
 * conflicts in monorepos where two separate node_modules trees resolve different
 * copies of @types/express-serve-static-core.
 */
type RouterLike = {
    get(path: string, handler: (req: Request, res: Response) => void): unknown;
    post(path: string, handler: (req: Request, res: Response) => void): unknown;
    delete(path: string, handler: (req: Request, res: Response) => void): unknown;
};
import type { WalletLike, RpcResponse } from '../types.js';
import { type AllowedOrigins } from '../shared/originMatcher.js';
export interface WalletRelayServiceOptions {
    /**
     * Express app — when provided, REST routes are registered automatically.
     * Omit when using Next.js (or any other framework): call createSession(),
     * getSession(), and sendRequest() from your own route handlers instead.
     */
    app?: RouterLike;
    /** HTTP server — WebSocket upgrade handler is attached here. */
    server: Server;
    /**
     * Backend wallet used to encrypt/decrypt messages with mobile.
     * Use `ProtoWallet` with a private key stored in an environment variable:
     * ```ts
     * import { ProtoWallet, PrivateKey } from '@bsv/sdk'
     * wallet: new ProtoWallet(PrivateKey.fromWif(process.env['WALLET_WIF']!))
     * ```
     * The same key must be used across restarts — the mobile's ECDH shared secret
     * is derived from the backend's identity key embedded in the QR code.
     */
    wallet: WalletLike;
    /**
     * ws(s):// base URL of this server — embedded in the QR pairing URI.
     * Defaults to the `RELAY_URL` environment variable, then `ws://localhost:3000`.
     */
    relayUrl?: string;
    /**
     * Default http(s):// URL of the desktop frontend — embedded in the QR pairing
     * URI when `createSession()` is called without a per-session origin override.
     * Defaults to the `ORIGIN` environment variable, then `http://localhost:5173`.
     *
     * For multi-app deployments (one relay shared by N webapps) leave this unset
     * or set it to a sensible fallback, and pass `origin` per-call to
     * `createSession({ origin })` instead. Use `allowedOrigins` to restrict which
     * origins are accepted.
     */
    origin?: string;
    /**
     * Origin allowlist — controls (a) which origins may be claimed by callers of
     * `createSession({ origin })`, and (b) which browser origins may open a
     * desktop-role WebSocket connection.
     *
     * Accepts a string, string[], RegExp, or predicate function. When unset, the
     * lib falls back to the single-value `origin` for backward compatibility with
     * the original API.
     */
    allowedOrigins?: AllowedOrigins;
    /** Called when a mobile completes pairing and the session transitions to 'connected'. */
    onSessionConnected?: (sessionId: string) => void;
    /** Called when a connected mobile disconnects (session transitions to 'disconnected'). */
    onSessionDisconnected?: (sessionId: string) => void;
    /**
     * Maximum number of sessions held in memory at once.
     * Requests for new sessions beyond this limit are rejected with HTTP 429.
     * Default: unlimited.
     */
    maxSessions?: number;
    /**
     * URI scheme used in the generated QR pairing URI (e.g. `'bsv-browser'`, `'my-app'`).
     * Defaults to `'bsv-browser'`. Must match the deep-link scheme registered by the
     * wallet app that will scan the QR code.
     */
    schema?: string;
    /**
     * Sign the QR pairing URI with the backend wallet key.
     * When `true` (the default), `createSession()` embeds a `sig` parameter in the
     * pairing URI; the mobile can call `verifyPairingSignature()` to authenticate
     * the QR before connecting.
     * Set to `false` to disable for testing or legacy compatibility.
     */
    signQrCodes?: boolean;
}
/**
 * High-level facade that wires together the relay, session manager,
 * and RPC handler into a ready-to-use WebSocket service.
 *
 * Express usage (routes registered automatically):
 * ```ts
 * const relay = new WalletRelayService({ app, server, wallet, relayUrl, origin })
 * ```
 *
 * Next.js / custom framework (omit `app`, call methods from your route handlers):
 * ```ts
 * const relay = new WalletRelayService({ server, wallet, relayUrl, origin })
 * // In GET    /api/session:        relay.createSession()
 * // In GET    /api/session/:id:    relay.getSession(id)
 * // In POST   /api/request/:id:   relay.sendRequest(id, method, params)
 * // In DELETE /api/session/:id:   relay.deleteSession(id, desktopToken)
 * ```
 *
 * Express auto-registered routes:
 *   GET    /api/session        — create session, return { sessionId, status, qrDataUrl }
 *   GET    /api/session/:id    — return { sessionId, status, relay }
 *   POST   /api/request/:id    — body { method, params } — relay to mobile, return RpcResponse
 *   DELETE /api/session/:id    — terminate session; closes mobile WebSocket, marks expired
 */
export declare class WalletRelayService {
    private readonly opts;
    private readonly sessions;
    private readonly relay;
    private readonly handler;
    private readonly pending;
    private readonly mobileAuthTimers;
    private wallet;
    private relayUrl;
    private origin;
    private schema;
    private signQrCodes;
    /** Compiled allowlist used for both per-session origin claims and WS upgrades. */
    private isOriginAllowed;
    constructor(opts: WalletRelayServiceOptions);
    /**
     * Create a session and return its QR data URL, pairing URI, and desktop token.
     *
     * Pass `options.origin` to embed a per-session origin in the QR (multi-app
     * deployments where the caller's URL — not the relay's — is the trust anchor).
     * When omitted, falls back to the constructor `origin`.
     *
     * If an allowlist is configured, the per-session origin must match — otherwise
     * a malicious caller could mint QRs claiming to be any domain.
     */
    createSession(options?: {
        origin?: string;
    }): Promise<{
        sessionId: string;
        status: string;
        qrDataUrl: string;
        pairingUri: string;
        desktopToken: string;
    }>;
    /** Return session status and relay URL, or null if not found. */
    getSession(id: string): {
        sessionId: string;
        status: string;
        relay: string;
    } | null;
    /**
     * Encrypt an RPC call, relay it to the mobile, and await the response.
     * Rejects if the session is not connected or if the mobile doesn't respond within 30 s.
     */
    sendRequest(sessionId: string, method: string, params: unknown, desktopToken?: string): Promise<RpcResponse>;
    /**
     * Terminate a session from the desktop side: closes the mobile's WebSocket,
     * rejects in-flight requests, and marks the session expired.
     * Throws if the session is not found or the token is invalid.
     */
    deleteSession(sessionId: string, desktopToken: string): void;
    /** Stop the GC timer, close the WebSocket server, and reject all in-flight requests. */
    stop(): void;
    /**
     * Reject all pending requests belonging to a session.
     * Pass null to reject every pending request (used on full shutdown).
     */
    private rejectPendingForSession;
    private registerRoutes;
    private handleMobileMessage;
    private handlePairingApproved;
}
export {};
//# sourceMappingURL=WalletRelayService.d.ts.map