import { expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PrivateAcquisitionDisclosure } from '../src/private/PrivateAcquisitionDisclosure.js'
import { acquisitionCoordinatorFixture } from './private-acquisition-coordinator.fixture.js'
async function fixture() {
  const f = await acquisitionCoordinatorFixture()
  let control = true
  const disclosure = new PrivateAcquisitionDisclosure(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.contracts,
    f.options.access,
    f.f.clock,
    () => control
  )
  await f.quote()
  return {
    ...f,
    disclosure,
    setControl: (value: boolean) => {
      control = value
    }
  }
}
it('prepares the exact original selection and privately delivers the current body once', async () => {
  const f = await fixture()
  await f.pay()
  const prepared = f.disclosure.prepare(f.f.id, f.caller),
    sent: string[] = []
  expect(JSON.parse(prepared.body)).toMatchObject({
    status: 'delivered',
    result: { context: 'AQID' }
  })
  expect(Object.isFrozen(prepared.headers)).toBe(true)
  prepared.enqueue((body, headers) => {
    expect(headers).toEqual(prepared.headers)
    sent.push(body)
  })
  expect(sent).toEqual([prepared.body])
  expect(() =>
    prepared.enqueue(body => {
      sent.push(body)
    })
  ).toThrow('already attempted')
})
it('refuses stale state after signing without enqueueing its earlier status', async () => {
  const f = await fixture(),
    prepared = f.disclosure.prepare(f.f.id, f.caller)
  await f.pay()
  let sent = false
  expect(() =>
    prepared.enqueue(() => {
      sent = true
    })
  ).toThrow()
  expect(sent).toBe(false)
  expect(JSON.parse(f.disclosure.prepare(f.f.id, f.caller).body).status).toBe('delivered')
})
it('enforces current access, cancellation and installed port identities at the send boundary', async () => {
  const f = await fixture(),
    first = f.disclosure.prepare(f.f.id, f.caller)
  f.setAccess(false)
  expect(() => first.enqueue(() => {})).toThrow()
  f.setAccess(true)
  const abort = new AbortController(),
    second = f.disclosure.prepare(f.f.id, { ...f.caller, signal: abort.signal })
  abort.abort()
  expect(() => second.enqueue(() => {})).toThrow()
  const third = f.disclosure.prepare(f.f.id, f.caller)
  f.options.access.guard = () => () => {}
  expect(() => third.enqueue(() => {})).toThrow()
})
it('preserves fixed missing-buyer behavior and rejects changed capability selectors', async () => {
  const f = await fixture()
  expect(() =>
    f.disclosure.prepare(f.f.id, {
      ...f.caller,
      buyer: new PrivateKey(90).toPublicKey().toString()
    })
  ).toThrow('not found')
  expect(() => f.disclosure.prepare(f.f.id, { ...f.caller, capability: '99'.repeat(32) })).toThrow(
    'selection differs'
  )
})
it('refuses asynchronous enqueue before its body starts', async () => {
  const f = await fixture(),
    prepared = f.disclosure.prepare(f.f.id, f.caller)
  let sent = false
  expect(() =>
    prepared.enqueue(async () => {
      sent = true
    })
  ).toThrow('synchronous')
  expect(sent).toBe(false)
})
it('sends only fixed public control diagnostics under current native authority', async () => {
  const f = await fixture(),
    packet = {
      version: 1,
      error: {
        code: 'not-found',
        message: 'Private acquisition request not-found',
        retryable: false
      }
    }
  let sent = 0
  f.disclosure.enqueueControl(packet, f.caller, () => {
    sent++
  })
  expect(sent).toBe(1)
  expect(() =>
    f.disclosure.enqueueControl(
      { ...packet, error: { ...packet.error, message: 'private detail' } },
      f.caller,
      () => {
        sent++
      }
    )
  ).toThrow('fixed public')
  f.setControl(false)
  expect(() =>
    f.disclosure.enqueueControl(packet, f.caller, () => {
      sent++
    })
  ).toThrow('authority changed')
  expect(sent).toBe(1)
})
it('binds every BRC-105 header to the original challenge and permits it only before construction expiry', async () => {
  const f = await fixture(),
    prepared = f.disclosure.prepare(f.f.id, f.caller, { challenge: true })
  expect(prepared.statusCode).toBe(402)
  expect(JSON.parse(prepared.body)).toEqual(f.current()!.original.challenge)
  expect(prepared.headers).toMatchObject({
    'x-bsv-payment-version': '1.0',
    'x-bsv-payment-satoshis-required': '100',
    'x-bsv-payment-derivation-prefix': f.current()!.original.challenge.derivationPrefix
  })
  f.f.setNow('100')
  let sent = false
  expect(() =>
    prepared.enqueue(() => {
      sent = true
    })
  ).toThrow('construction deadline')
  expect(sent).toBe(false)
  const expired = f.disclosure.prepare(f.f.id, f.caller, { challenge: true })
  expect(expired.statusCode).toBe(200)
  expect(JSON.parse(expired.body)).toMatchObject({ status: 'quoted' })
  expect(expired.headers).not.toHaveProperty('x-bsv-payment-version')
})
it('does not issue another payment challenge for pinned work or an uncharged recovery', async () => {
  const f = await fixture()
  expect(f.disclosure.prepare(f.f.id, f.caller).statusCode).toBe(200)
  f.setRelease(false)
  await f.pay()
  const pending = f.disclosure.prepare(f.f.id, f.caller, { challenge: true })
  expect(pending.statusCode).toBe(200)
  expect(JSON.parse(pending.body)).toMatchObject({ status: 'quoted' })
})
