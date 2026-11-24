import { expect, it, jest } from '@jest/globals'
import {
  SQLitePrivatePurchaseStore,
  SQLitePrivatePurchaseCommitmentStore
} from '../src/private/SQLitePrivatePurchaseStore.js'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'

it.each([undefined, 'native-observation-v1'] as const)(
  'seals explicit commitment custody, preserves exact delivery and refuses reader reinterpretation (%s)',
  clockProfile => {
    const f = purchaseStoreFixture({}, clockProfile, 'full-purchase-commitment-v1'),
      prepared = f.prepare()
    expect(prepared.state.format).toBe('private-purchase-state/2')
    expect(prepared.state).toHaveProperty('candidateProfile', 'full-purchase-commitment-v1')
    expect(prepared.progress).not.toHaveProperty('purchaseCommitment')
    expect(() =>
      new SQLitePrivatePurchaseStore(
        f.owner.domain,
        f.f.f.contracts,
        f.limits,
        f.policy,
        clockProfile
      ).load(f.id, f.buyer, f.clock, f.guard)
    ).toThrow(expect.objectContaining({ code: 'unavailable' }))
    const delivered = f.deliver()
    expect(delivered.progress.purchaseCommitment).toBe(f.purchaseCommitment)
    f.close(f.owner.domain)
    const reopened = f.open(),
      retained = reopened.store.load(f.id, f.buyer, f.clock, f.guard)!
    expect(retained.state).toEqual(delivered.state)
    let envelope: unknown
    reopened.store.disclose(retained, f.buyer, f.clock, f.guard, value => {
      envelope = value
    })
    expect(envelope).toEqual(f.f.envelope())
    expect(envelope).toHaveProperty('result.purchaseCommitment', f.purchaseCommitment)
    expect(envelope).toHaveProperty('result.potatoes.body.purchaseCommitment', f.purchaseCommitment)
  }
)

it('retains the historical state declaration and refuses implicit adoption of version-one custody', () => {
  const f = purchaseStoreFixture(),
    prepared = f.owner.store.prepare(f.custody, f.clock, f.guard),
    legacy = new SQLitePrivatePurchaseStore(f.owner.domain, f.f.f.contracts, f.limits, f.policy),
    old = legacy.load(f.id, f.buyer, f.clock, f.guard)!,
    format: 'private-purchase-state/1' = old.state.format
  expect(format).toBe('private-purchase-state/1')
  expect(prepared.state).not.toHaveProperty('candidateProfile')
  expect(old.progress).not.toHaveProperty('purchaseCommitment')
  const current = new SQLitePrivatePurchaseCommitmentStore(
    f.owner.domain,
    f.f.f.contracts,
    f.limits,
    f.policy
  )
  expect(() => current.load(f.id, f.buyer, f.clock, f.guard)).toThrow(
    expect.objectContaining({ code: 'unavailable' })
  )
  expect(() => current.prepare(f.custody, f.clock, f.guard)).toThrow()
  expect(legacy.load(f.id, f.buyer, f.clock, f.guard)!.state).toEqual(old.state)
})

it('requires an independently supplied full identity before pinning and cannot replace it on retry', () => {
  const f = purchaseStoreFixture({}, undefined, 'full-purchase-commitment-v1'),
    prepared = f.prepare()
  expect(() =>
    f.owner.store.pin(f.id, f.buyer, prepared.row.revision, f.candidate, f.clock, f.guard)
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
  expect(f.owner.store.load(f.id, f.buyer, f.clock, f.guard)!.state).toEqual(prepared.state)
  const pinned = f.pin()
  expect(() =>
    f.owner.store.pin(
      f.id,
      f.buyer,
      pinned.row.revision,
      f.candidate,
      f.clock,
      f.guard,
      'b4'.repeat(32)
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(
    f.owner.store.pin(
      f.id,
      f.buyer,
      pinned.row.revision,
      f.candidate,
      f.clock,
      f.guard,
      f.purchaseCommitment
    ).state
  ).toEqual(pinned.state)
})

it('retains the digest at the native writer observation after a lost commit reply', () => {
  const f = purchaseStoreFixture({}, 'native-observation-v1', 'full-purchase-commitment-v1'),
    prepared = f.prepare(),
    commit = f.owner.domain.ledger.commitPrepared.bind(f.owner.domain.ledger)
  jest.spyOn(f.owner.domain.ledger, 'commitPrepared').mockImplementationOnce((...args) => {
    f.setNow('30')
    const result = commit(...args)
    throw new Error('Lost committed reply ' + result)
  })
  expect(() =>
    f.owner.store.pin(
      f.id,
      f.buyer,
      prepared.row.revision,
      f.candidate,
      f.clock,
      f.guard,
      f.purchaseCommitment
    )
  ).toThrow('Lost committed reply')
  f.close(f.owner.domain)
  const reopened = f.open(),
    retained = reopened.store.load(f.id, f.buyer, f.clock, f.guard)!
  expect(retained.progress).toMatchObject({
    status: 'admission-pending',
    updatedAt: '30',
    purchaseCommitment: f.purchaseCommitment
  })
  expect(retained.candidate).toEqual(f.candidate)
  expect(
    reopened.store.pin(
      f.id,
      f.buyer,
      retained.row.revision,
      f.candidate,
      f.clock,
      f.guard,
      f.purchaseCommitment
    ).state
  ).toEqual(retained.state)
})

it('binds both signed packet and reserved status identities before completing an admitted obligation', () => {
  const f = purchaseStoreFixture({}, undefined, 'full-purchase-commitment-v1'),
    admitted = f.admit(),
    forged = f.f.envelope()
  if (forged.result.status !== 'delivered') throw new Error('Fixture delivery missing')
  forged.result.purchaseCommitment = 'b4'.repeat(32)
  expect(() =>
    f.owner.store.complete(f.id, f.buyer, admitted.row.revision, forged, f.clock, f.guard)
  ).toThrow()
  expect(f.owner.store.load(f.id, f.buyer, f.clock, f.guard)!.state).toEqual(admitted.state)
  f.setNow('33')
  const delivered = f.owner.store.complete(
    f.id,
    f.buyer,
    admitted.row.revision,
    f.f.envelope(),
    f.clock,
    f.guard
  )
  expect(() =>
    f.owner.store.complete(f.id, f.buyer, delivered.row.revision, forged, f.clock, f.guard)
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})
