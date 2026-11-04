import { expect, it, jest } from '@jest/globals'
import { SQLitePrivatePurchaseStore } from '../src/private/SQLitePrivatePurchaseStore.js'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'

it('retains default timestamp refusals while an explicitly installed profile uses its native observation', () => {
  const legacy = purchaseStoreFixture(),
    commit = legacy.owner.domain.ledger.commit.bind(legacy.owner.domain.ledger)
  jest.spyOn(legacy.owner.domain.ledger, 'commit').mockImplementationOnce((...args) => {
    legacy.setNow('21')
    return commit(...args)
  })
  expect(() => legacy.prepare()).toThrow(expect.objectContaining({ code: 'expired' }))
  expect(
    legacy.owner.store.load(legacy.id, legacy.buyer, legacy.clock, legacy.guard)
  ).toBeUndefined()
  legacy.setNow('20')
  const prepared = legacy.prepare()
  expect(prepared.state).not.toHaveProperty('clockProfile')
  const pin = legacy.owner.domain.ledger.commit.bind(legacy.owner.domain.ledger)
  jest.spyOn(legacy.owner.domain.ledger, 'commit').mockImplementationOnce((...args) => {
    legacy.setNow('30')
    return pin(...args)
  })
  legacy.setNow('29')
  expect(() =>
    legacy.owner.store.pin(
      legacy.id,
      legacy.buyer,
      prepared.row.revision,
      legacy.candidate,
      legacy.clock,
      legacy.guard
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(
    legacy.owner.store.load(legacy.id, legacy.buyer, legacy.clock, legacy.guard)!.progress.status
  ).toBe('prepared')

  const native = purchaseStoreFixture({}, 'native-observation-v1'),
    reserve = native.owner.domain.ledger.commitPrepared.bind(native.owner.domain.ledger)
  jest.spyOn(native.owner.domain.ledger, 'commitPrepared').mockImplementationOnce((...args) => {
    native.setNow('21')
    return reserve(...args)
  })
  const retained = native.prepare()
  expect(retained.state.clockProfile).toBe('native-observation-v1')
  expect(retained.progress.createdAt).toBe('21')
  expect(retained.custody.original.terms).toEqual(native.custody.original.terms)
  expect(retained.custody.original.request).toEqual(native.custody.original.request)
})

it('derives every purchase transition at native observation and retains exact signed delivery after reopen', () => {
  const f = purchaseStoreFixture({}, 'native-observation-v1')
  const commit = f.owner.domain.ledger.commitPrepared.bind(f.owner.domain.ledger)
  jest.spyOn(f.owner.domain.ledger, 'commitPrepared').mockImplementation((...args) => {
    f.setNow(String(BigInt(f.clock()) + 1n))
    return commit(...args)
  })
  const delivered = f.deliver()
  expect(delivered.progress.updatedAt).toBe('34')
  expect(delivered.progress.admission?.acceptedAt).toBe('30')
  const expectedEnvelope = f.f.envelope()
  if (expectedEnvelope.result.status !== 'delivered') throw new Error('Fixture delivery missing')
  expect(delivered.progress.delivery?.issuedAt).toBe(expectedEnvelope.result.potatoes.body.issuedAt)
  f.close(f.owner.domain)
  const reopened = f.open(),
    loaded = reopened.store.load(f.id, f.buyer, f.clock, f.guard)!
  let result: unknown
  reopened.store.disclose(loaded, f.buyer, f.clock, f.guard, value => {
    result = value
  })
  expect(result).toEqual(f.f.envelope())
  expect(loaded.candidate).toEqual(f.candidate)
  expect(() =>
    reopened.store.complete(
      f.id,
      f.buyer,
      loaded.row.revision,
      { result: 'replacement' },
      f.clock,
      f.guard
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})

it('binds the clock profile to original custody and rejects implicit adoption in either direction', () => {
  for (const profile of [undefined, 'native-observation-v1'] as const) {
    const f = purchaseStoreFixture({}, profile)
    f.prepare()
    const changed = new SQLitePrivatePurchaseStore(
      f.owner.domain,
      f.f.f.contracts,
      f.limits,
      f.policy,
      profile ? undefined : 'native-observation-v1'
    )
    expect(() => changed.load(f.id, f.buyer, f.clock, f.guard)).toThrow(
      expect.objectContaining({ code: 'context-changed' })
    )
  }
  const f = purchaseStoreFixture()
  expect(
    () =>
      new SQLitePrivatePurchaseStore(
        f.owner.domain,
        f.f.f.contracts,
        f.limits,
        f.policy,
        'future' as 'native-observation-v1'
      )
  ).toThrow('clock profile')
})

it('rechecks cutoff, current authority and completion capacity without retaining a partial preparation', () => {
  for (const refuse of ['cutoff', 'authority', 'capacity'] as const) {
    const f = purchaseStoreFixture(
      refuse === 'capacity' ? { maximumResultBytes: 8192 } : {},
      'native-observation-v1'
    )
    const commit = f.owner.domain.ledger.commitPrepared.bind(f.owner.domain.ledger)
    jest.spyOn(f.owner.domain.ledger, 'commitPrepared').mockImplementationOnce((...args) => {
      if (refuse === 'cutoff') f.setNow(f.custody.original.terms.body.purchaseUntil)
      if (refuse === 'authority') f.setPermitted(false)
      return commit(...args)
    })
    expect(() => f.prepare()).toThrow(
      expect.objectContaining({
        code: { cutoff: 'expired', authority: 'not-found', capacity: 'limited' }[refuse]
      })
    )
    f.setPermitted(true)
    expect(f.owner.store.load(f.id, f.buyer, f.clock, f.guard)).toBeUndefined()
    expect(
      f.owner.domain.ledger.enumerate('request-fence', null, 64, f.clock, f.guard).entries
    ).toEqual([])
  }
})

it('retains a pinned native transition after a lost reply and refuses changed financial identity and stale writers', () => {
  const f = purchaseStoreFixture({}, 'native-observation-v1'),
    prepared = f.prepare()
  const commit = f.owner.domain.ledger.commitPrepared.bind(f.owner.domain.ledger)
  f.setNow('29')
  jest.spyOn(f.owner.domain.ledger, 'commitPrepared').mockImplementationOnce((...args) => {
    f.setNow('30')
    commit(...args)
    throw new Error('Lost native purchase reply')
  })
  expect(() =>
    f.owner.store.pin(f.id, f.buyer, prepared.row.revision, f.candidate, f.clock, f.guard)
  ).toThrow('Lost native purchase reply')
  f.close(f.owner.domain)
  const reopened = f.open(),
    retained = reopened.store.load(f.id, f.buyer, f.clock, f.guard)!
  expect(retained.progress.updatedAt).toBe('30')
  expect(retained.candidate).toEqual(f.candidate)
  expect(() =>
    reopened.store.pin(f.id, f.buyer, prepared.row.revision, f.candidate, f.clock, f.guard)
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(() =>
    reopened.store.pin(
      f.id,
      f.buyer,
      retained.row.revision,
      { ...f.candidate, txid: '66'.repeat(32) },
      f.clock,
      f.guard
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})
