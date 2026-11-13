import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, PrivateKey, SessionManager } from '@bsv/sdk'
import { createAuthMiddleware, type AuthRequest } from '../index'

const serverIdentity = new PrivateKey(1).toPublicKey().toString()
const clientIdentity = new PrivateKey(43).toPublicKey().toString()
const servers: Server[] = []

async function endpoint(authenticated: boolean) {
  const app = express()
  app.use(rateLimit({ windowMs: 60_000, limit: 300 }))
  const sessionManager = new SessionManager()
  const requests: string[] = []
  let writes = 0
  app.use((req, _res, next) => {
    requests.push(req.path)
    next()
  })
  app.use(express.json())
  if (authenticated) {
    app.use(
      createAuthMiddleware({ wallet: new CompletedProtoWallet(new PrivateKey(1)), sessionManager })
    )
  } else {
    app.post('/.well-known/auth', (_req, res) => {
      res.status(404).end()
    })
  }
  app.post('/private', (req: AuthRequest, res) => {
    writes++
    res.json({ caller: req.auth?.identityKey, body: req.body })
  })
  app.post('/unpaid', (_req, res) => {
    res.status(402).json({ payment: 'not authorized' })
  })
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    sessionManager,
    writes: () => writes
  }
}

function client() {
  const wallet = new CompletedProtoWallet(new PrivateKey(43))
  const payment = jest.spyOn(wallet, 'createAction')
  return { authFetch: new AuthFetch(wallet), payment }
}

afterEach(async () => {
  jest.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

describe('explicit AuthFetch policy over real local BRC-103/104 HTTP', () => {
  test('pins the server and authenticates the caller and body before route execution', async () => {
    const host = await endpoint(true)
    const { authFetch, payment } = client()
    const result = await authFetch.fetch(`${host.origin}/private`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'owned test data' }),
      expectedIdentityKey: serverIdentity,
      allowPayments: false
    })
    expect(result.headers.get('x-bsv-auth-identity-key')).toBe(serverIdentity)
    expect(await result.json()).toEqual({
      caller: clientIdentity,
      body: { message: 'owned test data' }
    })
    expect(host.writes()).toBe(1)
    expect(host.requests).toEqual(['/.well-known/auth', '/private'])
    expect(payment).not.toHaveBeenCalled()
  })

  test('rejects a different handshake identity before sending the application request', async () => {
    const host = await endpoint(true)
    const { authFetch, payment } = client()
    await expect(
      authFetch.fetch(`${host.origin}/private`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'owned test data' }),
        expectedIdentityKey: new PrivateKey(44).toPublicKey().toString()
      })
    ).rejects.toThrow('initialResponse identity does not match the requested peer identity')
    expect(host.writes()).toBe(0)
    expect(host.requests).toEqual(['/.well-known/auth'])
    expect(payment).not.toHaveBeenCalled()
  })

  test.each([{ requireMutualAuth: true }, { expectedIdentityKey: serverIdentity }])(
    'does not send application data after an HTTP-only handshake: %j',
    async policy => {
      const host = await endpoint(false)
      const { authFetch, payment } = client()
      await expect(
        authFetch.fetch(`${host.origin}/private`, {
          ...policy,
          method: 'POST',
          body: 'owned test data'
        })
      ).rejects.toThrow('without valid BSV authentication')
      expect(host.writes()).toBe(0)
      expect(host.requests).toEqual(['/.well-known/auth'])
      expect(payment).not.toHaveBeenCalled()
    }
  )

  test('preserves refusal of an unsigned handshake error for default callers', async () => {
    const host = await endpoint(false)
    const { authFetch } = client()
    await expect(authFetch.fetch(`${host.origin}/private`, { method: 'POST' })).rejects.toThrow(
      'without valid BSV authentication'
    )
    expect(host.requests).toEqual(['/.well-known/auth'])
    expect(host.writes()).toBe(0)
  })

  test('returns an authenticated unpaid 402 without invoking wallet payment', async () => {
    const host = await endpoint(true)
    const { authFetch, payment } = client()
    const result = await authFetch.fetch(`${host.origin}/unpaid`, {
      method: 'POST',
      expectedIdentityKey: serverIdentity,
      allowPayments: false
    })
    expect(result.status).toBe(402)
    expect(result.headers.get('x-bsv-auth-identity-key')).toBe(serverIdentity)
    expect(await result.json()).toEqual({ payment: 'not authorized' })
    expect(payment).not.toHaveBeenCalled()
  })

  test('recovers an expired server session with the original pin and payment opt-out', async () => {
    const host = await endpoint(true)
    const { authFetch, payment } = client()
    const options = { method: 'POST', expectedIdentityKey: serverIdentity, allowPayments: false }
    expect((await authFetch.fetch(`${host.origin}/private`, options)).status).toBe(200)
    const session = host.sessionManager.getSession(clientIdentity)
    expect(session).toBeDefined()
    host.sessionManager.removeSession(session!)
    const result = await authFetch.fetch(`${host.origin}/unpaid`, options)
    expect(result.status).toBe(402)
    expect(result.headers.get('x-bsv-auth-identity-key')).toBe(serverIdentity)
    expect(host.requests).toEqual([
      '/.well-known/auth',
      '/private',
      '/unpaid',
      '/.well-known/auth',
      '/unpaid'
    ])
    expect(host.writes()).toBe(1)
    expect(payment).not.toHaveBeenCalled()
  })
})
