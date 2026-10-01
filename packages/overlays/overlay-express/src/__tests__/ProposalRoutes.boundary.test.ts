import { jest } from '@jest/globals'
import { authorKey } from '../../../../application/output-knowledge/test/proposal-fixture.js'
import { createProposalRouter } from '../ProposalRoutes.js'
import { proposalHTTPFixture } from './ProposalRoutes.fixture.js'

const fixtures: Awaited<ReturnType<typeof proposalHTTPFixture>>[] = []
async function fixture(...args: Parameters<typeof proposalHTTPFixture>) {
  const f = await proposalHTTPFixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})

it.each([
  ['content-type', 'text/plain', 400],
  ['content-encoding', 'gzip', 422],
  ['x-extra', 'x'.repeat(16385), 413]
])('rejects bounded pre-authentication header %s', async (name, value, status) => {
  const f = await fixture()
  const result = await fetch(f.origin + '/api/overlay/v1/proposals/get', {
    method: 'POST',
    headers: { ...f.headers, [name]: value },
    body: f.query
  })
  expect(result.status).toBe(status)
  expect((await result.json()).error).toBeDefined()
})

it('bounds actual raw bytes and rejects empty and malformed UTF-8 before authentication', async () => {
  const f = await fixture({ maximumRequestBytes: 1024 })
  for (const [body, status] of [
    ['x'.repeat(1025), 413],
    ['', 400],
    [Buffer.from([0xff]), 400]
  ] as const) {
    const result = await fetch(f.origin + '/api/overlay/v1/proposals/get', {
      method: 'POST',
      headers: f.headers,
      body
    })
    expect(result.status).toBe(status)
  }
  expect((await f.storage.head()).revision).toBe('1')
})

it('guards initial service errors and removes internal diagnostics from signed responses', async () => {
  const f = await fixture()
  await f.fetch()
  jest.spyOn(f.service, 'get').mockRejectedValue(new Error('private database path and payload'))
  const response = await f.fetch()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    version: 1,
    error: { code: 'unavailable', message: 'Proposal request unavailable', retryable: true }
  })
  f.httpState.control = false
  await expect(f.fetch()).rejects.toThrow()
})

it('enforces selected profile/cache headers on authenticated requests', async () => {
  const f = await fixture()
  for (const [name, value, code, status] of [
    ['x-bsv-overlay-profile', 'urn:unknown', 'unsupported', 422],
    ['cache-control', 'public', 'invalid', 400],
    ['x-bsv-overlay-capability', 'invalid', 'invalid', 400]
  ] as const) {
    const response = await f.client.fetch(f.origin + '/api/overlay/v1/proposals/get', {
      method: 'POST',
      headers: { ...f.headers, [name]: value },
      body: f.query
    })
    expect(response.status).toBe(status)
    expect((await response.json()).error.code).toBe(code)
  }
})

it('keeps a disconnected operation physically counted until it settles', async () => {
  const f = await fixture({ maximumWork: 1 })
  const result = await f.service.get(f.query, f.caller)
  await f.fetch()
  let release!: (value: Awaited<ReturnType<typeof f.service.get>>) => void, began!: () => void
  const started = new Promise<void>(resolve => {
    began = resolve
  })
  const pending = new Promise<Awaited<ReturnType<typeof f.service.get>>>(resolve => {
    release = resolve
  })
  const original = f.service.get.bind(f.service)
  const call = jest
    .spyOn(f.service, 'get')
    .mockImplementationOnce(async () => {
      began()
      return await pending
    })
    .mockImplementation(original)
  const controller = new AbortController()
  const abortable = f.clientFor(authorKey, controller.signal)
  const first = Promise.allSettled([
    abortable.fetch(f.origin + '/api/overlay/v1/proposals/get', {
      method: 'POST',
      headers: f.headers,
      body: f.query
    })
  ])
  try {
    await started
    controller.abort()
    expect((await first)[0].status).toBe('rejected')
    const full = await f.fetch()
    expect(full.status).toBe(413)
    expect((await full.json()).error.code).toBe('limited')
    expect(call).toHaveBeenCalledTimes(1)
  } finally {
    release(result)
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  expect((await f.fetch()).status).toBe(200)
  expect(call).toHaveBeenCalledTimes(2)
})

it('counts per-principal work separately while permitting another authorized reader', async () => {
  const f = await fixture({ maximumWork: 2, maximumWorkPerPrincipal: 1 })
  const response = await f.service.get(f.query, f.caller)
  await f.fetch()
  let release!: (value: Awaited<ReturnType<typeof f.service.get>>) => void, began!: () => void
  const started = new Promise<void>(resolve => {
    began = resolve
  })
  const pending = new Promise<Awaited<ReturnType<typeof f.service.get>>>(resolve => {
    release = resolve
  })
  const original = f.service.get.bind(f.service)
  jest
    .spyOn(f.service, 'get')
    .mockImplementationOnce(async () => {
      began()
      return await pending
    })
    .mockImplementation(original)
  const first = Promise.allSettled([f.fetch()])
  try {
    await started
    expect((await f.fetch()).status).toBe(413)
    const { PrivateKey } = await import('@bsv/sdk')
    const reader = f.clientFor(new PrivateKey(2))
    const other = await reader.fetch(f.origin + '/api/overlay/v1/proposals/get', {
      method: 'POST',
      headers: f.headers,
      body: f.query
    })
    expect(other.status).toBe(200)
  } finally {
    release(response)
  }
  expect((await first)[0]).toMatchObject({ status: 'fulfilled', value: { status: 200 } })
})

it('withholds an oversized service response through a signed control result', async () => {
  const f = await fixture({ maximumResponseBytes: 1 })
  const response = await f.fetch()
  expect(response.status).toBe(413)
  expect((await response.json()).error.code).toBe('limited')
})

it('validates capacities, HTTPS base, native gate and synchronous control authority', async () => {
  const f = await fixture()
  for (const key of [
    'maximumRequests',
    'maximumWork',
    'maximumWorkPerPrincipal',
    'requestTimeoutMs',
    'maximumRequestBytes',
    'maximumResponseBytes'
  ])
    for (const value of [0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER])
      expect(() => createProposalRouter({ ...f.options, [key]: value })).toThrow('capacity')
  expect(() =>
    createProposalRouter({ ...f.options, maximumWork: 1, maximumWorkPerPrincipal: 2 })
  ).toThrow('capacity')
  expect(() =>
    createProposalRouter({ ...f.options, baseURL: 'http://provider.example/api' })
  ).toThrow()
  expect(() => createProposalRouter({ ...f.options, authenticate: undefined as never })).toThrow(
    'authentication'
  )
  expect(() =>
    createProposalRouter({ ...f.options, authorizeControl: (async () => true) as never })
  ).toThrow('synchronous')
  expect(() =>
    createProposalRouter({
      ...f.options,
      journal: { ...f.options.journal, responseEnqueue: 'other' } as never
    })
  ).toThrow('native-enqueue')
})
