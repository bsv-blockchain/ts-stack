import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CompletedProtoWallet,
  OutputLookupTransport,
  PrivateKey,
  OUTPUT_LOOKUP_PROFILE,
  signOutputPacket
} from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createOutputLookupRouter, type OutputLookupRouteOptions } from '../OutputLookupRoutes.js'
import {
  providerFixture,
  providerEntry
} from '../../../../application/output-knowledge/test/lookup-provider-fixture.js'

const servers: Server[] = []
const fixtures: Awaited<ReturnType<typeof providerFixture>>[] = []
async function endpoint(
  authentication: 'none' | 'brc103' = 'brc103',
  configuration: Partial<OutputLookupRouteOptions> = {}
) {
  const app = express(),
    server = createServer({ maxHeaderSize: 65536 }, app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    baseURL = origin + '/tenant/api'
  const f = await providerFixture(authentication, baseURL)
  fixtures.push(f)
  const wallet = new CompletedProtoWallet(new PrivateKey(2))
  const payments = jest.spyOn(wallet, 'createAction')
  const auth = createAuthMiddleware({
    wallet: new CompletedProtoWallet(new PrivateKey(1)),
    allowUnauthenticated: true,
    transportLimits: {
      requestTimeoutMs: 3000,
      maxPendingRequests: 8,
      maxRequestBytes: 1048576,
      maxResponseBytes: 4194304
    }
  })
  const routes = {
    companion: f.service,
    service: 'records',
    baseURL,
    identity: new PrivateKey(1).toPublicKey().toString(),
    chain: f.source.selection.chain,
    authentication,
    authenticate: auth,
    manifest: f.manifest,
    now: () => f.clock.now,
    allowedOrigins: ['https://client.example.test'],
    allowLocalHTTP: true,
    ...configuration
  }
  app.use(createOutputLookupRouter(routes))
  const legacy = jest.fn()
  app.use((_req, _res, next) => {
    legacy()
    next()
  })
  app.post('/lookup', (_req, res) => res.json({ type: 'output-list', outputs: [] }))
  const responses: { path: string; headers: Headers }[] = []
  const fetchClient: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    responses.push({ path: new URL(String(input)).pathname, headers: response.headers })
    return response
  }
  const client = () =>
    new OutputLookupTransport({
      contract: f.contracts.fresh(f.caller.capabilityDigest, '1000').record,
      trust: f.contracts.recoveryTrust(),
      wallet,
      now: () => f.clock.now,
      requestTimeoutMs: 3000,
      fetch: fetchClient
    })
  return { ...f, app, origin, baseURL, client, payments, legacy, responses, routes }
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
  for (const f of fixtures.splice(0)) await f.cleanup()
})

describe('real retained provider through BRC-103/104 HTTP', () => {
  it('requires a verified principal even when shared admin middleware allows anonymous fallback', async () => {
    const f = await endpoint()
    const response = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-bsv-overlay-capability': f.caller.capabilityDigest,
        'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
      },
      body: JSON.stringify(f.open)
    })
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('unauthorized')
    expect((await f.index.head()).retained.pins).toBe(0)
  })

  it('does not advertise a capability whose bytes exceed the configured host bound', async () => {
    const f = await endpoint('none', { maximumResponseBytes: 65536 })
    const response = await fetch(f.baseURL + '/overlay/v1/capabilities')
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('unsupported')
  })

  it('bounds raw request bytes with the lower configured host limit', async () => {
    const f = await endpoint('none', { maximumRequestBytes: 128 })
    const response = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(f.open)
    })
    expect(response.status).toBe(413)
    expect((await f.index.head()).retained.pins).toBe(0)
  })

  it.each([
    { maximumRequests: 0 },
    { maximumRequests: 4097 },
    { maximumRequestBytes: 0 },
    { maximumRequestBytes: 1048577 },
    { maximumResponseBytes: 65535 },
    { maximumResponseBytes: 4194305 }
  ])('rejects invalid HTTP bounds %j', async configuration => {
    const f = await endpoint('none')
    expect(() => createOutputLookupRouter({ ...f.routes, ...configuration })).toThrow(
      'Invalid lookup HTTP'
    )
  })

  it.each([
    ['duplicate JSON', 400],
    ['invalid UTF-8', 400],
    ['oversized body', 413],
    ['compression', 422],
    ['content type', 400],
    ['missing selector', 400],
    ['wrong profile', 422],
    ['wrong selector', 409]
  ])('rejects %s before any original snapshot exists', async (fault, status) => {
    const f = await endpoint('none')
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-bsv-overlay-capability': f.caller.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
    }
    let body: string | Uint8Array<ArrayBuffer> = JSON.stringify(f.open)
    if (fault === 'duplicate JSON') body = body.replace('"query":', '"query":null,"query":')
    if (fault === 'invalid UTF-8') body = Uint8Array.from([0xc3, 0x28])
    if (fault === 'oversized body') body = ' '.repeat(1048577)
    if (fault === 'compression') headers['content-encoding'] = 'gzip'
    if (fault === 'content type') headers['content-type'] = 'text/plain'
    if (fault === 'missing selector') delete headers['x-bsv-overlay-capability']
    if (fault === 'wrong profile') headers['x-bsv-overlay-profile'] = 'urn:test:unsupported'
    if (fault === 'wrong selector') headers['x-bsv-overlay-capability'] = 'ff'.repeat(32)
    const response = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'POST',
      headers,
      body
    })
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const packet = await response.json()
    expect(packet.version).toBe(1)
    expect(packet.error.message).not.toContain(f.path)
    expect((await f.index.head()).retained.pins).toBe(0)
    expect(f.legacy).not.toHaveBeenCalled()
  })

  it('keeps malformed protocol paths away from legacy payload logging', async () => {
    const f = await endpoint('none')
    for (const suffix of ['/lookup/open/', '/lookup/OPEN', '/lookup/unrecognized']) {
      const response = await fetch(f.baseURL + '/overlay/v1' + suffix, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ private: 'unlogged' })
      })
      expect(response.status).toBe(404)
    }
    expect(f.legacy).not.toHaveBeenCalled()
  })

  it('fails explicitly if mounted after a generic body parser', async () => {
    const f = await endpoint('none'),
      app = express(),
      server = createServer({ maxHeaderSize: 65536 }, app)
    servers.push(server)
    app.use(express.json())
    app.use(createOutputLookupRouter(f.routes))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/tenant/api/overlay/v1/lookup/open`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(f.open)
      }
    )
    expect(response.status).toBe(422)
    expect((await f.index.head()).retained.pins).toBe(0)
  })

  it('authenticates two clients, pushes coherent live changes by long poll, and recovers a missed change', async () => {
    const f = await endpoint(),
      a = f.client(),
      b = f.client()
    const one = await a.open(f.open),
      two = await b.open({ ...f.open, requestId: 'second-listener-000000000' })
    const readA = a.read(one, { ...one.limits, waitMs: 1000 }),
      readB = b.read(two, { ...two.limits, waitMs: 1000 })
    await f
      .peer()
      .index.commit({ base: '0', evaluatedAt: '1000', edits: [providerEntry(0)], event: {} })
    const [seenA, seenB] = await Promise.all([readA, readB])
    expect(seenA.groups).toEqual(seenB.groups)
    expect(seenA.groups).toHaveLength(1)
    await f.index.commit({
      base: '1',
      evaluatedAt: '1000',
      edits: [{ key: providerEntry(0).key, previous: '1', next: null }],
      event: {}
    })
    const resumed = await f.client().read(seenB, { ...seenB.limits, waitMs: 0 })
    expect(resumed.groups[0].observations[0].kind).toBe('withdraw')
    expect(resumed.through).toBe('2')
    expect(await a.open(f.open)).toEqual(one)
    expect(await b.close(two.session)).toEqual({ version: 1, closed: true })
    expect(f.payments).not.toHaveBeenCalled()
    expect(f.legacy).not.toHaveBeenCalled()
    for (const response of f.responses.filter(value => value.path.includes('/lookup/'))) {
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('vary')).toContain('x-bsv-overlay-capability')
      expect(response.headers.get('x-bsv-overlay-profile')).toBe(OUTPUT_LOOKUP_PROFILE)
    }
  })

  it('returns independently bounded signed errors without creating a snapshot or paying', async () => {
    const f = await endpoint(),
      client = f.client()
    await expect(
      client.open({ ...f.open, limits: { ...f.open.limits, maxBytes: 1 } })
    ).rejects.toMatchObject({
      code: 'limited',
      packet: { error: { limit: { kind: 'envelope' } } }
    })
    expect((await f.index.head()).retained.pins).toBe(0)
    expect(f.payments).not.toHaveBeenCalled()
    expect(f.legacy).not.toHaveBeenCalled()
  })

  it('authenticates rejection when current access is revoked during a long poll', async () => {
    const f = await endpoint(),
      client = f.client(),
      first = await client.open(f.open)
    f.hooks.authorization = async context => {
      if (context.stage === 'disclosure')
        await f.sessions.blockGuard('serving', '0', 'ab'.repeat(32))
    }
    await expect(client.read(first, { ...first.limits, waitMs: 10 })).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(f.payments).not.toHaveBeenCalled()
  })

  it('publishes only its signed bound capability and enforces explicit browser origins', async () => {
    const f = await endpoint()
    const discovery = await fetch(f.baseURL + '/overlay/v1/capabilities')
    expect(discovery.status).toBe(200)
    expect(await discovery.json()).toEqual(f.manifest())
    const allowed = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://client.example.test',
        'access-control-request-headers':
          'content-type,x-bsv-overlay-capability,x-bsv-auth-signature'
      }
    })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://client.example.test')
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull()
    expect(allowed.headers.get('access-control-expose-headers')).toContain(
      'x-bsv-overlay-capability'
    )
    const denied = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'OPTIONS',
      headers: { origin: 'https://unconfigured.example.test' }
    })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect(f.legacy).not.toHaveBeenCalled()
  })

  it('keeps explicit public lookup and the unrelated legacy route independent', async () => {
    const f = await endpoint('none'),
      first = await f.client().open(f.open)
    expect(first.scope.provider).toBe(f.origin)
    expect(f.responses.some(response => response.path === '/.well-known/auth')).toBe(false)
    expect(await (await fetch(f.origin + '/lookup', { method: 'POST' })).json()).toEqual({
      type: 'output-list',
      outputs: []
    })
    expect(f.legacy).toHaveBeenCalledTimes(1)
  })
})

function selectedHeaders(f: Awaited<ReturnType<typeof endpoint>>) {
  return {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-bsv-overlay-capability': f.caller.capabilityDigest,
    'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
  }
}
function requestOpen(f: Awaited<ReturnType<typeof endpoint>>, signal?: AbortSignal) {
  return fetch(f.baseURL + '/overlay/v1/lookup/open', {
    method: 'POST',
    headers: selectedHeaders(f),
    body: JSON.stringify(f.open),
    signal
  })
}
function rawGet(url: string, headers: string[]) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { headers, method: 'GET' }, res => {
      let body = ''
      res.setEncoding('utf8').on('data', data => {
        body += data
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('HTTP framing, capabilities and lifecycle boundaries', () => {
  it('checks complete raw header bytes and case-insensitive duplicates before routing', async () => {
    const f = await endpoint('none'),
      url = f.baseURL + '/overlay/v1/capabilities'
    const prefix = ['Host', new URL(f.origin).host, 'Connection', 'close', 'x-padding']
    const overhead = prefix.reduce((total, text) => total + Buffer.byteLength(text), 0)
    expect((await rawGet(url, [...prefix, 'a'.repeat(16384 - overhead)])).status).toBe(200)
    const large = await rawGet(url, [...prefix, 'a'.repeat(16385 - overhead)])
    expect(large.status).toBe(413)
    expect(JSON.parse(large.body).error.code).toBe('limited')
    const duplicate = await rawGet(url, [
      'Host',
      new URL(f.origin).host,
      'X-Test',
      'one',
      'x-test',
      'two'
    ])
    expect(duplicate.status).toBe(400)
    expect(JSON.parse(duplicate.body).error.code).toBe('invalid')
  })

  it('requires no-store, exact methods and JSON while accepting identity encoding and media-type whitespace', async () => {
    const f = await endpoint('none')
    for (const [suffix, method] of [
      ['/capabilities', 'POST'],
      ['/lookup/open', 'GET']
    ]) {
      const response = await fetch(f.baseURL + '/overlay/v1' + suffix, { method })
      expect(response.status).toBe(400)
    }
    for (const cache of [undefined, 'no-cache']) {
      const headers: Record<string, string> = selectedHeaders(f)
      delete headers['cache-control']
      if (cache !== undefined) headers['cache-control'] = cache
      const response = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
        method: 'POST',
        headers,
        body: JSON.stringify(f.open)
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('invalid')
    }
    const good = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'POST',
      headers: {
        ...selectedHeaders(f),
        'content-encoding': 'identity',
        'content-type': ' Application/JSON ; charset=utf-8'
      },
      body: JSON.stringify(f.open)
    })
    expect(good.status).toBe(200)
    expect((await good.json()).phase).toBe('snapshot')
    const missingType = selectedHeaders(f) as Record<string, string>
    delete missingType['content-type']
    const missing = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'POST',
      headers: missingType
    })
    expect(missing.status).toBe(400)
    const caps = await fetch(f.baseURL + '/overlay/v1/CAPABILITIES')
    expect(caps.status).toBe(404)
    expect(f.legacy).not.toHaveBeenCalled()
  })

  it('validates authentication installation and boundary capacities at construction', async () => {
    const f = await endpoint('none')
    for (const options of [
      { authentication: 'brc103', authenticate: undefined },
      { authentication: 'other' }
    ])
      expect(() =>
        createOutputLookupRouter({ ...f.routes, ...options } as OutputLookupRouteOptions)
      ).toThrow('Authenticated lookup requires its actual authentication middleware')
    for (const options of [
      { maximumRequests: 1 },
      { maximumRequests: 4096 },
      { maximumRequestBytes: 1 },
      { maximumResponseBytes: 65536 }
    ])
      expect(() => createOutputLookupRouter({ ...f.routes, ...options })).not.toThrow()
  })

  it('rejects every independent advertised identity, base, chain, signature, expiry and service mismatch', async () => {
    let published: unknown
    const f = await endpoint('none', { manifest: () => published })
    const original = f.manifest()
    const changed: [string, (body: typeof original.body) => void, number][] = [
      [
        'identity',
        body => {
          body.identity = new PrivateKey(3).toPublicKey().toString()
        },
        401
      ],
      [
        'base',
        body => {
          body.baseURL += '/other'
        },
        401
      ],
      [
        'chain',
        body => {
          body.chain.genesisHash = 'ff'.repeat(32)
        },
        401
      ],
      [
        'expiry equality',
        body => {
          body.expiresAt = '1000'
        },
        410
      ],
      [
        'service count',
        body => {
          body.services.push({ ...body.services[0], name: 'other' })
        },
        422
      ],
      [
        'service name',
        body => {
          body.services[0].name = 'other'
        },
        422
      ],
      [
        'profile count',
        body => {
          body.services[0].profiles.push({
            ...body.services[0].profiles[0],
            id: 'urn:example:other'
          })
        },
        422
      ],
      [
        'profile id',
        body => {
          body.services[0].profiles[0].id = 'urn:example:other'
        },
        422
      ],
      [
        'authentication',
        body => {
          body.services[0].profiles[0].authentication = 'brc103'
        },
        422
      ]
    ]
    for (const [name, edit, status] of changed) {
      const body = structuredClone(original.body)
      edit(body)
      published = signOutputPacket(
        'capabilities',
        body,
        new PrivateKey(name === 'identity' ? 3 : 1)
      )
      const response = await fetch(f.baseURL + '/overlay/v1/capabilities')
      expect({ name, status: response.status }).toEqual({ name, status })
    }
    published = {
      ...original,
      signature: signOutputPacket('capabilities', original.body, new PrivateKey(3)).signature
    }
    const invalid = await fetch(f.baseURL + '/overlay/v1/capabilities')
    expect(invalid.status).toBe(401)
    published = original
    expect((await fetch(f.baseURL + '/overlay/v1/capabilities')).status).toBe(200)
  })

  it('refuses advertised request capacity above its concrete host bound', async () => {
    const f = await endpoint('none', { maximumRequestBytes: 1048575 })
    expect((await fetch(f.baseURL + '/overlay/v1/capabilities')).status).toBe(422)
  })

  it('handles authentication errors and the root handshake only when explicitly installed', async () => {
    const auth = jest.fn((_req, _res, next) =>
      next(Object.assign(new Error('private auth'), { code: 'unauthorized' }))
    )
    const f = await endpoint('brc103', { authenticate: auth })
    for (const path of ['/tenant/api/overlay/v1/lookup/open', '/.well-known/auth']) {
      const response = await fetch(f.origin + path, {
        method: 'POST',
        headers: selectedHeaders(f),
        body: '{}'
      })
      expect(response.status).toBe(401)
      expect((await response.json()).error.message).toBe('Lookup request unauthorized')
    }
    const fallback = await endpoint('brc103', { authenticate: (_req, _res, next) => next() })
    expect(
      (
        await fetch(fallback.origin + '/.well-known/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(422)
    expect((await requestOpen(fallback)).status).toBe(401)
    const shared = await endpoint('brc103', { handleHandshake: false, authenticate: auth })
    expect(
      (
        await fetch(shared.origin + '/.well-known/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(404)
    expect(shared.legacy).toHaveBeenCalledTimes(1)
    const publicOnly = await endpoint('none')
    expect((await fetch(publicOnly.origin + '/.well-known/auth', { method: 'POST' })).status).toBe(
      404
    )
  })

  it('rejects malformed companion responses without disclosing their bodies', async () => {
    let reply: unknown
    const operation = jest.fn(
      async () => reply as Awaited<ReturnType<OutputLookupRouteOptions['companion']['open']>>
    )
    const f = await endpoint('none', {
      companion: { open: operation, read: operation, close: operation },
      maximumResponseBytes: 65536
    })
    const headers = {
      'x-bsv-overlay-capability': f.caller.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
    }
    for (const bad of [
      { body: { secret: 'private' }, headers },
      { body: 'private'.repeat(11000), headers },
      { body: 'private', headers: { ...headers, 'x-bsv-overlay-capability': 'ff'.repeat(32) } },
      { body: 'private', headers: { ...headers, 'x-bsv-overlay-profile': 'wrong' } }
    ]) {
      reply = bad
      const response = await requestOpen(f)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        version: 1,
        error: { code: 'unavailable', message: 'Lookup request unavailable', retryable: false }
      })
    }
    reply = { body: ' '.repeat(65536), headers }
    const exact = await requestOpen(f)
    expect(exact.status).toBe(200)
    expect(await exact.text()).toHaveLength(65536)
  })
})

it('bounds simultaneous HTTP responses, cancels on disconnect, and releases capacity exactly once', async () => {
  let start!: () => void,
    cancelled!: () => void,
    complete!: (value: Awaited<ReturnType<OutputLookupRouteOptions['companion']['open']>>) => void
  const started = new Promise<void>(resolve => {
    start = resolve
  })
  const cancellation = new Promise<void>(resolve => {
    cancelled = resolve
  })
  const physical = new Promise<Awaited<ReturnType<OutputLookupRouteOptions['companion']['open']>>>(
    resolve => {
      complete = resolve
    }
  )
  let calls = 0,
    originalSignal: AbortSignal | undefined
  const operation: OutputLookupRouteOptions['companion']['open'] = async (_input, who, signal) => {
    calls++
    if (calls === 1) {
      originalSignal = signal
      signal!.addEventListener('abort', cancelled, { once: true })
      start()
      return await physical
    }
    return {
      body: '{}',
      headers: {
        'x-bsv-overlay-capability': who.capabilityDigest,
        'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
      }
    }
  }
  const f = await endpoint('none', {
    maximumRequests: 1,
    companion: { open: operation, read: operation, close: operation }
  })
  const abort = new AbortController()
  const first = requestOpen(f, abort.signal).catch(error => error)
  await started
  const limited = await requestOpen(f)
  expect(limited.status).toBe(413)
  expect((await limited.json()).error).toMatchObject({ code: 'limited', retryable: true })
  expect(calls).toBe(1)
  abort.abort()
  await first
  await cancellation
  expect(originalSignal!.aborted).toBe(true)
  const afterClose = await requestOpen(f)
  expect(afterClose.status).toBe(200)
  await afterClose.text()
  complete({
    body: 'private late result',
    headers: {
      'x-bsv-overlay-capability': f.caller.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
    }
  })
  const afterLate = await requestOpen(f)
  expect(afterLate.status).toBe(200)
  expect(await afterLate.text()).toBe('{}')
  expect(calls).toBe(3)
})

it('classifies raw parser failures without trusting arbitrary objects or leaked details', async () => {
  for (const [error, code, status] of [
    [new Error('private parse'), 'invalid', 400],
    [Object.assign(new Error('private size'), { type: 'entity.too.large' }), 'limited', 413],
    [{ type: 'entity.too.large', detail: 'private object' }, 'invalid', 400]
  ] as const) {
    jest.spyOn(express, 'raw').mockImplementationOnce(() => (_req, _res, next) => {
      next(error)
    })
    const f = await endpoint('none')
    const response = await requestOpen(f)
    expect(response.status).toBe(status)
    expect((await response.json()).error).toEqual({
      code,
      message: 'Lookup request ' + code,
      retryable: false
    })
  }
})

it('keeps public requests out of authentication and removes transport listeners after completion', async () => {
  const authenticate = jest.fn((_req, _res, next) =>
    next(new Error('Should not authenticate public request'))
  )
  const publicRoute = await endpoint('none', { authenticate })
  expect((await requestOpen(publicRoute)).status).toBe(200)
  expect(authenticate).not.toHaveBeenCalled()
  let incoming: express.Request | undefined, outgoing: express.Response | undefined
  const identity = new PrivateKey(2).toPublicKey().toString()
  let releaseListener: ((...args: unknown[]) => void) | undefined
  const installed: express.RequestHandler = (req, res, next) => {
    releaseListener = res
      .listeners('finish')
      .find(listener => res.listeners('close').includes(listener))
    incoming = req
    outgoing = res
    ;(req as express.Request & { auth: { identityKey: string } }).auth = { identityKey: identity }
    next()
  }
  const operation = jest.fn(async (_body, who) => ({
    body: '{}',
    headers: {
      'x-bsv-overlay-capability': who.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
    }
  }))
  const f = await endpoint('brc103', {
    authenticate: installed,
    companion: { open: operation, read: operation, close: operation }
  })
  const response = await requestOpen(f)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(await response.text()).toBe('{}')
  expect(operation.mock.calls[0][1].principal).toBe(identity)
  expect(operation.mock.calls[0][0]).toEqual(f.open)
  expect(incoming!.listenerCount('aborted')).toBe(0)
  expect(outgoing!.listenerCount('close')).toBe(0)
  expect(releaseListener).toBeDefined()
  expect(outgoing!.listeners('finish')).not.toContain(releaseListener)
})

it('does not write again after a response has ended during companion work', async () => {
  let outgoing: express.Response, ended: jest.SpyInstance
  const installed: express.RequestHandler = (req, res, next) => {
    ;(req as express.Request & { auth: { identityKey: string } }).auth = {
      identityKey: new PrivateKey(2).toPublicKey().toString()
    }
    outgoing = res
    ended = jest.spyOn(res, 'end')
    next()
  }
  const operation: OutputLookupRouteOptions['companion']['open'] = async (_body, who) => {
    outgoing.status(503).end('already ended')
    return {
      body: 'private late response',
      headers: {
        'x-bsv-overlay-capability': who.capabilityDigest,
        'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
      }
    }
  }
  const f = await endpoint('brc103', {
    authenticate: installed,
    companion: { open: operation, read: operation, close: operation }
  })
  const response = await requestOpen(f)
  expect(response.status).toBe(503)
  expect(await response.text()).toBe('already ended')
  expect(ended!).toHaveBeenCalledTimes(1)
})

it('advertises a smaller response maximum that exactly matches the host', async () => {
  let published: unknown
  const f = await endpoint('none', { maximumResponseBytes: 65536, manifest: () => published })
  const body = f.manifest().body
  body.services[0].profiles[0].maxResponseBytes = 65536
  published = signOutputPacket('capabilities', body, new PrivateKey(1))
  expect((await fetch(f.baseURL + '/overlay/v1/capabilities')).status).toBe(200)
})

it('validates raw JSON framing before invoking an independently installed companion', async () => {
  const operation = jest.fn(async (_input, who) => ({
    body: '{}',
    headers: {
      'x-bsv-overlay-capability': who.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
    }
  }))
  const f = await endpoint('none', {
    companion: { open: operation, read: operation, close: operation }
  })
  for (const body of ['{"query":1,"query":2}', '[', Buffer.from([0xc3, 0x28])]) {
    const response = await fetch(f.baseURL + '/overlay/v1/lookup/open', {
      method: 'POST',
      headers: selectedHeaders(f),
      body
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid')
  }
  expect(operation).not.toHaveBeenCalled()
  const valid = await requestOpen(f)
  expect(valid.status).toBe(200)
  expect(operation.mock.calls[0][0]).toEqual(f.open)
})

it('requires authenticated transport when a native disclosure companion is configured', async () => {
  const f = await endpoint('none')
  expect(() => createOutputLookupRouter({ ...f.routes, disclosure: {} as never })).toThrow(
    'Lookup native disclosure requires authenticated transport'
  )
})
