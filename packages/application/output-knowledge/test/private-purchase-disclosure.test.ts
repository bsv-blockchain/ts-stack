import { expect, it, jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PrivatePurchaseAccess } from '../src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseDisclosure } from '../src/private/PrivatePurchaseDisclosure.js'
import { purchaseDisclosureFixture as fixture } from './private-purchase-disclosure.fixture.js'

it('refuses and drains a control authority that returns a promise', () => {
  const f = fixture(),
    send = jest.fn()
  const disclosure = new PrivatePurchaseDisclosure(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.f.contracts,
    f.access,
    f.f.clock,
    (() => Promise.reject(new Error('async control'))) as never
  )
  expect(() =>
    disclosure.enqueueControl(
      {
        version: 1,
        error: {
          code: 'not-found',
          message: 'Private purchase request not-found',
          retryable: false
        }
      },
      f.caller,
      send
    )
  ).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  expect(send).not.toHaveBeenCalled()
})

it('authorizes initial and retained access from the exact original request', () => {
  const f = fixture(),
    initial = f.access.guard(f.f.id, f.caller.buyer, f.caller.current, f.f.f.original.request)
  const loaded = f.f.owner.store.prepare(f.f.custody, f.f.clock, initial)
  expect(loaded.progress.status).toBe('prepared')
  const retained = f.f.owner.store.load(
    f.f.id,
    f.caller.buyer,
    f.f.clock,
    f.access.guard(f.f.id, f.caller.buyer, f.caller.current)
  )!
  expect(retained.custody.original).toEqual(loaded.custody.original)
  expect(f.decisions.some(item => item.mode === 'initial')).toBe(true)
  expect(f.decisions.at(-1)).toEqual({ mode: 'retained', request: f.f.f.original.request })
})

it('prepares original signed terms and enqueues exactly once without payment headers', () => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller, { terms: true }),
    send = jest.fn((_body: string, _headers: unknown) => {})
  expect(JSON.parse(result.body)).toEqual(f.f.custody.original.terms)
  expect(result.statusCode).toBe(200)
  expect(Object.keys(result.headers)).toEqual(['x-bsv-overlay-capability', 'x-bsv-overlay-profile'])
  result.enqueue(send)
  expect(send).toHaveBeenCalledWith(result.body, result.headers)
  expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(send).toHaveBeenCalledTimes(1)
})

it('checks the exclusive construction cutoff again after HTTP signing', () => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller, { terms: true }),
    send = jest.fn()
  f.f.setNow('100')
  expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'expired' }))
  expect(send).not.toHaveBeenCalled()
})

it.each(['recipient', 'authentication', 'policy'])(
  'refuses revoked %s at the physical private enqueue boundary',
  kind => {
    const f = fixture()
    f.f.deliver()
    const result = f.disclosure.prepare(f.f.id, f.caller),
      send = jest.fn()
    if (kind === 'recipient') f.caller.buyer = new PrivateKey(45).toPublicKey().toString()
    if (kind === 'authentication') f.setAuthenticated(false)
    if (kind === 'policy') f.setPermitted(false)
    // The prepared caller is an owned snapshot; mutating the caller object cannot
    // change its recipient. Revocation comes from the installed current policy.
    if (kind === 'recipient') f.setPermitted(false)
    expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(send).not.toHaveBeenCalled()
  }
)

it('wrong recipients and a missing original have identical not-found behavior before policy sees private request data', () => {
  const f = fixture()
  const stranger = { ...f.caller, buyer: new PrivateKey(45).toPublicKey().toString() }
  expect(() => f.disclosure.prepare(f.f.id, stranger)).toThrow(
    expect.objectContaining({ code: 'not-found' })
  )
  f.f.deliver()
  const prior = f.decisions.length
  expect(() => f.disclosure.prepare(f.f.id, stranger)).toThrow(
    expect.objectContaining({ code: 'not-found' })
  )
  expect(f.decisions).toHaveLength(prior)
})

it('returns immutable delivered bytes after catalogue expiry and refuses a new selected contract', () => {
  const f = fixture()
  f.f.deliver()
  f.f.setNow('100000')
  const result = f.disclosure.prepare(f.f.id, f.caller),
    send = jest.fn((_body: string, _headers: unknown) => {})
  result.enqueue(send)
  expect(JSON.parse(result.body)).toEqual(f.f.f.envelope())
  expect(() => f.disclosure.prepare(f.f.id, { ...f.caller, capability: 'ab'.repeat(32) })).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
})

it('a native head change between HTTP signing and enqueue refuses the old snapshot', () => {
  const f = fixture()
  f.f.prepare()
  const result = f.disclosure.prepare(f.f.id, f.caller),
    send = jest.fn()
  f.f.pin()
  // A stale private snapshot uses the same public not-found response as missing
  // custody; it must not disclose the new protected state through an error.
  expect(() => result.enqueue(send)).toThrow(expect.objectContaining({ code: 'not-found' }))
  expect(send).not.toHaveBeenCalled()
})

it('declared async and returned promises are refused and a rejected enqueue promise is drained', () => {
  const f = fixture()
  f.f.prepare()
  const first = f.disclosure.prepare(f.f.id, f.caller)
  expect(() => first.enqueue(async () => {})).toThrow(expect.objectContaining({ code: 'invalid' }))
  const next = f.disclosure.prepare(f.f.id, f.caller)
  expect(() => next.enqueue((() => Promise.reject(new Error('async enqueue'))) as never)).toThrow(
    expect.objectContaining({ code: 'invalid' })
  )
  const asyncPolicy = new PrivatePurchaseAccess(
    f.f.owner.domain,
    f.f.f.original.request.topic,
    (() => Promise.reject(new Error('async permission'))) as never
  )
  expect(() =>
    f.f.owner.store.load(
      f.f.id,
      f.caller.buyer,
      f.f.clock,
      asyncPolicy.guard(f.f.id, f.caller.buyer, f.caller.current)
    )
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
})

it('only fixed public control diagnostics can be authenticated and enqueued', () => {
  const f = fixture(),
    send = jest.fn()
  const packet = {
    version: 1,
    error: { code: 'not-found', message: 'Private purchase request not-found', retryable: false }
  }
  f.disclosure.enqueueControl(packet, f.caller, send)
  expect(send).toHaveBeenCalledTimes(1)
  expect(() =>
    f.disclosure.enqueueControl(
      { ...packet, error: { ...packet.error, message: 'private key detail' } },
      f.caller,
      send
    )
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
  f.setControl(false)
  expect(() => f.disclosure.enqueueControl(packet, f.caller, send)).toThrow(
    expect.objectContaining({ code: 'unauthorized' })
  )
  expect(send).toHaveBeenCalledTimes(1)
})

it('initial recipient/topic/id binding cannot be substituted by a policy accepting everything', () => {
  const f = fixture()
  for (const request of [
    { ...f.f.f.original.request, topic: 'other' },
    { ...f.f.f.original.request, requestId: 'ab'.repeat(16) },
    { ...f.f.f.original.request, recipient: new PrivateKey(45).toPublicKey().toString() }
  ])
    expect(() => f.access.guard(f.f.id, f.caller.buyer, f.caller.current, request)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
  expect(
    () =>
      new PrivatePurchaseAccess(
        f.f.owner.domain,
        f.f.f.original.request.topic,
        (async () => true) as never
      )
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
})
