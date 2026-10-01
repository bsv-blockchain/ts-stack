import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { RequestHandler } from 'express'
import { SessionManager } from '@bsv/sdk'
import { AuthRequest, createAuthMiddleware } from '@bsv/auth-express-middleware'
import { _tu, TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { StorageClient } from '../StorageClient'
import { StorageServer } from '../StorageServer'

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0)
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { server, url: `http://localhost:${port}` }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

describe('StorageServer mounted in a host application', () => {
  let remote: TestWalletNoSetup

  beforeAll(async () => {
    remote = await _tu.createSQLiteTestWallet({ databaseName: 'storageServerMount', dropAll: true })
  })

  afterAll(async () => {
    await remote.wallet.destroy()
  })

  test('serves JSON-RPC under a sub-path while the host handles the shared BRC-104 handshake', async () => {
    const sessionManager = new SessionManager()
    const storageServer = new StorageServer(remote.activeStorage, {
      wallet: remote.wallet,
      monetize: false,
      logRpcRequests: false,
      sessionManager
    })
    const host = express()
    host.use('/storage', storageServer.app)
    host.use(express.json())
    host.use(createAuthMiddleware({ wallet: remote.wallet, sessionManager }))
    const { server, url } = await listen(host)
    const client = new StorageClient(remote.wallet, `${url}/storage`)
    try {
      const settings = await client.makeAvailable()
      expect(settings.storageIdentityKey).toBe(remote.activeStorage.getSettings().storageIdentityKey)
      const { user } = await client.findOrInsertUser(remote.identityKey)
      expect(user.identityKey).toBe(remote.identityKey)

      const health = await fetch(`${url}/storage/healthz`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ status: 'ok' })
    } finally {
      await client.destroy()
      await closeServer(server)
    }
  })

  test('omits the unauthenticated GET routes when publicRoutes is false', async () => {
    const host = express()
    host.use(
      '/default',
      new StorageServer(remote.activeStorage, { wallet: remote.wallet, monetize: false, logRpcRequests: false }).app
    )
    host.use(
      '/private',
      new StorageServer(remote.activeStorage, {
        wallet: remote.wallet,
        monetize: false,
        logRpcRequests: false,
        publicRoutes: false
      }).app
    )
    const { server, url } = await listen(host)
    try {
      const info = await fetch(`${url}/default`)
      expect(info.status).toBe(200)
      expect(await info.text()).toBe(`BRC-100 ${remote.wallet.chain}Net Storage Provider.`)
      expect(await (await fetch(`${url}/default/robots.txt`)).text()).toBe('User-agent: *\nDisallow: /')
      expect((await fetch(`${url}/default/healthz`)).status).toBe(200)

      for (const path of ['', '/robots.txt', '/healthz']) {
        expect((await fetch(`${url}/private${path}`)).status).toBe(401)
      }
    } finally {
      await closeServer(server)
    }
  })

  test('start() requires a port', () => {
    const storageServer = new StorageServer(remote.activeStorage, { wallet: remote.wallet, monetize: false })
    expect(() => storageServer.start()).toThrow(WERR_INVALID_PARAMETER)
  })
})

describe('StorageServer preRpcMiddleware', () => {
  let remote: TestWalletNoSetup

  beforeAll(async () => {
    remote = await _tu.createSQLiteTestWallet({ databaseName: 'storageServerPreRpc', dropAll: true })
  })

  afterAll(async () => {
    await remote.wallet.destroy()
  })

  test('runs after authentication and can respond without dispatching the RPC', async () => {
    const seen: Array<{ identityKey?: string; method?: string }> = []
    let full = true
    const quota: RequestHandler = (req, res, next) => {
      seen.push({ identityKey: (req as AuthRequest).auth?.identityKey, method: req.body?.method })
      if (full) {
        res.status(507).json({ status: 'error', code: 'ERR_QUOTA_EXCEEDED' })
        return
      }
      next()
    }
    const storageServer = new StorageServer(remote.activeStorage, {
      port: 0,
      wallet: remote.wallet,
      monetize: false,
      logRpcRequests: false,
      preRpcMiddleware: [quota]
    })
    storageServer.start()
    if (!storageServer.server.listening) await once(storageServer.server, 'listening')
    const { port } = storageServer.server.address() as AddressInfo
    const url = `http://localhost:${port}`
    const client = new StorageClient(remote.wallet, url)
    const dispatch = jest.spyOn(remote.activeStorage, 'makeAvailable')
    try {
      const unauthenticated = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'makeAvailable', params: [], id: 1 })
      })
      expect(unauthenticated.status).toBe(401)
      expect(seen).toEqual([])

      await expect(client.makeAvailable()).rejects.toThrow('network error 507')
      expect(seen).toEqual([{ identityKey: remote.identityKey, method: 'makeAvailable' }])
      expect(dispatch).not.toHaveBeenCalled()

      full = false
      const settings = await client.makeAvailable()
      expect(settings.storageIdentityKey).toBe(remote.activeStorage.getSettings().storageIdentityKey)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(seen).toHaveLength(2)
    } finally {
      dispatch.mockRestore()
      await client.destroy()
      await storageServer.close()
    }
  })

  test('dispatches unchanged without preRpcMiddleware', async () => {
    const storageServer = new StorageServer(remote.activeStorage, {
      port: 0,
      wallet: remote.wallet,
      monetize: false,
      logRpcRequests: false
    })
    storageServer.start()
    if (!storageServer.server.listening) await once(storageServer.server, 'listening')
    const { port } = storageServer.server.address() as AddressInfo
    const client = new StorageClient(remote.wallet, `http://localhost:${port}`)
    try {
      const settings = await client.makeAvailable()
      expect(settings.storageIdentityKey).toBe(remote.activeStorage.getSettings().storageIdentityKey)
    } finally {
      await client.destroy()
      await storageServer.close()
    }
  })
})
