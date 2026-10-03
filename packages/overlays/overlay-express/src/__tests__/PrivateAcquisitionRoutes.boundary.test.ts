import { afterEach, expect, it, jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { createPrivateAcquisitionRouter } from '../PrivateAcquisitionRoutes.js'
import { privateAcquisitionHTTPFixture } from './PrivateAcquisitionRoutes.fixture.js'

const fixtures: Awaited<ReturnType<typeof privateAcquisitionHTTPFixture>>[] = []
async function fixture(...args: Parameters<typeof privateAcquisitionHTTPFixture>) {
  const f = await privateAcquisitionHTTPFixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})

it.each([
  ['content-type', 'text/plain', 400],
  ['content-encoding', 'gzip', 422],
  ['x-extra', 'x'.repeat(131073), 413]
])(
  'rejects bounded pre-authentication header %s without public effects',
  async (name, value, status) => {
    const f = await fixture()
    const response = await fetch(f.origin + '/api/overlay/v1/private/acquire', {
      method: 'POST',
      headers: { ...f.headers, [name]: value },
      body: JSON.stringify(f.contract.request)
    })
    expect(response.status).toBe(status)
    expect((await response.json()).error).toBeDefined()
    expect(f.current()).toBeUndefined()
    expect(f.counts.prepare).toBe(0)
  }
)
it('bounds raw bytes, rejects malformed UTF-8, and enforces mount ordering', async () => {
  const f = await fixture({ maximumRequestBytes: 1024 })
  for (const [body, status] of [
    ['x'.repeat(1025), 413],
    ['', 400],
    [Buffer.from([0xff]), 400]
  ] as const) {
    const response = await fetch(f.origin + '/api/overlay/v1/private/recover', {
      method: 'POST',
      headers: f.headers,
      body
    })
    expect(response.status).toBe(status)
  }
  const parsed = await fixture({}, true)
  const response = await fetch(parsed.origin + '/api/overlay/v1/private/acquire', {
    method: 'POST',
    headers: parsed.headers,
    body: '{}'
  })
  expect(response.status).toBe(422)
  expect(f.counts.prepare).toBe(0)
  expect(parsed.counts.prepare).toBe(0)
})
it('enforces exact selected profile and no-store on authenticated requests', async () => {
  const f = await fixture()
  for (const [name, value, code, status] of [
    ['x-bsv-overlay-profile', 'urn:unknown', 'unsupported', 422],
    ['cache-control', 'public', 'invalid', 400],
    ['x-bsv-overlay-capability', 'invalid', 'invalid', 400]
  ] as const) {
    const response = await f.client.fetch(f.origin + '/api/overlay/v1/private/acquire', {
      method: 'POST',
      headers: { ...f.headers, [name]: value },
      body: JSON.stringify(f.contract.request)
    })
    expect(response.status).toBe(status)
    expect((await response.json()).error.code).toBe(code)
  }
  expect(f.counts.prepare).toBe(0)
})
it('keeps disconnected work counted until physical settlement', async () => {
  const f = await fixture({ maximumWork: 1 })
  expect((await f.fetch()).status).toBe(402)
  const result = await f.coordinator.recover(f.f.id, f.caller)
  let release!: (value: typeof result) => void, began!: () => void
  const started = new Promise<void>(resolve => {
    began = resolve
  })
  const pending = new Promise<typeof result>(resolve => {
    release = resolve
  })
  const original = f.coordinator.recover.bind(f.coordinator)
  jest
    .spyOn(f.coordinator, 'recover')
    .mockImplementationOnce(async () => {
      began()
      return await pending
    })
    .mockImplementation(original)
  const controller = new AbortController(),
    abortable = f.clientFor(new PrivateKey(84), controller.signal)
  const first = Promise.allSettled([
    abortable.fetch(f.origin + '/api/overlay/v1/private/recover', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(f.status)
    })
  ])
  try {
    await started
    controller.abort()
    expect((await first)[0].status).toBe('rejected')
    const blocked = await f.fetch('recover')
    expect(blocked.status).toBe(413)
    expect((await blocked.json()).error.code).toBe('limited')
  } finally {
    release(result)
    await first
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  expect((await f.fetch('recover')).status).toBe(200)
})
it('bounds prepared responses and controls signed diagnostics under current native policy', async () => {
  const f = await fixture({ maximumResponseBytes: 1 })
  const response = await f.fetch()
  expect(response.status).toBe(413)
  expect((await response.json()).error.code).toBe('limited')
  f.httpState.control = false
  await expect(f.fetch('recover')).rejects.toThrow()
})
it('preserves credential-free default CORS and enforces only explicitly installed origins', async () => {
  const f = await fixture(),
    restricted = await fixture({ allowedOrigins: ['https://allowed.example'] })
  for (const [owner, origin, status] of [
    [f, 'https://unknown.example', 204],
    [restricted, 'https://allowed.example', 204],
    [restricted, 'https://denied.example', 403]
  ] as const) {
    const response = await fetch(owner.origin + '/api/overlay/v1/private/recover', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-headers': 'content-type, x-bsv-overlay-profile' }
    })
    expect(response.status).toBe(status)
    expect(response.headers.has('access-control-allow-credentials')).toBe(false)
    if (status === 204)
      expect(response.headers.get('access-control-allow-origin')).toBe(owner === f ? '*' : origin)
  }
  const publicResult = await fetch(f.origin + '/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  expect(await publicResult.json()).toEqual({ type: 'output-list', outputs: [] })
})
it('accepts the profile ceiling and rejects invalid transport configurations', async () => {
  const f = await fixture()
  expect(() =>
    createPrivateAcquisitionRouter({ ...f.options, maximumRequestBytes: 4194304 })
  ).not.toThrow()
  for (const options of [
    { maximumRequestBytes: 4194305 },
    { maximumRequestBytes: 0 },
    { maximumResponseBytes: 4194305 },
    { maximumWork: 0 },
    { maximumWork: 1, maximumWorkPerPrincipal: 2 },
    { requestTimeoutMs: 30001 },
    { allowedOrigins: ['*'] }
  ])
    expect(() => createPrivateAcquisitionRouter({ ...f.options, ...options })).toThrow()
})
it.each([
  '/api/overlay/v1/private/recover?x=1',
  '/api/overlay/v1/private/RECOVER',
  '/api/overlay/v1/private/recover/'
])('rejects ambiguous selected endpoint %s', async path => {
  const f = await fixture()
  const response = await fetch(f.origin + path, { method: 'POST', headers: f.headers, body: '{}' })
  expect([400, 404]).toContain(response.status)
  expect(f.current()).toBeUndefined()
})
