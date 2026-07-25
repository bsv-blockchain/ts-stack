import express, { type Express } from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  authenticatedIdentityKey,
  configureTrustProxy,
  rateLimitOptions
} from '../RateLimitPolicy'
import { StorageServer } from '../StorageServer'

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

describe('StorageServer rate-limit policy', () => {
  test('isolates authenticated identities and returns a stable 429 response', async () => {
    const app = express()
    app.use((req, _res, next) => {
      ;(req as typeof req & { auth?: { identityKey?: string } }).auth = {
        identityKey: req.header('x-test-identity') ?? undefined
      }
      next()
    })
    app.use(rateLimit(rateLimitOptions(
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

  test('supports explicit proxy trust but rejects invalid hop counts', () => {
    const app = express()
    expect(app.get('trust proxy')).toBe(false)
    configureTrustProxy(app, 1)
    expect(app.get('trust proxy')).toBe(1)
    expect(() => configureTrustProxy(app, -1)).toThrow(/non-negative integer/)
    expect(() => configureTrustProxy(app, 1.5)).toThrow(/non-negative integer/)
  })

  test('StorageServer rejects over-budget work before authentication', async () => {
    const server = new StorageServer({} as any, {
      port: 0,
      wallet: {} as any,
      monetize: false,
      preAuthRateLimit: { limit: 1 }
    })
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      server.start()
      const httpServer = (server as any).server
      await new Promise<void>((resolve, reject) => {
        if (httpServer.listening) resolve()
        else {
          httpServer.once('listening', resolve)
          httpServer.once('error', reject)
        }
      })
      const address = httpServer.address()
      if (address == null || typeof address === 'string') throw new Error('missing test server address')
      const first = await fetch(`http://127.0.0.1:${address.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      expect(first.status).not.toBe(429)
      const rejected = await fetch(`http://127.0.0.1:${address.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      expect(rejected.status).toBe(429)
      await expect(rejected.json()).resolves.toMatchObject({ code: 'ERR_RATE_LIMITED' })
    } finally {
      await server.close()
      log.mockRestore()
    }
  })
})
