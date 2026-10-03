import express, { type Express, type RequestHandler } from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPrivatePublicationRouter } from '../PrivatePublicationRoutes.js'
import type { PrivatePublicationRouteOptions } from '../PrivatePublicationHTTPPorts.js'
import { PrivatePublicationDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePublicationDisclosure.js'
import { coordinatorFixture } from '../../../../application/output-knowledge/test/private-publication-coordinator-fixture.js'

export async function privatePublicationHTTPFixture(
  overrides:
    | Partial<PrivatePublicationRouteOptions>
    | ((
        owner: ReturnType<typeof coordinatorFixture>
      ) => Promise<Partial<PrivatePublicationRouteOptions>>) = {},
  beforeParser = false,
  mount?: (
    app: Express,
    authenticate: RequestHandler,
    owner: ReturnType<typeof coordinatorFixture>
  ) => void | Promise<void>
) {
  const f = coordinatorFixture()
  const httpState = { control: true }
  const disclosure = new PrivatePublicationDisclosure(
    f.native.owner,
    f.store,
    f.contract.contracts,
    f.options.access,
    f.options.clock,
    () => httpState.control
  )
  const wallet = new CompletedProtoWallet(f.contract.key)
  const sign = wallet.createSignature.bind(wallet)
  let onSign: (() => void | Promise<void>) | undefined
  wallet.createSignature = async (...args) => {
    const result = await sign(...args)
    await onSign?.()
    return result
  }
  const app = express()
  if (beforeParser) app.use(express.json())
  const auth = createAuthMiddleware({
    wallet,
    allowUnauthenticated: true,
    transportLimits: { requestTimeoutMs: 3000 }
  })
  const installed = typeof overrides === 'function' ? await overrides(f) : overrides
  const options: PrivatePublicationRouteOptions = {
    service: f.coordinator,
    disclosure,
    baseURL: f.contract.installation.baseURL,
    authenticate: auth,
    requestTimeoutMs: 10000,
    ...installed
  }
  app.use(createPrivatePublicationRouter(options))
  await mount?.(app, auth, f)
  app.post('/lookup', express.json(), (_req, res) => res.json({ type: 'output-list', outputs: [] }))
  const server = createServer({ maxHeaderSize: 65536 }, app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-bsv-overlay-capability': f.caller.capability,
    'x-bsv-overlay-profile': f.caller.profile
  }
  const wireHeaders: Headers[] = []
  const clientFor = (key: PrivateKey, signal?: AbortSignal) => {
    let wireCache = 'no-store'
    const authenticated = new AuthFetch(
      new CompletedProtoWallet(key),
      undefined,
      undefined,
      undefined,
      { requestTimeoutMs: 3000 },
      async (input, init) => {
        const sent = new Headers(init?.headers)
        sent.set('cache-control', wireCache)
        const response = await fetch(input, {
          ...init,
          headers: sent,
          signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error'
        })
        wireHeaders.push(response.headers)
        return response
      }
    )
    return {
      fetch: async (url: string, init: Parameters<AuthFetch['fetch']>[1] = {}) => {
        const selected = { ...(init.headers as Record<string, string>) }
        wireCache = selected['cache-control'] ?? 'no-store'
        delete selected['cache-control']
        return await authenticated.fetch(url, {
          ...init,
          headers: selected,
          allowPayments: false,
          requireMutualAuth: true,
          expectedIdentityKey: f.contract.installation.seller
        })
      }
    }
  }
  const client = clientFor(new PrivateKey(63))
  return {
    ...f,
    disclosure,
    httpState,
    options,
    client,
    clientFor,
    wireHeaders,
    origin,
    headers,
    onHTTPSign(callback?: () => void | Promise<void>) {
      onSign = callback
    },
    async fetch(operation: 'publish' | 'status' = 'publish', text?: string) {
      return await client.fetch(origin + '/api/overlay/v1/private/' + operation, {
        method: 'POST',
        headers,
        body: text ?? JSON.stringify(operation === 'publish' ? f.contract.request : f.status)
      })
    },
    async close() {
      await f.coordinator.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
      f.cleanup()
    }
  }
}
