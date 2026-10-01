import {
  canonicalOutputJSON,
  PrivateKey,
  CompletedProtoWallet,
  OutputProposalTransport,
  retainOutputCapability
} from '@bsv/sdk'
import { proposalHTTPFixture } from './ProposalRoutes.fixture.js'
import {
  signed,
  authorKey
} from '../../../../application/output-knowledge/test/proposal-fixture.js'

const fixtures: Awaited<ReturnType<typeof proposalHTTPFixture>>[] = []
async function fixture(...args: Parameters<typeof proposalHTTPFixture>) {
  const f = await proposalHTTPFixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})

it('uses actual mutual authentication for put/get/finalize without altering finite lookup', async () => {
  const f = await fixture()
  const put = await f.fetch('put')
  expect(put.status).toBe(200)
  expect(await put.json()).toEqual(f.ack)
  const response = await f.fetch()
  expect(response.status).toBe(200)
  expect((await response.json()).proposal).toEqual(f.proposal)
  const wire = f.wireHeaders.at(-1)!
  expect(wire.get('cache-control')).toBe('private, no-store')
  expect(wire.get('access-control-allow-origin')).toBe('*')
  expect(wire.get('access-control-allow-credentials')).toBeNull()
  expect(wire.get('x-bsv-overlay-capability')).toBe(f.caller.capabilityDigest)
  expect(wire.get('x-bsv-overlay-profile')).toBe(f.headers['x-bsv-overlay-profile'])
  const final = await f.fetch('finalize')
  expect(final.status).toBe(200)
  expect((await final.json()).state.status).toBe('finalizing')
  expect(await (await fetch(f.origin + '/lookup', { method: 'POST' })).json()).toEqual({
    type: 'output-list',
    outputs: []
  })
})

it('enforces current recipients and makes missing and unauthorized get indistinguishable', async () => {
  const f = await fixture()
  const recipient = f.clientFor(new PrivateKey(2)),
    outsider = f.clientFor(new PrivateKey(3))
  const url = f.origin + '/api/overlay/v1/proposals/get'
  expect(
    (await recipient.fetch(url, { method: 'POST', headers: f.headers, body: f.query })).status
  ).toBe(200)
  const denied = await outsider.fetch(url, { method: 'POST', headers: f.headers, body: f.query })
  const absent = await f.fetch(
    'get',
    canonicalOutputJSON({ ...JSON.parse(f.query), channel: 'ff'.repeat(32) })
  )
  expect(denied.status).toBe(404)
  expect(absent.status).toBe(404)
  expect(await denied.json()).toEqual(await absent.json())
})

it('rechecks access after actual response signing and sends only a newly signed sanitized error', async () => {
  const f = await fixture()
  expect((await f.fetch()).status).toBe(200)
  let signatures = 0
  f.onHTTPSign(() => {
    signatures++
    f.state.allowed = false
  })
  const response = await f.fetch()
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    version: 1,
    error: { code: 'not-found', message: 'Proposal request not-found', retryable: false }
  })
  expect(signatures).toBe(2)
})

it('rejects a stale channel during signing but retains an original publication ACK', async () => {
  const f = await fixture()
  await f.fetch()
  let signatures = 0
  f.onHTTPSign(async () => {
    if (++signatures === 1)
      await f.service.put(
        { version: 1, proposal: signed({ revision: '1', previous: f.request.proposalId }) },
        f.caller
      )
  })
  const response = await f.fetch()
  expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe('reset-required')
  expect(signatures).toBe(2)
  expect(await (await f.fetch('put')).json()).toEqual(f.ack)
})

it('withholds active state at signed expiry and returns the durable expired state on the next read', async () => {
  const f = await fixture()
  await f.fetch()
  f.onHTTPSign(() => {
    f.state.now = '100'
  })
  const expired = await f.fetch()
  expect(expired.status).toBe(410)
  expect((await expired.json()).error.code).toBe('expired')
  const refreshed = await f.fetch()
  expect(refreshed.status).toBe(200)
  expect((await refreshed.json()).state).toEqual({ status: 'expired', recordedAt: '100' })
})

it('closes if control authority changes while signing the replacement', async () => {
  const f = await fixture()
  await f.fetch()
  let signatures = 0
  f.onHTTPSign(() => {
    if (++signatures === 1) f.state.allowed = false
    else f.httpState.control = false
  })
  await expect(f.fetch()).rejects.toThrow()
  expect(signatures).toBe(2)
})

it('allows unrelated channel changes while signing without exposing their data', async () => {
  const f = await fixture()
  await f.fetch()
  let changed = false
  f.onHTTPSign(async () => {
    if (!changed) {
      changed = true
      await f.service.put({ version: 1, proposal: signed({ channel: 'ff'.repeat(32) }) }, f.caller)
    }
  })
  const response = await f.fetch()
  expect(response.status).toBe(200)
  expect((await response.json()).proposal).toEqual(f.proposal)
})

it('rejects unsigned callers and incorrect signed selection without fallback or admission', async () => {
  const f = await fixture()
  const unsigned = await fetch(f.origin + '/api/overlay/v1/proposals/get', {
    method: 'POST',
    headers: f.headers,
    body: f.query
  })
  expect(unsigned.status).toBe(401)
  f.headers['x-bsv-overlay-capability'] = 'ff'.repeat(32)
  const changed = await f.fetch()
  expect(changed.status).toBe(409)
  expect((await changed.json()).error.code).toBe('context-changed')
  expect((await f.storage.head()).revision).toBe('1')
})

it.each([
  ['/api/overlay/v1/PROPOSALS/get', 'POST', 404],
  ['/api/overlay/v1/proposals/get/', 'POST', 404],
  ['/api/overlay/v1/proposals/get?x=1', 'POST', 400],
  ['/api/overlay/v1/proposals/get', 'GET', 400],
  ['/api/overlay/v1/proposals/unknown', 'POST', 404]
])('enforces exact route and method %s %s', async (path, method, status) => {
  const f = await fixture()
  const response = await fetch(f.origin + path, {
    method,
    headers: f.headers,
    ...(method === 'POST' ? { body: f.query } : {})
  })
  expect(response.status).toBe(status)
  expect((await response.json()).error).toBeDefined()
})

it('preserves actual framing, rejects earlier body parsing and supports explicit CORS origins', async () => {
  const f = await fixture({ allowedOrigins: ['https://reader.example'] })
  const origin = f.origin + '/api/overlay/v1/proposals/get'
  const preflight = await fetch(origin, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://reader.example',
      'access-control-request-headers': 'content-type,x-bsv-overlay-profile'
    }
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe('https://reader.example')
  expect(
    (await fetch(origin, { method: 'OPTIONS', headers: { origin: 'https://other.example' } }))
      .status
  ).toBe(403)
  const duplicate = await f.fetch('get', f.query.replace('{', '{"version":1,'))
  expect(duplicate.status).toBe(400)
  expect((await duplicate.json()).error.code).toBe('invalid')
  const before = await fixture({}, true)
  const response = await fetch(before.origin + '/api/overlay/v1/proposals/get', {
    method: 'POST',
    headers: before.headers,
    body: before.query
  })
  expect(response.status).toBe(422)
})

it('composes the retained SDK client with actual authenticated HTTP and native journal disclosure', async () => {
  const f = await fixture()
  const retained = retainOutputCapability(f.manifest, { ...f.trust, now: f.state.now }).record
  const calls: string[] = []
  const common = {
    contract: retained,
    trust: f.trust,
    wallet: new CompletedProtoWallet(authorKey),
    now: () => f.state.now,
    requestTimeoutMs: 3000,
    fetch: (async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://provider.example')
      calls.push(url.pathname)
      const response = await fetch(f.origin + url.pathname, init)
      return new Response(response.body, { status: response.status, headers: response.headers })
    }) as typeof fetch
  }
  const put = new OutputProposalTransport({
    ...common,
    operation: 'put',
    request: JSON.parse(f.publication)
  })
  const get = new OutputProposalTransport({
    ...common,
    operation: 'get',
    request: JSON.parse(f.query)
  })
  const finalize = new OutputProposalTransport({
    ...common,
    operation: 'finalize',
    request: f.request
  })
  expect(await put.send()).toEqual(f.ack)
  expect((await get.send()).proposal).toEqual(f.proposal)
  const reserved = await finalize.send()
  expect(reserved.matchesRequest).toBe(true)
  expect(reserved.response.state.status).toBe('finalizing')
  const different = new OutputProposalTransport({
    ...common,
    operation: 'finalize',
    request: { ...f.request, operationId: 'different-reservation' }
  })
  expect(await different.send()).toEqual({ response: reserved.response, matchesRequest: false })
  // Reconstruct from serialized local operation storage; current discovery is invalid.
  const saved = JSON.parse(
    JSON.stringify({ contract: retained, request: JSON.parse(f.publication) })
  )
  f.manifest.body.services = []
  f.state.now = '101'
  const recovered = new OutputProposalTransport({ ...common, ...saved, operation: 'put' })
  expect(await recovered.send()).toEqual(f.ack)
  expect(calls).toContain('/.well-known/auth')
  expect(calls.filter(path => path.endsWith('/put'))).toHaveLength(2)
  expect((await f.storage.head()).revision).toBe('2')
})

it('delivers the guarded access-revocation result to the SDK without disclosing a signed stale proposal', async () => {
  const f = await fixture()
  const { record } = retainOutputCapability(f.manifest, { ...f.trust, now: f.state.now })
  const client = new OutputProposalTransport({
    contract: record,
    trust: f.trust,
    operation: 'get',
    request: JSON.parse(f.query),
    wallet: new CompletedProtoWallet(authorKey),
    now: () => f.state.now,
    requestTimeoutMs: 3000,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://provider.example')
      const response = await fetch(f.origin + url.pathname, init)
      return new Response(response.body, { status: response.status, headers: response.headers })
    }
  })
  expect((await client.send()).proposal).toEqual(f.proposal)
  f.onHTTPSign(() => {
    f.state.allowed = false
  })
  await expect(client.send()).rejects.toMatchObject({
    name: 'OutputProposalServiceError',
    code: 'not-found',
    packet: {
      version: 1,
      error: { code: 'not-found', message: 'Proposal request not-found', retryable: false }
    }
  })
})
