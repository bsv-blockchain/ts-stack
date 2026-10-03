import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, OUTPUT_PROFILES } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { MemoryStore, rateLimit } from 'express-rate-limit'
import { createRootEvictionRouter, type RootEvictionRouteOptions } from '../RootEvictionRoutes.js'
import { rootServiceFixture } from '../../../../application/output-knowledge/test/root-eviction-service-fixture.js'
import { rootContractKey } from '../../../../application/output-knowledge/test/root-contract-fixture.js'
import { requesterKey } from '../../../../application/output-knowledge/test/root-eviction-fixture.js'

export async function rootHTTPFixture(
  overrides: Partial<RootEvictionRouteOptions> = {},
  beforeParser = false
) {
  const f = await rootServiceFixture()
  const wallet = new CompletedProtoWallet(rootContractKey)
  const clientWallet = new CompletedProtoWallet(requesterKey)
  const originalSign = wallet.createSignature.bind(wallet)
  let onSign: (() => Promise<void> | void) | undefined
  wallet.createSignature = async (...args) => {
    const result = await originalSign(...args)
    await onSign?.()
    return result
  }
  const app = express()
  const rateStore = new MemoryStore()
  app.use(rateLimit({ windowMs: 60_000, limit: 1000, store: rateStore }))
  if (beforeParser) app.use(express.json())
  const auth = createAuthMiddleware({
    wallet,
    allowUnauthenticated: true,
    transportLimits: { requestTimeoutMs: 3000 }
  })
  const state = { manifest: f.selection.manifest as unknown, data: true, control: true }
  const options: RootEvictionRouteOptions = {
    companion: f.service(),
    journal: f.store,
    baseURL: 'https://root.example.test/api',
    authenticate: auth,
    manifest: () => state.manifest,
    authorize: (_identity, access) => (access === undefined ? state.control : state.data),
    ...overrides
  }
  app.use(createRootEvictionRouter(options))
  app.post('/lookup', (_req, res) => res.json({ type: 'output-list', outputs: [] }))
  app.get('/api/overlay/v1/capabilities', (_req, res) => res.status(404).end())
  const server = createServer({ maxHeaderSize: 65536 }, app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let wireCache = 'no-store'
  const wireHeaders: Headers[] = []
  const authenticated = new AuthFetch(
    clientWallet,
    undefined,
    undefined,
    undefined,
    { requestTimeoutMs: 3000 },
    async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('cache-control', wireCache)
      const response = await fetch(input, {
        ...init,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error'
      })
      wireHeaders.push(response.headers)
      return response
    }
  )
  // BRC-104 authenticates profile headers, not the HTTP cache-control field.
  // Apply that transport field at fetch, as the SDK lookup transport does.
  const client = {
    fetch: async (url: string, init: Parameters<AuthFetch['fetch']>[1] = {}) => {
      const headers = { ...(init.headers as Record<string, string>) }
      wireCache = headers['cache-control'] ?? 'no-store'
      delete headers['cache-control']
      return await authenticated.fetch(url, {
        ...init,
        headers,
        allowPayments: false,
        requireMutualAuth: true,
        expectedIdentityKey: rootContractKey.toPublicKey().toString()
      })
    }
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-bsv-overlay-capability': f.caller.capabilityDigest,
    'x-bsv-overlay-profile': OUTPUT_PROFILES.eviction
  }
  return {
    ...f,
    options,
    stateHTTP: state,
    client,
    wireHeaders,
    origin,
    headers,
    onHTTPSign(callback: () => Promise<void> | void) {
      onSign = callback
    },
    async fetch(
      operation: 'request' | 'status' = 'request',
      text = operation === 'request' ? f.text : f.statusText
    ) {
      return await client.fetch(origin + '/api/overlay/v1/root-evictions/' + operation, {
        method: 'POST',
        headers,
        body: text
      })
    },
    async cleanup() {
      server.closeAllConnections()
      try {
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      } finally {
        rateStore.shutdown()
        await f.cleanup()
      }
    }
  }
}
