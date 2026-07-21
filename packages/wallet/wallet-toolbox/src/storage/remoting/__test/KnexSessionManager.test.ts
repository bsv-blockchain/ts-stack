import { PeerSession } from '@bsv/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Knex, knex as makeKnex } from 'knex'
import { AUTH_SESSION_MIGRATION, KnexMigrations } from '../../schema/KnexMigrations'
import { KnexSessionManager } from '../KnexSessionManager'

describe('KnexSessionManager', () => {
  let folder: string
  let knexA: Knex
  let knexB: Knex
  let now: number
  let managerA: KnexSessionManager
  let managerB: KnexSessionManager

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'wallet-toolbox-auth-sessions-'))
    const filename = join(folder, 'sessions.sqlite')
    const config: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    }
    knexA = makeKnex(config)
    knexB = makeKnex(config)

    const migrations = new KnexMigrations('test', 'auth session tests', '1'.repeat(64), 1024)
    const migration = await migrations.getMigration(AUTH_SESSION_MIGRATION)
    await migration.up(knexA)

    now = 1_000
    const options = { ttlMs: 100, now: () => now }
    managerA = new KnexSessionManager(knexA, options)
    managerB = new KnexSessionManager(knexB, options)
  })

  afterEach(async () => {
    await knexA.destroy()
    await knexB.destroy()
    rmSync(folder, { recursive: true, force: true })
  })

  it('shares sessions by nonce and identity across database connections', async () => {
    const session = makeSession({
      sessionNonce: 'nonce-a',
      peerIdentityKey: 'identity-a',
      peerNonce: 'peer-a'
    })
    await managerA.addSession(session)

    await expect(managerB.getSession('nonce-a')).resolves.toEqual(session)
    await expect(managerB.getSession('identity-a')).resolves.toEqual(session)
    await expect(managerB.hasSession('nonce-a')).resolves.toBe(true)
    await expect(managerB.hasSession('identity-a')).resolves.toBe(true)
  })

  it('returns the most recently updated session for an identity', async () => {
    await managerA.addSession(makeSession({
      sessionNonce: 'older',
      peerIdentityKey: 'shared-identity',
      lastUpdate: 900
    }))
    const newer = makeSession({
      sessionNonce: 'newer',
      peerIdentityKey: 'shared-identity',
      lastUpdate: 950
    })
    await managerB.addSession(newer)

    await expect(managerA.getSession('shared-identity')).resolves.toEqual(newer)
  })

  it('does not allow a stale writer or stale remover to replace newer state', async () => {
    await managerA.addSession(makeSession({ lastUpdate: 900 }))

    const authenticated = makeSession({
      isAuthenticated: true,
      peerNonce: 'peer-new',
      lastUpdate: 950
    })
    await managerB.updateSession(authenticated)

    const stale = makeSession({
      isAuthenticated: false,
      peerNonce: 'peer-stale',
      lastUpdate: 925
    })
    const queryErrors: unknown[] = []
    knexA.on('query-error', error => queryErrors.push(error))
    await managerA.updateSession(stale)
    await managerA.removeSession(stale)

    await expect(managerA.getSession('session-nonce')).resolves.toEqual(authenticated)
    expect(queryErrors).toEqual([])

    await managerB.removeSession(authenticated)
    await expect(managerA.getSession('session-nonce')).resolves.toBeUndefined()
  })

  it('merges equal-timestamp authentication progress without allowing a downgrade', async () => {
    const pending = makeSession({
      peerNonce: undefined,
      peerIdentityKey: undefined,
      certificatesRequired: true,
      certificatesValidated: false
    })
    await managerA.addSession(pending)

    const authenticated = makeSession({
      peerNonce: 'peer-established',
      peerIdentityKey: 'identity-established',
      isAuthenticated: true,
      certificatesRequired: true,
      certificatesValidated: true
    })
    await managerB.updateSession(authenticated)

    await managerA.updateSession(pending)
    await managerA.removeSession(pending)
    await expect(managerA.getSession('session-nonce')).resolves.toEqual(authenticated)

    await managerB.removeSession(authenticated)
    await expect(managerA.getSession('session-nonce')).resolves.toBeUndefined()
  })

  it('expires and explicitly prunes old sessions', async () => {
    await managerA.addSession(makeSession())
    now = 1_099
    await expect(managerB.hasSession('session-nonce')).resolves.toBe(true)

    now = 1_100
    await expect(managerB.getSession('session-nonce')).resolves.toBeUndefined()
    await expect(managerB.hasSession('identity-key')).resolves.toBe(false)
    await expect(managerB.pruneExpiredSessions()).resolves.toBe(1)
  })

  it('rejects invalid options and session records', async () => {
    expect(() => new KnexSessionManager(knexA, { ttlMs: 0 })).toThrow('ttlMs')
    await expect(managerA.addSession(makeSession({ sessionNonce: undefined }))).rejects.toThrow('sessionNonce')
    await expect(managerA.addSession(makeSession({ lastUpdate: Number.NaN }))).rejects.toThrow('lastUpdate')
    await expect(managerA.addSession(makeSession({ lastUpdate: Number.MAX_SAFE_INTEGER }))).rejects.toThrow('safe integer')
  })
})

function makeSession (overrides: Partial<PeerSession> = {}): PeerSession {
  return {
    isAuthenticated: false,
    sessionNonce: 'session-nonce',
    peerIdentityKey: 'identity-key',
    lastUpdate: 1_000,
    certificatesRequired: false,
    certificatesValidated: true,
    ...overrides
  }
}
