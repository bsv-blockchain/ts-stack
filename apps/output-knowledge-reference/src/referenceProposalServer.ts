import express from 'express'
import { createServer, type ServerOptions } from 'node:https'
import type { AddressInfo } from 'node:net'
import { rateLimit } from 'express-rate-limit'
import { CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import type { Engine } from '@bsv/overlay'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createProposalRouter } from '@bsv/overlay-express/proposals'
import { createOutputLookupRouter } from '@bsv/overlay-express/output-lookup'
import { fixtureChain } from './fixtureChain.js'
import {
  createReferenceProposalProvider,
  REFERENCE_PROPOSAL_SERVICE,
  referenceProposalClock
} from './referenceProposalProvider.js'

/** Owned loopback HTTPS fixture. TLS material and actual admission lifetime stay with the installer. */
export async function startReferenceProposalServer(options: {
  path: string
  create: boolean
  identityKey: PrivateKey
  admissionEngine: Engine
  tls: Pick<ServerOptions, 'cert' | 'key'>
  staticDirectory: string
  port?: number
  onFailure?(error: unknown): void
}) {
  const app = express(),
    server = createServer({ ...options.tls, maxHeaderSize: 16384, requestTimeout: 30000 }, app)
  app.disable('x-powered-by')
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4176, '127.0.0.1', resolve)
  })
  const origin = 'https://127.0.0.1:' + (server.address() as AddressInfo).port,
    host = {
      id: 'working-documents',
      baseURL: origin + '/api',
      identity: options.identityKey.toPublicKey().toString(),
      service: REFERENCE_PROPOSAL_SERVICE
    }
  let provider: Awaited<ReturnType<typeof createReferenceProposalProvider>> | undefined
  const stopListener = async () => {
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
  }
  try {
    provider = await createReferenceProposalProvider({ ...options, baseURL: host.baseURL })
    const owned = provider
    const authenticate = createAuthMiddleware({
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
      res.set({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      })
      if (req.headers.host !== new URL(origin).host) {
        res.status(403).end()
        return
      }
      next()
    })
    app.use(rateLimit({ windowMs: 60000, limit: 600 }))
    app.get('/', (_req, res) => res.redirect('/proposal.html'))
    app.get('/demo/config', (_req, res) => res.json({ fixture: true, host }))
    // Discovery explicitly refreshes the signed advertisement. Old subscriptions
    // retain their original contract/session; no recovery path rediscovers it.
    app.get('/api/overlay/v1/capabilities', (_req, res) => res.json(owned.refreshManifest()))
    app.use(
      createOutputLookupRouter({
        companion: owned.lookup,
        disclosure: owned.lookupDisclosure,
        service: REFERENCE_PROPOSAL_SERVICE,
        baseURL: host.baseURL,
        identity: host.identity,
        chain: fixtureChain,
        authentication: 'brc103',
        authenticate,
        manifest: owned.manifest,
        now: referenceProposalClock,
        allowedOrigins: [origin]
      })
    )
    app.use(
      createProposalRouter({
        service: owned.service,
        disclosure: owned.disclosure,
        journal: owned.owner.journal,
        baseURL: host.baseURL,
        authenticate,
        authorizeControl: owned.current,
        allowedOrigins: [origin]
      })
    )
    app.use(express.static(options.staticDirectory))
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
    let closing: Promise<void> | undefined
    return {
      host,
      origin,
      provider: owned,
      close() {
        closing ??= (async () => {
          try {
            await stopListener()
          } finally {
            await owned.close()
          }
        })()
        return closing
      }
    }
  } catch (error) {
    try {
      await stopListener()
    } finally {
      await provider?.close()
    }
    throw error
  }
}
