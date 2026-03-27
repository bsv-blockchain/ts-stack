import { Server } from 'http';
import { W as WireEnvelope, S as Session, a as SessionStatus, R as RpcRequest, b as RpcResponse, c as WalletLike } from './encoding-DVjN4p5t.cjs';
export { C as CryptoParams, P as PROTOCOL_ID, d as PairingParams, e as ParseResult, f as SessionInfo, g as base64urlToBytes, h as buildPairingUri, i as bytesToBase64url, j as decryptEnvelope, k as encryptEnvelope, p as parsePairingUri } from './encoding-DVjN4p5t.cjs';
import { Express } from 'express';
import '@bsv/sdk';

type Role = 'desktop' | 'mobile';
type MessageHandler = (topic: string, envelope: WireEnvelope, role: Role) => void;
type TopicValidator = (topic: string) => boolean;
type TokenValidator = (topic: string, token: string | null) => boolean;
type ConnectHandler = (topic: string) => void;
type DisconnectHandler = (topic: string, role: Role) => void;
/**
 * Topic-keyed WebSocket relay. Mounts at /ws.
 *
 * Connections: ws://host/ws?topic=<sessionId>&role=desktop|mobile
 *
 * - Messages from mobile  → forwarded to desktop (or buffered)
 * - Messages from desktop → forwarded to mobile  (or buffered)
 * - Buffered messages are flushed when the other side connects
 * - Heartbeat pings every 30 s; non-responsive sockets are terminated
 * - Origin header validated against allowedOrigin when present (browser clients only)
 * - role=desktop connections validated via onValidateDesktopToken callback when set
 */
declare class WebSocketRelay {
    private wss;
    private topics;
    private onMessage;
    private validateTopic;
    private validateDesktopToken;
    private onDisconnectCb;
    private onMobileConnectCb;
    private allowedOrigin;
    private heartbeatTimer;
    constructor(server: Server, options?: {
        allowedOrigin?: string;
    });
    /** Register a callback for every inbound message from either side. */
    onIncoming(handler: MessageHandler): void;
    /** Register a validator called on each new connection to verify the topic exists. */
    onValidateTopic(validator: TopicValidator): void;
    /**
     * Register a validator for role=desktop connections.
     * Receives the topic and the `token` query parameter (null if absent).
     * Return false to reject the connection with close code 1008.
     */
    onValidateDesktopToken(validator: TokenValidator): void;
    /**
     * Register a callback invoked when a socket disconnects.
     * Use this to react to mobile disconnects (e.g. reject in-flight requests).
     */
    onDisconnect(handler: DisconnectHandler): void;
    /** Register a callback invoked when a mobile socket connects (before proof). */
    onMobileConnect(handler: ConnectHandler): void;
    /** Forcibly close the mobile socket for a topic (e.g. auth timeout or proof failure). */
    disconnectMobile(topic: string): void;
    /** Remove a topic entry — call when its session is garbage-collected. */
    removeTopic(topic: string): void;
    /** Push an envelope to the mobile socket (or buffer if disconnected). */
    sendToMobile(topic: string, envelope: WireEnvelope): void;
    /** Push an envelope to the desktop socket (or buffer if disconnected). */
    sendToDesktop(topic: string, envelope: WireEnvelope): void;
    close(): void;
    private handleConnection;
    private getOrCreateTopic;
    private buffer;
    private runHeartbeat;
}

/**
 * In-memory session store with QR code generation and automatic GC.
 *
 * Sessions use a 32-byte random base64url ID which also serves as the WS topic
 * and the BSV wallet keyID.
 */
declare class QRSessionManager {
    private sessions;
    private gcTimer;
    private onExpired;
    constructor();
    /** Register a callback invoked when a session is garbage-collected. */
    onSessionExpired(cb: (id: string) => void): void;
    /** Stop the GC timer (call on server shutdown). */
    stop(): void;
    createSession(): Session;
    getSession(id: string): Session | null;
    /** Mark that a mobile WS has opened for this session, starting the grace window. */
    setPairingStarted(id: string): void;
    setStatus(id: string, status: SessionStatus): void;
    setMobileIdentityKey(id: string, key: string): void;
    /**
     * Generate a QR data URL for the given URI.
     * Requires the `qrcode` package to be installed.
     */
    generateQRCode(uri: string): Promise<string>;
    private gc;
}

/**
 * Pure utilities for creating and parsing JSON-RPC messages.
 * No I/O — safe to unit-test in isolation.
 */
declare class WalletRequestHandler {
    private seq;
    /** Create an RPC request with a unique ID and incrementing seq. */
    createRequest(method: string, params: unknown): RpcRequest;
    /** Create a protocol-level message (pairing_ack, session_revoke, …). */
    createProtocolMessage(method: string, params: unknown): RpcRequest;
    parseMessage(raw: string): RpcRequest | RpcResponse;
    isResponse(msg: RpcRequest | RpcResponse): msg is RpcResponse;
    errorResponse(id: string, seq: number, code: number, message: string): RpcResponse;
}

interface WalletRelayServiceOptions {
    /**
     * Express app — when provided, REST routes are registered automatically.
     * Omit when using Next.js (or any other framework): call createSession(),
     * getSession(), and sendRequest() from your own route handlers instead.
     */
    app?: Express;
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
     * http(s):// URL of the desktop frontend — used for CORS and the pairing URI.
     * Defaults to the `ORIGIN` environment variable, then `http://localhost:5173`.
     */
    origin?: string;
    /** Called when a mobile completes pairing and the session transitions to 'connected'. */
    onSessionConnected?: (sessionId: string) => void;
    /** Called when a connected mobile disconnects (session transitions to 'disconnected'). */
    onSessionDisconnected?: (sessionId: string) => void;
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
 * // In GET /api/session:        relay.createSession()
 * // In GET /api/session/:id:    relay.getSession(id)
 * // In POST /api/request/:id:   relay.sendRequest(id, method, params)
 * ```
 *
 * Express auto-registered routes:
 *   GET  /api/session        — create session, return { sessionId, status, qrDataUrl }
 *   GET  /api/session/:id    — return { sessionId, status }
 *   POST /api/request/:id    — body { method, params } — relay to mobile, return RpcResponse
 */
declare class WalletRelayService {
    private opts;
    private sessions;
    private relay;
    private handler;
    private pending;
    private mobileAuthTimers;
    private wallet;
    private relayUrl;
    private origin;
    constructor(opts: WalletRelayServiceOptions);
    /** Create a session and return its QR data URL, pairing URI, and desktop WebSocket token. */
    createSession(): Promise<{
        sessionId: string;
        status: string;
        qrDataUrl: string;
        pairingUri: string;
        desktopToken: string;
    }>;
    /** Return session status, or null if not found. */
    getSession(id: string): {
        sessionId: string;
        status: string;
    } | null;
    /**
     * Encrypt an RPC call, relay it to the mobile, and await the response.
     * Rejects if the session is not connected or if the mobile doesn't respond within 30 s.
     */
    sendRequest(sessionId: string, method: string, params: unknown): Promise<RpcResponse>;
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

export { type ConnectHandler, type DisconnectHandler, type MessageHandler, QRSessionManager, type Role, RpcRequest, RpcResponse, Session, SessionStatus, type TokenValidator, type TopicValidator, WalletLike, WalletRelayService, type WalletRelayServiceOptions, WalletRequestHandler, WebSocketRelay, WireEnvelope };
