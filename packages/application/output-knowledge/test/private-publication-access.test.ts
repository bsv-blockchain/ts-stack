import { expect, it } from '@jest/globals'
import { PrivatePublicationAccess } from '../src/private/PrivatePublicationAccess.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { allow } from './private-publication-fixture.js'
import { protectedValue } from '../src/private/ProtectedLedgerCodec.js'

it('checks current publisher authority inside staging and native reads without disclosing private values to policy', () => {
  const f = verifiedFixture(),
    input = f.contract.prepared.fence.reference
  const access = new PrivatePublicationAccess(
    f.native.owner,
    input.topic,
    (reference, publisher) => {
      expect(reference).toEqual(input)
      expect(publisher).toBe(f.selected.publisher)
      expect(reference).not.toHaveProperty('privateValues')
      reference.evidence.txid = 'ff'.repeat(32)
      return true
    }
  )
  const guard = access.guard(
    f.contract.record.publicationId,
    f.selected.publisher,
    () => true,
    input
  )
  const state = f.store.stageVerified(
    f.contract.request,
    f.selected,
    '30',
    f.contract.record,
    () => '20',
    guard
  )
  expect(f.reopen().loadVerified(state.publicationId, () => '21', guard)!.request).toEqual(
    f.contract.request
  )
})
it('makes absent, wrong-publisher and revoked reads indistinguishable', () => {
  const f = verifiedFixture(),
    state = f.stage()
  const access = new PrivatePublicationAccess(f.native.owner, state.topic, () => true)
  const cases = [
    { id: 'ff'.repeat(32), publisher: f.selected.publisher, current: () => true },
    { id: state.publicationId, publisher: f.contract.installation.seller, current: () => true },
    { id: state.publicationId, publisher: f.selected.publisher, current: () => false }
  ]
  for (const item of cases)
    expect(() =>
      f.store.loadVerified(item.id, () => '21', access.guard(item.id, item.publisher, item.current))
    ).toThrow(
      expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
    )
})
it('checks ownership before parsing unavailable original contract material', () => {
  const f = verifiedFixture(),
    state = f.stage(),
    row = f.store.loadVerified(state.publicationId, () => '20', allow)!
  f.native.owner.ledger.commit(
    row.revision,
    [
      {
        kind: row.record.kind,
        key: row.record.key,
        expectedRevision: row.record.revision,
        reservedBytes: row.record.reservedBytes,
        reservedUpdates: row.record.reservedUpdates,
        value: protectedValue({ ...row.fence, original: {} }, row.record.reservedBytes).value
      }
    ],
    () => '20',
    allow
  )
  const access = new PrivatePublicationAccess(f.native.owner, state.topic, () => true)
  expect(() =>
    f.store.loadVerified(
      state.publicationId,
      () => '21',
      access.guard(state.publicationId, f.contract.installation.seller, () => true)
    )
  ).toThrow(
    expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
  )
})
it('uses the retained public reference on retry even if the proposed material differs', () => {
  const f = verifiedFixture(),
    state = f.stage(),
    original = f.contract.prepared.fence.reference
  const access = new PrivatePublicationAccess(f.native.owner, state.topic, reference => {
    expect(reference.assetId).toBe(original.assetId)
    return true
  })
  const guard = access.guard(state.publicationId, f.selected.publisher, () => true, {
    ...original,
    assetId: 'ff'.repeat(32)
  })
  expect(f.store.loadVerified(state.publicationId, () => '21', guard)!.fence.state).toEqual(state)
})
it('rolls back initial records if request authority changes at the physical commit', () => {
  const f = verifiedFixture(),
    input = f.contract.prepared.fence.reference
  let checks = 0
  const access = new PrivatePublicationAccess(f.native.owner, input.topic, () => ++checks < 2)
  const guard = access.guard(
    f.contract.record.publicationId,
    f.selected.publisher,
    () => true,
    input
  )
  expect(() =>
    f.store.stageVerified(
      f.contract.request,
      f.selected,
      '30',
      f.contract.record,
      () => '20',
      guard
    )
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
  expect(f.native.rows()).toHaveLength(0)
})
it('owns an initial reference before later caller mutation and checks the selected topic/request identity', () => {
  const f = verifiedFixture(),
    input = structuredClone(f.contract.prepared.fence.reference)
  const access = new PrivatePublicationAccess(f.native.owner, input.topic, () => true)
  const guard = access.guard(
    f.contract.record.publicationId,
    f.selected.publisher,
    () => true,
    input
  )
  input.topic = 'changed'
  expect(
    f.store.stageVerified(
      f.contract.request,
      f.selected,
      '30',
      f.contract.record,
      () => '20',
      guard
    ).progress.phase
  ).toBe('staged')
  expect(() =>
    access.guard(f.contract.record.publicationId, f.selected.publisher, () => true, input)
  ).toThrow()
  expect(() =>
    access.guard(
      'ff'.repeat(32),
      f.selected.publisher,
      () => true,
      f.contract.prepared.fence.reference
    )
  ).toThrow()
})
it('rechecks request context after a synchronous policy changes it', () => {
  const f = verifiedFixture(),
    state = f.stage()
  let current = true
  const access = new PrivatePublicationAccess(f.native.owner, state.topic, () => {
    current = false
    return true
  })
  expect(() =>
    f.store.loadVerified(
      state.publicationId,
      () => '21',
      access.guard(state.publicationId, f.selected.publisher, () => current)
    )
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
})
it('rejects asynchronous policies and observes an incorrectly returned rejected promise', async () => {
  const f = verifiedFixture(),
    state = f.stage()
  expect(
    () =>
      new PrivatePublicationAccess(
        f.native.owner,
        state.topic,
        (async () => true) as unknown as () => boolean
      )
  ).toThrow()
  const access = new PrivatePublicationAccess(f.native.owner, state.topic, (() =>
    Promise.reject(new Error('async policy'))) as unknown as () => boolean)
  expect(() =>
    f.store.loadVerified(
      state.publicationId,
      () => '21',
      access.guard(state.publicationId, f.selected.publisher, () => true)
    )
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
  await new Promise<void>(resolve => setImmediate(resolve))
})
