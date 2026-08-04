import { PeerSession } from '@bsv/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Knex, knex as makeKnex } from 'knex'
import { AUTH_SESSION_MIGRATION, KnexMigrations } from '../../schema/KnexMigrations'
import { AUTH_SESSION_TABLE, KnexSessionManager } from '../KnexSessionManager'

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

  it('coalesces only recent timestamp touches for a row-backed authenticated session', async () => {
    await managerA.addSession(makeSession({
      isAuthenticated: true,
      lastUpdate: 1_000
    }))
    const session = await managerB.getSession('session-nonce')
    expect(session).toBeDefined()

    now = 1_010
    session!.lastUpdate = now
    await managerB.updateSession(session!)
    await expect(knexA(AUTH_SESSION_TABLE).where({ sessionNonce: 'session-nonce' }).first())
      .resolves.toMatchObject({ lastUpdate: 1_000, expiresAt: 1_100 })

    // The test TTL gives the default touch window a 25 ms boundary. Reaching
    // that boundary refreshes the durable timestamp and expiration.
    now = 1_025
    session!.lastUpdate = now
    await managerB.updateSession(session!)
    await expect(knexA(AUTH_SESSION_TABLE).where({ sessionNonce: 'session-nonce' }).first())
      .resolves.toMatchObject({ lastUpdate: 1_025, expiresAt: 1_125 })
  })

  it('persists security-state transitions and supports exact timestamp persistence', async () => {
    await managerA.addSession(makeSession({
      isAuthenticated: true,
      certificatesRequired: true,
      certificatesValidated: false
    }))
    const session = await managerB.getSession('session-nonce')
    expect(session).toBeDefined()

    now = 1_005
    session!.lastUpdate = now
    session!.certificatesValidated = true
    await managerB.updateSession(session!)
    await expect(knexA(AUTH_SESSION_TABLE).where({ sessionNonce: 'session-nonce' }).first())
      .resolves.toMatchObject({ lastUpdate: 1_005, certificatesValidated: 1 })

    const exactManager = new KnexSessionManager(knexB, {
      ttlMs: 100,
      touchIntervalMs: 0,
      now: () => now
    })
    const exactSession = await exactManager.getSession('session-nonce')
    expect(exactSession).toBeDefined()
    now = 1_006
    exactSession!.lastUpdate = now
    await exactManager.updateSession(exactSession!)
    await expect(knexA(AUTH_SESSION_TABLE).where({ sessionNonce: 'session-nonce' }).first())
      .resolves.toMatchObject({ lastUpdate: 1_006, expiresAt: 1_106 })
  })

  it('retries a current session update after a concurrent insert becomes visible', async () => {
    const session = makeSession()
    await managerA.addSession(session)
    const update = jest.spyOn(managerA as any, 'updateIfCurrentOrNewer')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)

    await managerA.addSession(session)

    expect(update).toHaveBeenCalledTimes(2)

    update.mockClear()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
    await managerA.addSession(session)
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('recovers from a duplicate-key insert race and preserves other insert failures', async () => {
    const duplicateInsert = jest.fn(async () => await Promise.reject(
      Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
    ))
    const failingInsert = jest.fn(async () => await Promise.reject(new Error('database unavailable')))
    const makeKnex = (insert: jest.Mock): Knex => {
      const first = jest.fn(async () => undefined)
      const where = jest.fn(() => ({ first }))
      return jest.fn(() => ({ where, insert })) as unknown as Knex
    }

    const duplicateManager = new KnexSessionManager(makeKnex(duplicateInsert))
    const duplicateUpdate = jest.spyOn(duplicateManager as any, 'updateIfCurrentOrNewer')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
    await duplicateManager.addSession(makeSession())
    expect(duplicateUpdate).toHaveBeenCalledTimes(2)

    const unchangedManager = new KnexSessionManager(makeKnex(duplicateInsert))
    const unchangedUpdate = jest.spyOn(unchangedManager as any, 'updateIfCurrentOrNewer')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
    await unchangedManager.addSession(makeSession())
    expect(unchangedUpdate).toHaveBeenCalledTimes(2)

    const failingManager = new KnexSessionManager(makeKnex(failingInsert))
    jest.spyOn(failingManager as any, 'updateIfCurrentOrNewer').mockResolvedValueOnce(0)
    await expect(failingManager.addSession(makeSession())).rejects.toThrow('database unavailable')
  })

  it('rejects invalid options and session records', async () => {
    expect(() => new KnexSessionManager(knexA, { ttlMs: 0 })).toThrow('ttlMs')
    expect(() => new KnexSessionManager(knexA, { touchIntervalMs: -1 })).toThrow('touchIntervalMs')
    expect(() => new KnexSessionManager(knexA, { touchIntervalMs: 1.5 })).toThrow('touchIntervalMs')
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
