import express, { type Express } from 'express'
import { rateLimit } from 'express-rate-limit'
import { afterEach, describe, expect, it } from '@jest/globals'
import {
  authenticatedIdentityKey,
  configureTrustProxy,
  rateLimitOptions
} from './rateLimitPolicy'

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
  })

  it('enforces IP and authenticated-identity buckets with stable 429 responses', async () => {
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
      const rejected = await fetch(`${url}/protected`, { headers: { 'x-test-identity': 'alice' } })
      expect(rejected.status).toBe(429)
      expect(rejected.headers.has('ratelimit')).toBe(true)
      await expect(rejected.json()).resolves.toEqual({
        status: 'error',
        code: 'ERR_RATE_LIMITED',
        description: 'Too many requests. Please retry later.'
      })
    })
  })

  it('requires bounded numeric proxy and rate-limit configuration', () => {
    const app = express()
    configureTrustProxy(app, '1')
    expect(app.get('trust proxy')).toBe(1)
    expect(() => configureTrustProxy(app, 'true')).toThrow(/TRUST_PROXY_HOPS/)
    expect(() => configureTrustProxy(app, '11')).toThrow(/TRUST_PROXY_HOPS/)

    process.env.TEST_RATE_LIMIT_MAX = '0'
    expect(() => rateLimitOptions('TEST_RATE_LIMIT', {
      windowMs: 60_000,
      limit: 1
    })).toThrow(/positive integer/)
  })
})
