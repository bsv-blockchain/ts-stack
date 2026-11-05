import { expect, it, jest } from '@jest/globals'
import {
  PrivatePublicationAccess,
  type PrivatePublicationPublicReference
} from '../src/private/PrivatePublicationAccess.js'
import { privatePublicationFenceAddress } from '../src/private/PrivatePublicationRecords.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { allow } from './private-publication-fixture.js'
import { protectedValue, type ProtectedLedgerView } from '../src/private/ProtectedLedgerCodec.js'

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

it.each([null, {}, true, async () => true])(
  'requires a synchronous policy before creating any access guard (%p)',
  policy => {
    const f = verifiedFixture()
    expect(
      () =>
        new PrivatePublicationAccess(
          f.native.owner,
          f.contract.request.topic,
          policy as unknown as () => boolean
        )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Private publication access policy must be synchronous'
      })
    )
    expect(f.native.rows()).toHaveLength(0)
  }
)

it.each([null, {}, false, async () => true])(
  'requires a synchronous request context before any policy or ledger work (%p)',
  current => {
    const f = verifiedFixture(),
      policy = jest.fn(() => true),
      access = new PrivatePublicationAccess(f.native.owner, f.contract.request.topic, policy)
    expect(() =>
      access.guard(
        f.contract.record.publicationId,
        f.selected.publisher,
        current as unknown as () => boolean,
        f.contract.prepared.fence.reference
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Private publication request context must be synchronous'
      })
    )
    expect(policy).not.toHaveBeenCalled()
    expect(f.native.rows()).toHaveLength(0)
  }
)

it.each([false, undefined, 'true', 1])(
  'refuses a non-true current context before even reading the publication (%p)',
  current => {
    const f = verifiedFixture(),
      policy = jest.fn(() => true),
      access = new PrivatePublicationAccess(f.native.owner, f.contract.request.topic, policy),
      get = jest.fn<ProtectedLedgerView['get']>()
    const guard = access.guard(
      f.contract.record.publicationId,
      f.selected.publisher,
      (() => current) as unknown as () => boolean,
      f.contract.prepared.fence.reference
    )
    expect(() => guard({ revision: '0', observedAt: '20', get })).toThrow(
      expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
    )
    expect(get).not.toHaveBeenCalled()
    expect(policy).not.toHaveBeenCalled()
  }
)

it('observes a rejected context promise while refusing all ledger and policy work', async () => {
  const f = verifiedFixture(),
    policy = jest.fn(() => true),
    access = new PrivatePublicationAccess(f.native.owner, f.contract.request.topic, policy),
    get = jest.fn<ProtectedLedgerView['get']>()
  const guard = access.guard(
    f.contract.record.publicationId,
    f.selected.publisher,
    (() => Promise.reject(new Error('async request context'))) as unknown as () => boolean,
    f.contract.prepared.fence.reference
  )
  expect(() => guard({ revision: '0', observedAt: '20', get })).toThrow(
    expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
  )
  expect(get).not.toHaveBeenCalled()
  expect(policy).not.toHaveBeenCalled()
  await new Promise<void>(resolve => setImmediate(resolve))
})

it.each(['publicationId', 'topic'] as const)(
  'checks the retained %s binding independently before policy evaluation',
  field => {
    const f = verifiedFixture(),
      state = f.stage(),
      row = f.store.loadVerified(state.publicationId, () => '20', allow)!,
      policy = jest.fn(() => true),
      access = new PrivatePublicationAccess(f.native.owner, state.topic, policy)
    // Read the genuine native record, then exercise the guard's damaged-port boundary.
    // Changing only one binding must not be hidden by the other correct binding.
    const get = jest.fn<ProtectedLedgerView['get']>(() => ({
      ...row.record,
      value: protectedValue(
        {
          ...row.record.value,
          state: { ...state, [field]: field === 'topic' ? 'other-topic' : 'ff'.repeat(32) }
        },
        row.record.reservedBytes
      ).value
    }))
    const guard = access.guard(state.publicationId, f.selected.publisher, () => true)
    expect(() => guard({ revision: row.revision, observedAt: '20', get })).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Private publication access binding differs'
      })
    )
    expect(get).toHaveBeenCalledTimes(1)
    expect(policy).not.toHaveBeenCalled()
    expect(f.store.loadVerified(state.publicationId, () => '21', allow)!.fence.state).toEqual(state)
  }
)

it.each(['null', 'number', 'string', 'array', 'publisher-array'] as const)(
  'keeps malformed retained state indistinguishable from absence (%s)',
  shape => {
    const f = verifiedFixture(),
      state = f.stage(),
      row = f.store.loadVerified(state.publicationId, () => '20', allow)!,
      policy = jest.fn(() => true),
      access = new PrivatePublicationAccess(f.native.owner, state.topic, policy)
    const malformed = {
      null: null,
      number: 1,
      string: 'state',
      array: [],
      'publisher-array': Object.assign([], { ...state })
    }[shape]
    const get = jest.fn<ProtectedLedgerView['get']>(() => ({
      ...row.record,
      value: { ...row.record.value, state: malformed }
    }))
    expect(() =>
      access.guard(
        state.publicationId,
        f.selected.publisher,
        () => true
      )({
        revision: row.revision,
        observedAt: '20',
        get
      })
    ).toThrow(
      expect.objectContaining({ code: 'not-found', message: 'Private publication not found' })
    )
    expect(policy).not.toHaveBeenCalled()
  }
)

it.each(['topic', 'requestId'] as const)(
  'refuses an independently changed initial %s with the exact identity diagnostic',
  field => {
    const f = verifiedFixture(),
      policy = jest.fn(() => true),
      access = new PrivatePublicationAccess(f.native.owner, f.contract.request.topic, policy),
      initial = {
        ...f.contract.prepared.fence.reference,
        [field]: field === 'topic' ? 'other-topic' : 'ff'.repeat(16)
      }
    expect(() =>
      access.guard(f.contract.record.publicationId, f.selected.publisher, () => true, initial)
    ).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Private publication request identity differs'
      })
    )
    expect(policy).not.toHaveBeenCalled()
    expect(f.native.rows()).toHaveLength(0)
  }
)

it('owns supported extensions and supplies their critical public semantics to the policy', () => {
  const f = verifiedFixture(),
    extension = 'urn:test:private-publication-authority',
    supported = [extension],
    input = {
      ...f.contract.prepared.fence.reference,
      extensions: { [extension]: { revision: 1 } },
      critical: [extension]
    },
    policy = jest.fn<(reference: PrivatePublicationPublicReference, publisher: string) => boolean>(
      () => true
    ),
    access = new PrivatePublicationAccess(f.native.owner, input.topic, policy, supported)
  supported.length = 0
  const guard = access.guard(
    f.contract.record.publicationId,
    f.selected.publisher,
    () => true,
    input
  )
  f.native.owner.ledger.read(
    [privatePublicationFenceAddress(f.native.owner.identity, f.contract.record.publicationId)],
    () => '20',
    guard
  )
  expect(policy.mock.calls).toEqual([[input, f.selected.publisher]])
  expect(policy.mock.calls[0][0]).not.toHaveProperty('privateValues')
  expect(() =>
    new PrivatePublicationAccess(f.native.owner, input.topic, () => true).guard(
      f.contract.record.publicationId,
      f.selected.publisher,
      () => true,
      input
    )
  ).toThrow(expect.objectContaining({ code: 'unsupported' }))
})
