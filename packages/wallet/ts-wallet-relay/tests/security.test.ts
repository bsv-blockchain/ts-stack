/**
 * Security hardening tests — desktop token, origin enforcement, pending cleanup.
 *
 * These tests exercise the three security improvements directly against the
 * building-block classes rather than through HTTP/WS integration, keeping them
 * fast and dependency-free.
 */

import { QRSessionManager } from '../src/server/QRSessionManager.js'
import { secureTokenEqual } from '../src/server/secureTokenEqual.js'
import { compileOriginMatcher } from '../src/shared/originMatcher.js'

// ── QRSessionManager — desktop token ─────────────────────────────────────────

describe('QRSessionManager — desktopToken', () => {
  it('generates a desktopToken on every new session', () => {
    const mgr = new QRSessionManager()
    const session = mgr.createSession()
    expect(typeof session.desktopToken).toBe('string')
    expect(session.desktopToken.length).toBeGreaterThan(0)
    mgr.stop()
  })

  it('generates a unique desktopToken for each session', () => {
    const mgr = new QRSessionManager()
    const tokens = new Set(Array.from({ length: 20 }, () => mgr.createSession().desktopToken))
    expect(tokens.size).toBe(20)
    mgr.stop()
  })

  it('exposes desktopToken via getSession', () => {
    const mgr = new QRSessionManager()
    const created = mgr.createSession()
    const retrieved = mgr.getSession(created.id)
    expect(retrieved?.desktopToken).toBe(created.desktopToken)
    mgr.stop()
  })

  it('records the backend identity key only on a known session', () => {
    const mgr = new QRSessionManager()
    const created = mgr.createSession()
    mgr.setBackendIdentityKey('unknown-session', '02' + 'a'.repeat(64))
    expect(mgr.getSession('unknown-session')).toBeNull()
    expect(mgr.getSession(created.id)?.backendIdentityKey).toBeUndefined()

    mgr.setBackendIdentityKey(created.id, '02' + 'b'.repeat(64))
    expect(mgr.getSession(created.id)?.backendIdentityKey).toBe('02' + 'b'.repeat(64))
    mgr.stop()
  })

  it('does not let repeated unauthenticated connects extend the pairing grace window', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const mgr = new QRSessionManager()
    const session = mgr.createSession()
    now.mockReturnValue(2_000)
    mgr.setPairingStarted(session.id)
    now.mockReturnValue(3_000)
    mgr.setPairingStarted(session.id)
    expect(mgr.getSession(session.id)?.pairingStartedAt).toBe(2_000)
    mgr.stop()
    now.mockRestore()
  })

  it('uses an absolute first-pairing TTL that reconnects cannot renew', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const onExpired = jest.fn()
    const mgr = new QRSessionManager()
    mgr.onSessionExpired(onExpired)
    const session = mgr.createSession()
    mgr.setStatus(session.id, 'connected')
    const firstExpiry = session.expiresAt

    now.mockReturnValue(10_000)
    mgr.setStatus(session.id, 'disconnected')
    mgr.setStatus(session.id, 'connected')
    expect(session.expiresAt).toBe(firstExpiry)
    expect(session.connectedAt).toBe(1_000)

    now.mockReturnValue(firstExpiry + 1)
    expect(mgr.getSession(session.id)?.status).toBe('expired')
    expect(onExpired).toHaveBeenCalledTimes(1)
    mgr.stop()
    now.mockRestore()
  })

  it('reclaims elapsed sessions before enforcing the capacity ceiling', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const mgr = new QRSessionManager({ maxSessions: 1 })
    const first = mgr.createSession()
    now.mockReturnValue(first.expiresAt + 1)
    expect(() => mgr.createSession()).not.toThrow()
    mgr.stop()
    now.mockRestore()
  })
})

// ── WebSocketRelay — desktop token validation ─────────────────────────────────
// WebSocketRelay requires a real HTTP server (ws binds to it), so we test the
// validator logic in isolation without instantiating the class.

describe('desktop token validator logic', () => {
  it('accepts correct token', () => {
    const sessions = new Map([['topic-1', { desktopToken: 'secret-abc' }]])
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && secureTokenEqual(sessions.get(topic)!.desktopToken, token)

    expect(validator('topic-1', 'secret-abc')).toBe(true)
  })

  it('rejects wrong token', () => {
    const sessions = new Map([['topic-1', { desktopToken: 'secret-abc' }]])
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && secureTokenEqual(sessions.get(topic)!.desktopToken, token)

    expect(validator('topic-1', 'wrong-token')).toBe(false)
  })

  it('rejects null token (no token provided)', () => {
    const sessions = new Map([['topic-1', { desktopToken: 'secret-abc' }]])
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && secureTokenEqual(sessions.get(topic)!.desktopToken, token)

    expect(validator('topic-1', null)).toBe(false)
  })

  it('rejects unknown topic', () => {
    const sessions = new Map([['topic-1', { desktopToken: 'secret-abc' }]])
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && secureTokenEqual(sessions.get(topic)!.desktopToken, token)

    expect(validator('unknown-topic', 'any-token')).toBe(false)
  })

  it.each(['xecret-abc', 'secret-abd', 'secret-abc-extra', ''])(
    'rejects mismatched token %j through the secure comparator',
    token => {
      expect(secureTokenEqual('secret-abc', token)).toBe(false)
    }
  )
})

// ── Origin enforcement logic ──────────────────────────────────────────────────

describe('origin header enforcement logic', () => {
  // Mirrors what WebSocketRelay.handleConnection does, using the real matcher.
  function shouldAllow(
    requestOrigin: string | undefined,
    matcher: ((o: string) => boolean) | null
  ): boolean {
    if (requestOrigin && matcher && !matcher(requestOrigin)) return false
    return true
  }

  it('allows when origin matches allowedOrigin', () => {
    const m = compileOriginMatcher('https://app.example.com')
    expect(shouldAllow('https://app.example.com', m)).toBe(true)
  })

  it('rejects when origin does not match allowedOrigin', () => {
    const m = compileOriginMatcher('https://app.example.com')
    expect(shouldAllow('https://evil.attacker.com', m)).toBe(false)
  })

  it('allows native clients that send no origin header', () => {
    const m = compileOriginMatcher('https://app.example.com')
    expect(shouldAllow(undefined, m)).toBe(true)
  })

  it('allows any origin when allowedOrigin is not configured', () => {
    expect(shouldAllow('https://any.example.com', null)).toBe(true)
  })
})

// ── compileOriginMatcher (allowlist shapes) ───────────────────────────────────

describe('compileOriginMatcher', () => {
  it('returns null when allowed is undefined', () => {
    expect(compileOriginMatcher(undefined)).toBeNull()
  })

  it('returns null when allowed is null', () => {
    expect(compileOriginMatcher(null)).toBeNull()
  })

  describe('string', () => {
    it('matches exact equality', () => {
      const m = compileOriginMatcher('https://app.example.com')!
      expect(m('https://app.example.com')).toBe(true)
    })

    it('rejects non-matching origin', () => {
      const m = compileOriginMatcher('https://app.example.com')!
      expect(m('https://evil.example.com')).toBe(false)
    })

    it('is case-sensitive (origin spec compliant)', () => {
      const m = compileOriginMatcher('https://app.example.com')!
      expect(m('https://APP.example.com')).toBe(false)
    })
  })

  describe('string array', () => {
    it('matches any value in the list', () => {
      const m = compileOriginMatcher([
        'https://app.example.com',
        'https://cities.example.com',
        'https://eu4.example.com'
      ])!
      expect(m('https://app.example.com')).toBe(true)
      expect(m('https://cities.example.com')).toBe(true)
      expect(m('https://eu4.example.com')).toBe(true)
    })

    it('rejects origins not in the list', () => {
      const m = compileOriginMatcher(['https://app.example.com'])!
      expect(m('https://evil.example.com')).toBe(false)
    })

    it('rejects when list is empty', () => {
      const m = compileOriginMatcher([])!
      expect(m('https://app.example.com')).toBe(false)
    })

    it('snapshots the allowlist and rejects invalid runtime entries', () => {
      const origins = ['https://app.example.com']
      const m = compileOriginMatcher(origins)!
      origins.push('https://evil.example.com')
      expect(m('https://evil.example.com')).toBe(false)
      expect(() => compileOriginMatcher([true] as never)).toThrow(/only strings/)
    })
  })

  describe('RegExp', () => {
    it('matches by pattern', () => {
      const m = compileOriginMatcher(/^https:\/\/[a-z0-9-]+\.example\.com$/)!
      expect(m('https://app.example.com')).toBe(true)
      expect(m('https://cities.example.com')).toBe(true)
    })

    it('rejects origins that do not match the pattern', () => {
      const m = compileOriginMatcher(/^https:\/\/[a-z0-9-]+\.example\.com$/)!
      expect(m('https://example.com')).toBe(false) // no subdomain
      expect(m('http://app.example.com')).toBe(false) // wrong scheme
      expect(m('https://app.example.com.evil.com')).toBe(false) // trailing
    })

    it('does not inherit mutable lastIndex state from global or sticky expressions', () => {
      for (const expression of [
        /^https:\/\/app\.example\.com$/g,
        /^https:\/\/app\.example\.com$/y
      ]) {
        const m = compileOriginMatcher(expression)!
        expect(m('https://app.example.com')).toBe(true)
        expect(m('https://app.example.com')).toBe(true)
        expect(expression.lastIndex).toBe(0)
      }
    })
  })

  describe('predicate function', () => {
    it('uses the function directly', () => {
      const calls: string[] = []
      const m = compileOriginMatcher((o: string) => {
        calls.push(o)
        return o.endsWith('.trusted.com')
      })!
      expect(m('https://app.trusted.com')).toBe(true)
      expect(m('https://evil.com')).toBe(false)
      expect(calls).toEqual(['https://app.trusted.com', 'https://evil.com'])
    })

    it('fails closed when a predicate throws or returns a non-boolean value at runtime', () => {
      expect(
        compileOriginMatcher(() => {
          throw new Error('parser failed')
        })!('https://app')
      ).toBe(false)
      expect(compileOriginMatcher((() => 'yes') as never)!('https://app')).toBe(false)
    })
  })

  it('rejects an invalid runtime matcher instead of silently disabling the allowlist', () => {
    expect(() => compileOriginMatcher(42 as never)).toThrow(/allowedOrigins/)
  })
})

// ── Token uniqueness / entropy ────────────────────────────────────────────────

describe('desktop token entropy', () => {
  it('token is base64url (no +, /, or = characters)', () => {
    const mgr = new QRSessionManager()
    const { desktopToken } = mgr.createSession()
    expect(desktopToken).toMatch(/^[A-Za-z0-9_-]+$/)
    mgr.stop()
  })

  it('token has at least 24 bytes of entropy (32+ chars in base64url)', () => {
    // 24 raw bytes → 32 base64url chars
    const mgr = new QRSessionManager()
    const { desktopToken } = mgr.createSession()
    expect(desktopToken.length).toBeGreaterThanOrEqual(32)
    mgr.stop()
  })
})
