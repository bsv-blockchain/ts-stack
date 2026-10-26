import { AsyncSessionManager, PeerSession } from '@bsv/sdk'
import { Knex } from 'knex'
import { TableAuthSession, tableAuthSessionToPeerSession } from '../schema/tables/TableAuthSession'

export const AUTH_SESSION_TABLE = 'auth_sessions'
export const AUTH_MESSAGE_NONCE_TABLE = 'auth_message_nonces'
export const DEFAULT_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_AUTH_SESSION_TOUCH_INTERVAL_MS = 60 * 1000
export const DEFAULT_MAX_AUTH_MESSAGE_NONCES_PER_SESSION = 100_000
export const DEFAULT_MAX_INITIAL_REQUEST_NONCES = 100_000
export const DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY = 100_000
type NullableBoolean = boolean | number | null | undefined

export interface KnexSessionManagerOptions {
  /** Session lifetime since its most recent authenticated use. Default: 24 hours. */
  ttlMs?: number
  /**
   * Maximum time that an authenticated, timestamp-only session update may be
   * coalesced. Authentication and certificate state changes are always written
   * immediately. Default: 1 minute (or one quarter of ttlMs when shorter).
   */
  touchIntervalMs?: number
  /** Maximum one-time signed message nonces retained per active session. */
  maxMessageNoncesPerSession?: number
  /** Maximum unsigned initial-request replay claims retained across all identities. */
  maxInitialRequestNonces?: number
  /**
   * Maximum unsigned initial-request replay claims retained per identity.
   * The oldest claim is evicted at capacity so unauthenticated traffic cannot
   * permanently disable new handshakes. Default: 100,000.
   */
  maxInitialRequestNoncesPerIdentity?: number
  /** Testable clock source. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Shared BRC-103 session storage for horizontally scaled StorageServer nodes.
 *
 * Every instance must use the same Knex database. The wallet-toolbox migration
 * creates the required `auth_sessions` and `auth_message_nonces` tables. The
 * nonce table atomically rejects replay across replicas. Writes are monotonic
 * by `PeerSession.lastUpdate`, preventing a delayed request on one replica from
 * replacing newer session state written by another replica.
 */
export class KnexSessionManager implements AsyncSessionManager {
  private readonly ttlMs: number
  private readonly touchIntervalMs: number
  private readonly maxMessageNoncesPerSession: number
  private readonly maxInitialRequestNonces: number
  private readonly maxInitialRequestNoncesPerIdentity: number
  private readonly now: () => number
  /** Rows associated with session objects returned by this manager. */
  private readonly persistedRows = new WeakMap<PeerSession, TableAuthSession>()

  constructor(
    private readonly knex: Knex,
    options: KnexSessionManagerOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_AUTH_SESSION_TTL_MS
    this.touchIntervalMs =
      options.touchIntervalMs ??
      Math.min(DEFAULT_AUTH_SESSION_TOUCH_INTERVAL_MS, Math.max(1, Math.floor(this.ttlMs / 4)))
    this.maxMessageNoncesPerSession = options.maxMessageNoncesPerSession ?? DEFAULT_MAX_AUTH_MESSAGE_NONCES_PER_SESSION
    this.maxInitialRequestNonces = options.maxInitialRequestNonces ?? DEFAULT_MAX_INITIAL_REQUEST_NONCES
    this.maxInitialRequestNoncesPerIdentity =
      options.maxInitialRequestNoncesPerIdentity ?? DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY
    this.now = options.now ?? Date.now

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new TypeError('KnexSessionManager ttlMs must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.touchIntervalMs) || this.touchIntervalMs < 0) {
      throw new TypeError('KnexSessionManager touchIntervalMs must be a non-negative safe integer.')
    }
    if (!Number.isSafeInteger(this.maxMessageNoncesPerSession) || this.maxMessageNoncesPerSession < 1) {
      throw new TypeError('KnexSessionManager maxMessageNoncesPerSession must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.maxInitialRequestNonces) || this.maxInitialRequestNonces < 1) {
      throw new TypeError('KnexSessionManager maxInitialRequestNonces must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.maxInitialRequestNoncesPerIdentity) || this.maxInitialRequestNoncesPerIdentity < 1) {
      throw new TypeError('KnexSessionManager maxInitialRequestNoncesPerIdentity must be a positive safe integer.')
    }
    if (typeof this.now !== 'function') {
      throw new TypeError('KnexSessionManager now must be a function.')
    }
  }

  async addSession(session: PeerSession): Promise<void> {
    await this.persistSession(session, false)
  }

  async updateSession(session: PeerSession): Promise<void> {
    await this.persistSession(session, true)
  }

  async getSession(identifier: string): Promise<PeerSession | undefined> {
    const byNonce = await this.activeSessions().where({ sessionNonce: identifier }).first()
    if (byNonce != null) return this.sessionForRow(byNonce)

    const byIdentity = await this.activeSessions()
      .where({ peerIdentityKey: identifier })
      .orderBy('isAuthenticated', 'desc')
      .orderByRaw('CASE WHEN ?? = ? AND COALESCE(??, ?) <> ? THEN ? ELSE ? END DESC', [
        'certificatesRequired',
        true,
        'certificatesValidated',
        false,
        true,
        0,
        1
      ])
      .orderBy('lastUpdate', 'desc')
      .orderBy('sessionNonce', 'desc')
      .first()
    return byIdentity == null ? undefined : this.sessionForRow(byIdentity)
  }

  async removeSession(session: PeerSession): Promise<void> {
    if (typeof session.sessionNonce !== 'string') return
    if (!Number.isSafeInteger(session.lastUpdate) || session.lastUpdate < 0) return

    const removed = await this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
      .where({ sessionNonce: session.sessionNonce })
      .where(function () {
        // Knex query builders are thenable, but these calls only build the
        // surrounding delete predicate; they do not start standalone queries.
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.where('lastUpdate', '<', session.lastUpdate).orWhere(function () {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.where('lastUpdate', '=', session.lastUpdate).where('isAuthenticated', session.isAuthenticated)
          applyNullableMatch(this, 'peerNonce', session.peerNonce)
          applyNullableMatch(this, 'peerIdentityKey', session.peerIdentityKey)
          applyNullableMatch(this, 'certificatesRequired', session.certificatesRequired)
          applyNullableMatch(this, 'certificatesValidated', session.certificatesValidated)
        })
      })
      .delete()
    if (removed > 0) {
      await this.knex(AUTH_MESSAGE_NONCE_TABLE).where({ sessionNonce: session.sessionNonce }).delete()
    }
  }

  async hasSession(identifier: string): Promise<boolean> {
    const byNonce = await this.activeSessions().where({ sessionNonce: identifier }).first('sessionNonce')
    if (byNonce != null) return true

    const byIdentity = await this.activeSessions().where({ peerIdentityKey: identifier }).first('sessionNonce')
    return byIdentity != null
  }

  /** Atomically reject reuse of a signed BRC-103 message nonce across replicas. */
  async claimMessageNonce(sessionNonce: string, messageNonce: string): Promise<boolean> {
    validateNonceIdentifier(sessionNonce, 'sessionNonce')
    validateNonceIdentifier(messageNonce, 'messageNonce')

    const now = this.currentTime()
    return await this.knex.transaction(async trx => {
      const session = await trx<TableAuthSession>(AUTH_SESSION_TABLE)
        .where({ sessionNonce })
        .where('expiresAt', '>', now)
        .first('sessionNonce', 'expiresAt')
      if (session == null) throw new Error(`Session not found for nonce: ${sessionNonce}`)

      const existing = await trx(AUTH_MESSAGE_NONCE_TABLE).where({ sessionNonce, messageNonce }).first('messageNonce')
      if (existing != null) return false

      const countRow = await trx(AUTH_MESSAGE_NONCE_TABLE)
        .where({ sessionNonce })
        .count<{ count: number | string }[]>({ count: '*' })
        .first()
      const count = Number(countRow?.count ?? 0)
      if (!Number.isSafeInteger(count) || count >= this.maxMessageNoncesPerSession) {
        throw new Error('BRC-103 session message nonce capacity exhausted')
      }

      try {
        await trx(AUTH_MESSAGE_NONCE_TABLE).insert({
          sessionNonce,
          messageNonce,
          expiresAt: Number(session.expiresAt)
        })
        return true
      } catch (error: unknown) {
        if (isDuplicateKeyError(error)) return false
        throw error
      }
    })
  }

  /** Atomically reject replayed unsigned initial requests across replicas. */
  async claimInitialRequestNonce(identityKey: string, initialNonce: string): Promise<boolean> {
    validateNonceIdentifier(identityKey, 'identityKey', 66)
    validateNonceIdentifier(initialNonce, 'initialNonce', 64)
    const claimScope = `initial:${identityKey}`
    const now = this.currentTime()
    const expiresAt = now + this.ttlMs
    if (!Number.isSafeInteger(expiresAt)) {
      throw new TypeError('Initial-request replay expiry must be a safe integer')
    }

    return await this.knex.transaction(async trx => {
      // Initial identities are attacker-selected. Prune all expired claims so
      // cycling through identities cannot leave unbounded dead rows behind.
      await trx(AUTH_MESSAGE_NONCE_TABLE)
        .where('sessionNonce', 'like', 'initial:%')
        .where('expiresAt', '<=', now)
        .delete()
      const existing = await trx(AUTH_MESSAGE_NONCE_TABLE)
        .where({ sessionNonce: claimScope, messageNonce: initialNonce })
        .first('messageNonce')
      if (existing != null) return false
      const countRow = await trx(AUTH_MESSAGE_NONCE_TABLE)
        .where({ sessionNonce: claimScope })
        .count<{ count: number | string }[]>({ count: '*' })
        .first()
      const count = Number(countRow?.count ?? 0)
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('BRC-103 initial request nonce count is invalid')
      }
      const evictionCount = count - this.maxInitialRequestNoncesPerIdentity + 1
      if (evictionCount > 0) {
        await this.evictOldestInitialRequestClaims(trx, evictionCount, claimScope)
      }
      const totalRow = await trx(AUTH_MESSAGE_NONCE_TABLE)
        .where('sessionNonce', 'like', 'initial:%')
        .count<{ count: number | string }[]>({ count: '*' })
        .first()
      const total = Number(totalRow?.count ?? 0)
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new Error('BRC-103 total initial request nonce count is invalid')
      }
      const globalEvictionCount = total - this.maxInitialRequestNonces + 1
      if (globalEvictionCount > 0) {
        await this.evictOldestInitialRequestClaims(trx, globalEvictionCount)
      }
      try {
        await trx(AUTH_MESSAGE_NONCE_TABLE).insert({
          sessionNonce: claimScope,
          messageNonce: initialNonce,
          expiresAt
        })
        return true
      } catch (error: unknown) {
        if (isDuplicateKeyError(error)) return false
        throw error
      }
    })
  }

  /** Delete expired rows. Call from an operator-controlled maintenance task. */
  async pruneExpiredSessions(): Promise<number> {
    const now = this.currentTime()
    return await this.knex.transaction(async trx => {
      const removedSessions = await trx<TableAuthSession>(AUTH_SESSION_TABLE).where('expiresAt', '<=', now).delete()
      await trx(AUTH_MESSAGE_NONCE_TABLE)
        .where('sessionNonce', 'like', 'initial:%')
        .where('expiresAt', '<=', now)
        .delete()
      // A signed nonce belongs to its session for the full lifetime of that
      // session, including sliding TTL extensions. Delete only orphaned rows;
      // their original expiresAt value must not reopen replay in an active
      // session after it has been touched.
      await trx(AUTH_MESSAGE_NONCE_TABLE)
        .whereNot('sessionNonce', 'like', 'initial:%')
        .whereNotExists(
          trx<TableAuthSession>(AUTH_SESSION_TABLE)
            .select(trx.raw('1'))
            .whereRaw('?? = ??', [`${AUTH_SESSION_TABLE}.sessionNonce`, `${AUTH_MESSAGE_NONCE_TABLE}.sessionNonce`])
        )
        .delete()
      return removedSessions
    })
  }

  private activeSessions(): Knex.QueryBuilder<TableAuthSession, TableAuthSession[]> {
    return this.knex<TableAuthSession>(AUTH_SESSION_TABLE).where('expiresAt', '>', this.currentTime())
  }

  private async evictOldestInitialRequestClaims(
    trx: Knex.Transaction,
    count: number,
    claimScope?: string
  ): Promise<void> {
    // Keep batches below conservative SQL parameter limits when an operator
    // lowers a configured cap beneath an already-populated table.
    let remaining = count
    while (remaining > 0) {
      const batchSize = Math.min(remaining, 250)
      const query = trx<{ sessionNonce: string; messageNonce: string }>(AUTH_MESSAGE_NONCE_TABLE)
        .orderBy('expiresAt', 'asc')
        .orderBy('sessionNonce', 'asc')
        .orderBy('messageNonce', 'asc')
        .limit(batchSize)
        .select('sessionNonce', 'messageNonce')
      if (claimScope === undefined) {
        query.where('sessionNonce', 'like', 'initial:%')
      } else {
        query.where({ sessionNonce: claimScope })
      }
      const oldestClaims = await query
      if (oldestClaims.length === 0) return
      await trx(AUTH_MESSAGE_NONCE_TABLE)
        .whereIn(
          ['sessionNonce', 'messageNonce'],
          oldestClaims.map(claim => [claim.sessionNonce, claim.messageNonce])
        )
        .delete()
      remaining -= oldestClaims.length
    }
  }

  private async persistSession(session: PeerSession, coalesceTouch: boolean): Promise<void> {
    this.validatePersistentSession(session)
    const row = this.toTableAuthSession(session)
    if (coalesceTouch && this.canCoalesceTouch(session, row)) return

    const updated = await this.updateIfCurrentOrNewer(row)
    if (updated > 0) {
      this.persistedRows.set(session, row)
      return
    }

    // A zero-row update can mean either that this write is stale or that the
    // database reports no changed rows for an idempotent update. Avoid an
    // expected duplicate-key failure in both cases; insert only when the nonce
    // is genuinely absent.
    const existing = await this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
      .where({ sessionNonce: row.sessionNonce })
      .first('lastUpdate')
    if (existing != null) {
      // A concurrent insert may have appeared after the first update. Retry if
      // our state is still current enough to advance or merge that new row.
      if (existing.lastUpdate <= row.lastUpdate) {
        const retried = await this.updateIfCurrentOrNewer(row)
        if (retried > 0) this.persistedRows.set(session, row)
      }
      return
    }

    try {
      await this.knex<TableAuthSession>(AUTH_SESSION_TABLE).insert(row)
      this.persistedRows.set(session, row)
    } catch (error: unknown) {
      // Another replica may have inserted this nonce between our update and
      // insert. Retry only known duplicate-key races; preserve every other
      // database failure for the caller.
      if (!isDuplicateKeyError(error)) throw error
      const retried = await this.updateIfCurrentOrNewer(row)
      if (retried > 0) this.persistedRows.set(session, row)
    }
  }

  private validatePersistentSession(session: PeerSession): void {
    if (typeof session.sessionNonce !== 'string' || session.sessionNonce.length === 0) {
      throw new TypeError('Invalid session: sessionNonce is required to persist a session.')
    }
    if (!Number.isSafeInteger(session.lastUpdate) || session.lastUpdate < 0) {
      throw new TypeError('Invalid session: lastUpdate must be a non-negative safe integer.')
    }
  }

  /**
   * Coalesce only the routine last-used write performed after an authenticated
   * general message. The WeakMap proves that this exact session object came
   * from a durable row read (or successful write) by this manager. Every
   * authentication/certificate transition and every unrecognized object still
   * takes the monotonic database path.
   */
  private canCoalesceTouch(session: PeerSession, row: TableAuthSession): boolean {
    if (this.touchIntervalMs === 0 || row.isAuthenticated !== true) return false
    const persisted = this.persistedRows.get(session)
    if (!persisted?.isAuthenticated) return false

    const persistedLastUpdate = Number(persisted.lastUpdate)
    const elapsed = Number(row.lastUpdate) - persistedLastUpdate
    if (elapsed < 0 || elapsed >= this.touchIntervalMs) return false
    if (Number(persisted.expiresAt) - this.currentTime() <= this.touchIntervalMs) return false

    return (
      nullableEqual(row.peerNonce, persisted.peerNonce) &&
      nullableEqual(row.peerIdentityKey, persisted.peerIdentityKey) &&
      nullableBooleanEqual(row.certificatesRequired, persisted.certificatesRequired) &&
      nullableBooleanEqual(row.certificatesValidated, persisted.certificatesValidated)
    )
  }

  private sessionForRow(row: TableAuthSession): PeerSession {
    const session = tableAuthSessionToPeerSession(row)
    this.persistedRows.set(session, { ...row })
    return session
  }

  private async updateIfCurrentOrNewer(row: TableAuthSession): Promise<number> {
    return await this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
      .where({ sessionNonce: row.sessionNonce })
      .where('lastUpdate', '<=', row.lastUpdate)
      .update({
        // Identity and peer nonces become immutable once established. This
        // prevents an equal-timestamp write from another replica replacing
        // the identifiers attached to an authenticated session.
        peerNonce: this.knex.raw('coalesce(??, ?)', ['peerNonce', row.peerNonce ?? null]),
        peerIdentityKey: this.knex.raw('coalesce(??, ?)', ['peerIdentityKey', row.peerIdentityKey ?? null]),
        // Authentication and certificate validation only advance during a
        // session. Merge those flags so two writes in the same millisecond
        // cannot downgrade stronger state merely because Date.now collided.
        isAuthenticated:
          row.isAuthenticated === true || row.isAuthenticated === 1 ? true : this.knex.raw('??', ['isAuthenticated']),
        certificatesRequired: this.mergeNullableBoolean('certificatesRequired', row.certificatesRequired),
        certificatesValidated: this.mergeNullableBoolean('certificatesValidated', row.certificatesValidated),
        lastUpdate: row.lastUpdate,
        expiresAt: row.expiresAt
      })
  }

  private mergeNullableBoolean(column: string, value: NullableBoolean): boolean | Knex.Raw {
    // Resolve the incoming value here rather than in SQL: Postgres rejects
    // integer comparisons against boolean columns and untyped null parameters.
    if (value === true || value === 1) return true
    if (value == null) return this.knex.raw('??', [column])
    return this.knex.raw('coalesce(??, ?)', [column, false])
  }

  private toTableAuthSession(session: PeerSession): TableAuthSession {
    const expiresAt = session.lastUpdate + this.ttlMs
    if (!Number.isSafeInteger(expiresAt)) {
      throw new TypeError('Invalid session: lastUpdate plus ttlMs must be a safe integer.')
    }

    return {
      sessionNonce: session.sessionNonce as string,
      peerNonce: session.peerNonce ?? null,
      peerIdentityKey: session.peerIdentityKey ?? null,
      isAuthenticated: session.isAuthenticated,
      lastUpdate: session.lastUpdate,
      certificatesRequired: session.certificatesRequired ?? null,
      certificatesValidated: session.certificatesValidated ?? null,
      expiresAt
    }
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('KnexSessionManager now must return a non-negative safe integer.')
    }
    return value
  }
}

function applyNullableMatch(query: Knex.QueryBuilder, column: string, value: string | boolean | undefined): void {
  if (value == null) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    query.whereNull(column)
  } else {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    query.where(column, value)
  }
}

function nullableEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null)
}

function nullableBooleanEqual(
  left: boolean | number | null | undefined,
  right: boolean | number | null | undefined
): boolean {
  if (left == null || right == null) return left == null && right == null
  return Boolean(left) === Boolean(right)
}

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) return false
  const databaseError = error as { code?: unknown; errno?: unknown }
  return (
    databaseError.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    databaseError.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    databaseError.code === 'ER_DUP_ENTRY' ||
    databaseError.code === '23505' ||
    databaseError.errno === 1062
  )
}

function validateNonceIdentifier(value: string, name: string, maxLength = 64): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters.`)
  }
}
