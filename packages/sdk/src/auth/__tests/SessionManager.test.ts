import { SessionManager } from '../SessionManager'
import { PeerSession } from '../types'

describe('SessionManager', () => {
  let sessionManager: SessionManager
  let validSession: PeerSession
  let now: number

  beforeEach(() => {
    now = 1_000
    sessionManager = new SessionManager({ now: () => now })
    validSession = {
      isAuthenticated: false,
      sessionNonce: 'testSessionNonce',
      peerIdentityKey: 'testPeerIdentityKey',
      lastUpdate: now
    }
  })

  describe('addSession', () => {
    it('should add a session when sessionNonce and peerIdentityKey are present', () => {
      sessionManager.addSession(validSession)

      if (typeof validSession.sessionNonce === 'string') {
        expect(sessionManager.getSession(validSession.sessionNonce)).toBe(validSession)
      }

      if (typeof validSession.peerIdentityKey === 'string') {
        expect(sessionManager.getSession(validSession.peerIdentityKey)).toBe(validSession)
      }
    })

    it('should throw an error if sessionNonce and peerIdentityKey are missing', () => {
      const invalidSession = {
        ...validSession,
        sessionNonce: undefined,
        peerIdentityKey: undefined
      }

      expect(() => sessionManager.addSession(invalidSession)).toThrow(
        'Invalid session: sessionNonce is required to add a session.'
      )
    })

    it('should not throw an error if just peerIdentityKey is missing', () => {
      const invalidSession = { ...validSession, peerIdentityKey: undefined }

      expect(() => sessionManager.addSession(invalidSession)).not.toThrow(
        'Invalid session: peerIdentityKey is required.'
      )
    })
  })

  describe('getSession', () => {
    it('should retrieve a session by sessionNonce', () => {
      sessionManager.addSession(validSession)

      if (typeof validSession.sessionNonce === 'string') {
        const retrievedSession = sessionManager.getSession(validSession.sessionNonce)
        expect(retrievedSession).toBe(validSession)
      }
    })

    it('should retrieve a session by peerIdentityKey', () => {
      sessionManager.addSession(validSession)

      if (typeof validSession.peerIdentityKey === 'string') {
        const retrievedSession = sessionManager.getSession(validSession.peerIdentityKey)
        expect(retrievedSession).toBe(validSession)
      }
    })

    it('prefers an authorization-ready session over a newer certificate-pending one', () => {
      const ready = {
        ...validSession,
        sessionNonce: 'ready',
        isAuthenticated: true,
        certificatesRequired: true,
        certificatesValidated: true,
        lastUpdate: 900
      }
      const pending = {
        ...validSession,
        sessionNonce: 'pending',
        isAuthenticated: true,
        certificatesRequired: true,
        certificatesValidated: false,
        lastUpdate: 950
      }
      sessionManager.addSession(ready)
      sessionManager.addSession(pending)

      expect(sessionManager.getSession('testPeerIdentityKey')).toBe(ready)
    })

    it('should return undefined for a non-existent identifier', () => {
      const retrievedSession = sessionManager.getSession('nonExistentIdentifier')
      expect(retrievedSession).toBeUndefined()
    })

    it('rejects missing timestamps and prefers proven sessions over newer unsigned sessions', () => {
      expect(() =>
        sessionManager.addSession({
          ...validSession,
          sessionNonce: 'missing-time',
          lastUpdate: undefined
        })
      ).toThrow('lastUpdate')

      const sessions: PeerSession[] = [
        {
          ...validSession,
          sessionNonce: 'authenticated',
          isAuthenticated: true,
          lastUpdate: 900
        },
        {
          ...validSession,
          sessionNonce: 'newer-unsigned',
          lastUpdate: 950
        },
        {
          ...validSession,
          sessionNonce: 'older-unsigned',
          lastUpdate: 925
        }
      ]

      for (const session of sessions) {
        sessionManager.addSession(session)
      }

      expect(sessionManager.getSession('testPeerIdentityKey')).toBe(sessions[0])
    })
  })

  describe('removeSession', () => {
    it('should remove a session by both sessionNonce and peerIdentityKey', () => {
      sessionManager.addSession(validSession)

      sessionManager.removeSession(validSession)

      if (typeof validSession.sessionNonce === 'string') {
        expect(sessionManager.getSession(validSession.sessionNonce)).toBeUndefined()
      }
      if (typeof validSession.peerIdentityKey === 'string') {
        expect(sessionManager.getSession(validSession.peerIdentityKey)).toBeUndefined()
      }
    })

    it('should not throw an error when removing a session with undefined identifiers', () => {
      const sessionWithUndefinedIdentifiers = {
        ...validSession,
        sessionNonce: undefined,
        peerIdentityKey: undefined
      }

      expect(() => sessionManager.removeSession(sessionWithUndefinedIdentifiers)).not.toThrow()
    })
  })

  describe('hasSession', () => {
    it('should return true if a session exists for the identifier', () => {
      sessionManager.addSession(validSession)

      if (typeof validSession.sessionNonce === 'string') {
        expect(sessionManager.hasSession(validSession.sessionNonce)).toBe(true)
      }
      if (typeof validSession.peerIdentityKey === 'string') {
        expect(sessionManager.hasSession(validSession.peerIdentityKey)).toBe(true)
      }
    })

    it('should return false if no session exists for the identifier', () => {
      expect(sessionManager.hasSession('nonExistentIdentifier')).toBe(false)
    })
  })

  describe('security bounds', () => {
    it('expires idle sessions and removes their identity and replay indexes', () => {
      sessionManager.addSession(validSession)
      expect(sessionManager.claimMessageNonce('testSessionNonce', 'message-1')).toBe(true)
      expect(sessionManager.claimMessageNonce('testSessionNonce', 'message-1')).toBe(false)

      now += 30 * 60 * 1000
      expect(sessionManager.hasSession('testSessionNonce')).toBe(false)
      expect(sessionManager.hasSession('testPeerIdentityKey')).toBe(false)
      expect(() => sessionManager.claimMessageNonce('testSessionNonce', 'message-2')).toThrow(
        'Session not found'
      )
    })

    it('evicts the oldest unauthenticated session at capacity without stale identity entries', () => {
      const bounded = new SessionManager({ maxSessions: 2, now: () => now })
      const first = { ...validSession, sessionNonce: 'first', lastUpdate: 900 }
      const active = {
        ...validSession,
        sessionNonce: 'active',
        peerIdentityKey: 'active-key',
        isAuthenticated: true,
        lastUpdate: 800
      }
      const replacement = {
        ...validSession,
        sessionNonce: 'replacement',
        peerIdentityKey: 'replacement-key',
        lastUpdate: 950
      }
      bounded.addSession(first)
      bounded.addSession(active)
      bounded.addSession(replacement)

      expect(bounded.getSession('first')).toBeUndefined()
      expect(bounded.getSession('testPeerIdentityKey')).toBeUndefined()
      expect(bounded.getSession('active')).toBe(active)
      expect(bounded.getSession('replacement')).toBe(replacement)
    })

    it('does not let a new unsigned handshake evict authenticated sessions at capacity', () => {
      const bounded = new SessionManager({ maxSessions: 2, now: () => now })
      const first = {
        ...validSession,
        sessionNonce: 'authenticated-1',
        peerIdentityKey: 'identity-1',
        isAuthenticated: true
      }
      const second = {
        ...validSession,
        sessionNonce: 'authenticated-2',
        peerIdentityKey: 'identity-2',
        isAuthenticated: true
      }
      bounded.addSession(first)
      bounded.addSession(second)

      expect(() =>
        bounded.addSession({
          ...validSession,
          sessionNonce: 'attacker',
          peerIdentityKey: 'attacker-identity'
        })
      ).toThrow('authenticated sessions were preserved')
      expect(bounded.getSession('authenticated-1')).toBe(first)
      expect(bounded.getSession('authenticated-2')).toBe(second)
      expect(bounded.getSession('attacker')).toBeUndefined()
    })

    it('bounds nonce claims and validates manager options', () => {
      const bounded = new SessionManager({
        maxMessageNoncesPerSession: 1,
        now: () => now
      })
      bounded.addSession(validSession)
      expect(bounded.claimMessageNonce('testSessionNonce', 'first')).toBe(true)
      expect(() => bounded.claimMessageNonce('testSessionNonce', 'second')).toThrow('capacity')

      expect(() => new SessionManager({ maxSessions: 0 })).toThrow('maxSessions')
      expect(() => new SessionManager({ maxSessionIdleMs: 0 })).toThrow('maxSessionIdleMs')
      expect(() => new SessionManager({ maxMessageNoncesPerSession: 0 })).toThrow(
        'maxMessageNoncesPerSession'
      )
      expect(() => new SessionManager({ maxInitialRequestNonces: 0 })).toThrow(
        'maxInitialRequestNonces'
      )
    })

    it('rejects retained initial-request replays and evicts the oldest claim at capacity', () => {
      const bounded = new SessionManager({
        maxSessionIdleMs: 10,
        maxInitialRequestNonces: 1,
        now: () => now
      })
      expect(bounded.claimInitialRequestNonce('identity', 'initial')).toBe(true)
      expect(bounded.claimInitialRequestNonce('identity', 'initial')).toBe(false)
      expect(bounded.claimInitialRequestNonce('other', 'initial')).toBe(true)
      expect(bounded.claimInitialRequestNonce('other', 'initial')).toBe(false)
      // The evicted unsigned claim no longer causes a global availability
      // failure. Signed messages still retain their per-session fail-closed cap.
      expect(bounded.claimInitialRequestNonce('identity', 'initial')).toBe(true)

      now += 10
      expect(bounded.claimInitialRequestNonce('other', 'initial')).toBe(true)
    })

    it('bounds unsigned initial-request claims independently per identity', () => {
      const bounded = new SessionManager({
        maxInitialRequestNonces: 10,
        maxInitialRequestNoncesPerIdentity: 2,
        now: () => now
      })
      expect(bounded.claimInitialRequestNonce('alice', 'one')).toBe(true)
      expect(bounded.claimInitialRequestNonce('alice', 'two')).toBe(true)
      expect(bounded.claimInitialRequestNonce('bob', 'one')).toBe(true)
      expect(bounded.claimInitialRequestNonce('bob', 'one')).toBe(false)
      expect(bounded.claimInitialRequestNonce('alice', 'three')).toBe(true)
      expect(bounded.claimInitialRequestNonce('alice', 'one')).toBe(true)
      expect(bounded.claimInitialRequestNonce('bob', 'one')).toBe(false)
    })

    it('expires only the addressed session on reads instead of sweeping unrelated state', () => {
      const bounded = new SessionManager({ maxSessionIdleMs: 10, now: () => now })
      const expired = { ...validSession, sessionNonce: 'expired', lastUpdate: now }
      const current = {
        ...validSession,
        sessionNonce: 'current',
        peerIdentityKey: 'current-identity',
        lastUpdate: now + 9
      }
      bounded.addSession(expired)
      bounded.addSession(current)
      now += 10

      expect(bounded.getSession('current')).toBe(current)
      expect(bounded.getSession('expired')).toBeUndefined()
    })

    it('rejects stale sessions and invalid clocks', () => {
      const bounded = new SessionManager({ maxSessionIdleMs: 10, now: () => now })
      expect(() => bounded.addSession({ ...validSession, lastUpdate: now - 10 })).toThrow(
        'already-expired'
      )
      expect(() => new SessionManager({ now: () => Number.NaN }).hasSession('none')).toThrow(
        'now must return'
      )
    })

    it('removes the original identity index when a stored session identity changes', () => {
      sessionManager.addSession(validSession)
      validSession.peerIdentityKey = 'replacementIdentityKey'
      sessionManager.updateSession(validSession)

      expect(sessionManager.getSession('testPeerIdentityKey')).toBeUndefined()
      expect(sessionManager.getSession('replacementIdentityKey')).toBe(validSession)
    })
  })
})
