import { jest } from '@jest/globals'
import { getEventListeners } from 'node:events'
import {
  AuthFetch,
  OUTPUT_PROFILES,
  SimplifiedFetchTransport,
  signOutputPacket
} from '../../../mod.js'
import {
  OutputRootEvictionTransport,
  OutputRootEvictionServiceError
} from '../OutputRootEvictionTransport.js'
import { rootTransportFixture } from './OutputRootEvictionTransport.fixture.js'
import {
  rootKey,
  otherKey,
  rootPolicy,
  rootRequestBody,
  rootResultBody,
  signedRootRequest
} from './OutputRootEvictionProtocol.fixture.js'

afterEach(() => jest.restoreAllMocks())

it.each([0, -1, 30001, 1.5, Number.NaN])(
  'rejects an invalid root request deadline %s',
  requestTimeoutMs => {
    expect(() => rootTransportFixture({ requestTimeoutMs })).toThrow(
      'Invalid root coordination request deadline'
    )
  }
)

it('requires an actual fetch implementation before network use', () => {
  expect(() => rootTransportFixture({ fetch: null as never })).not.toThrow()
  expect(() => rootTransportFixture({ fetch: 42 as never })).toThrow(
    'Root coordination requires a fetch implementation'
  )
})

it('enforces the selected target count independently of the fixed protocol maximum', () => {
  const body = rootRequestBody(),
    first = body.targets[0]
  body.targets.push({
    ...first,
    outpoint: { ...first.outpoint, outputIndex: 1 },
    advertisement: { ...first.advertisement, outputIndex: 1 }
  })
  expect(() =>
    rootTransportFixture({ request: signedRootRequest(body) }, manifest => {
      manifest.services[0].profiles[0].parameters.maxTargets = 1
    })
  ).toThrow('Root request exceeds its original selected limits')
})

it('binds submit/retry/status to owned original request and capability through discovery expiry', async () => {
  const f = rootTransportFixture()
  const send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
  const original = structuredClone(f.request)
  f.request.body.reason = 'caller changed this'
  f.record.manifest.body.baseURL = 'https://different.example'
  expect(await f.client.submit()).toEqual(f.result)
  expect(await f.client.submit()).toEqual(f.result)
  expect(await f.client.status()).toEqual(f.result)
  expect(send.mock.calls.map(([url]) => url)).toEqual([
    'https://root.example.test/api/overlay/v1/root-evictions/request',
    'https://root.example.test/api/overlay/v1/root-evictions/request',
    'https://root.example.test/api/overlay/v1/root-evictions/status'
  ])
  for (const [, init] of send.mock.calls)
    expect(init).toMatchObject({
      method: 'POST',
      allowPayments: false,
      requireMutualAuth: true,
      expectedIdentityKey: original.body.recipient,
      headers: {
        'content-type': 'application/json',
        'x-bsv-overlay-capability': f.selection.digest,
        'x-bsv-overlay-profile': OUTPUT_PROFILES.eviction
      }
    })
  expect(JSON.parse(send.mock.calls[0][1]!.body as string)).toEqual(original)
  expect(send.mock.calls[1][1]!.body).toEqual(send.mock.calls[0][1]!.body)
  expect(JSON.parse(send.mock.calls[2][1]!.body as string)).toEqual({
    version: 1,
    requester: original.body.requester,
    requestId: original.body.requestId
  })
  expect(f.fetchClient).not.toHaveBeenCalled()
})

it.each(['kind', 'service', 'profile'])(
  'rejects a different retained %s before networking',
  kind => {
    const f = rootTransportFixture()
    expect(
      () =>
        new OutputRootEvictionTransport({
          ...f.options,
          trust: { ...f.options.trust, [kind]: 'different' } as never
        })
    ).toThrow('requires the root-advertisements coordination profile')
    expect(f.fetchClient).not.toHaveBeenCalled()
  }
)

it.each(['signature', 'recipient', 'chain', 'policy', 'wallet'])(
  'rejects invalid original %s',
  kind => {
    const f = rootTransportFixture()
    let request = signedRootRequest()
    if (kind === 'signature')
      request.signature = signOutputPacket(
        'root-eviction-request',
        request.body,
        otherKey
      ).signature
    if (kind === 'recipient')
      request = signedRootRequest({
        ...rootRequestBody(),
        recipient: otherKey.toPublicKey().toString()
      })
    if (kind === 'chain') {
      const body = rootRequestBody(),
        chain = { network: 'other', genesisHash: '12'.repeat(32) }
      body.chain = chain
      body.targets[0].outpoint.chain = chain
      request = signedRootRequest(body)
    }
    expect(
      () =>
        new OutputRootEvictionTransport({
          ...f.options,
          request,
          ...(kind === 'policy' ? { policyDigest: 'invalid' } : {}),
          ...(kind === 'wallet' ? { wallet: undefined as never } : {})
        })
    ).toThrow()
    expect(f.fetchClient).not.toHaveBeenCalled()
  }
)

it('enforces selected lifetime and canonical request byte ceilings before I/O', () => {
  expect(() =>
    rootTransportFixture({}, m => {
      m.services[0].profiles[0].parameters.maxLifetimeSeconds = '99'
    })
  ).toThrow('selected limits')
  expect(() =>
    rootTransportFixture({}, m => {
      m.services[0].profiles[0].maxRequestBytes = 128
    })
  ).toThrow('byte limit')
})

it.each(['signature', 'request', 'policy', 'root'])(
  'does not accept a result whose %s differs from retained authority',
  async kind => {
    const f = rootTransportFixture(),
      body = rootResultBody()
    if (kind === 'request') body.requestDigest = '12'.repeat(32)
    if (kind === 'policy') body.policyDigest = '13'.repeat(32)
    if (kind === 'root') body.root = otherKey.toPublicKey().toString()
    const packet = signOutputPacket(
      'root-eviction-result',
      body,
      kind === 'signature' ? otherKey : rootKey
    )
    jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response(packet))
    await expect(f.client.submit()).rejects.toThrow()
  }
)

it('retains the independently selected policy and classifies checked service errors', async () => {
  const f = rootTransportFixture()
  f.options.policyDigest = 'aa'.repeat(32)
  const send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
  expect((await f.client.status()).body.policyDigest).toBe(rootPolicy)
  const packet = {
    version: 1,
    error: { code: 'not-found', message: 'Unavailable', retryable: false }
  }
  send.mockImplementation(async () => f.response(packet, 404))
  await expect(f.client.status()).rejects.toBeInstanceOf(OutputRootEvictionServiceError)
  await expect(f.client.status()).rejects.toMatchObject({
    name: 'OutputRootEvictionServiceError',
    code: 'not-found',
    packet
  })
  const error = new OutputRootEvictionServiceError(packet as never)
  packet.error.message = 'mutated'
  expect(error.packet.error.message).toBe('Unavailable')
})

it('rejects payment and changed selected headers without accepting any result', async () => {
  const f = rootTransportFixture()
  const send = jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response({}, 402))
  await expect(f.client.submit()).rejects.toThrow('Root coordination cannot request payment')
  send.mockImplementation(async () =>
    f.response(f.result, 200, { 'x-bsv-overlay-capability': 'cd'.repeat(32) })
  )
  await expect(f.client.submit()).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Root response changed selected contract'
  })
})

it('retains physical capacity after cancellation until the actual authentication operation settles', async () => {
  const f = rootTransportFixture()
  let resolve!: (value: Response) => void
  const send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const stop = new AbortController()
  const pending = f.client.submit(stop.signal)
  stop.abort()
  await expect(pending).rejects.toThrow('Root request cancelled')
  await expect(f.client.status()).rejects.toThrow('Root request or earlier I/O is still active')
  resolve(f.response())
  await new Promise<void>(done => setImmediate(done))
  send.mockImplementation(async () => f.response())
  expect(await f.client.status()).toEqual(f.result)
})

it.each(['endpoint', 'redirect', 'headers', 'encoding', 'body'])(
  'bounds the underlying root authentication HTTP exchange: %s',
  async kind => {
    const f = rootTransportFixture({}, manifest => {
      manifest.services[0].profiles[0].maxResponseBytes = 128
    })
    const endpoint = 'https://root.example.test/api/overlay/v1/root-evictions/request'
    const response = f.response(kind === 'body' ? 'x'.repeat(129) : '{}')
    if (kind === 'redirect')
      Object.defineProperty(response, 'url', { value: 'https://other.example' })
    if (kind === 'headers') response.headers.set('x-padding', 'x'.repeat(16385))
    if (kind === 'encoding') response.headers.set('content-encoding', 'gzip')
    f.fetchClient.mockResolvedValue(response)
    const send = jest
      .spyOn(SimplifiedFetchTransport.prototype, 'send')
      .mockImplementation(async function (this: SimplifiedFetchTransport) {
        await this.fetchClient(kind === 'endpoint' ? 'https://other.example' : endpoint, {
          method: 'POST'
        })
        throw new Error('Fixture expected the bounded exchange to reject')
      })
    const expected = {
      endpoint: 'Root transport changed endpoint',
      redirect: 'Root response changed endpoint',
      headers: 'Root HTTP header limit',
      encoding: 'Root requires identity encoding',
      body: 'Root HTTP body limit'
    }
    await expect(f.client.submit()).rejects.toThrow(expected[kind as keyof typeof expected])
    expect(send).toHaveBeenCalledTimes(1)
    if (kind === 'endpoint') expect(f.fetchClient).not.toHaveBeenCalled()
    else
      expect(f.fetchClient).toHaveBeenCalledWith(
        endpoint,
        expect.objectContaining({ redirect: 'error', cache: 'no-store', credentials: 'omit' })
      )
  }
)

it('requires the HTTP error status to agree with the authenticated error code', async () => {
  const f = rootTransportFixture()
  jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () =>
      f.response(
        { version: 1, error: { code: 'not-found', message: 'Unavailable', retryable: false } },
        500
      )
    )
  await expect(f.client.status()).rejects.toThrow('Root error status mismatch')
})

it('retains physical ownership after a deadline until the pending dependency settles', async () => {
  const f = rootTransportFixture({ requestTimeoutMs: 5 })
  let settle!: (value: Response) => void
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(
    () =>
      new Promise(resolve => {
        settle = resolve
      })
  )
  await expect(f.client.submit()).rejects.toThrow('Root request deadline')
  await expect(f.client.status()).rejects.toThrow('Root request or earlier I/O is still active')
  settle(f.response())
  await new Promise<void>(resolve => setImmediate(resolve))
})

it('accepts a selected success larger than the separate error allowance', async () => {
  const f = rootTransportFixture({}, m => {
    m.services[0].profiles[0].maxResponseBytes = 8192
  })
  const encoded = JSON.stringify(f.result).padEnd(8192, ' ')
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response(encoded))
  expect(await f.client.status()).toEqual(f.result)
})

it('accepts the exact header ceiling, an unchanged response URL and mixed-case identity encoding', async () => {
  const f = rootTransportFixture()
  const endpoint = 'https://root.example.test/api/overlay/v1/root-evictions/request'
  const response = f.response(f.result, 200, { 'content-encoding': 'IdEnTiTy' })
  Object.defineProperty(response, 'url', { value: endpoint })
  let bytes = 'x-padding'.length
  response.headers.forEach((value, name) => {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
  })
  response.headers.set('x-padding', 'x'.repeat(16384 - bytes))
  f.fetchClient.mockResolvedValue(response)
  jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport
  ) {
    const received = await this.fetchClient(endpoint)
    expect(await received.json()).toEqual(f.result)
    throw new Error('Exact boundary accepted')
  })
  await expect(f.client.submit()).rejects.toThrow('Exact boundary accepted')
})

it('reports a header overflow as a capacity limit before decoding a body', async () => {
  const f = rootTransportFixture()
  f.fetchClient.mockResolvedValue(f.response('not JSON', 200, { 'x-padding': 'x'.repeat(16384) }))
  jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport
  ) {
    await this.fetchClient('https://root.example.test/.well-known/auth')
  })
  await expect(f.client.submit()).rejects.toMatchObject({
    code: 'limited',
    message: 'Root HTTP header limit'
  })
})

it('allows the separate handshake budget when the selected result allowance is smaller', async () => {
  const f = rootTransportFixture({}, m => {
    m.services[0].profiles[0].maxResponseBytes = 128
  })
  const body = ' '.repeat(8192)
  f.fetchClient.mockResolvedValue(new Response(body))
  jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport
  ) {
    const received = await this.fetchClient('https://root.example.test/.well-known/auth')
    expect(await received.text()).toBe(body)
    throw new Error('Handshake allowance accepted')
  })
  await expect(f.client.submit()).rejects.toThrow('Handshake allowance accepted')
})

it('releases cancellation listeners and the deadline after successful repeated calls', async () => {
  jest.useFakeTimers()
  try {
    const f = rootTransportFixture(),
      stop = new AbortController()
    jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
    for (let i = 0; i < 3; i++) {
      expect(await f.client.status(stop.signal)).toEqual(f.result)
      expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0)
      expect(jest.getTimerCount()).toBe(0)
    }
    stop.abort()
    await expect(f.client.status(stop.signal)).rejects.toMatchObject({ code: 'cancelled' })
  } finally {
    jest.useRealTimers()
  }
})

it('accepts exact selected target and lifetime ceilings and reports exceedance as limited', async () => {
  const f = rootTransportFixture({}, m => {
    m.services[0].profiles[0].parameters.maxTargets = 1
    m.services[0].profiles[0].parameters.maxLifetimeSeconds = '100'
  })
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
  expect(await f.client.submit()).toEqual(f.result)
  expect(() =>
    rootTransportFixture({}, m => {
      m.services[0].profiles[0].parameters.maxLifetimeSeconds = '99'
    })
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(() => rootTransportFixture({ wallet: undefined as never })).toThrow(
    'Root coordination requires a wallet'
  )
})

it.each([false, true])(
  'requires HTTPS even when general development HTTP opt-in is %s',
  allowLocalHTTP => {
    expect(() =>
      rootTransportFixture({}, undefined, {
        baseURL: 'http://127.0.0.1:8080/api',
        allowLocalHTTP
      })
    ).toThrow(allowLocalHTTP ? 'Private profiles require HTTPS' : 'Overlay base requires HTTPS')
  }
)
