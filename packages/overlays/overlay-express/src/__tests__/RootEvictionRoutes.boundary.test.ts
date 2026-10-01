import express, { type Request, type Response, type RequestHandler } from 'express'
import { EventEmitter } from 'node:events'
import { OUTPUT_PROFILES, OutputProtocolError, PrivateKey } from '@bsv/sdk'
import { createRootEvictionRouter, type RootEvictionRouteOptions } from '../RootEvictionRoutes.js'
import { guardRootAdvertisementResponse } from '../RootEvictionResponseGuard.js'
import {
  rootHTTPCORS,
  rootHTTPControlHeaders,
  sendRootHTTPError
} from '../RootEvictionHTTPPolicy.js'

jest.mock('../RootEvictionResponseGuard.js', () => ({ guardRootAdvertisementResponse: jest.fn() }))

const identity = new PrivateKey(81).toPublicKey().toString()
const selector = 'ab'.repeat(32)
const path = '/api/overlay/v1/root-evictions/request'
const authHeaders = [
  'x-bsv-auth-identity-key',
  'x-bsv-auth-message-type',
  'x-bsv-auth-nonce',
  'x-bsv-auth-request-id',
  'x-bsv-auth-requested-certificates',
  'x-bsv-auth-signature',
  'x-bsv-auth-version',
  'x-bsv-auth-your-nonce'
]
const profileHeaders = ['x-bsv-overlay-capability', 'x-bsv-overlay-profile']

function response() {
  const fields = new Map<string, unknown>()
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    vary: jest.fn().mockReturnThis(),
    set: jest.fn(function (name: string | Record<string, string>, value?: string): Response {
      if (typeof name === 'string') fields.set(name, value)
      else for (const [key, item] of Object.entries(name)) fields.set(key, item)
      return res as unknown as Response
    }),
    getHeader: (name: string) => fields.get(name),
    end: jest.fn().mockReturnThis()
  })
  return { res, fields, native: res as unknown as Response }
}

function request() {
  return Object.assign(new EventEmitter(), {
    path,
    url: path,
    method: 'POST',
    rawHeaders: [] as string[],
    aborted: false,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-bsv-overlay-capability': selector,
      'x-bsv-overlay-profile': OUTPUT_PROFILES.eviction
    } as Record<string, string | string[] | undefined>,
    body: undefined as unknown,
    auth: { identityKey: identity } as { identityKey?: string } | undefined
  })
}

function fixture(overrides: Partial<RootEvictionRouteOptions> = {}) {
  const body = {
    body: '{}',
    headers: {
      'x-bsv-overlay-capability': selector,
      'x-bsv-overlay-profile': OUTPUT_PROFILES.eviction
    },
    head: { revision: '0' },
    access: {
      operation: 'submit' as const,
      principal: identity,
      requester: identity,
      requestId: selector
    }
  }
  const submit = jest.fn().mockResolvedValue(body)
  const options: RootEvictionRouteOptions = {
    companion: { submit, status: jest.fn().mockResolvedValue(body) },
    journal: { head: jest.fn(), enqueue: jest.fn() },
    baseURL: 'https://root.example/api',
    authenticate: jest.fn((_req, _res, next) => next()),
    manifest: () => undefined,
    authorize: jest.fn(() => true),
    ...overrides
  }
  let parserBody: unknown = Buffer.from('{}')
  let parserError: unknown
  const raw = jest.spyOn(express, 'raw').mockImplementation(() => (req, res, next) => {
    ;(req as Request).body = parserBody
    next(parserError)
  })
  const router = createRootEvictionRouter(options)
  // Invoke the registered Express middleware directly to observe lifecycle and
  // parser failure contracts. Separate tests exercise real HTTP and signatures.
  const handler = router.stack[0].handle as RequestHandler
  return {
    body,
    submit,
    options,
    raw,
    parser(value: unknown, error?: unknown) {
      parserBody = value
      parserError = error
    },
    async call(req = request(), res = response()) {
      const next = jest.fn()
      handler(req as unknown as Request, res.native, next)
      await new Promise<void>(resolve => setImmediate(resolve))
      return { req, ...res, next }
    }
  }
}

afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

it('preserves the complete browser authentication/profile vocabulary and never cookies', () => {
  const f = response(),
    req = request()
  expect(rootHTTPCORS(req as unknown as Request, f.native)).toBe(true)
  expect(f.fields.get('access-control-allow-methods')).toBe('POST, OPTIONS')
  expect(f.fields.get('access-control-allow-headers')).toBe(
    ['authorization', 'content-type', 'cache-control', ...authHeaders, ...profileHeaders].join(', ')
  )
  expect(f.fields.get('access-control-expose-headers')).toBe(
    [...authHeaders, ...profileHeaders].join(', ')
  )
  expect(f.fields.get('cache-control')).toBe('private, no-store')
  expect(f.fields.has('access-control-allow-credentials')).toBe(false)
})

it.each([
  undefined,
  ' Content-Type , X-BSV-AUTH-SIGNATURE ',
  'content-type,x-extra',
  ['content-type']
])('terminates preflight with exact allowed header semantics: %j', requested => {
  const f = response(),
    req = request()
  req.method = 'OPTIONS'
  req.headers['access-control-request-headers'] = requested
  expect(rootHTTPCORS(req as unknown as Request, f.native)).toBe(false)
  expect(f.res.status).toHaveBeenCalledWith(
    requested === undefined || (typeof requested === 'string' && !requested.includes('extra'))
      ? 204
      : 403
  )
  expect(f.res.end).toHaveBeenCalledTimes(1)
})

it('copies only complete locally selected string control headers', () => {
  const f = response()
  const allowed = [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'vary',
    ...profileHeaders
  ]
  const expected = Object.fromEntries(allowed.map((key, index) => [key, String(index)]))
  for (const [key, value] of Object.entries(expected)) f.fields.set(key, value)
  f.fields.set('set-cookie', 'private-cookie')
  f.fields.set('x-bsv-auth-signature', 'obsolete-signature')
  expect(rootHTTPControlHeaders(f.native)).toEqual(expected)
  f.fields.set('vary', ['Origin'])
  expect(rootHTTPControlHeaders(f.native)).not.toHaveProperty('vary')
})

it.each(['destroyed', 'writableEnded', 'headersSent'] as const)(
  'does not write another error after %s',
  state => {
    const f = response()
    f.res[state] = true
    sendRootHTTPError(f.native, new Error('private diagnostic'))
    expect(f.res.end).not.toHaveBeenCalled()
    expect(f.res.status).not.toHaveBeenCalled()
  }
)

it('serializes a bounded sanitized error with its exact status and media type', () => {
  const f = response()
  sendRootHTTPError(f.native, new OutputProtocolError('limited', 'private diagnostic', true))
  expect(f.res.status).toHaveBeenCalledWith(413)
  expect(f.fields.get('content-type')).toBe('application/json')
  expect(JSON.parse(f.res.end.mock.calls[0][0])).toEqual({
    version: 1,
    error: { code: 'limited', message: 'Root request limited', retryable: true }
  })
})

it('uses bounded raw parsing without decompression and accepts identity content encoding', async () => {
  const f = fixture({ maximumRequestBytes: 512 }),
    req = request()
  req.headers['content-encoding'] = 'identity'
  req.headers['content-type'] = ' APPLICATION/JSON ; charset=utf-8'
  const result = await f.call(req)
  const raw = f.raw.mock.calls[0][0]!
  expect(raw.limit).toBe(512)
  expect(raw.inflate).toBe(false)
  expect((raw.type as () => boolean)()).toBe(true)
  expect(result.res.status).toHaveBeenCalledWith(200)
  expect(result.fields.get('content-type')).toBe('application/json')
  expect(f.submit).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'case', 'query', 'method', 'media'])(
  'rejects %s without falling through or authenticating',
  async kind => {
    const f = fixture(),
      req = request()
    if (kind === 'unknown') req.path += '/extra'
    if (kind === 'case') req.path = path.toUpperCase()
    if (kind === 'query') req.url += '?'
    if (kind === 'method') req.method = 'PUT'
    if (kind === 'media') delete req.headers['content-type']
    const r = await f.call(req)
    expect(r.next).not.toHaveBeenCalled()
    expect(r.res.status).toHaveBeenCalledWith(['unknown', 'case'].includes(kind) ? 404 : 400)
    expect(f.options.authenticate).not.toHaveBeenCalled()
  }
)

it('allows exactly the inclusive header byte ceiling', async () => {
  const f = fixture(),
    req = request()
  req.rawHeaders = ['x-padding', 'a'.repeat(16384 - 9)]
  expect((await f.call(req)).res.status).toHaveBeenCalledWith(200)
  const larger = request()
  larger.rawHeaders = ['x-padding', 'a'.repeat(16384 - 8)]
  expect((await f.call(larger)).res.status).toHaveBeenCalledWith(413)
  expect(f.submit).toHaveBeenCalledTimes(1)
})

it.each([
  new Error('parse failure'),
  { type: 'entity.too.large' },
  Object.assign(new Error('large'), { type: 'entity.too.large' })
])('distinguishes actual oversized parser errors from other failures', async error => {
  const f = fixture()
  f.parser(undefined, error)
  const r = await f.call()
  expect(r.res.status).toHaveBeenCalledWith(error instanceof Error && 'type' in error ? 413 : 400)
  expect(f.options.authenticate).not.toHaveBeenCalled()
})

it.each([undefined, 'unknown', {}])(
  'requires an actual authenticated principal: %j',
  async principal => {
    const f = fixture(),
      req = request()
    req.auth = typeof principal === 'string' ? { identityKey: principal } : principal
    const r = await f.call(req)
    expect(r.res.status).toHaveBeenCalledWith(401)
    expect(f.submit).not.toHaveBeenCalled()
  }
)

it('accepts a response exactly at the configured byte limit', async () => {
  const f = fixture({ maximumResponseBytes: 2 })
  expect((await f.call()).res.status).toHaveBeenCalledWith(200)
})

it('mounts the exact origin-root path without an accidental double slash', async () => {
  const f = fixture({ baseURL: 'https://root.example' }),
    req = request()
  req.path = req.url = '/overlay/v1/root-evictions/request'
  const r = await f.call(req)
  expect(r.next).not.toHaveBeenCalled()
  expect(r.res.status).toHaveBeenCalledWith(200)
})

it.each([Buffer.from([0xc3, 0x28]), Buffer.from(''), '{}'])(
  'rejects absent/non-byte or invalid UTF-8 parser output before authentication',
  async body => {
    const f = fixture()
    f.parser(body)
    const r = await f.call()
    expect(r.res.status).toHaveBeenCalledWith(400)
    expect(f.options.authenticate).not.toHaveBeenCalled()
  }
)

it('captures immutable complete access and rejects a different authenticated recipient', async () => {
  const f = fixture()
  await f.call()
  const guard = jest.mocked(guardRootAdvertisementResponse).mock.calls[0][1]
  expect(guard.targets).toEqual([])
  expect(guard.revision).toBe('0')
  expect(guard.authorize(new PrivateKey(82).toPublicKey().toString(), 'data')).toBe(false)
  expect(f.options.authorize).not.toHaveBeenCalled()
  expect(guard.authorize(identity, 'data')).toBe(true)
  const access = jest.mocked(f.options.authorize).mock.calls[0][1]
  expect(access).toEqual(f.body.access)
  expect(Object.isFrozen(access)).toBe(true)
  f.body.access.requestId = 'cd'.repeat(32)
  expect(access!.requestId).toBe(selector)
  expect(guard.authorize(identity, 'control')).toBe(true)
  expect(f.options.authorize).toHaveBeenLastCalledWith(identity, undefined)
})

it.each(['aborted', 'close'])(
  'cancels pending work on %s and removes listeners after settlement',
  async event => {
    const f = fixture(),
      req = request(),
      r = response()
    let settle!: (value: typeof f.body) => void
    f.submit.mockImplementation(
      () =>
        new Promise(resolve => {
          settle = resolve
        })
    )
    await f.call(req, r)
    const signal = f.submit.mock.calls[0][3] as AbortSignal
    expect(signal.aborted).toBe(false)
    if (event === 'aborted') req.emit(event)
    else r.res.emit(event)
    expect(signal.aborted).toBe(true)
    settle(f.body)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(r.res.end).not.toHaveBeenCalled()
    expect(guardRootAdvertisementResponse).not.toHaveBeenCalled()
    expect(req.listenerCount('aborted')).toBe(0)
    expect(r.res.listenerCount('close')).toBe(event === 'close' ? 0 : 1)
  }
)

it.each(['aborted', 'destroyed'] as const)(
  'passes a cancelled signal to work already %s',
  async state => {
    const f = fixture(),
      req = request(),
      r = response()
    if (state === 'aborted') req.aborted = true
    else r.res.destroyed = true
    await f.call(req, r)
    expect((f.submit.mock.calls[0][3] as AbortSignal).aborted).toBe(true)
    expect(r.res.end).not.toHaveBeenCalled()
  }
)

it.each(['destroyed', 'writableEnded'] as const)(
  'does not enqueue a settled result when response is %s',
  async state => {
    const f = fixture(),
      r = response()
    f.submit.mockImplementation(async () => {
      r.res[state] = true
      return f.body
    })
    await f.call(request(), r)
    expect(r.res.end).not.toHaveBeenCalled()
    expect(guardRootAdvertisementResponse).not.toHaveBeenCalled()
  }
)

it.each(['finish', 'close'])(
  'releases capacity once at %s and removes both release listeners',
  async event => {
    const f = fixture({ maximumRequests: 1 }),
      first = await f.call()
    expect(first.res.listenerCount('finish')).toBe(1)
    expect(first.res.listenerCount('close')).toBe(1)
    expect((await f.call()).res.status).toHaveBeenCalledWith(413)
    first.res.emit(event)
    expect(first.res.listenerCount('finish')).toBe(0)
    expect(first.res.listenerCount('close')).toBe(0)
    first.res.emit('finish')
    first.res.emit('close')
    expect((await f.call()).res.status).toHaveBeenCalledWith(200)
    expect((await f.call()).res.status).toHaveBeenCalledWith(413)
  }
)
