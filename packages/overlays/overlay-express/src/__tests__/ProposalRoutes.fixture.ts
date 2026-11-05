import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, OUTPUT_PROFILES, type PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { MemoryStore, rateLimit } from 'express-rate-limit'
import {
  createProposalRouter,
  type ProposalRouteOptions,
  type ProposalHTTPOperation
} from '../ProposalRoutes.js'
import type { ProposalJournalEntry } from '../../../../application/output-knowledge/src/proposals/ProposalJournal.js'
import { proposalDisclosureFixture } from '../../../../application/output-knowledge/test/proposal-disclosure-fixture.js'
import { authorKey } from '../../../../application/output-knowledge/test/proposal-fixture.js'

export async function proposalHTTPFixture(
  overrides: Partial<ProposalRouteOptions<ProposalJournalEntry>> = {},
  beforeParser = false
) {
  const f = await proposalDisclosureFixture()
  const wallet = new CompletedProtoWallet(authorKey)
  const sign = wallet.createSignature.bind(wallet)
  let onSign: (() => void | Promise<void>) | undefined
  wallet.createSignature = async (...args) => {
    const result = await sign(...args)
    await onSign?.()
    return result
  }
  const app = express(),
    rateStore = new MemoryStore()
  app.use(rateLimit({ windowMs: 60_000, limit: 2000, store: rateStore }))
  if (beforeParser) app.use(express.json())
  const auth = createAuthMiddleware({
    wallet,
    allowUnauthenticated: true,
    transportLimits: { requestTimeoutMs: 3000 }
  })
  const httpState = { control: true }
  const options: ProposalRouteOptions<ProposalJournalEntry> = {
    service: f.service,
    disclosure: f.disclosure,
    journal: f.storage,
    baseURL: f.manifest.body.baseURL,
    authenticate: auth,
    authorizeControl: () => httpState.control,
    ...overrides
  }
  app.use(createProposalRouter(options))
  app.post('/lookup', (_req, res) => res.json({ type: 'output-list', outputs: [] }))
  const server = createServer({ maxHeaderSize: 65536 }, app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const wireHeaders: Headers[] = []
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-bsv-overlay-capability': f.caller.capabilityDigest,
    'x-bsv-overlay-profile': OUTPUT_PROFILES.proposal
  }
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
          expectedIdentityKey: authorKey.toPublicKey().toString()
        })
      }
    }
  }
  const client = clientFor(authorKey)
  return {
    ...f,
    options,
    httpState,
    client,
    clientFor,
    wireHeaders,
    origin,
    headers,
    onHTTPSign(callback: () => void | Promise<void>) {
      onSign = callback
    },
    async fetch(
      operation: ProposalHTTPOperation = 'get',
      text = operation === 'get'
        ? f.query
        : operation === 'put'
          ? f.publication
          : JSON.stringify(f.request)
    ) {
      return await client.fetch(origin + '/api/overlay/v1/proposals/' + operation, {
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
        await f.close()
      }
    }
  }
}
