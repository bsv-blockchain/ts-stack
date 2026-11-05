import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import { HostWallet } from '../../test/support/wallets.js'
import { createEconomicQueryHost } from './handlers.js'
import { bytesProvider } from './providers.js'
import { createHostRateLimiter, rateLimitKey } from './rateLimit.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async server =>
        await new Promise<void>(resolve => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

async function serve(limit: number, identityKey?: string): Promise<string> {
  const app = express()
  app.use(express.json())
  if (identityKey !== undefined) {
    app.use((req, _res, next) => {
      ;(req as unknown as { auth: { identityKey: string } }).auth = { identityKey }
      next()
    })
  }
  createEconomicQueryHost({
    wallet: new HostWallet(),
    providers: [bytesProvider('relay-lookup', async () => [1])],
    rateLimit: { windowMs: 60_000, limit },
    logger: { error: () => undefined }
  }).mount(app)
  const server: Server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('host rate limit', () => {
  it('answers 429 ERR_RATE_LIMITED past the limit, across all three routes', async () => {
    const base = await serve(2)
    expect((await fetch(`${base}/economic/params`)).status).toBe(200)
    // An unauthenticated query is refused by the handler, but still spends the budget.
    const query = await fetch(`${base}/economic/query`, { method: 'POST' })
    expect(query.status).toBe(401)
    const limited = await fetch(`${base}/economic/params`)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({
      status: 'error',
      code: 'ERR_RATE_LIMITED',
      description: 'Too many requests. Please retry later.'
    })
    expect(limited.headers.get('ratelimit-policy')).toContain('2')
  })

  it('counts authenticated clients by identity key, and others by address', () => {
    const identityKey = `02${'ab'.repeat(32)}`
    expect(rateLimitKey({ auth: { identityKey }, ip: '127.0.0.1' })).toBe(`identity:${identityKey}`)
    expect(rateLimitKey({ auth: { identityKey: 'unknown' }, ip: '127.0.0.1' })).toBe('ip:127.0.0.1')
    expect(rateLimitKey({ socket: { remoteAddress: '10.0.0.1' } })).toBe('ip:10.0.0.1')
    // IPv6 clients are grouped by their /56, so one host cannot rotate addresses around the limit.
    expect(rateLimitKey({ ip: '2001:db8:1:2:3:4:5:6' })).toBe(
      rateLimitKey({ ip: '2001:db8:1:2:ff:ff:ff:ff' })
    )
  })

  it('gives each identity key its own budget', async () => {
    const base = await serve(1, `02${'cd'.repeat(32)}`)
    expect((await fetch(`${base}/economic/params`)).status).toBe(200)
    expect((await fetch(`${base}/economic/params`)).status).toBe(429)
  })

  it('rejects out-of-range limits', () => {
    expect(() => createHostRateLimiter({ limit: 0 })).toThrow(RangeError)
    expect(() => createHostRateLimiter({ windowMs: 24 * 60 * 60 * 1000 + 1 })).toThrow(RangeError)
    expect(() => createHostRateLimiter({ limit: 1.5 })).toThrow(RangeError)
  })
})
