import { AsyncSessionManager, PeerSession } from '@bsv/sdk'
import { Knex } from 'knex'
import { TableAuthSession, tableAuthSessionToPeerSession } from '../schema/tables/TableAuthSession'

export const AUTH_SESSION_TABLE = 'auth_sessions'
export const DEFAULT_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export interface KnexSessionManagerOptions {
  /** Session lifetime since its most recent authenticated use. Default: 24 hours. */
  ttlMs?: number
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
  private readonly now: () => number

  constructor (private readonly knex: Knex, options: KnexSessionManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_AUTH_SESSION_TTL_MS
    this.now = options.now ?? Date.now

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new TypeError('KnexSessionManager ttlMs must be a positive safe integer.')
    }
  }

  async addSession (session: PeerSession): Promise<void> {
    await this.persistSession(session)
  }

  async updateSession (session: PeerSession): Promise<void> {
    await this.persistSession(session)
  }

  async getSession (identifier: string): Promise<PeerSession | undefined> {
    const byNonce = await this.activeSessions()
      .where({ sessionNonce: identifier })
      .first()
    if (byNonce != null) return tableAuthSessionToPeerSession(byNonce)

    const byIdentity = await this.activeSessions()
      .where({ peerIdentityKey: identifier })
      .orderBy('lastUpdate', 'desc')
      .orderBy('sessionNonce', 'desc')
      .first()
    return byIdentity == null ? undefined : tableAuthSessionToPeerSession(byIdentity)
  }

  async removeSession (session: PeerSession): Promise<void> {
    if (typeof session.sessionNonce !== 'string') return
    if (!Number.isSafeInteger(session.lastUpdate) || session.lastUpdate < 0) return

    await this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
      .where({ sessionNonce: session.sessionNonce })
      .where(function () {
        this.where('lastUpdate', '<', session.lastUpdate)
          .orWhere(function () {
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

  private async persistSession (session: PeerSession): Promise<void> {
    if (typeof session.sessionNonce !== 'string' || session.sessionNonce.length === 0) {
      throw new TypeError('Invalid session: sessionNonce is required to persist a session.')
    }
    if (!Number.isSafeInteger(session.lastUpdate) || session.lastUpdate < 0) {
      throw new TypeError('Invalid session: lastUpdate must be a non-negative safe integer.')
    }

    const row = this.toTableAuthSession(session)
    const updated = await this.updateIfCurrentOrNewer(row)
    if (updated > 0) return

    try {
      await this.knex<TableAuthSession>(AUTH_SESSION_TABLE).insert(row)
    } catch (error: unknown) {
      // Another replica may have inserted this nonce between our update and
      // insert. Confirm the conflict is that expected race, then retry the
      // monotonic update; otherwise preserve the original database failure.
      const existing = await this.knex<TableAuthSession>(AUTH_SESSION_TABLE)
        .where({ sessionNonce: row.sessionNonce })
        .first('sessionNonce')
      if (existing == null) throw error
      await this.updateIfCurrentOrNewer(row)
    }
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

  private mergeNullableBoolean (column: string, value: boolean | number | null | undefined): Knex.Raw {
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
    query.whereNull(column)
  } else {
    query.where(column, value)
  }
}
