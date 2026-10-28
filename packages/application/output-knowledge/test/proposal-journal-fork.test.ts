import { expect, it, jest } from '@jest/globals'
import { canonicalOutputJSON, Utils } from '@bsv/sdk'
import { ProposalJournalState } from '../src/proposals/ProposalJournalState.js'
import {
  ProposalTransitions,
  type ProposalTransition
} from '../src/proposals/ProposalTransitions.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import type { ProposalJournalLimits } from '../src/proposals/ProposalJournal.js'
import { author, signed, scope, createRegistry, finalize } from './proposal-client-fixture.js'

function setup(limits: Partial<ProposalJournalLimits> = {}) {
  const lifecycle = new ProposalTransitions(createRegistry(), scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const state = new ProposalJournalState(lifecycle, author, limits)
  const first = lifecycle.put(undefined, signed(), author, '10')
  const apply = (target: ProposalJournalState, transition: ProposalTransition) => {
    const prepared = target.prepare(transition, { local: 'retained' })
    const result = target.plan(prepared)
    expect(result.status).toBe('committed')
    if (result.status !== 'committed') throw new Error('fixture commit')
    target.apply(prepared, result.revision)
  }
  apply(state, first)
  return { lifecycle, state, first, apply, key: proposalChannelKey(first.next.proposal.body) }
}

it('forks the entire retained journal and isolates independent successor writes and owned reads', () => {
  const { state, lifecycle, first, apply, key } = setup()
  const copy = state.fork()
  expect(copy.configuration).toBe(state.configuration)
  expect(copy.serviceIdentity).toBe(state.serviceIdentity)
  expect(copy.head()).toEqual(state.head())
  expect(copy.read('0', 256)).toEqual(state.read('0', 256))
  const next = lifecycle.put(
    first.next,
    signed({ revision: '1', previous: first.next.proposalId }),
    author,
    '11'
  )
  apply(copy, next)
  expect(copy.channel(key)).toEqual(next.next)
  expect(state.channel(key)).toEqual(first.next)
  expect(copy.head().revision).toBe('2')
  expect(state.head().revision).toBe('1')
  const history = copy.read('0', 256)
  history[0].transition.next.proposal.body.payload = ''
  history[0].local!.local = 'changed'
  expect(copy.read('0', 1)).toEqual(state.read('0', 1))
  apply(state, lifecycle.expire(first.next, '100'))
  expect(state.channel(key)?.state.status).toBe('expired')
  expect(copy.channel(key)?.state.status).toBe('active')
})

it('retains admission reservations and exact operation identities while independently completing a staged copy', () => {
  const { state, lifecycle, first, apply } = setup()
  const tx = finalize(first.next.proposal),
    operationId = 'fork-reservation-0001'
  const reserved = lifecycle.reserve(
    first.next,
    author,
    {
      version: 1,
      operationId,
      service: scope.service,
      proposalId: first.next.proposalId,
      txid: tx.id('hex'),
      beef: 'AA=='
    },
    Utils.toBase64(tx.toBinary()),
    '99'
  )
  apply(state, reserved)
  const copy = state.fork()
  expect(copy.head().reserved).toEqual(state.head().reserved)
  expect(copy.head().reserved?.entries).toBe(1)
  expect(copy.operation(author, scope.service, operationId)).toEqual(reserved.next)
  const done = lifecycle.complete(
    reserved.next,
    {
      status: 'admitted',
      operationId,
      txid: tx.id('hex'),
      steak: {},
      assessmentContextId: 'test-chain-view'
    },
    '101'
  )
  apply(copy, done)
  expect(copy.head().reserved).toEqual({ entries: 0, bytes: 0 })
  expect(state.head().reserved?.entries).toBe(1)
  expect(copy.operation(author, scope.service, operationId)?.state.status).toBe('finalized')
  expect(state.operation(author, scope.service, operationId)?.state.status).toBe('finalizing')
  expect(copy.fork().read('0', 256)).toEqual(copy.read('0', 256))
})

it('refuses a staged copy when the installed lifecycle configuration changes', () => {
  const { state, lifecycle } = setup(),
    before = state.head(),
    configuration = lifecycle.configuration(),
    changed = jest.spyOn(lifecycle, 'configuration').mockReturnValue({
      ...configuration,
      clock: { ...configuration.clock, maxLifetimeSeconds: '101' }
    })
  try {
    expect(() => state.fork()).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Proposal journal configuration changed'
      })
    )
    expect(state.head()).toEqual(before)
  } finally {
    changed.mockRestore()
  }
  expect(state.fork().read('0', 256)).toEqual(state.read('0', 256))
})

it('retains the versioned journal identity and complete installed lifecycle configuration', () => {
  const { state, lifecycle } = setup()
  expect(state.configuration).toBe(
    canonicalOutputJSON({
      format: 'proposal-journal/1',
      identity: author,
      ...lifecycle.configuration()
    })
  )
})

it.each([
  { unrecognized: 1 },
  { entries: 0 },
  { entries: 1.5 },
  { bytes: '1' },
  { channels: Number.NaN },
  { channelsPerAuthor: Number.POSITIVE_INFINITY },
  { entryBytes: 4194305 }
])('rejects malformed or unknown retention limits before staging (%p)', limits => {
  expect(() => setup(limits as Partial<ProposalJournalLimits>)).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Invalid proposal journal limit' })
  )
})

it.each([{ bytes: 1 }, { channels: 1 }])(
  'requires coherent byte and principal capacities (%p)',
  limits => {
    expect(() => setup(limits)).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Inconsistent proposal journal limits' })
    )
  }
)

it.each([0, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects malformed read bounds without advancing retained history (%p)',
  maximum => {
    const { state } = setup(),
      before = state.head()
    expect(() => state.read('0', maximum)).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid proposal journal read bound' })
    )
    expect(state.head()).toEqual(before)
  }
)

it.each(['short', '!abcdefghijklmnop', 'abcdefghijklmnop!', 'abcdefghijklmnop\n'])(
  'requires a fully framed operation identifier (%p)',
  operationId => {
    const { state } = setup()
    expect(() => state.operation(author, scope.service, operationId)).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid proposal operation identifier' })
    )
  }
)

it('includes an exact byte-boundary page and leaves the first omitted entry available', () => {
  const { lifecycle, first } = setup(),
    scratch = new ProposalJournalState(lifecycle, author),
    expired = lifecycle.expire(first.next, '100'),
    firstPlan = scratch.prepare(first),
    expiredPlan = scratch.prepare(expired),
    state = new ProposalJournalState(lifecycle, author, {
      entryBytes: firstPlan.bytes + expiredPlan.bytes
    })
  state.apply(state.prepare(first), '1')
  state.apply(state.prepare(expired), '2')
  const other = lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '11')
  state.apply(state.prepare(other), '3')
  expect(state.read('0', 256).map(entry => entry.revision)).toEqual(['1', '2'])
  expect(state.read('2', 256).map(entry => entry.revision)).toEqual(['3'])
  expect(state.read('0', 1).map(entry => entry.revision)).toEqual(['1'])
})

it('charges a channel once across its revisions while enforcing the exact principal limit', () => {
  const { state, lifecycle, first, apply } = setup({ channels: 2, channelsPerAuthor: 2 }),
    updated = lifecycle.put(
      first.next,
      signed({ revision: '1', previous: first.next.proposalId }),
      author,
      '11'
    ),
    second = lifecycle.put(undefined, signed({ channel: 'ee'.repeat(32) }), author, '12'),
    third = lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '13')
  apply(state, updated)
  expect(state.head().channels).toBe(1)
  apply(state, second)
  expect(state.head().channels).toBe(2)
  expect(state.plan(state.prepare(third))).toEqual({
    status: 'limited',
    reason: 'Proposal retention limit; retain terminal fences and pending work'
  })
  expect(state.channel(proposalChannelKey(updated.next.proposal.body))).toEqual(updated.next)
})

it('checks the exact revision before applying a staged transition', () => {
  const { state, lifecycle, first } = setup(),
    before = state.head(),
    transition = state.prepare(lifecycle.expire(first.next, '100'))
  expect(() => state.apply(transition, '3')).toThrow(
    expect.objectContaining({ code: 'unavailable', message: 'Invalid proposal journal history' })
  )
  expect(state.head()).toEqual(before)
  state.apply(transition, '2')
  expect(state.head().revision).toBe('2')
})
