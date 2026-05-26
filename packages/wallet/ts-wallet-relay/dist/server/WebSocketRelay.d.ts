import type { Server } from 'node:http';
import type { WireEnvelope } from '../types.js';
import { type AllowedOrigins } from '../shared/originMatcher.js';
export type Role = 'desktop' | 'mobile';
export type MessageHandler = (topic: string, envelope: WireEnvelope, role: Role) => void;
export type TopicValidator = (topic: string) => boolean;
export type TokenValidator = (topic: string, token: string | null) => boolean;
export type ConnectHandler = (topic: string) => void;
export type DisconnectHandler = (topic: string, role: Role) => void;
export interface WebSocketRelayOptions {
    /**
     * Legacy single-string origin allowlist. Kept for backward compatibility —
     * prefer `allowedOrigins` for richer matching (arrays, regex, predicates).
     * If both are set, `allowedOrigins` takes precedence.
     */
    allowedOrigin?: string;
    /**
     * Origin allowlist used to gate browser WS upgrades (role=desktop). Accepts
     * a single string, an array, a RegExp, or a custom predicate function.
     * When unset and `allowedOrigin` is also unset, no origin validation runs.
     */
    allowedOrigins?: AllowedOrigins;
}
/**
 * Topic-keyed WebSocket relay. Mounts at /ws.
 *
 * Connections: ws://host/ws?topic=<sessionId>&role=desktop|mobile
 *
 * - Messages from mobile  → forwarded to desktop (or buffered)
 * - Messages from desktop → forwarded to mobile  (or buffered)
 * - Buffered messages are flushed when the other side connects
 * - Heartbeat pings every 30 s; non-responsive sockets are terminated
 * - Origin header validated against allowedOrigins (or legacy allowedOrigin)
 *   when present — browser clients only; native mobile clients are exempt
 * - role=desktop connections validated via onValidateDesktopToken callback when set
 */
export declare class WebSocketRelay {
    private readonly wss;
    private readonly topics;
    private onMessage;
    private validateTopic;
    private validateDesktopToken;
    private onDisconnectCb;
    private onMobileConnectCb;
    private isOriginAllowed;
    private heartbeatTimer;
    constructor(server: Server, options?: WebSocketRelayOptions);
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
//# sourceMappingURL=WebSocketRelay.d.ts.map