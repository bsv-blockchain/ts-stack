import { AsyncSessionManager, PeerSession } from '@bsv/sdk'
import { Knex } from 'knex'
import { TableAuthSession, tableAuthSessionToPeerSession } from '../schema/tables/TableAuthSession'

export const AUTH_SESSION_TABLE = 'auth_sessions'
export const DEFAULT_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_AUTH_SESSION_TOUCH_INTERVAL_MS = 60 * 1000
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
  /** Testable clock source. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Shared BRC-103 session storage for horizontally scaled StorageServer nodes.
 *
 * Every instance must use the same Knex database. The wallet-toolbox migration
 * creates the required `auth_sessions` table. Writes are monotonic by
 * `PeerSession.lastUpdate`, preventing a delayed request on one replica from
 * replacing newer session state written by another replica.
 */
export class KnexSessionManager implements AsyncSessionManager {
  private readonly ttlMs: number
  private readonly touchIntervalMs: number
  private readonly now: () => number
  /** Rows associated with session objects returned by this manager. */
  private readonly persistedRows = new WeakMap<PeerSession, TableAuthSession>()

  constructor (private readonly knex: Knex, options: KnexSessionManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_AUTH_SESSION_TTL_MS
    this.touchIntervalMs = options.touchIntervalMs ?? Math.min(
      DEFAULT_AUTH_SESSION_TOUCH_INTERVAL_MS,
      Math.max(1, Math.floor(this.ttlMs / 4))
    )
    this.now = options.now ?? Date.now

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new TypeError('KnexSessionManager ttlMs must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.touchIntervalMs) || this.touchIntervalMs < 0) {
      throw new TypeError('KnexSessionManager touchIntervalMs must be a non-negative safe integer.')
    }
  }

  async addSession (session: PeerSession): Promise<void> {
    await this.persistSession(session, false)
  }

  async updateSession (session: PeerSession): Promise<void> {
    await this.persistSession(session, true)
  }

  async getSession (identifier: string): Promise<PeerSession | undefined> {
    const byNonce = await this.activeSessions()
      .where({ sessionNonce: identifier })
      .first()
    if (byNonce != null) return this.sessionForRow(byNonce)

    const byIdentity = await this.activeSessions()
      .where({ peerIdentityKey: identifier })
      .orderBy('lastUpdate', 'desc')
      .orderBy('sessionNonce', 'desc')
      .first()
    return byIdentity == null ? undefined : this.sessionForRow(byIdentity)
  }

  async removeSession (session: PeerSession): Promise<void> {
    if (typeof session.sessionNonce !== 'string') return
    if (!Number.isSafeInteger(session.lastUpdate) || session.lastUpdate < 0) return

    await this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
      .where({ sessionNonce: session.sessionNonce })
      .where(function () {
        // Knex query builders are thenable, but these calls only build the
        // surrounding delete predicate; they do not start standalone queries.
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.where('lastUpdate', '<', session.lastUpdate)
          .orWhere(function () {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.where('lastUpdate', '=', session.lastUpdate)
              .where('isAuthenticated', session.isAuthenticated)
            applyNullableMatch(this, 'peerNonce', session.peerNonce)
            applyNullableMatch(this, 'peerIdentityKey', session.peerIdentityKey)
            applyNullableMatch(this, 'certificatesRequired', session.certificatesRequired)
            applyNullableMatch(this, 'certificatesValidated', session.certificatesValidated)
          })
      })
      .delete()
  }

  async hasSession (identifier: string): Promise<boolean> {
    const byNonce = await this.activeSessions()
      .where({ sessionNonce: identifier })
      .first('sessionNonce')
    if (byNonce != null) return true

    const byIdentity = await this.activeSessions()
      .where({ peerIdentityKey: identifier })
      .first('sessionNonce')
    return byIdentity != null
  }

  /** Delete expired rows. Call from an operator-controlled maintenance task. */
  async pruneExpiredSessions (): Promise<number> {
    return await this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
      .where('expiresAt', '<=', this.now())
      .delete()
  }

  private activeSessions (): Knex.QueryBuilder<TableAuthSession, TableAuthSession[]> {
    return this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
      .where('expiresAt', '>', this.now())
  }

  private async persistSession (session: PeerSession, coalesceTouch: boolean): Promise<void> {
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

  private validatePersistentSession (session: PeerSession): void {
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
  private canCoalesceTouch (session: PeerSession, row: TableAuthSession): boolean {
    if (this.touchIntervalMs === 0 || row.isAuthenticated !== true) return false
    const persisted = this.persistedRows.get(session)
    if (!persisted?.isAuthenticated) return false

    const persistedLastUpdate = Number(persisted.lastUpdate)
    const elapsed = Number(row.lastUpdate) - persistedLastUpdate
    if (elapsed < 0 || elapsed >= this.touchIntervalMs) return false
    if (Number(persisted.expiresAt) - this.now() <= this.touchIntervalMs) return false

    return nullableEqual(row.peerNonce, persisted.peerNonce) &&
      nullableEqual(row.peerIdentityKey, persisted.peerIdentityKey) &&
      nullableBooleanEqual(row.certificatesRequired, persisted.certificatesRequired) &&
      nullableBooleanEqual(row.certificatesValidated, persisted.certificatesValidated)
  }

  private sessionForRow (row: TableAuthSession): PeerSession {
    const session = tableAuthSessionToPeerSession(row)
    this.persistedRows.set(session, { ...row })
    return session
  }

  private async updateIfCurrentOrNewer (row: TableAuthSession): Promise<number> {
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
        isAuthenticated: this.knex.raw(
          'case when ?? = 1 or ? = 1 then 1 else 0 end',
          ['isAuthenticated', row.isAuthenticated === true || row.isAuthenticated === 1 ? 1 : 0]
        ),
        certificatesRequired: this.mergeNullableBoolean('certificatesRequired', row.certificatesRequired),
        certificatesValidated: this.mergeNullableBoolean('certificatesValidated', row.certificatesValidated),
        lastUpdate: row.lastUpdate,
        expiresAt: row.expiresAt
      })
  }

  private mergeNullableBoolean (column: string, value: NullableBoolean): Knex.Raw {
    let incoming: 0 | 1 | null
    if (value == null) {
      incoming = null
    } else if (value === true || value === 1) {
      incoming = 1
    } else {
      incoming = 0
    }
    return this.knex.raw(
      'case when ?? = 1 or ? = 1 then 1 when ?? is null and ? is null then null else 0 end',
      [column, incoming, column, incoming]
    )
  }

  private toTableAuthSession (session: PeerSession): TableAuthSession {
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
}

function applyNullableMatch (
  query: Knex.QueryBuilder,
  column: string,
  value: string | boolean | undefined
): void {
  if (value == null) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    query.whereNull(column)
  } else {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    query.where(column, value)
  }
}

function nullableEqual (left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null)
}

function nullableBooleanEqual (
  left: boolean | number | null | undefined,
  right: boolean | number | null | undefined
): boolean {
  if (left == null || right == null) return left == null && right == null
  return Boolean(left) === Boolean(right)
}

function isDuplicateKeyError (error: unknown): boolean {
  if (typeof error !== 'object' || error == null) return false
  const databaseError = error as { code?: unknown, errno?: unknown }
  return databaseError.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    databaseError.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    databaseError.code === 'ER_DUP_ENTRY' ||
    databaseError.errno === 1062
}
