import { randomBytes } from 'node:crypto'
import type { Session, SessionStatus } from '../types.js'

const PAIRING_TTL_MS   = 120 * 1000  // 2 min QR expiry
const PAIRING_GRACE_MS = 30  * 1000  // extra window once mobile WS has opened
const PENDING_EXPIRY_MS = PAIRING_TTL_MS + PAIRING_GRACE_MS + 60 * 1000  // ~3.5 min
const SESSION_TTL_MS  = 24 * 60 * 60 * 1000 // 24 hours (once connected)
const GC_INTERVAL_MS  = 10 * 60 * 1000           // GC every 10 min

export interface QRSessionManagerOptions {
  /**
   * Maximum number of sessions held in memory at once.
   * `createSession` throws with code 429 when the cap is reached.
   * Default: unlimited.
   */
  maxSessions?: number
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
export class QRSessionManager {
  private sessions = new Map<string, Session>()
  private gcTimer: ReturnType<typeof setInterval>
  private onExpired: ((id: string) => void) | null = null
  private readonly maxSessions: number

  constructor(options?: QRSessionManagerOptions) {
    this.maxSessions = options?.maxSessions ?? Infinity
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS).unref()
  }

  /** Register a callback invoked when a session is garbage-collected. */
  onSessionExpired(cb: (id: string) => void): void {
    this.onExpired = cb
  }

  /** Stop the GC timer (call on server shutdown). */
  stop(): void {
    clearInterval(this.gcTimer)
  }

  createSession(): Session {
    if (this.sessions.size >= this.maxSessions) {
      const err = new Error('Session limit reached') as Error & { code: number }
      err.code = 429
      throw err
    }
    const id           = randomBytes(32).toString('base64url')
    const desktopToken = randomBytes(24).toString('base64url')
    const now = Date.now()
    const session: Session = {
      id,
      status:    'pending',
      createdAt: now,
      // Short TTL — extended to SESSION_TTL_MS when the session becomes connected.
      // This ensures unscanned QR codes are GC'd quickly rather than after 30 days.
      expiresAt: now + PENDING_EXPIRY_MS,
      desktopToken,
    }
    this.sessions.set(id, session)
    return session
  }

  getSession(id: string): Session | null {
    const session = this.sessions.get(id)
    if (!session) return null
    // Lazily expire pending sessions past their pairing window.
    // Respect the grace window: if the mobile WS has already opened (pairingStartedAt is
    // set), don't flip to 'expired' for another PAIRING_GRACE_MS. This prevents a race
    // where the mobile connects just before the 120 s boundary and pairing_approved is
    // still in flight when the caller polls session status.
    if (session.status === 'pending' && Date.now() > session.createdAt + PAIRING_TTL_MS) {
      const gracedUntil = (session.pairingStartedAt ?? 0) + PAIRING_GRACE_MS
      if (Date.now() > gracedUntil) session.status = 'expired'
    }
    return session
  }

  /** Mark that a mobile WS has opened for this session, starting the grace window. */
  setPairingStarted(id: string): void {
    const session = this.sessions.get(id)
    if (session && session.status === 'pending') session.pairingStartedAt = Date.now()
  }

  setStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.status = status
    // Extend lifetime to full SESSION_TTL_MS once a mobile wallet connects.
    if (status === 'connected') session.expiresAt = Date.now() + SESSION_TTL_MS
  }

  setMobileIdentityKey(id: string, key: string): void {
    const session = this.sessions.get(id)
    if (session) session.mobileIdentityKey = key
  }

  /**
   * Generate a QR data URL for the given URI.
   * Requires the `qrcode` package to be installed.
   */
  async generateQRCode(uri: string): Promise<string> {
    // Dynamic import keeps `qrcode` optional — only the server entry needs it.
    const QRCode = (await import('qrcode')).default
    return QRCode.toDataURL(uri, { width: 300, margin: 2 })
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id)
        this.onExpired?.(id)
      }
    }
  }
}
