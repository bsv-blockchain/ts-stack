import express, { type Request, type Response, type RequestHandler } from 'express'
import { EventEmitter } from 'node:events'
import { OUTPUT_PROFILES, PrivateKey } from '@bsv/sdk'
import { createProposalRouter, type ProposalRouteOptions } from '../ProposalRoutes.js'
import { guardProposalResponse } from '../ProposalResponseGuard.js'
import { sendProposalHTTPError } from '../ProposalHTTPPolicy.js'

jest.mock('../ProposalResponseGuard.js', () => ({ guardProposalResponse: jest.fn() }))

const identity = new PrivateKey(81).toPublicKey().toString()
const path = '/api/overlay/v1/proposals/get'
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
      'x-bsv-overlay-capability': 'ab'.repeat(32),
      'x-bsv-overlay-profile': OUTPUT_PROFILES.proposal
    } as Record<string, string | string[] | undefined>,
    body: undefined as unknown,
    auth: { identityKey: identity } as { identityKey?: string } | undefined
  })
}
function response() {
  const fields = new Map<string, string>()
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    vary: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    set: jest.fn((name: string | Record<string, string>, value?: string): Response => {
      if (typeof name === 'string') fields.set(name, value!)
      else for (const [key, item] of Object.entries(name)) fields.set(key, item)
      return res as unknown as Response
    }),
    getHeader: (name: string) => fields.get(name),
    destroy: jest.fn((): Response => {
      res.destroyed = true
      res.emit('close')
      return res as unknown as Response
    })
  })
  return { res, fields, native: res as unknown as Response }
}
function fixture(overrides: Partial<ProposalRouteOptions> = {}) {
  const get = jest.fn().mockResolvedValue({ version: 1 })
  const bind = jest.fn(() => ({
    body: '{"version":1}',
    reference: { kind: 'channel' as const, channelKey: 'local' },
    validate: () => true
  }))
  const options: ProposalRouteOptions = {
    service: { get, put: get, finalize: get },
    disclosure: { bind },
    journal: { responseEnqueue: 'proposal-journal-send/1', enqueueResponse: jest.fn() },
    authenticate: jest.fn((_req, _res, next) => next()),
    authorizeControl: () => true,
    baseURL: 'https://provider.example/api',
    ...overrides
  }
  let parserBody: unknown = Buffer.from('{}'),
    parserError: unknown
  const raw = jest.spyOn(express, 'raw').mockImplementation(() => (req, _res, next) => {
    ;(req as Request).body = parserBody
    next(parserError)
  })
  const handler = createProposalRouter(options).stack[0].handle as RequestHandler
  return {
    get,
    bind,
    options,
    raw,
    parser(body: unknown, error?: unknown) {
      parserBody = body
      parserError = error
    },
    async call(req = request(), result = response()) {
      const next = jest.fn()
      handler(req as unknown as Request, result.native, next)
      await new Promise<void>(resolve => setImmediate(resolve))
      return { req, ...result, next }
    }
  }
}
afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

it('bounds exact header bytes and rejects duplicate names before authentication', async () => {
  const f = fixture()
  const req = request()
  req.rawHeaders = ['x', 'a'.repeat(16383)]
  expect((await f.call(req)).res.status).toHaveBeenCalledWith(200)
  for (const rawHeaders of [
    ['x', 'a'.repeat(16384)],
    ['X-Local', 'a', 'x-local', 'b']
  ]) {
    const invalid = request()
    invalid.rawHeaders = rawHeaders
    const result = await f.call(invalid)
    expect(result.res.status).toHaveBeenCalledWith(rawHeaders.length === 2 ? 413 : 400)
  }
  expect(f.options.authenticate).toHaveBeenCalledTimes(1)
})

it('preserves all raw bytes without decompression and owns the authenticated caller', async () => {
  const f = fixture({ maximumRequestBytes: 512 }),
    req = request()
  req.headers['content-type'] = ' APPLICATION/JSON ; charset=utf-8'
  req.headers['content-encoding'] = 'identity'
  f.parser(Buffer.from('  {"version":1}  '))
  expect((await f.call(req)).res.status).toHaveBeenCalledWith(200)
  const raw = f.raw.mock.calls[0][0]!
  expect(raw.limit).toBe(512)
  expect(raw.inflate).toBe(false)
  expect((raw.type as () => boolean)()).toBe(true)
  const [text, caller] = f.get.mock.calls[0]
  expect(text).toBe('  {"version":1}  ')
  expect(caller).toEqual({ caller: identity, capabilityDigest: 'ab'.repeat(32) })
  expect(Object.isFrozen(caller)).toBe(true)
})

it('releases transport slots exactly once and expires stalled requests', async () => {
  const f = fixture({ maximumRequests: 1, requestTimeoutMs: 10, authenticate: jest.fn() })
  const first = await f.call()
  expect((await f.call()).res.status).toHaveBeenCalledWith(413)
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  expect(first.res.destroy).toHaveBeenCalledTimes(1)
  first.res.emit('finish')
  const next = await f.call()
  expect(next.res.status).not.toHaveBeenCalled()
  expect((await f.call()).res.status).toHaveBeenCalledWith(413)
  next.res.emit('finish')
})

it.each([undefined, 'not-a-buffer', Buffer.alloc(0)])(
  'rejects an absent raw body (%j)',
  async body => {
    const f = fixture()
    f.parser(body)
    expect((await f.call()).res.status).toHaveBeenCalledWith(400)
    expect(f.options.authenticate).not.toHaveBeenCalled()
  }
)

it.each([
  new Error('parse'),
  { type: 'entity.too.large' },
  Object.assign(new Error('large'), { type: 'entity.too.large' })
])('distinguishes oversized parser errors from other failures', async error => {
  const f = fixture()
  f.parser(undefined, error)
  expect((await f.call()).res.status).toHaveBeenCalledWith(
    error instanceof Error && 'type' in error ? 413 : 400
  )
  expect(f.options.authenticate).not.toHaveBeenCalled()
})

it.each([undefined, {}, { identityKey: 'unknown' }])(
  'rejects missing authenticated authority (%j)',
  async auth => {
    const f = fixture(),
      req = request()
    req.auth = auth
    expect((await f.call(req)).res.status).toHaveBeenCalledWith(401)
    expect(f.get).not.toHaveBeenCalled()
  }
)

it('does not execute after request cancellation or an already completed authentication response', async () => {
  for (const kind of ['request', 'closed', 'ended'] as const) {
    const f = fixture({
      authenticate: (_req, res, next) => {
        if (kind === 'ended') Object.defineProperty(res, 'writableEnded', { value: true })
        next()
      }
    })
    const req = request(),
      result = response()
    req.aborted = kind === 'request'
    result.res.destroyed = kind === 'closed'
    await f.call(req, result)
    expect(f.get).not.toHaveBeenCalled()
    result.res.emit('close')
  }
})

it('hands off disabled handshake paths and sanitizes authentication failures', async () => {
  const f = fixture({ handleHandshake: false }),
    req = request()
  req.path = req.url = '/.well-known/auth'
  expect((await f.call(req)).next).toHaveBeenCalledTimes(1)
  const missing = fixture()
  expect((await missing.call(req)).res.status).toHaveBeenCalledWith(422)
  const failed = fixture({ authenticate: (_req, _res, next) => next(new Error('private')) })
  const result = await failed.call()
  expect(result.res.status).toHaveBeenCalledWith(503)
  expect(Buffer.from(result.res.end.mock.calls[0][0]).toString()).not.toContain('private')
  expect(failed.get).not.toHaveBeenCalled()
})

it('closes after a prepared response fails rather than emitting an unguarded replacement', async () => {
  const f = fixture(),
    result = response()
  result.res.end.mockImplementation(() => {
    throw new Error('local write failure')
  })
  await f.call(request(), result)
  expect(guardProposalResponse).toHaveBeenCalledTimes(1)
  expect(result.res.destroy).toHaveBeenCalledTimes(1)
  expect(result.res.end).toHaveBeenCalledTimes(1)
})

it.each(['destroyed', 'writableEnded', 'headersSent'] as const)(
  'never appends an error after %s',
  state => {
    const result = response()
    result.res[state] = true
    sendProposalHTTPError(result.native, new Error('local'))
    expect(result.res.status).not.toHaveBeenCalled()
    expect(result.res.end).not.toHaveBeenCalled()
  }
)

it.each(['finish', 'close'] as const)(
  'releases a transport slot promptly on %s and removes both listeners',
  async event => {
    const f = fixture({ maximumRequests: 1, requestTimeoutMs: 30000, authenticate: jest.fn() })
    const first = await f.call()
    expect(first.res.listenerCount('finish')).toBe(1)
    expect(first.res.listenerCount('close')).toBe(1)
    expect((await f.call()).res.status).toHaveBeenCalledWith(413)
    first.res.emit(event)
    expect(first.res.listenerCount('finish')).toBe(0)
    expect(first.res.listenerCount('close')).toBe(0)
    const second = await f.call()
    expect(second.res.status).not.toHaveBeenCalled()
    const full = await f.call()
    expect(full.res.status).toHaveBeenCalledWith(413)
    expect(JSON.parse(Buffer.from(full.res.end.mock.calls[0][0]).toString())).toEqual({
      version: 1,
      error: { code: 'limited', message: 'Proposal request limited', retryable: true }
    })
    first.res.emit('finish')
    first.res.emit('close')
    expect((await f.call()).res.status).toHaveBeenCalledWith(413)
    second.res.emit('finish')
  }
)

it('bounds total physical work across principals, retains disconnected work and releases only settled work', async () => {
  const f = fixture({ maximumWork: 2, maximumWorkPerPrincipal: 2 })
  const waiting: { resolve(value: unknown): void; reject(error: unknown): void }[] = []
  f.get.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        waiting.push({ resolve, reject })
      })
  )
  const first = await f.call()
  const otherRequest = request()
  otherRequest.auth = { identityKey: new PrivateKey(82).toPublicKey().toString() }
  const second = await f.call(otherRequest)
  const thirdRequest = () => {
    const value = request()
    value.auth = { identityKey: new PrivateKey(83).toPublicKey().toString() }
    return value
  }
  const full = await f.call(thirdRequest())
  expect(f.get).toHaveBeenCalledTimes(2)
  expect(full.res.status).toHaveBeenCalledWith(413)
  expect(JSON.parse(Buffer.from(full.res.end.mock.calls[0][0]).toString()).error.retryable).toBe(
    true
  )
  first.res.destroy()
  expect((await f.call(thirdRequest())).res.status).toHaveBeenCalledWith(413)
  waiting[0].resolve({ version: 1 })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(first.res.end).not.toHaveBeenCalled()
  const admitted = await f.call(thirdRequest())
  expect(admitted.res.status).not.toHaveBeenCalled()
  expect(f.get).toHaveBeenCalledTimes(3)
  expect((await f.call()).res.status).toHaveBeenCalledWith(413)
  waiting[1].reject(new Error('internal detail'))
  waiting[2].resolve({ version: 1 })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(second.res.status).toHaveBeenCalledWith(503)
  expect(admitted.res.status).toHaveBeenCalledWith(200)
  f.get.mockResolvedValue({ version: 1 })
  expect((await f.call()).res.status).toHaveBeenCalledWith(200)
})

it('counts simultaneous work for one principal until the last call settles', async () => {
  const f = fixture({ maximumWork: 4, maximumWorkPerPrincipal: 2 })
  const waiting: ((value: unknown) => void)[] = []
  f.get.mockImplementation(
    () =>
      new Promise(resolve => {
        waiting.push(resolve)
      })
  )
  const first = await f.call()
  const second = await f.call()
  expect((await f.call()).res.status).toHaveBeenCalledWith(413)
  waiting[0]({ version: 1 })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(first.res.status).toHaveBeenCalledWith(200)
  const third = await f.call()
  expect(f.get).toHaveBeenCalledTimes(3)
  expect((await f.call()).res.status).toHaveBeenCalledWith(413)
  waiting[1]({ version: 1 })
  waiting[2]({ version: 1 })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(second.res.status).toHaveBeenCalledWith(200)
  expect(third.res.status).toHaveBeenCalledWith(200)
  f.get.mockResolvedValue({ version: 1 })
  expect((await f.call()).res.status).toHaveBeenCalledWith(200)
})

it.each(['aborted', 'destroyed', 'writableEnded'] as const)(
  'withholds settled output after %s',
  async state => {
    const f = fixture()
    let finish!: (value: unknown) => void
    f.get.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const first = await f.call()
    if (state === 'aborted') first.req.aborted = true
    else first.res[state] = true
    finish({ version: 1 })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.bind).not.toHaveBeenCalled()
    expect(guardProposalResponse).not.toHaveBeenCalled()
    expect(first.res.end).not.toHaveBeenCalled()
    first.res.emit('close')
  }
)

it.each(['aborted', 'destroyed', 'writableEnded'] as const)(
  'does not disclose a late service error after %s',
  async state => {
    const f = fixture()
    let fail!: (error: unknown) => void
    f.get.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const first = await f.call()
    if (state === 'aborted') first.req.aborted = true
    else first.res[state] = true
    fail(new Error('private detail'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(guardProposalResponse).not.toHaveBeenCalled()
    expect(first.res.end).not.toHaveBeenCalled()
    first.res.emit('close')
  }
)

it('accepts the exact response byte ceiling and guards an oversized response as a control', async () => {
  const f = fixture({ maximumResponseBytes: 13 })
  // UTF-8 bytes, not character count. Each pound sign uses two bytes.
  f.bind.mockReturnValue({
    body: '{"a":"£££"}',
    reference: { kind: 'channel', channelKey: 'local' },
    validate: () => true
  })
  expect(Buffer.byteLength('{"a":"£££"}')).toBe(14)
  const oversized = await f.call()
  expect(oversized.res.status).toHaveBeenCalledWith(413)
  expect(jest.mocked(guardProposalResponse).mock.calls.at(-1)![1].initial).toHaveProperty('error')
  f.bind.mockReturnValue({
    body: '{"a":"££x"}',
    reference: { kind: 'channel', channelKey: 'local' },
    validate: () => true
  })
  const exact = await f.call()
  expect(exact.res.status).toHaveBeenCalledWith(200)
  expect(exact.res.end).toHaveBeenCalledWith('{"a":"££x"}')
  expect(exact.fields.get('content-type')).toBe('application/json')
})

it('supports an origin without a base path and preserves the exact decoded signed text', async () => {
  const f = fixture({ baseURL: 'https://provider.example' })
  const req = request()
  req.path = req.url = '/overlay/v1/proposals/get'
  const text = '\uFEFF{"value":"£"}'
  f.parser(Buffer.from(text))
  expect((await f.call(req)).res.status).toHaveBeenCalledWith(200)
  expect(f.get.mock.calls[0][0]).toBe(text)
})

it('requires media type and canonical query-free POST before authentication', async () => {
  const f = fixture()
  const absent = request()
  delete absent.headers['content-type']
  const queried = request()
  queried.url += '?x=1'
  for (const req of [absent, queried]) {
    const result = await f.call(req)
    expect(result.res.status).toHaveBeenCalledWith(400)
    expect(result.fields.get('content-type')).toBe('application/json')
    expect(JSON.parse(Buffer.from(result.res.end.mock.calls[0][0]).toString())).toEqual({
      version: 1,
      error: { code: 'invalid', message: 'Proposal request invalid', retryable: false }
    })
  }
  expect(f.options.authenticate).not.toHaveBeenCalled()
})

it.each(['aborted', 'destroyed'] as const)('stops after authentication changes %s', async state => {
  const f = fixture({
    authenticate: (req, res, next) => {
      Object.defineProperty(state === 'aborted' ? req : res, state, { value: true })
      next()
    }
  })
  const result = await f.call()
  expect(f.get).not.toHaveBeenCalled()
  expect(guardProposalResponse).not.toHaveBeenCalled()
  expect(result.res.end).not.toHaveBeenCalled()
  result.res.emit('close')
})
