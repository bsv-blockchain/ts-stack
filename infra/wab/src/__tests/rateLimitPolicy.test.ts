import express, { type Express } from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  authenticatedIdentityKey,
  configureTrustProxy,
  rateLimitOptions
} from '../security/rateLimitPolicy'

async function withServer (
  app: Express,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  try {
    const address = server.address()
    if (address == null || typeof address === 'string') throw new Error('missing test server address')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error == null ? resolve() : reject(error))
    })
  }
}

describe('rate-limit security policy', () => {
  afterEach(() => {
    delete process.env.TEST_RATE_LIMIT_MAX
    delete process.env.TEST_RATE_LIMIT_WINDOW_MS
  })

  it('returns a stable 429 response and standard rate-limit headers', async () => {
    const app = express()
    app.use(rateLimit(rateLimitOptions(
      'TEST_RATE_LIMIT',
      { windowMs: 60_000, limit: 1 }
    )))
    app.post('/protected', (_req, res) => res.sendStatus(204))

    await withServer(app, async url => {
      expect((await fetch(`${url}/protected`, { method: 'POST' })).status).toBe(204)
      const rejected = await fetch(`${url}/protected`, { method: 'POST' })
      expect(rejected.status).toBe(429)
      expect(rejected.headers.has('ratelimit')).toBe(true)
      await expect(rejected.json()).resolves.toEqual({
        status: 'error',
        code: 'ERR_RATE_LIMITED',
        description: 'Too many requests. Please retry later.'
      })
    })
  })

  it('isolates authenticated identity buckets and safely falls back to IP', async () => {
    const app = express()
    app.use((req, _res, next) => {
      ;(req as typeof req & { auth?: { identityKey?: string } }).auth = {
        identityKey: req.header('x-test-identity') ?? undefined
      }
      next()
    })
    app.use(rateLimit(rateLimitOptions(
      'TEST_RATE_LIMIT',
      { windowMs: 60_000, limit: 1 },
      { keyGenerator: authenticatedIdentityKey }
    )))
    app.get('/protected', (_req, res) => res.sendStatus(204))

    await withServer(app, async url => {
      expect((await fetch(`${url}/protected`, { headers: { 'x-test-identity': 'alice' } })).status).toBe(204)
      expect((await fetch(`${url}/protected`, { headers: { 'x-test-identity': 'bob' } })).status).toBe(204)
      expect((await fetch(`${url}/protected`, { headers: { 'x-test-identity': 'alice' } })).status).toBe(429)
    })
  })

  it('trusts forwarding headers only when an explicit bounded hop count is configured', () => {
    const app = express()
    expect(app.get('trust proxy')).toBe(false)
    configureTrustProxy(app, '1')
    expect(app.get('trust proxy')).toBe(1)
    expect(() => configureTrustProxy(app, 'true')).toThrow(/TRUST_PROXY_HOPS/)
    expect(() => configureTrustProxy(app, '11')).toThrow(/TRUST_PROXY_HOPS/)
  })

  it('rejects invalid or unbounded environment overrides', () => {
    process.env.TEST_RATE_LIMIT_MAX = '0'
    expect(() => rateLimitOptions('TEST_RATE_LIMIT', {
      windowMs: 60_000,
      limit: 1
    })).toThrow(/positive integer/)

    process.env.TEST_RATE_LIMIT_MAX = '1000001'
    expect(() => rateLimitOptions('TEST_RATE_LIMIT', {
      windowMs: 60_000,
      limit: 1
    })).toThrow(/must not exceed/)
  })

  it.each(['-1', 'unlimited'])('allows an explicit %s rate-limit opt-out', value => {
    process.env.TEST_RATE_LIMIT_MAX = value
    expect(rateLimitOptions('TEST_RATE_LIMIT', {
      windowMs: 60_000,
      limit: 1
    }).limit).toBe(Number.MAX_SAFE_INTEGER)
  })
})
