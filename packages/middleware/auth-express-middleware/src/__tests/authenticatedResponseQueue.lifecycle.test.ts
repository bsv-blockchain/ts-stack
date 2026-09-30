import { getEventListeners } from 'node:events'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Socket, type AddressInfo } from 'node:net'
import type { Response } from 'express'
import {
  AuthenticatedResponseQueue,
  authenticatedResponseQueue,
  bindAuthenticatedResponseQueue,
  guardAuthenticatedResponse,
  type AuthenticatedResponseQueueGuard,
  type AuthenticatedResponseReplacement
} from '../authenticatedResponseQueue.js'

// Exercise the transport lifetime independently of peer signing. Actual BRC-104
// signatures and HTTP bytes are checked by the companion integration suite.
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
function fixture(maximum = 16) {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.httpVersionMajor = 1
  req.method = 'POST'
  const res = new ServerResponse(req) as unknown as Response
  for (const name of ['end', 'write', 'writeHead', 'flushHeaders'] as const)
    Reflect.set(res, `__${name}`, ServerResponse.prototype[name])
  const queue = new AuthenticatedResponseQueue(res, 'fixture-identity', 'fixture-request', maximum)
  cleanup.push(() => {
    queue.close()
    socket.destroy()
  })
  return { req, res, queue }
}
function candidate(body = new Uint8Array([1, 2])): AuthenticatedResponseReplacement {
  return { statusCode: 200, headers: { 'x-value': 'original' }, body }
}
const enqueue: AuthenticatedResponseQueueGuard = (_response, send) => send()
const restore = () => undefined

it('keeps ordinary unbound responses available and seals a bound unguarded response', () => {
  const { res } = fixture()
  expect(authenticatedResponseQueue(res)).toBeUndefined()
  bindAuthenticatedResponseQueue(res, 'identity', 'request', 16)
  expect(authenticatedResponseQueue(res)).toBeUndefined()
  expect(() => guardAuthenticatedResponse(res, enqueue)).toThrow('exactly once before sending')
})
it.each([undefined, null, {}, 'guard'])('rejects a non-callable guard (%s)', guard => {
  const { queue } = fixture()
  expect(() => queue.register(guard as AuthenticatedResponseQueueGuard)).toThrow(
    'exactly once before sending'
  )
  expect(queue.registered).toBe(false)
})
it.each(['fake', 'http2'])('rejects unsupported native response type (%s)', mode => {
  const { req, res } = fixture()
  req.httpVersionMajor = 2
  const queue = new AuthenticatedResponseQueue(mode === 'fake' ? ({} as Response) : res, '', '', 16)
  expect(() => queue.register(enqueue)).toThrow('native Node HTTP/1 transport')
})
it.each(['headersSent', 'writableEnded', 'destroyed'])(
  'refuses registration when the response is already %s',
  flag => {
    const { queue, res } = fixture()
    Object.defineProperty(res, flag, { configurable: true, value: true })
    expect(() => queue.register(enqueue)).toThrow('already closed or queued')
  }
)
it.each(['getHeaders', 'getHeaderNames', 'setHeader', 'removeHeader'])(
  'rejects deferred or substituted header method %s',
  method => {
    const { queue, res } = fixture()
    Reflect.set(res, method, () => undefined)
    expect(() => queue.register(enqueue)).toThrow('native HTTP header methods')
  }
)
it('accepts the inclusive final status and body limits, and an initial response above 64 KiB', async () => {
  const { queue } = fixture(2)
  queue.register(enqueue)
  const input = { ...candidate(), statusCode: 599 }
  queue.prepare(input, 0)
  await expect(queue.deliver(599, {}, input.body, restore)).resolves.toBeUndefined()
  expect(queue.queued).toBe(true)
  const large = fixture(-1).queue
  large.register(enqueue)
  expect(large.prepare(candidate(new Uint8Array(65537)), 0).body).toHaveLength(65537)
})
it('owns both the submitted candidate and the snapshot returned for signing', async () => {
  const { queue, res } = fixture()
  queue.register(enqueue)
  const input = candidate()
  const signing = queue.prepare(input, 0)
  input.body[0] = 99
  input.headers['x-value'] = 'changed'
  signing.body[1] = 99
  signing.headers['x-value'] = 'also changed'
  await expect(queue.deliver(200, {}, new Uint8Array([1, 2]), restore)).resolves.toBeUndefined()
  expect(res.getHeader('x-value')).toBe('original')
  expect(queue.queued).toBe(true)
})
it.each(['string', 'extra', 'head-body'])('rejects malformed initial candidate %s', mode => {
  const { queue, req } = fixture()
  queue.register(enqueue)
  const input = candidate()
  if (mode === 'string') Reflect.set(input, 'headers', 'not headers')
  if (mode === 'extra') Reflect.set(input, 'unrecognized', true)
  if (mode === 'head-body') req.method = 'HEAD'
  expect(() => queue.prepare(input, 0)).toThrow(
    mode === 'string' ? 'headers' : mode === 'extra' ? 'status, headers and body' : 'bodyless'
  )
})
it.each(['repeat', 'seal', 'close'])('does not prepare a response after %s', mode => {
  const { queue } = fixture()
  queue.register(enqueue)
  if (mode === 'repeat') queue.prepare(candidate(), 0)
  if (mode === 'seal') queue.sealUnguarded()
  if (mode === 'close') queue.close()
  expect(() => queue.prepare(candidate(), 0)).toThrow('not ready to sign')
})
it.each(['unprepared', 'unregistered', 'closed'])(
  'rejects a signed response outside its signing lifetime (%s)',
  async mode => {
    const { queue } = fixture()
    if (mode !== 'unregistered') queue.register(enqueue)
    if (mode !== 'unprepared') queue.prepare(candidate(), 0)
    if (mode === 'closed') queue.close()
    await expect(queue.deliver(200, {}, new Uint8Array([1, 2]), restore)).rejects.toThrow(
      'unexpected signed response'
    )
    expect(queue.queued).toBe(false)
  }
)
it.each(['status', 'bytes'])('rejects a signed %s mismatch without sending', async mode => {
  const { queue, res } = fixture()
  queue.register(enqueue)
  queue.prepare(candidate(), 0)
  await expect(
    queue.deliver(
      mode === 'status' ? 201 : 200,
      {},
      new Uint8Array(mode === 'bytes' ? [3] : [1, 2]),
      restore
    )
  ).rejects.toThrow('differs from the retained candidate')
  expect(res.headersSent).toBe(false)
  expect(queue.queued).toBe(false)
})
it('cannot commit when native response restoration failed', async () => {
  const { queue, res } = fixture()
  queue.register(enqueue)
  queue.prepare(candidate(), 0)
  await expect(
    queue.deliver(200, {}, new Uint8Array([1, 2]), () => {
      Reflect.set(res, 'end', () => undefined)
    })
  ).rejects.toThrow('Native response restoration failed')
  expect(queue.queued).toBe(false)
  expect(res.headersSent).toBe(false)
})
it('rejects nonempty Reset Content before signing bytes the HTTP client cannot consume', () => {
  const { queue } = fixture()
  queue.register(enqueue)
  expect(() => queue.prepare({ ...candidate(), statusCode: 205 }, 0)).toThrow('bodyless')
})
it('cannot both send and request a replacement', async () => {
  const { queue } = fixture()
  queue.register((_response, send) => {
    send()
    return candidate()
  })
  queue.prepare(candidate(), 0)
  await expect(queue.deliver(200, {}, new Uint8Array([1, 2]), restore)).rejects.toThrow(
    'cannot also be replaced'
  )
  expect(queue.queued).toBe(true)
})
it.each(['missing', 'second', 'oversize'])('enforces one bounded replacement (%s)', async mode => {
  const { queue } = fixture(-1)
  queue.register(() =>
    mode === 'missing' ? undefined : candidate(new Uint8Array(mode === 'oversize' ? 65537 : 2))
  )
  queue.prepare(candidate(), mode === 'second' ? 1 : 0)
  await expect(queue.deliver(200, {}, new Uint8Array([1, 2]), restore)).rejects.toThrow(
    mode === 'oversize' ? '64 KiB' : 'one bounded replacement'
  )
  expect(queue.queued).toBe(false)
})
it('cancels pending work immediately on response close and removes its abort listener', async () => {
  const { queue, res } = fixture()
  let signal!: AbortSignal
  let entered!: () => void
  const checking = new Promise<void>(resolve => {
    entered = resolve
  })
  queue.register((_response, _send, value) => {
    signal = value
    entered()
    return new Promise<void>(() => undefined)
  })
  queue.prepare(candidate(), 0)
  const delivery = queue.deliver(200, {}, new Uint8Array([1, 2]), restore)
  // Capture an early failure as data before any assertion or suspension. A
  // broken signing lifetime must fail the test, not create an unhandled matcher
  // rejection while the test is still waiting to enter its guard.
  const completed = delivery.then(
    () => undefined,
    error => error as unknown
  )
  await Promise.race([checking, completed])
  expect(signal).toBeDefined()
  expect(getEventListeners(signal, 'abort')).toHaveLength(1)
  res.emit('close')
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  expect(await completed).toMatchObject({ message: expect.stringContaining('cancelled') })
  expect(signal.aborted).toBe(true)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  expect(queue.queued).toBe(false)
})
it('removes cancellation listeners when work completes without cancelling the request', async () => {
  const { queue } = fixture()
  let signal!: AbortSignal
  queue.register((_response, _send, value) => {
    signal = value
    return candidate()
  })
  queue.prepare(candidate(), 0)
  await queue.deliver(200, {}, new Uint8Array([1, 2]), restore)
  expect(signal.aborted).toBe(false)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  await expect(queue.wait(Promise.resolve('complete'))).resolves.toBe('complete')
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})
it('preserves a finished native response when cleaning up its guard', () => {
  const { queue, res } = fixture()
  Object.defineProperty(res, 'writableFinished', { configurable: true, value: true })
  queue.close()
  expect(res.destroyed).toBe(false)
  expect(() => queue.register(enqueue)).toThrow('exactly once before sending')
})

it('owns the signed byte buffer before the application guard runs', async () => {
  let failure: unknown
  const server = createServer((req, nativeResponse) => {
    const res = nativeResponse as unknown as Response
    for (const name of ['end', 'write', 'writeHead', 'flushHeaders'] as const)
      Reflect.set(res, `__${name}`, ServerResponse.prototype[name])
    const queue = new AuthenticatedResponseQueue(res, 'fixture-identity', 'fixture-request', 16)
    const signedBytes = new Uint8Array([1, 2])
    queue.register((_response, send) => {
      // The signer/caller may reuse its buffer after handing it to transport.
      // This cannot alter already captured bytes while the final guard runs.
      signedBytes[0] = 99
      send()
    })
    queue.prepare(candidate(), 0)
    void queue.deliver(200, {}, signedBytes, restore).catch(error => {
      failure = error
      res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
      signal: AbortSignal.timeout(2000)
    })
    expect(response.status).toBe(200)
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2])
    expect(failure).toBeUndefined()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
})
