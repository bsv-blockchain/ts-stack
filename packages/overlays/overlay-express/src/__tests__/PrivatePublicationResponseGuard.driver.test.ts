import { expect, it, jest } from '@jest/globals'
import type { Response } from 'express'
import type {
  AuthenticatedResponseCandidate,
  AuthenticatedResponseQueueGuard
} from '@bsv/auth-express-middleware'
import { OUTPUT_PROFILES, OutputProtocolError, PrivateKey } from '@bsv/sdk'
import type { PrivatePublicationHTTPPrepared } from '../PrivatePublicationHTTPPorts.js'

let installed: AuthenticatedResponseQueueGuard
jest.unstable_mockModule('@bsv/auth-express-middleware', () => ({
  guardAuthenticatedResponse(_res: Response, guard: AuthenticatedResponseQueueGuard) {
    installed = guard
  }
}))
const { guardPrivatePublicationResponse } = await import('../PrivatePublicationResponseGuard.js')
const { privatePublicationHTTPError } = await import('../PrivatePublicationHTTPPolicy.js')
const publisher = new PrivateKey(63).toPublicKey().toString()
function fixture() {
  const abort = new AbortController()
  const caller = {
    publisher,
    capability: '11'.repeat(32),
    profile: OUTPUT_PROFILES.publication,
    current: () => true,
    signal: abort.signal
  }
  const headers = {
    'x-bsv-overlay-capability': caller.capability,
    'x-bsv-overlay-profile': caller.profile,
    'cache-control': 'private, no-store',
    'content-type': 'application/json; charset=utf-8'
  }
  const body = '{"version":1,"status":"pending"}'
  const prepared: PrivatePublicationHTTPPrepared = {
    body,
    headers,
    enqueue: send => {
      send(body, headers)
    }
  }
  const disclosure = {
    prepare: () => prepared,
    enqueueControl: (_input: unknown, _caller: unknown, send: () => void) => {
      send()
    }
  }
  const options = { caller, disclosure, initial: { prepared }, controlHeaders: {} }
  const candidate: AuthenticatedResponseCandidate = {
    attempt: 0,
    identityKey: publisher,
    requestId: 'synthetic-local-request',
    statusCode: 200,
    body: Buffer.from(body),
    headers: { ...headers }
  }
  const enqueue = jest.fn<() => void>(),
    signal = new AbortController()
  return {
    abort,
    caller,
    prepared,
    disclosure,
    options,
    candidate,
    enqueue,
    signal,
    run() {
      guardPrivatePublicationResponse({} as Response, options)
      return installed(candidate, enqueue, signal.signal)
    }
  }
}
it.each([
  'identity',
  'capability',
  'profile',
  'cache',
  'media',
  'status',
  'length',
  'byte'
] as const)(
  'withholds mismatched signed response %s and permits only a fixed replacement',
  async mode => {
    const f = fixture()
    if (mode === 'identity')
      Object.assign(f.candidate, { identityKey: new PrivateKey(64).toPublicKey().toString() })
    if (mode === 'capability') f.candidate.headers['x-bsv-overlay-capability'] = '22'.repeat(32)
    if (mode === 'profile') f.candidate.headers['x-bsv-overlay-profile'] = 'urn:other'
    if (mode === 'cache') f.candidate.headers['cache-control'] = 'public'
    if (mode === 'media') f.candidate.headers['content-type'] = 'text/plain'
    if (mode === 'status') f.candidate.statusCode = 201
    if (mode === 'length') f.candidate.body = Buffer.from('{}')
    if (mode === 'byte') f.candidate.body[0] = 0
    const result = await f.run()
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      statusCode: ['status', 'length', 'byte'].includes(mode) ? 400 : 401,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': 'application/json; charset=utf-8'
      }
    })
  }
)
it('requires exact body and selector inside the native callback', async () => {
  for (const change of ['body', 'capability', 'profile'] as const) {
    const f = fixture()
    f.prepared.enqueue = send =>
      send(change === 'body' ? 'changed' : f.prepared.body, {
        ...f.prepared.headers,
        ...(change === 'body' ? {} : { ['x-bsv-overlay-' + change]: 'changed' })
      })
    expect(await f.run()).toMatchObject({ statusCode: 409 })
    expect(f.enqueue).not.toHaveBeenCalled()
  }
})
it('enqueues once, refuses a second owner call, and never replaces after an enqueue error', async () => {
  const f = fixture()
  await f.run()
  expect(f.enqueue).toHaveBeenCalledTimes(1)
  const twice = fixture()
  twice.prepared.enqueue = send => {
    send(twice.prepared.body, twice.prepared.headers)
    send(twice.prepared.body, twice.prepared.headers)
  }
  expect(() => twice.run()).toThrow('single synchronous attempt')
  expect(twice.enqueue).toHaveBeenCalledTimes(1)
  const failed = fixture()
  failed.enqueue.mockImplementation(() => {
    throw new Error('Late native failure')
  })
  expect(() => failed.run()).toThrow('Late native failure')
  expect(failed.enqueue).toHaveBeenCalledTimes(1)
})
it('refuses cancelled or inactive authenticated response authority', async () => {
  const request = fixture()
  request.abort.abort()
  expect(() => request.run()).toThrow()
  expect(request.enqueue).not.toHaveBeenCalled()
  const transport = fixture()
  transport.signal.abort()
  expect(() => transport.run()).toThrow()
  expect(transport.enqueue).not.toHaveBeenCalled()
  const context = fixture()
  context.caller.current = () => false
  expect(await context.run()).toMatchObject({ statusCode: 401 })
  expect(context.enqueue).not.toHaveBeenCalled()
})
it('observes and rejects asynchronous owners and prevents deferred enqueue', async () => {
  const f = fixture()
  let late: (() => void) | undefined
  f.prepared.enqueue = send => {
    late = () => send(f.prepared.body, f.prepared.headers)
    return Promise.resolve()
  }
  expect(await f.run()).toMatchObject({ statusCode: 400 })
  expect(() => late!()).toThrow('single synchronous attempt')
  expect(f.enqueue).not.toHaveBeenCalled()
  const empty = fixture()
  empty.prepared.enqueue = () => {}
  expect(await empty.run()).toMatchObject({ statusCode: 503 })
  expect(empty.enqueue).not.toHaveBeenCalled()
})
it('uses the same physical authority for initial fixed errors and does not replace failed control sends', async () => {
  const f = fixture(),
    error = new OutputProtocolError('not-found', 'private detail')
  const control = privatePublicationHTTPError(error)
  guardPrivatePublicationResponse({} as Response, { ...f.options, initial: { error } })
  const candidate = { ...f.candidate, statusCode: control.statusCode, body: control.body }
  await installed(candidate, f.enqueue, f.signal.signal)
  expect(f.enqueue).toHaveBeenCalledTimes(1)
  f.enqueue.mockClear()
  f.disclosure.enqueueControl = () => {
    throw new Error('Current control denied')
  }
  expect(() => installed(candidate, f.enqueue, f.signal.signal)).toThrow('Current control denied')
  expect(f.enqueue).not.toHaveBeenCalled()
})
