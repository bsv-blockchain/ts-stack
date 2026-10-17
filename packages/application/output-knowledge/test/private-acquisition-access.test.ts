import { expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PrivateAcquisitionAccess } from '../src/private/PrivateAcquisitionAccess.js'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'

it('uses initial authority only for creation and the frozen original for recovery', async () => {
  const f = await acquisitionStoreFixture(),
    observed: unknown[] = []
  const access = new PrivateAcquisitionAccess(
    f.owner.domain,
    f.original.request.service,
    (request, buyer, mode) => {
      observed.push({ request, buyer, mode })
      return true
    }
  )
  const proposed = structuredClone(f.original.request),
    guard = access.guard(f.id, f.buyer, () => true, proposed)
  proposed.termsDigest = '77'.repeat(32)
  const quote = f.owner.store.quote(f.original, 'AQ==', f.clock, guard)
  const recovered = f.open().store.load(
    f.id,
    f.buyer,
    f.clock,
    access.guard(f.id, f.buyer, () => true)
  )!
  expect(recovered.state).toEqual(quote.state)
  expect(observed).toContainEqual({ request: f.original.request, buyer: f.buyer, mode: 'initial' })
  expect(observed).toContainEqual({ request: f.original.request, buyer: f.buyer, mode: 'retained' })
})
it('returns the same not-found result for another buyer and an absent acquisition', async () => {
  const f = await acquisitionStoreFixture()
  f.quote()
  const access = new PrivateAcquisitionAccess(
      f.owner.domain,
      f.original.request.service,
      () => true
    ),
    other = new PrivateKey(89).toPublicKey().toString()
  for (const id of [f.id, '00'.repeat(32)])
    expect(() =>
      f.owner.store.load(
        id,
        other,
        f.clock,
        access.guard(id, other, () => true)
      )
    ).toThrow(expect.objectContaining({ code: 'not-found', message: 'Acquisition not found' }))
})
it('rechecks current identity before and after installed policy, then again at native commit', async () => {
  const f = await acquisitionStoreFixture()
  let current = true
  const access = new PrivateAcquisitionAccess(f.owner.domain, f.original.request.service, () => {
    current = false
    return true
  })
  expect(() =>
    f.owner.store.quote(
      f.original,
      'AQ==',
      f.clock,
      access.guard(f.id, f.buyer, () => current, f.original.request)
    )
  ).toThrow('Acquisition not found')
  expect(f.owner.store.load(f.id, f.buyer, f.clock, f.guard)).toBeUndefined()
  let checks = 0
  const later = new PrivateAcquisitionAccess(
    f.owner.domain,
    f.original.request.service,
    () => ++checks === 1
  )
  expect(() =>
    f.owner.store.quote(
      f.original,
      'AQ==',
      f.clock,
      later.guard(f.id, f.buyer, () => true, f.original.request)
    )
  ).toThrow('Acquisition not found')
  expect(f.open().store.load(f.id, f.buyer, f.clock, f.guard)).toBeUndefined()
})
it.each([false, 1, {}, undefined])('requires literal policy permission %p', async verdict => {
  const f = await acquisitionStoreFixture()
  const access = new PrivateAcquisitionAccess(
    f.owner.domain,
    f.original.request.service,
    () => verdict as boolean
  )
  expect(() =>
    f.owner.store.quote(
      f.original,
      'AQ==',
      f.clock,
      access.guard(f.id, f.buyer, () => true, f.original.request)
    )
  ).toThrow('Acquisition not found')
})
it('rejects async authority before the body and consumes invalid promise verdicts', async () => {
  const f = await acquisitionStoreFixture()
  let calls = 0
  expect(
    () =>
      new PrivateAcquisitionAccess(f.owner.domain, f.original.request.service, (async () => {
        calls++
        return true
      }) as never)
  ).toThrow('must be synchronous')
  const access = new PrivateAcquisitionAccess(
    f.owner.domain,
    f.original.request.service,
    () => true
  )
  expect(() =>
    access.guard(
      f.id,
      f.buyer,
      (async () => {
        calls++
        return true
      }) as never,
      f.original.request
    )
  ).toThrow('must be synchronous')
  expect(calls).toBe(0)
  const invalid = new PrivateAcquisitionAccess(
    f.owner.domain,
    f.original.request.service,
    () => Promise.reject(new Error('private failure')) as never
  )
  expect(() =>
    f.owner.store.quote(
      f.original,
      'AQ==',
      f.clock,
      invalid.guard(f.id, f.buyer, () => true, f.original.request)
    )
  ).toThrow('Acquisition not found')
  await Promise.resolve()
})
it.each(['buyer', 'service', 'chain', 'id'] as const)(
  'binds the initial request to installed %s',
  async changed => {
    const f = await acquisitionStoreFixture(),
      request = structuredClone(f.original.request)
    const access = new PrivateAcquisitionAccess(f.owner.domain, request.service, () => true)
    if (changed === 'buyer') request.recipient = new PrivateKey(89).toPublicKey().toString()
    if (changed === 'service') request.service = 'another'
    if (changed === 'chain') request.listing.chain.network = 'another'
    expect(() =>
      access.guard(changed === 'id' ? '00'.repeat(32) : f.id, f.buyer, () => true, request)
    ).toThrow('request binding differs')
  }
)
