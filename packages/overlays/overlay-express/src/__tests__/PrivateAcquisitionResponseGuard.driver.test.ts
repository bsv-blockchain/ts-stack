import { beforeAll, expect, it, jest } from '@jest/globals'
import type { Response } from 'express'
import type {
  AuthenticatedResponseCandidate,
  AuthenticatedResponseQueueGuard
} from '@bsv/auth-express-middleware'
import { OUTPUT_PROFILES, OutputProtocolError, PrivateKey } from '@bsv/sdk'
import type { PrivateAcquisitionHTTPPrepared } from '../PrivateAcquisitionHTTPPorts.js'
import { acquisitionCoordinatorFixture } from '../../../../application/output-knowledge/test/private-acquisition-coordinator.fixture.js'
import { PrivateAcquisitionDisclosure } from '../../../../application/output-knowledge/src/private/PrivateAcquisitionDisclosure.js'

let installed: AuthenticatedResponseQueueGuard
jest.unstable_mockModule('@bsv/auth-express-middleware', () => ({
  guardAuthenticatedResponse(_res: Response, guard: AuthenticatedResponseQueueGuard) {
    installed = guard
  }
}))
const { guardPrivateAcquisitionResponse } = await import('../PrivateAcquisitionResponseGuard.js')
const { privateAcquisitionHTTPError } = await import('../PrivateAcquisitionHTTPPolicy.js')
let packets: Record<
  'challenge' | 'recovery',
  Pick<PrivateAcquisitionHTTPPrepared, 'statusCode' | 'body' | 'headers'>
>
let buyer: string, seller: string, capability: string
beforeAll(async () => {
  const f = await acquisitionCoordinatorFixture()
  try {
    await f.quote()
    const disclosure = new PrivateAcquisitionDisclosure(
      f.f.owner.domain,
      f.f.owner.store,
      f.f.f.contracts,
      f.options.access,
      f.f.clock,
      () => true
    )
    packets = {
      challenge: disclosure.prepare(f.f.id, f.caller, { challenge: true }),
      recovery: disclosure.prepare(f.f.id, f.caller)
    }
    buyer = f.caller.buyer
    seller = f.f.f.installation.seller
    capability = f.caller.capability
  } finally {
    await f.coordinator.stop()
    await f.dispose()
  }
})
function fixture(mode: 'challenge' | 'recovery' = 'challenge') {
  const abort = new AbortController()
  const caller = {
    buyer,
    capability,
    profile: OUTPUT_PROFILES.acquisition,
    current: () => true,
    signal: abort.signal
  }
  const packet = packets[mode]
  const headers = {
    ...packet.headers,
    'cache-control': 'private, no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-bsv-auth-identity-key': seller
  }
  const prepared: PrivateAcquisitionHTTPPrepared = {
    ...packet,
    headers: { ...packet.headers },
    enqueue: send => {
      send(prepared.body, prepared.headers)
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
    identityKey: buyer,
    requestId: 'synthetic-local-acquisition',
    statusCode: packet.statusCode,
    body: Buffer.from(packet.body),
    headers
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
      guardPrivateAcquisitionResponse({} as Response, options)
      return installed(candidate, enqueue, signal.signal)
    }
  }
}
it.each(['challenge', 'recovery'] as const)(
  'binds %s to the authenticated seller and buyer',
  async mode => {
    const good = fixture(mode)
    expect(await good.run()).toBeUndefined()
    expect(good.enqueue).toHaveBeenCalledTimes(1)
    for (const field of ['seller', 'buyer', 'missing-seller'] as const) {
      const f = fixture(mode)
      if (field === 'seller')
        f.candidate.headers['x-bsv-auth-identity-key'] = new PrivateKey(101)
          .toPublicKey()
          .toString()
      if (field === 'missing-seller') delete f.candidate.headers['x-bsv-auth-identity-key']
      if (field === 'buyer')
        Object.assign(f.candidate, { identityKey: new PrivateKey(102).toPublicKey().toString() })
      expect(await f.run()).toMatchObject({ statusCode: 401 })
      expect(f.enqueue).not.toHaveBeenCalled()
    }
  }
)
it.each(['capability', 'profile', 'cache', 'media', 'status', 'length', 'byte'] as const)(
  'withholds changed signed %s',
  async mode => {
    const f = fixture()
    if (mode === 'capability') f.candidate.headers['x-bsv-overlay-capability'] = '22'.repeat(32)
    if (mode === 'profile') f.candidate.headers['x-bsv-overlay-profile'] = 'urn:other'
    if (mode === 'cache') f.candidate.headers['cache-control'] = 'public'
    if (mode === 'media') f.candidate.headers['content-type'] = 'text/plain'
    if (mode === 'status') f.candidate.statusCode = 200
    if (mode === 'length') f.candidate.body = Buffer.from('{}')
    if (mode === 'byte') f.candidate.body[0] = 0
    expect(await f.run()).toMatchObject({
      statusCode: ['status', 'length', 'byte'].includes(mode) ? 400 : 401
    })
    expect(f.enqueue).not.toHaveBeenCalled()
  }
)
it.each([
  'x-bsv-payment-version',
  'x-bsv-payment-satoshis-required',
  'x-bsv-payment-derivation-prefix'
])('checks %s and forbids it on recovery and control', async name => {
  for (const mode of ['challenge', 'recovery'] as const) {
    const f = fixture(mode)
    f.candidate.headers[name] = 'changed'
    const result = await f.run()
    expect(result).toMatchObject({ statusCode: 400 })
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(result?.headers).not.toHaveProperty(name)
    const control = privateAcquisitionHTTPError(
      new OutputProtocolError('invalid', 'private detail')
    )
    expect(() =>
      installed(
        { ...f.candidate, attempt: 1, statusCode: control.statusCode, body: control.body },
        f.enqueue,
        f.signal.signal
      )
    ).toThrow('payment response header changed')
  }
})
it('validates original challenge headers before installing a queue guard', () => {
  for (const name of [
    'x-bsv-payment-version',
    'x-bsv-payment-satoshis-required',
    'x-bsv-payment-derivation-prefix'
  ]) {
    const f = fixture()
    Object.assign(f.prepared.headers, { [name]: 'changed' })
    expect(() => f.run()).toThrow('differ from original quote')
    expect(f.enqueue).not.toHaveBeenCalled()
  }
  for (const mode of ['challenge', 'recovery'] as const) {
    const f = fixture(mode)
    f.caller.buyer = new PrivateKey(103).toPublicKey().toString()
    expect(() => f.run()).toThrow('another buyer')
  }
})
it('requires exact original body and selector inside the synchronous native callback', async () => {
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
it('permits one synchronous attempt and never replaces after native enqueue begins', () => {
  const twice = fixture()
  twice.prepared.enqueue = send => {
    send(twice.prepared.body, twice.prepared.headers)
    send(twice.prepared.body, twice.prepared.headers)
  }
  expect(() => twice.run()).toThrow('single synchronous attempt')
  expect(twice.enqueue).toHaveBeenCalledTimes(1)
  const failed = fixture()
  failed.enqueue.mockImplementation(() => {
    throw new Error('Native queue failure')
  })
  expect(() => failed.run()).toThrow('Native queue failure')
  expect(failed.enqueue).toHaveBeenCalledTimes(1)
})
it('observes async owners, prevents deferred enqueue and rejects a silent owner', async () => {
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
it('refuses cancellation and rechecks live caller authority', async () => {
  for (const which of ['request', 'transport'] as const) {
    const f = fixture()
    ;(which === 'request' ? f.abort : f.signal).abort()
    expect(() => f.run()).toThrow()
    expect(f.enqueue).not.toHaveBeenCalled()
  }
  const f = fixture()
  f.caller.current = () => false
  expect(await f.run()).toMatchObject({ statusCode: 401 })
  expect(f.enqueue).not.toHaveBeenCalled()
})
it('authorizes initial and replacement controls once and never discloses internal error text', async () => {
  const f = fixture('recovery'),
    error = new OutputProtocolError('not-found', 'private detail')
  const control = privateAcquisitionHTTPError(error)
  guardPrivateAcquisitionResponse({} as Response, { ...f.options, initial: { error } })
  const candidate = { ...f.candidate, statusCode: control.statusCode, body: control.body }
  await installed(candidate, f.enqueue, f.signal.signal)
  expect(f.enqueue).toHaveBeenCalledTimes(1)
  expect(Buffer.from(control.body).toString()).not.toContain('private detail')
  f.enqueue.mockClear()
  f.disclosure.enqueueControl = () => {
    throw new Error('Current control denied')
  }
  expect(() => installed(candidate, f.enqueue, f.signal.signal)).toThrow('Current control denied')
  expect(f.enqueue).not.toHaveBeenCalled()
})
