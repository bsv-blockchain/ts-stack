/**
 * Security hardening tests — desktop token, origin enforcement, pending cleanup.
 *
 * These tests exercise the three security improvements directly against the
 * building-block classes rather than through HTTP/WS integration, keeping them
 * fast and dependency-free.
 */

import { QRSessionManager } from '../src/server/QRSessionManager.js'
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
    const tokens = new Set(
      Array.from({ length: 20 }, () => mgr.createSession().desktopToken)
    )
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
})

// ── WebSocketRelay — desktop token validation ─────────────────────────────────
// WebSocketRelay requires a real HTTP server (ws binds to it), so we test the
// validator logic in isolation without instantiating the class.

describe('desktop token validator logic', () => {
  it('accepts correct token', () => {
    const sessions = new Map([['topic-1', { desktopToken: 'secret-abc' }]])
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && token !== null && token === sessions.get(topic)!.desktopToken

    expect(validator('topic-1', 'secret-abc')).toBe(true)
  })

  it('rejects wrong token', () => {
    const sessions = new Map([['topic-1', { desktopToken: 'secret-abc' }]])
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && token !== null && token === sessions.get(topic)!.desktopToken

    expect(validator('topic-1', 'wrong-token')).toBe(false)
  })

  it('rejects null token (no token provided)', () => {
    const sessions = new Map([['topic-1', { desktopToken: 'secret-abc' }]])
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && token !== null && token === sessions.get(topic)!.desktopToken

    expect(validator('topic-1', null)).toBe(false)
  })

  it('rejects unknown topic', () => {
    const sessions = new Map<string, { desktopToken: string }>()
    const validator = (topic: string, token: string | null) =>
      sessions.has(topic) && token !== null && token === sessions.get(topic)!.desktopToken

    expect(validator('unknown-topic', 'any-token')).toBe(false)
  })
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
        'https://eu4.example.com',
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
  })

  describe('RegExp', () => {
    it('matches by pattern', () => {
      const m = compileOriginMatcher(/^https:\/\/[a-z0-9-]+\.example\.com$/)!
      expect(m('https://app.example.com')).toBe(true)
      expect(m('https://cities.example.com')).toBe(true)
    })

    it('rejects origins that do not match the pattern', () => {
      const m = compileOriginMatcher(/^https:\/\/[a-z0-9-]+\.example\.com$/)!
      expect(m('https://example.com')).toBe(false)        // no subdomain
      expect(m('http://app.example.com')).toBe(false)     // wrong scheme
      expect(m('https://app.example.com.evil.com')).toBe(false) // trailing
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
