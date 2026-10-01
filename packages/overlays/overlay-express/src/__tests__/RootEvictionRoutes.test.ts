import { canonicalOutputJSON, verifyOutputRootEvictionResult, signOutputPacket } from '@bsv/sdk'
import { rootHTTPFixture } from './RootEvictionRoutes.fixture.js'
import { createRootEvictionRouter } from '../RootEvictionRoutes.js'
import { rootContractKey } from '../../../../application/output-knowledge/test/root-contract-fixture.js'
import { policy } from '../../../../application/output-knowledge/test/root-eviction-fixture.js'

const fixtures: Awaited<ReturnType<typeof rootHTTPFixture>>[] = []
async function fixture(...args: Parameters<typeof rootHTTPFixture>) {
  const f = await rootHTTPFixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})

it('authenticates actual raw intake and status, retaining original selection through discovery loss', async () => {
  const f = await fixture()
  const response = await f.fetch()
  expect(response.status).toBe(200)
  expect(f.wireHeaders.at(-1)!.get('cache-control')).toBe('private, no-store')
  expect(f.wireHeaders.at(-1)!.get('access-control-allow-origin')).toBe('*')
  expect(f.wireHeaders.at(-1)!.get('access-control-allow-credentials')).toBeNull()
  const packet = verifyOutputRootEvictionResult(await response.json(), JSON.parse(f.text), policy)
  expect(packet.body.outcomes[0].actionStatus).toBe('pending')
  f.stateHTTP.manifest = undefined
  const retry = await f.fetch()
  expect(retry.status).toBe(200)
  expect(
    verifyOutputRootEvictionResult(await retry.json(), JSON.parse(f.text), policy).body
  ).toEqual(packet.body)
  const status = await f.fetch('status')
  expect(status.status).toBe(200)
  expect(
    verifyOutputRootEvictionResult(await status.json(), JSON.parse(f.text), policy).body
  ).toEqual(packet.body)
  expect((await fetch(f.origin + '/api/overlay/v1/capabilities')).status).toBe(404)
  expect(await (await fetch(f.origin + '/lookup', { method: 'POST' })).json()).toEqual({
    type: 'output-list',
    outputs: []
  })
})

it('denies unsigned callers even with permissive shared authentication middleware', async () => {
  const f = await fixture()
  const result = await fetch(f.origin + '/api/overlay/v1/root-evictions/request', {
    method: 'POST',
    headers: f.headers,
    body: f.text
  })
  expect(result.status).toBe(401)
  expect((await result.json()).error.code).toBe('unauthorized')
  expect(f.sign).not.toHaveBeenCalled()
})

it.each([
  ['case', '/api/overlay/v1/ROOT-EVICTIONS/request', 'POST', 404],
  ['trailing slash', '/api/overlay/v1/root-evictions/request/', 'POST', 404],
  ['query', '/api/overlay/v1/root-evictions/request?x=1', 'POST', 400],
  ['method', '/api/overlay/v1/root-evictions/request', 'GET', 400]
])('does not alias %s into root intake', async (_kind, path, method, status) => {
  const f = await fixture()
  const response = await fetch(f.origin + path, {
    method,
    headers: f.headers,
    ...(method === 'POST' ? { body: f.text } : {})
  })
  expect(response.status).toBe(status)
  expect(f.sign).not.toHaveBeenCalled()
})

it.each(['utf8', 'compression', 'type', 'size', 'parser'])(
  'rejects %s before durable intake',
  async kind => {
    const f = await fixture(kind === 'size' ? { maximumRequestBytes: 16 } : {}, kind === 'parser')
    const headers = { ...f.headers }
    let body: string | Uint8Array<ArrayBuffer> = f.text
    if (kind === 'utf8') body = Uint8Array.from([0xc3, 0x28])
    if (kind === 'compression') Object.assign(headers, { 'content-encoding': 'gzip' })
    if (kind === 'type') headers['content-type'] = 'text/plain'
    const response = await fetch(f.origin + '/api/overlay/v1/root-evictions/request', {
      method: 'POST',
      headers,
      body
    })
    expect(response.status).toBe(
      kind === 'size' ? 413 : ['compression', 'parser'].includes(kind) ? 422 : 400
    )
    expect(f.sign).not.toHaveBeenCalled()
    expect((await f.store.head()).revision).toBe('0')
  }
)

it.each(['selector', 'profile', 'cache', 'duplicate-json'])(
  'rejects authenticated %s before signing',
  async kind => {
    const f = await fixture()
    const headers = { ...f.headers }
    if (kind === 'selector') headers['x-bsv-overlay-capability'] = 'xx'
    if (kind === 'profile') headers['x-bsv-overlay-profile'] = 'unsupported'
    if (kind === 'cache') headers['cache-control'] = 'public'
    const body =
      kind === 'duplicate-json' ? f.text.replace('"version":1', '"version":1,"version":1') : f.text
    const response = await f.client.fetch(f.origin + '/api/overlay/v1/root-evictions/request', {
      method: 'POST',
      headers,
      body
    })
    expect(response.status).toBe(kind === 'profile' ? 422 : 400)
    expect(f.sign).not.toHaveBeenCalled()
  }
)

it('preserves noncanonical whitespace in the selected received-byte bound', async () => {
  const f = await fixture()
  const manifest = structuredClone(f.selection.manifest)
  manifest.body.services[0].profiles[0].maxRequestBytes = Buffer.byteLength(f.text)
  f.stateHTTP.manifest = signOutputPacket('capabilities', manifest.body, rootContractKey)
  // Selecting a changed signed manifest requires its exact new selector.
  const { outputPacketDigest } = await import('@bsv/sdk')
  f.headers['x-bsv-overlay-capability'] = outputPacketDigest('capabilities', manifest.body)
  const response = await f.fetch('request', f.text + ' ')
  expect(response.status).toBe(413)
  expect(f.sign).not.toHaveBeenCalled()
})

it('checks requester access again after actual BRC-104 signing and emits only a sanitized error', async () => {
  const f = await fixture()
  // Arm only after handshake, using a successful status-less request first.
  await (await f.fetch()).text()
  f.onHTTPSign(() => {
    f.stateHTTP.data = false
  })
  const response = await f.fetch('status')
  expect(response.status).toBe(404)
  const body = await response.json()
  expect(body.error.code).toBe('not-found')
  expect(body).not.toHaveProperty('body')
  expect(f.wireHeaders.at(-1)!.get('access-control-allow-origin')).toBe('*')
})

it('preserves selected headers and refuses alternate companion response contracts', async () => {
  const f = await fixture()
  const invoke = f.options.companion.submit.bind(f.options.companion)
  f.options.companion.submit = async (...args) => {
    const response = await invoke(...args)
    response.headers['x-bsv-overlay-capability'] = '00'.repeat(32)
    return response
  }
  const response = await f.fetch()
  expect(response.status).toBe(503)
  expect(canonicalOutputJSON(await response.json())).not.toContain('signature')
})

it('supports public preflight and explicit origin policy without cookies', async () => {
  const f = await fixture()
  const preflight = await fetch(f.origin + '/api/overlay/v1/root-evictions/status', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://new.example',
      'access-control-request-headers': 'content-type,x-bsv-auth-signature'
    }
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
  const invalid = await fetch(f.origin + '/api/overlay/v1/root-evictions/status', {
    method: 'OPTIONS',
    headers: { 'access-control-request-headers': 'x-unrecognized' }
  })
  expect(invalid.status).toBe(403)
  const restricted = await fixture({ allowedOrigins: ['https://known.example'] })
  const denied = await fetch(restricted.origin + '/api/overlay/v1/root-evictions/status', {
    method: 'OPTIONS',
    headers: { origin: 'https://new.example' }
  })
  expect(denied.status).toBe(403)
  const allowed = await fetch(restricted.origin + '/api/overlay/v1/root-evictions/status', {
    method: 'OPTIONS',
    headers: { origin: 'https://known.example' }
  })
  expect(allowed.status).toBe(204)
  expect(allowed.headers.get('access-control-allow-origin')).toBe('https://known.example')
})

it.each([
  { maximumRequests: 0 },
  { maximumRequests: 4097 },
  { maximumRequestBytes: 1048577 },
  { maximumResponseBytes: 0 },
  { maximumResponseBytes: 1048577 },
  { allowedOrigins: ['*'] }
])('rejects invalid installation bounds %j', async invalid => {
  const f = await fixture()
  expect(() => createRootEvictionRouter({ ...f.options, ...invalid })).toThrow()
})

it.each(['body', 'size', 'profile', 'operation', 'principal'])(
  'fails closed on companion %s contract drift',
  async kind => {
    const f = await fixture(kind === 'size' ? { maximumResponseBytes: 16 } : {})
    const invoke = f.options.companion.submit.bind(f.options.companion)
    f.options.companion.submit = async (...args) => {
      const response = await invoke(...args)
      if (kind === 'body') response.body = 42 as never
      if (kind === 'profile') response.headers['x-bsv-overlay-profile'] = 'different'
      if (kind === 'operation') response.access.operation = 'status'
      if (kind === 'principal') response.access.principal = 'different'
      return response
    }
    const response = await f.fetch()
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('unavailable')
  }
)

it('enforces HTTP capacity while signing remains physically pending and releases it after completion', async () => {
  const f = await fixture({ maximumRequests: 1 })
  const { rootDeferred, rootAwaitStart } =
    await import('../../../../application/output-knowledge/test/root-eviction-service-fixture.js')
  const started = rootDeferred<void>(),
    release = rootDeferred<void>()
  f.sign.mockImplementation(async body => {
    started.resolve()
    await release.promise
    return signOutputPacket('root-eviction-result', body, rootContractKey)
  })
  const pending = f.fetch()
  void pending.catch(() => {})
  try {
    await rootAwaitStart(started.promise, pending)
    const crowded = await fetch(f.origin + '/api/overlay/v1/root-evictions/request', {
      method: 'POST',
      headers: f.headers,
      body: f.text
    })
    expect(crowded.status).toBe(413)
    expect((await crowded.json()).error.retryable).toBe(true)
  } finally {
    release.resolve()
    await pending
  }
  expect((await f.fetch('status')).status).toBe(200)
})

it('rejects excessive headers before authentication or signing', async () => {
  const f = await fixture()
  const response = await fetch(f.origin + '/api/overlay/v1/root-evictions/request', {
    method: 'POST',
    headers: { ...f.headers, 'x-fixture-padding': 'x'.repeat(16385) },
    body: f.text
  })
  expect(response.status).toBe(413)
  expect(f.sign).not.toHaveBeenCalled()
})

it('leaves the origin handshake to its shared owner when explicitly disabled', async () => {
  const f = await fixture({ handleHandshake: false })
  expect((await fetch(f.origin + '/.well-known/auth', { method: 'POST' })).status).toBe(404)
})

it('requires synchronous authority/snapshot callbacks and actual authentication middleware', async () => {
  const f = await fixture()
  for (const invalid of [
    { authenticate: undefined },
    { authorize: undefined },
    { manifest: undefined },
    { authorize: async () => true },
    { manifest: async () => undefined }
  ])
    expect(() => createRootEvictionRouter({ ...f.options, ...invalid } as never)).toThrow(
      'Root routes require'
    )
})

it('does not disclose a result or replacement after both data and control authorization are revoked', async () => {
  const f = await fixture()
  await (await f.fetch()).text()
  f.stateHTTP.data = false
  f.stateHTTP.control = false
  await expect(f.fetch('status')).rejects.toThrow()
})

it('rejects an absent body before authentication', async () => {
  const f = await fixture()
  const response = await fetch(f.origin + '/api/overlay/v1/root-evictions/request', {
    method: 'POST',
    headers: f.headers
  })
  expect(response.status).toBe(400)
  expect(f.sign).not.toHaveBeenCalled()
})

it('rejects duplicate raw headers before authentication', async () => {
  const f = await fixture()
  const { request } = await import('node:http')
  const response = await new Promise<{ status: number | undefined; text: string }>(
    (resolve, reject) => {
      const req = request(
        f.origin + '/api/overlay/v1/root-evictions/request',
        { method: 'POST', headers: { ...f.headers, 'x-fixture-duplicate': ['one', 'two'] } },
        res => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', chunk => {
            text += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode, text }))
          res.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end(f.text)
    }
  )
  expect(response.status).toBe(400)
  expect(JSON.parse(response.text).error.code).toBe('invalid')
  expect(f.sign).not.toHaveBeenCalled()
})

it.each(['error', 'unhandled', 'already-ended'])(
  'sanitizes %s authentication middleware failures',
  async kind => {
    const f = await fixture({
      authenticate: (_req, res, next) => {
        if (kind === 'already-ended') res.end('already ended')
        next(kind === 'unhandled' ? undefined : new Error('private storage or wallet diagnostic'))
      }
    })
    const response = await fetch(
      f.origin +
        (kind === 'unhandled' ? '/.well-known/auth' : '/api/overlay/v1/root-evictions/request'),
      { method: 'POST', headers: f.headers, body: '{}' }
    )
    expect(response.status).toBe(kind === 'unhandled' ? 422 : kind === 'error' ? 503 : 200)
    expect(await response.text()).not.toContain('private storage')
    expect(f.sign).not.toHaveBeenCalled()
  }
)

it('preserves a received BOM so strict protocol JSON rejects it rather than accepting changed bytes', async () => {
  const f = await fixture()
  const response = await fetch(f.origin + '/.well-known/auth', {
    method: 'POST',
    headers: f.headers,
    body: '\uFEFF{}'
  })
  expect(response.status).toBe(400)
  expect(f.sign).not.toHaveBeenCalled()
})
