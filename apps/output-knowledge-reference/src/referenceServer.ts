import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CompletedProtoWallet, PrivateKey, closedOutputObject, parseOutputJSON } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createOutputLookupRouter } from '@bsv/overlay-express/output-lookup'
import { createReferenceProvider, REFERENCE_SERVICE, referenceNow } from './referenceProvider.js'
import { fixtureChain } from './fixtureChain.js'
import type { ReferenceHost } from './referenceClient.js'

/** Deliberately loopback-only. The public fixture keys provide no production access control. */
export async function startReferenceServer(options: {
  path: string
  create: boolean
  id: string
  identityKey: PrivateKey
  port?: number
  allowedOrigins?: string[]
  peers?: ReferenceHost[]
  staticDirectory?: string
}) {
  const app = express()
  app.disable('x-powered-by')
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000 }, app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const host: ReferenceHost = {
    id: options.id,
    baseURL: origin + '/api',
    identity: options.identityKey.toPublicKey().toString()
  }
  let closeProvider: (() => Promise<void>) | undefined
  try {
    const provider = await createReferenceProvider({ ...options, baseURL: host.baseURL })
    closeProvider = () => provider.close()
    const auth = createAuthMiddleware({
      wallet: new CompletedProtoWallet(options.identityKey),
      allowUnauthenticated: true,
      transportLimits: {
        requestTimeoutMs: 5000,
        maxPendingRequests: 32,
        maxRequestBytes: 1048576,
        maxResponseBytes: 4194304
      }
    })
    app.use((req, res, next) => {
      res.set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.set(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' " +
          (options.allowedOrigins ?? []).map(value => new URL(value).origin).join(' ') +
          "; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      )
      if (req.headers.host !== new URL(origin).host) {
        res.status(403).end()
        return
      }
      next()
    })
    app.use(rateLimit({ windowMs: 60000, limit: 600 }))
    app.use(
      createOutputLookupRouter({
        companion: provider.service,
        disclosure: provider.disclosure,
        service: REFERENCE_SERVICE,
        baseURL: host.baseURL,
        identity: host.identity,
        chain: fixtureChain,
        authentication: 'brc103',
        authenticate: auth,
        manifest: provider.manifest,
        now: referenceNow,
        allowedOrigins: [...new Set([origin, ...(options.allowedOrigins ?? [])])],
        allowLocalHTTP: true
      })
    )
    app.get('/demo/config', (_req, res) => {
      res.json({ fixture: true, host, peers: options.peers ?? [] })
    })
    const writers = new Set([91, 92].map(key => new PrivateKey(key).toPublicKey().toString()))
    app.post(
      '/demo/command',
      express.raw({ type: 'application/json', limit: 1024, inflate: false }),
      auth,
      async (req, res) => {
        const identity = (req as express.Request & { auth?: { identityKey?: string } }).auth
          ?.identityKey
        if (!identity || !writers.has(identity)) {
          res.status(401).json({ error: 'unauthorized' })
          return
        }
        try {
          const body = parseOutputJSON(req.body, { bytes: 1024 })
          closedOutputObject(body, ['action'])
          const commands = {
            publish: provider.publish,
            replace: provider.replace,
            withdraw: provider.withdraw,
            reintroduce: provider.reintroduce
          }
          if (typeof body.action !== 'string' || !Object.hasOwn(commands, body.action)) {
            res.status(400).json({ error: 'invalid-command' })
            return
          }
          const sequence = await commands[body.action as keyof typeof commands]()
          res.json({ sequence })
        } catch {
          res.status(409).json({ error: 'command-not-committed' })
        }
      }
    )
    if (options.staticDirectory) app.use(express.static(options.staticDirectory))
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res.status(400).json({ error: 'invalid-request' })
      }
    )
    return {
      host,
      origin,
      provider,
      async close() {
        server.closeAllConnections()
        try {
          await new Promise<void>((resolve, reject) =>
            server.close(error => (error ? reject(error) : resolve()))
          )
        } finally {
          await provider.close()
        }
      }
    }
  } catch (error) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await closeProvider?.()
    throw error
  }
}
