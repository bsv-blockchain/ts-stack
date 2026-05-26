import type { Session, SessionStatus } from '../types.js';
export interface QRSessionManagerOptions {
    /**
     * Maximum number of sessions held in memory at once.
     * `createSession` throws with code 429 when the cap is reached.
     * Default: unlimited.
     */
    maxSessions?: number;
}
/**
 * In-memory session store with QR code generation and automatic GC.
 *
 * Sessions use a 32-byte random base64url ID which also serves as the WS topic
 * and the BSV wallet keyID.
 *
 * Pending sessions that were never scanned expire after ~3.5 min.
 * Connected sessions expire after 30 days.
 */
export declare class QRSessionManager {
    private readonly sessions;
    private readonly gcTimer;
    private onExpired;
    private readonly maxSessions;
    constructor(options?: QRSessionManagerOptions);
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
//# sourceMappingURL=QRSessionManager.d.ts.map