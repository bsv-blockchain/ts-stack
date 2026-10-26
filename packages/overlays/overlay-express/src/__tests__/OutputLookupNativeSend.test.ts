import { afterEach, test, expect, jest } from '@jest/globals'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MemoryStore, rateLimit } from 'express-rate-limit'
import {
  CompletedProtoWallet,
  PrivateKey,
  OutputLookupTransport,
  OutputProtocolError
} from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createOutputLookupRouter } from '../OutputLookupRoutes.js'
import { LookupResponseDisclosure } from '../../../../application/output-knowledge/src/lookup/LookupResponseDisclosure.js'
import {
  providerFixture,
  providerEntry
} from '../../../../application/output-knowledge/test/lookup-provider-fixture.js'
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
})
async function fixture(maximumRequests = 64) {
  const app = express(),
    server = createServer({ maxHeaderSize: 65536 }, app),
    rateStore = new MemoryStore()
  let f: Awaited<ReturnType<typeof providerFixture>> | undefined
  closes.push(async () => {
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    rateStore.shutdown()
    await f?.cleanup()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  f = await providerFixture('brc103', baseURL)
  const state = {
      allowed: true,
      control: true,
      preparationFails: false,
      failResponsePreparation: false
    },
    store = f
  const disclosure = new LookupResponseDisclosure({
    sessions: f.sessions,
    contracts: f.contracts,
    authorize: async context => {
      if (!state.allowed) throw new OutputProtocolError('unauthorized', 'Synthetic private detail')
      return {
        access: context.principal!,
        guards: [
          {
            id: 'serving',
            revision: await store.sessions.guard('serving'),
            failure: 'unauthorized'
          }
        ]
      }
    },
    authorizeControl: () => state.control
  })
  const wallet = new CompletedProtoWallet(new PrivateKey(1)),
    sign = wallet.createSignature.bind(wallet)
  let onPrepared: ((signal: AbortSignal) => Promise<void>) | undefined
  let onSign: (() => void | Promise<void>) | undefined,
    applicationResponse = false
  wallet.createSignature = async (...args) => {
    const result = await sign(...args)
    if (applicationResponse) await onSign?.()
    return result
  }
  const authenticate = createAuthMiddleware({
    wallet,
    allowUnauthenticated: true,
    transportLimits: { requestTimeoutMs: 2000 }
  })
  app.use(rateLimit({ windowMs: 60000, limit: 2000, store: rateStore }))
  app.use(
    createOutputLookupRouter({
      companion: {
        open: f.service.open.bind(f.service),
        close: f.service.close.bind(f.service),
        read: async (...args) => {
          if (state.preparationFails)
            throw new OutputProtocolError('unavailable', 'Synthetic private preparation detail')
          const response = await store.service.read(...args)
          applicationResponse = true
          await onPrepared?.(args[2]!)
          return response
        }
      },
      disclosure,
      maximumRequests,
      service: 'records',
      baseURL,
      identity: f.source.selection.identity,
      chain: f.source.selection.chain,
      authentication: 'brc103',
      authenticate: (req, res, next) => {
        authenticate(req, res, error => {
          if (!error && state.failResponsePreparation && req.path.endsWith('/lookup/read')) {
            res.status = (() => {
              throw new Error('Synthetic transport preparation failure')
            }) as never
          }
          next(error)
        })
      },
      manifest: f.manifest,
      now: () => store.clock.now,
      allowedOrigins: [],
      allowLocalHTTP: true
    })
  )
  app.post('/lookup', (_req, res) => res.json({ type: 'output-list', outputs: [] }))
  const responses: { status: number; body: string; headers: Headers }[] = []
  const client = new OutputLookupTransport({
    contract: f.contracts.fresh(f.caller.capabilityDigest, '1000').record,
    trust: f.contracts.recoveryTrust(),
    wallet: new CompletedProtoWallet(new PrivateKey(2)),
    now: () => store.clock.now,
    requestTimeoutMs: 2500,
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      responses.push({
        status: response.status,
        body: await response.clone().text(),
        headers: response.headers
      })
      return response
    }
  })
  return {
    ...f,
    baseURL,
    state,
    client,
    disclosure,
    responses,
    onPrepared: (callback: (signal: AbortSignal) => Promise<void>) => {
      onPrepared = callback
    },
    onSign: (callback: () => void | Promise<void>) => {
      onSign = callback
    }
  }
}
test('actual authenticated HTTP resets stale data after signing and delivers only a newly signed error', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open)
  await f.index.commit({
    base: '0',
    evaluatedAt: '1000',
    edits: [providerEntry(0)],
    event: { type: 'publish' }
  })
  let signatures = 0
  f.onSign(async () => {
    if (++signatures === 1) await f.sessions.blockGuard('serving', '0', 'bb'.repeat(32))
  })
  await assert.rejects(f.client.read(first, { ...first.limits, waitMs: 0 }), {
    code: 'unauthorized'
  })
  assert.equal(signatures, 2)
  const response = f.responses.at(-1)!
  assert.equal(response.status, 401)
  const packet = JSON.parse(response.body)
  assert.deepEqual(packet, {
    version: 1,
    error: { code: 'unauthorized', message: 'Lookup request unauthorized', retryable: false }
  })
  assert.equal(response.body.includes('beef'), false)
  assert.equal(response.body.includes('Synthetic private detail'), false)
  expect(await (await fetch(new URL('/lookup', f.baseURL), { method: 'POST' })).json()).toEqual({
    type: 'output-list',
    outputs: []
  })
}, 10000)
test('a response is withheld if control permission changes while signing the replacement', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open)
  let signatures = 0
  f.onSign(() => {
    if (++signatures === 1) f.state.allowed = false
    else f.state.control = false
  })
  await assert.rejects(f.client.read(first, { ...first.limits, waitMs: 0 }))
  assert.equal(signatures, 2)
  assert.equal(
    f.responses.some(response => response.body.includes('Synthetic private detail')),
    false
  )
}, 10000)
test('guarded HTTP preserves a valid live batch and ordinary close acknowledgement', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open)
  await f.index.commit({
    base: '0',
    evaluatedAt: '1000',
    edits: [providerEntry(0)],
    event: { type: 'publish' }
  })
  const next = await f.client.read(first, { ...first.limits, waitMs: 0 })
  assert.equal(next.phase, 'live')
  assert.equal(next.groups.length, 1)
  assert.equal(next.groups[0].observations[0].kind, 'output')
  await f.client.close(next.session)
  const response = f.responses.at(-1)!
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { version: 1, closed: true })
}, 10000)
test('exclusive session expiry after response signing withholds the prepared live data', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open)
  await f.index.commit({
    base: '0',
    evaluatedAt: '1000',
    edits: [providerEntry(0)],
    event: { type: 'publish' }
  })
  let signatures = 0
  f.onSign(() => {
    if (++signatures === 1) f.clock.now = first.expiresAt
  })
  await assert.rejects(f.client.read(first, { ...first.limits, waitMs: 0 }), {
    code: 'reset-required'
  })
  assert.equal(signatures, 2)
  assert.equal(f.responses.at(-1)!.body.includes('beef'), false)
}, 10000)

test('signs and gates a sanitized service-preparation error', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open)
  f.state.preparationFails = true
  await expect(f.client.read(first, { ...first.limits, waitMs: 0 })).rejects.toMatchObject({
    code: 'unavailable'
  })
  const response = f.responses.at(-1)!
  expect(response.status).toBe(503)
  expect(response.headers.get('content-type')?.split(';', 1)[0]).toBe('application/json')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-bsv-overlay-capability')).toBe(f.caller.capabilityDigest)
  expect(JSON.parse(response.body)).toEqual({
    version: 1,
    error: { code: 'unavailable', message: 'Lookup request unavailable', retryable: false }
  })
  expect(response.body).not.toContain('Synthetic private preparation detail')
}, 10000)

test('withholds a service error when control delivery cannot be bound', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open),
    received = f.responses.length
  f.state.preparationFails = true
  f.disclosure.control = () => {
    throw new Error('Synthetic control installation failure')
  }
  await expect(f.client.read(first, { ...first.limits, waitMs: 0 })).rejects.toThrow()
  expect(
    f.responses
      .slice(received)
      .every(
        response =>
          !response.body.includes('Synthetic control installation failure') &&
          !response.body.includes('Synthetic private preparation detail')
      )
  ).toBe(true)
}, 10000)

test('closes a guarded response if transport preparation throws before signing', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open),
    received = f.responses.length
  f.state.failResponsePreparation = true
  await expect(f.client.read(first, { ...first.limits, waitMs: 0 })).rejects.toThrow()
  expect(
    f.responses
      .slice(received)
      .every(response => !response.body.includes('Synthetic transport preparation failure'))
  ).toBe(true)
}, 10000)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('releases each guarded HTTP slot once and keeps its full capacity while a read is outstanding', async () => {
  const f = await fixture(1),
    first = await f.client.open(f.open),
    entered = deferred(),
    release = deferred()
  f.onPrepared(async () => {
    entered.resolve()
    await release.promise
  })
  const reading = f.client.read(first, { ...first.limits, waitMs: 0 }).then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error })
  )
  await entered.promise
  try {
    const crowded = await fetch(f.baseURL + '/overlay/v1/capabilities')
    expect(crowded.status).toBe(413)
    expect(await crowded.json()).toMatchObject({ error: { code: 'limited' } })
  } finally {
    release.resolve()
  }
  expect(await reading).toMatchObject({ status: 'fulfilled' })
  const reopened = await fetch(f.baseURL + '/overlay/v1/capabilities')
  expect(reopened.status).toBe(200)
}, 10000)

test('does not bind or send prepared lookup data after the client closes the request', async () => {
  const f = await fixture(),
    first = await f.client.open(f.open),
    entered = deferred(),
    cancelled = deferred(),
    release = deferred(),
    finished = deferred()
  f.onPrepared(async signal => {
    signal.addEventListener('abort', cancelled.resolve, { once: true })
    entered.resolve()
    await release.promise
    finished.resolve()
  })
  const bind = jest.spyOn(f.disclosure, 'bind'),
    control = jest.spyOn(f.disclosure, 'control')
  const abort = new AbortController()
  const reading = f.client.read(first, { ...first.limits, waitMs: 0 }, abort.signal)
  const rejected = expect(reading).rejects.toThrow()
  await entered.promise
  abort.abort()
  await cancelled.promise
  release.resolve()
  await rejected
  await finished.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(bind).not.toHaveBeenCalled()
  expect(control).not.toHaveBeenCalled()
}, 10000)
