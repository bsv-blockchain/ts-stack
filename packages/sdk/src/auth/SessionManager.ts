import { PeerSession } from './types.js'

/**
 * Opt-in async session-manager contract for horizontally scaled deployments.
 *
 * The default in-process {@link SessionManager} stores BRC-103 nonce/session
 * state in memory and is synchronous. Multi-instance HTTP servers that need
 * every instance to resolve the same handshake state — e.g. behind a load
 * balancer without sticky routing — can implement `AsyncSessionManager`
 * against a shared store such as Redis or SQL and pass it to {@link Peer}
 * or `createAuthMiddleware` instead.
 *
 * {@link Peer} accepts `SessionManager | AsyncSessionManager` and awaits every
 * call internally, so sync stores incur no extra latency while async stores
 * work transparently.
 */
export interface AsyncSessionManager {
  addSession: (session: PeerSession) => Promise<void>
  updateSession: (session: PeerSession) => Promise<void>
  getSession: (identifier: string) => Promise<PeerSession | undefined>
  removeSession: (session: PeerSession) => Promise<void>
  hasSession: (identifier: string) => Promise<boolean>
  /**
   * Atomically claim a signed BRC-103 message nonce for one session.
   *
   * Shared stores must implement this operation with a uniqueness constraint
   * or equivalent compare-and-set. Return `false` when the nonce was already
   * consumed. Peer fails closed when an asynchronous store omits this method.
   */
  claimMessageNonce?: (sessionNonce: string, messageNonce: string) => Promise<boolean>
  /** Atomically claim an unsigned initial request nonce for one claimed identity. */
  claimInitialRequestNonce?: (identityKey: string, initialNonce: string) => Promise<boolean>
}

export const DEFAULT_MAX_AUTH_SESSIONS = 10_000
export const DEFAULT_AUTH_SESSION_IDLE_MS = 30 * 60 * 1000
export const DEFAULT_MAX_MESSAGE_NONCES_PER_SESSION = 100_000
export const DEFAULT_MAX_INITIAL_REQUEST_NONCES = 100_000
export const DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY = 256

export interface SessionManagerOptions {
  /** Maximum sessions retained in process. Defaults to 10,000. */
  maxSessions?: number
  /** Idle lifetime for a session. Defaults to 30 minutes. */
  maxSessionIdleMs?: number
  /** Maximum one-time signed message nonces retained per session. Defaults to 100,000. */
  maxMessageNoncesPerSession?: number
  /** Maximum initial-request replay claims retained in process. Defaults to 100,000. */
  maxInitialRequestNonces?: number
  /** Maximum initial-request replay claims retained for one claimed identity. Defaults to 256. */
  maxInitialRequestNoncesPerIdentity?: number
  /** Testable clock source. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Manages sessions for peers, allowing multiple concurrent sessions
 * per identity key. Primary lookup is always by `sessionNonce`. Idle sessions,
 * total sessions, and one-time message nonce claims are bounded by default.
 * Capacity eviction removes only unauthenticated sessions. If every slot holds
 * an authenticated session, a new handshake is rejected until one expires or
 * is explicitly removed.
 */
export class SessionManager {
  /**
   * Maps sessionNonce -> PeerSession
   */
  readonly #sessionNonceToSession: Map<string, PeerSession>

  /**
   * Maps identityKey -> Set of sessionNonces
   */
  readonly #identityKeyToNonces: Map<string, Set<string>>
  readonly #sessionNonceToIdentityKey: Map<string, string>
  readonly #consumedMessageNonces: Map<string, Set<string>>
  readonly #consumedInitialRequestNonces: Map<string, number>
  readonly #initialRequestNonceKeysByIdentity: Map<string, Set<string>>
  readonly #maxSessions: number
  readonly #maxSessionIdleMs: number
  readonly #maxMessageNoncesPerSession: number
  readonly #maxInitialRequestNonces: number
  readonly #maxInitialRequestNoncesPerIdentity: number
  readonly #now: () => number

  constructor(options: SessionManagerOptions = {}) {
    this.#maxSessions = positiveSafeInteger(
      options.maxSessions ?? DEFAULT_MAX_AUTH_SESSIONS,
      'maxSessions'
    )
    this.#maxSessionIdleMs = positiveSafeInteger(
      options.maxSessionIdleMs ?? DEFAULT_AUTH_SESSION_IDLE_MS,
      'maxSessionIdleMs'
    )
    this.#maxMessageNoncesPerSession = positiveSafeInteger(
      options.maxMessageNoncesPerSession ?? DEFAULT_MAX_MESSAGE_NONCES_PER_SESSION,
      'maxMessageNoncesPerSession'
    )
    this.#maxInitialRequestNonces = positiveSafeInteger(
      options.maxInitialRequestNonces ?? DEFAULT_MAX_INITIAL_REQUEST_NONCES,
      'maxInitialRequestNonces'
    )
    this.#maxInitialRequestNoncesPerIdentity = Math.min(
      this.#maxInitialRequestNonces,
      positiveSafeInteger(
        options.maxInitialRequestNoncesPerIdentity ??
          DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY,
        'maxInitialRequestNoncesPerIdentity'
      )
    )
    this.#now = options.now ?? Date.now
    if (typeof this.#now !== 'function') throw new TypeError('now must be a function')
    this.#sessionNonceToSession = new Map<string, PeerSession>()
    this.#identityKeyToNonces = new Map<string, Set<string>>()
    this.#sessionNonceToIdentityKey = new Map<string, string>()
    this.#consumedMessageNonces = new Map<string, Set<string>>()
    this.#consumedInitialRequestNonces = new Map<string, number>()
    this.#initialRequestNonceKeysByIdentity = new Map<string, Set<string>>()
  }

  /**
   * Adds a session to the manager, associating it with its sessionNonce,
   * and also with its peerIdentityKey (if any).
   *
   * This does NOT overwrite existing sessions for the same peerIdentityKey,
   * allowing multiple concurrent sessions for the same peer.
   * At capacity, only an unauthenticated session may be evicted.
   *
   * @param {PeerSession} session - The peer session to add.
   */
  addSession(session: PeerSession): void {
    if (typeof session.sessionNonce !== 'string' || session.sessionNonce.length === 0) {
      throw new TypeError('Invalid session: sessionNonce is required to add a session.')
    }
    if (!Number.isSafeInteger(session.lastUpdate) || session.lastUpdate < 0) {
      throw new TypeError('Invalid session: lastUpdate must be a non-negative safe integer.')
    }

    const now = this.#currentTime()
    if (session.lastUpdate <= now - this.#maxSessionIdleMs) {
      throw new Error('Cannot add an already-expired BRC-103 session.')
    }
    const existing = this.#sessionNonceToSession.get(session.sessionNonce)
    if (existing != null) this.#removeSessionIndexes(existing)
    if (existing == null && this.#sessionNonceToSession.size >= this.#maxSessions) {
      // Admission is the only hot-path operation that needs a global sweep,
      // and only once the bounded store is actually full.
      this.pruneExpiredSessions(now)
    }
    if (existing == null && this.#sessionNonceToSession.size >= this.#maxSessions) {
      this.#evictLeastRecentlyUsedSession()
    }

    // Use the sessionNonce as the primary key
    this.#sessionNonceToSession.set(session.sessionNonce, session)

    // Also track it by identity key if present
    if (typeof session.peerIdentityKey === 'string') {
      let nonces = this.#identityKeyToNonces.get(session.peerIdentityKey)
      if (nonces == null) {
        nonces = new Set<string>()
        this.#identityKeyToNonces.set(session.peerIdentityKey, nonces)
      }
      nonces.add(session.sessionNonce)
      this.#sessionNonceToIdentityKey.set(session.sessionNonce, session.peerIdentityKey)
    }
  }

  /**
   * Updates a session in the manager (primarily by re-adding it),
   * ensuring we record the latest data (e.g., isAuthenticated, lastUpdate, etc.).
   *
   * @param {PeerSession} session - The peer session to update.
   */
  updateSession(session: PeerSession): void {
    if (typeof session.sessionNonce !== 'string' || session.sessionNonce.length === 0) {
      throw new TypeError('Invalid session: sessionNonce is required to update a session.')
    }
    const existing = this.#sessionNonceToSession.get(session.sessionNonce)
    if (existing != null) this.#removeSessionIndexes(existing)
    this.addSession(session)
  }

  /**
   * Retrieves a session based on a given identifier, which can be:
   *  - A sessionNonce, or
   *  - A peerIdentityKey.
   *
   * If it is a `sessionNonce`, returns that exact session.
   * If it is a `peerIdentityKey`, returns the "best" (e.g. most recently updated,
   * authenticated) session associated with that peer, if any.
   *
   * @param {string} identifier - The identifier for the session (sessionNonce or peerIdentityKey).
   * @returns {PeerSession | undefined} - The matching peer session, or undefined if not found.
   */
  getSession(identifier: string): PeerSession | undefined {
    const now = this.#currentTime()
    // Check if this identifier is directly a sessionNonce
    const direct = this.#sessionNonceToSession.get(identifier)
    if (direct != null) {
      if (this.#isExpired(direct, now)) {
        this.removeSession(direct)
      } else {
        return direct
      }
    }

    // Otherwise, interpret the identifier as an identity key
    const nonces = this.#identityKeyToNonces.get(identifier)
    if (nonces == null || nonces.size === 0) {
      return undefined
    }

    // Prefer an authenticated, authorization-ready session, then the most
    // recently updated one. An unsigned or certificate-incomplete request must
    // never shadow an existing usable peer session.
    let best: PeerSession | undefined
    for (const nonce of nonces) {
      const s = this.#sessionNonceToSession.get(nonce)
      if (s == null) {
        nonces.delete(nonce)
        continue
      }
      if (this.#isExpired(s, now)) {
        this.removeSession(s)
        continue
      }
      if (
        best == null ||
        (s.isAuthenticated === true && best.isAuthenticated !== true) ||
        (s.isAuthenticated === best.isAuthenticated &&
          isAuthorizationReady(s) &&
          !isAuthorizationReady(best)) ||
        (s.isAuthenticated === best.isAuthenticated &&
          isAuthorizationReady(s) === isAuthorizationReady(best) &&
          s.lastUpdate > best.lastUpdate)
      ) {
        best = s
      }
    }
    // Optionally, you could also filter out isAuthenticated===false if you only want
    // an authenticated session. But for our usage, let's return the latest any session.
    return best
  }

  /**
   * Removes a session from the manager by clearing all associated identifiers.
   *
   * @param {PeerSession} session - The peer session to remove.
   */
  removeSession(session: PeerSession): void {
    if (typeof session.sessionNonce !== 'string') return
    const existing = this.#sessionNonceToSession.get(session.sessionNonce)
    if (existing != null) this.#removeSessionIndexes(existing)
    this.#sessionNonceToSession.delete(session.sessionNonce)
    this.#consumedMessageNonces.delete(session.sessionNonce)
  }

  /**
   * Checks if a session exists for a given identifier (either sessionNonce or identityKey).
   *
   * @param {string} identifier - The identifier to check.
   * @returns {boolean} - True if the session exists, false otherwise.
   */
  hasSession(identifier: string): boolean {
    return this.getSession(identifier) != null
  }

  /** Atomically claim a one-time signed message nonce for an active session. */
  claimMessageNonce(sessionNonce: string, messageNonce: string): boolean {
    if (typeof sessionNonce !== 'string' || sessionNonce.length === 0) {
      throw new TypeError('sessionNonce must be a non-empty string')
    }
    if (typeof messageNonce !== 'string' || messageNonce.length === 0) {
      throw new TypeError('messageNonce must be a non-empty string')
    }
    const session = this.getSession(sessionNonce)
    if (session == null || session.sessionNonce !== sessionNonce) {
      throw new Error(`Session not found for nonce: ${sessionNonce}`)
    }
    let consumed = this.#consumedMessageNonces.get(sessionNonce)
    if (consumed == null) {
      consumed = new Set<string>()
      this.#consumedMessageNonces.set(sessionNonce, consumed)
    }
    if (consumed.has(messageNonce)) return false
    if (consumed.size >= this.#maxMessageNoncesPerSession) {
      throw new Error('BRC-103 session message nonce capacity exhausted')
    }
    consumed.add(messageNonce)
    return true
  }

  /** Atomically reject a replayed unsigned initial request before wallet work. */
  claimInitialRequestNonce(identityKey: string, initialNonce: string): boolean {
    if (typeof identityKey !== 'string' || identityKey.length === 0) {
      throw new TypeError('identityKey must be a non-empty string')
    }
    if (typeof initialNonce !== 'string' || initialNonce.length === 0) {
      throw new TypeError('initialNonce must be a non-empty string')
    }
    const now = this.#currentTime()
    const key = `${identityKey}\u0000${initialNonce}`
    const claimedAt = this.#consumedInitialRequestNonces.get(key)
    if (claimedAt !== undefined) {
      if (claimedAt > now - this.#maxSessionIdleMs) return false
      this.#deleteInitialRequestNonce(identityKey, key)
    }
    let identityKeys = this.#initialRequestNonceKeysByIdentity.get(identityKey)
    if (identityKeys == null) {
      identityKeys = new Set<string>()
      this.#initialRequestNonceKeysByIdentity.set(identityKey, identityKeys)
    }
    if (identityKeys.size >= this.#maxInitialRequestNoncesPerIdentity) {
      const oldestForIdentity = identityKeys.values().next().value
      if (oldestForIdentity !== undefined)
        this.#deleteInitialRequestNonce(identityKey, oldestForIdentity)
    }
    if (this.#consumedInitialRequestNonces.size >= this.#maxInitialRequestNonces) {
      // Initial requests are unsigned, so a global fail-closed cache lets an
      // unauthenticated sender deny every subsequent handshake. Keep a bounded
      // replay window instead: evict the oldest claim and accept the new one.
      const oldest = this.#consumedInitialRequestNonces.keys().next().value
      if (oldest !== undefined) {
        const separator = oldest.indexOf('\u0000')
        this.#deleteInitialRequestNonce(separator < 0 ? '' : oldest.slice(0, separator), oldest)
      }
    }
    this.#consumedInitialRequestNonces.set(key, now)
    let retainedIdentityKeys = this.#initialRequestNonceKeysByIdentity.get(identityKey)
    if (retainedIdentityKeys == null) {
      retainedIdentityKeys = new Set<string>()
      this.#initialRequestNonceKeysByIdentity.set(identityKey, retainedIdentityKeys)
    }
    retainedIdentityKeys.add(key)
    return true
  }

  /** Remove idle sessions and their identity/replay indexes. */
  pruneExpiredSessions(now = this.#currentTime()): number {
    const cutoff = now - this.#maxSessionIdleMs
    let removed = 0
    for (const session of this.#sessionNonceToSession.values()) {
      if (!Number.isSafeInteger(session.lastUpdate) || session.lastUpdate <= cutoff) {
        this.removeSession(session)
        removed += 1
      }
    }
    this.#pruneExpiredInitialRequestNonces(now)
    return removed
  }

  #pruneExpiredInitialRequestNonces(now: number): void {
    const cutoff = now - this.#maxSessionIdleMs
    for (const [key, claimedAt] of this.#consumedInitialRequestNonces) {
      if (claimedAt <= cutoff) {
        const separator = key.indexOf('\u0000')
        this.#deleteInitialRequestNonce(separator < 0 ? '' : key.slice(0, separator), key)
      }
    }
  }

  #deleteInitialRequestNonce(identityKey: string, key: string): void {
    this.#consumedInitialRequestNonces.delete(key)
    const keys = this.#initialRequestNonceKeysByIdentity.get(identityKey)
    keys?.delete(key)
    if (keys?.size === 0) this.#initialRequestNonceKeysByIdentity.delete(identityKey)
  }

  #isExpired(session: PeerSession, now: number): boolean {
    return (
      !Number.isSafeInteger(session.lastUpdate) ||
      session.lastUpdate <= now - this.#maxSessionIdleMs
    )
  }

  #removeSessionIndexes(session: PeerSession): void {
    if (typeof session.sessionNonce !== 'string') return
    const indexedIdentityKey = this.#sessionNonceToIdentityKey.get(session.sessionNonce)
    this.#sessionNonceToIdentityKey.delete(session.sessionNonce)
    if (indexedIdentityKey == null) return
    const nonces = this.#identityKeyToNonces.get(indexedIdentityKey)
    if (nonces == null) return
    nonces.delete(session.sessionNonce)
    if (nonces.size === 0) this.#identityKeyToNonces.delete(indexedIdentityKey)
  }

  #evictLeastRecentlyUsedSession(): void {
    let oldest: PeerSession | undefined
    for (const session of this.#sessionNonceToSession.values()) {
      // An unsigned handshake must never evict an established authenticated
      // session. When every slot is authenticated, reject the new allocation
      // until an existing session expires or is explicitly removed.
      if (session.isAuthenticated === true) continue
      if (oldest == null || session.lastUpdate < oldest.lastUpdate) {
        oldest = session
      }
    }
    if (oldest == null) {
      throw new Error('BRC-103 session capacity exhausted; authenticated sessions were preserved')
    }
    this.removeSession(oldest)
  }

  #currentTime(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('now must return a non-negative safe integer')
    }
    return value
  }
}

function isAuthorizationReady(session: PeerSession): boolean {
  return (
    session.isAuthenticated === true &&
    (session.certificatesRequired !== true || session.certificatesValidated === true)
  )
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}
