import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CompletedProtoWallet,
  OutputLookupTransport,
  OutputLookupServiceError,
  PrivateKey,
  OUTPUT_LOOKUP_PROFILE,
  outputPacketDigest,
  retainOutputCapability,
  signOutputPacket,
  type OutputLookupBatch,
  type OutputLookupLimits
} from '@bsv/sdk'
import { createAuthMiddleware, type AuthRequest } from '../index'

const servers: Server[] = []
const key = new PrivateKey(71)
const clientKey = new PrivateKey(43)
const chain = { network: 'lookup-http-test', genesisHash: '01'.repeat(32) }
const limits: OutputLookupLimits = { maxBytes: 65536, maxObservations: 10, waitMs: 0 }
const rules = { id: 'urn:test:lookup:1', parameters: { order: 'outpoint' } }
const rulesDigest = outputPacketDigest('service-rules', rules)
const opening = {
  version: 1,
  requestId: 'test-opening-0000000000001',
  service: 'ls_test',
  query: null,
  requiredRulesDigest: rulesDigest,
  limits
}

/** Only a transport fixture: it makes no durable snapshot/log qualification claim. */
async function endpoint(
  options: { serverKey?: PrivateKey; authenticated?: boolean; fetch?: typeof fetch } = {}
) {
  const app = express()
  app.use(rateLimit({ windowMs: 60_000, limit: 300 }))
  const requests: string[] = []
  const callers: string[] = []
  const cacheHeaders: string[] = []
  let status = 200
  let responseBody: unknown
  let responseHeaders: Record<string, string> = {}
  let delayed: (() => void) | undefined
  let disconnected = false
  let holdRead = false
  app.use((req, _res, next) => {
    requests.push(req.path)
    next()
  })
  app.use(express.json())
  if (options.authenticated !== false)
    app.use(createAuthMiddleware({ wallet: new CompletedProtoWallet(options.serverKey ?? key) }))
  else
    app.post('/.well-known/auth', (_req, res) => {
      res.status(404).json({ error: 'No authentication' })
    })
  app.post('/tenant/api/overlay/v1/lookup/:operation', (req: AuthRequest, res) => {
    callers.push(req.auth?.identityKey ?? 'anonymous')
    cacheHeaders.push(req.get('cache-control') ?? '')
    const send = () => {
      res.set({
        'cache-control': 'private, no-store',
        vary: 'Authorization, x-bsv-auth-identity-key, x-bsv-overlay-capability, x-bsv-overlay-profile',
        'x-bsv-overlay-capability': req.get('x-bsv-overlay-capability'),
        'x-bsv-overlay-profile': req.get('x-bsv-overlay-profile'),
        ...responseHeaders
      })
      res
        .status(status)
        .json(
          responseBody ??
            (req.params.operation === 'close'
              ? { version: 1, closed: true }
              : req.params.operation === 'open'
                ? snapshot
                : live)
        )
    }
    if (holdRead && req.params.operation === 'read') {
      delayed = send
      res.once('close', () => {
        disconnected = true
      })
    } else send()
  })
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tenant/api`
  const identity = key.toPublicKey().toString()
  const manifest = signOutputPacket(
    'capabilities',
    {
      version: 1,
      baseURL,
      identity,
      chain,
      issuedAt: '999',
      expiresAt: '1100',
      services: [
        {
          name: 'ls_test',
          kind: 'lookup',
          rules,
          rulesDigest,
          profiles: [
            {
              id: OUTPUT_LOOKUP_PROFILE,
              authentication: 'brc103',
              payment: 'none',
              maxRequestBytes: 1048576,
              maxResponseBytes: 65536,
              parameters: {
                sessionSeconds: '300',
                replaySeconds: '600',
                maxObservations: 10,
                maxWaitMs: 25000
              }
            }
          ]
        }
      ]
    },
    key
  )
  const trust = {
    baseURL,
    identity,
    chain,
    kind: 'lookup' as const,
    service: 'ls_test',
    profile: OUTPUT_LOOKUP_PROFILE,
    rules: new Map([[rules.id, () => {}]]),
    allowLocalHTTP: true
  }
  const { record } = retainOutputCapability(manifest, {
    ...trust,
    now: '1000',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '2'
  })
  const scope = {
    chain,
    provider: identity,
    service: 'ls_test',
    rulesDigest,
    queryDigest: outputPacketDigest('lookup-query', { service: 'ls_test', query: null }),
    access: 'test-principal',
    epoch: 'test-epoch'
  }
  const snapshot: OutputLookupBatch = {
    version: 1,
    session: 'test-session',
    scope,
    phase: 'snapshot',
    snapshotComplete: true,
    groups: [],
    cursor: 'snapshot-done',
    through: '4',
    highWater: '4',
    expiresAt: '1300',
    replayUntil: '1900',
    limits
  }
  const live: OutputLookupBatch = {
    ...snapshot,
    phase: 'live',
    cursor: 'live-6',
    through: '6',
    highWater: '6',
    groups: [
      {
        id: 'live-6',
        sequence: '6',
        observations: [
          {
            id: 'live-6-withdraw',
            scope,
            kind: 'withdraw',
            payload: {
              outpoint: { chain, txid: '02'.repeat(32), outputIndex: 0 },
              reason: 'evicted'
            }
          }
        ]
      }
    ]
  }
  const wallet = new CompletedProtoWallet(clientKey)
  const payments = jest.spyOn(wallet, 'createAction')
  const client = new OutputLookupTransport({
    contract: record,
    trust,
    wallet,
    fetch: options.fetch,
    now: () => '1000',
    requestTimeoutMs: 3000
  })
  return {
    client,
    snapshot,
    live,
    requests,
    callers,
    cacheHeaders,
    payments,
    reply: (body: unknown, code = 200, headers: Record<string, string> = {}) => {
      responseBody = body
      status = code
      responseHeaders = headers
    },
    hold: () => {
      holdRead = true
    },
    hasWaiter: () => delayed !== undefined,
    release: () => {
      delayed?.()
      holdRead = false
    },
    disconnected: () => disconnected
  }
}

afterEach(async () => {
  jest.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
})

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

describe('BRC-193 client through actual local BRC-103/104 HTTP', () => {
  test('verifies complete snapshot/live responses and idempotent close under the selected principal', async () => {
    const f = await endpoint()
    const first = await f.client.open(opening)
    expect(first).toEqual(f.snapshot)
    // The transport fixture has no durable client store. This explicit supplied
    // boundary exercises HTTP only, not receipt-before-cursor crash safety.
    expect(await f.client.read(first, limits)).toEqual(f.live)
    expect(await f.client.read(first, limits)).toEqual(f.live)
    expect(await f.client.close(first.session)).toEqual({ version: 1, closed: true })
    expect(f.callers).toEqual(Array(4).fill(clientKey.toPublicKey().toString()))
    expect(f.cacheHeaders).toEqual(Array(4).fill('no-store'))
    expect(f.requests.filter(path => path !== '/.well-known/auth')).toEqual([
      '/tenant/api/overlay/v1/lookup/open',
      '/tenant/api/overlay/v1/lookup/read',
      '/tenant/api/overlay/v1/lookup/read',
      '/tenant/api/overlay/v1/lookup/close'
    ])
    expect(f.payments).not.toHaveBeenCalled()
  })

  test('refuses another authenticated server before sending the opening query', async () => {
    const f = await endpoint({ serverKey: new PrivateKey(72) })
    await expect(f.client.open(opening)).rejects.toThrow('identity does not match')
    expect(f.requests).toEqual(['/.well-known/auth'])
    expect(f.callers).toEqual([])
    expect(f.payments).not.toHaveBeenCalled()
  })

  test('never downgrades a selected authenticated service to ordinary HTTP', async () => {
    const f = await endpoint({ authenticated: false })
    await expect(f.client.open(opening)).rejects.toThrow()
    expect(f.requests).toEqual(['/.well-known/auth'])
    expect(f.callers).toEqual([])
    expect(f.payments).not.toHaveBeenCalled()
  })

  test('rejects a signed 402 without creating any wallet action', async () => {
    const f = await endpoint()
    f.reply({ message: 'Payment is not part of this profile' }, 402, {
      'x-bsv-payment-version': '1.0',
      'x-bsv-payment-satoshis-required': '1'
    })
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.callers).toHaveLength(1)
    expect(f.payments).not.toHaveBeenCalled()
  })

  test('returns a verified limited error independently of a tiny requested allowance', async () => {
    const f = await endpoint()
    const packet = {
      version: 1,
      error: {
        code: 'limited',
        message: 'Envelope requires more bytes',
        retryable: false,
        limit: { kind: 'envelope', minimumBytes: 1024 }
      }
    }
    f.reply(packet, 413)
    const result = f.client.open({ ...opening, limits: { ...limits, maxBytes: 1 } })
    await expect(result).rejects.toBeInstanceOf(OutputLookupServiceError)
    await expect(result).rejects.toMatchObject({ packet })
    expect(f.payments).not.toHaveBeenCalled()
  })

  test.each(['x-bsv-overlay-capability', 'x-bsv-overlay-profile'])(
    'rejects a signed response that changes %s',
    async header => {
      const f = await endpoint()
      f.reply(f.snapshot, 200, { [header]: 'wrong-contract' })
      await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'context-changed' })
      expect(f.payments).not.toHaveBeenCalled()
    }
  )

  test('does not publish data whose body was altered after the server signed it', async () => {
    const tamper: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (String(input).endsWith('/lookup/open')) {
        const body = await response.json()
        body.cursor = 'modified-after-signing'
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: response.headers
        })
      }
      return response
    }
    const f = await endpoint({ fetch: tamper })
    await expect(f.client.open(opening)).rejects.toThrow()
    expect(f.callers.length).toBeGreaterThan(0)
    expect(f.payments).not.toHaveBeenCalled()
  })

  test('disconnects a cancelled long poll and permits recovery from the same prior cursor', async () => {
    const f = await endpoint()
    const first = await f.client.open(opening)
    f.hold()
    const controller = new AbortController()
    const pending = f.client.read(first, { ...limits, waitMs: 25000 }, controller.signal)
    await eventually(f.hasWaiter)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await eventually(f.disconnected)
    f.release()
    // Allow the cancelled AuthFetch operation to finish its bounded cleanup.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(await f.client.read(first, limits)).toEqual(f.live)
    expect(f.payments).not.toHaveBeenCalled()
  })
})
