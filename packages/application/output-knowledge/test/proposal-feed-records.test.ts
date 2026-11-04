import { expect, it } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import { LookupIndexCodec } from '../src/lookup/LookupIndexCodec.js'
import { proposalPayload } from '../src/proposals/ProposalJournalPayload.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import {
  assertProposalFeedRecordBounds,
  assertProposalFeedCommitTime,
  proposalFeedValue,
  proposalFeedEvent,
  proposalFeedWireLimits,
  assertProposalFeedWireGroup
} from '../src/proposals/ProposalChannelFeedRecords.js'
import { author, signed, scope, createRegistry } from './proposal-client-fixture.js'
const lifecycle = () =>
  new ProposalTransitions(createRegistry(), scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
const initial = () => lifecycle().put(undefined, signed(), author, '10')

it('accepts the exact conservative bound and rejects either envelope one byte short', () => {
  const records = { rowBytes: 4608, groupBytes: 9728, changes: 1 }
  expect(() => assertProposalFeedRecordBounds({ entryBytes: 4096 }, records)).not.toThrow()
  expect(() =>
    assertProposalFeedRecordBounds({ entryBytes: 4096 }, { ...records, rowBytes: 4607 })
  ).toThrow(/representation/)
  expect(() =>
    assertProposalFeedRecordBounds({ entryBytes: 4096 }, { ...records, groupBytes: 9727 })
  ).toThrow(/representation/)
  for (const size of [-1, 0, NaN, Infinity, 1.5])
    expect(() => assertProposalFeedRecordBounds({ entryBytes: size }, records)).toThrow()
  for (const key of ['rowBytes', 'groupBytes', 'changes'] as const)
    expect(() =>
      assertProposalFeedRecordBounds({ entryBytes: 4096 }, { ...records, [key]: NaN })
    ).toThrow()
  expect(() =>
    assertProposalFeedRecordBounds({ entryBytes: 4096 }, { ...records, changes: 0 })
  ).toThrow()
})

it('encodes owned retained proposal data while keeping private admission/local material out of the query row', () => {
  const first = initial(),
    value = proposalFeedValue(first.next)
  expect(value).toEqual({
    data: { version: 1, proposal: first.next.proposal, state: first.next.state },
    expiresAt: null
  })
  expect(value.data.proposal).not.toBe(first.next.proposal)
  expect(value.data.state).not.toBe(first.next.state)
  expect(value.data).not.toHaveProperty('admission')
  expect(value.data).not.toHaveProperty('local')
})

it('fits exact codec rows and a before/after group at maximal positions for each bounded journal record', () => {
  const first = initial(),
    expired = lifecycle().expire(first.next, '100')
  const entryBytes = Math.max(
    proposalPayload(first, 4194304).bytes,
    proposalPayload(expired, 4194304).bytes
  )
  const codec = new LookupIndexCodec({
    rowBytes: entryBytes + 512,
    groupBytes: 2 * (entryBytes + 512) + 512,
    changes: 1
  })
  assertProposalFeedRecordBounds({ entryBytes }, codec.limits)
  const key = 'ab'.repeat(64),
    previous = '18446744073709551614'
  const row = codec.row({ key, revision: previous, value: proposalFeedValue(first.next) })
  const group = codec.plan(
    {
      base: previous,
      evaluatedAt: '18446744073709551615',
      edits: [{ key, previous, next: proposalFeedValue(expired.next) }],
      event: proposalFeedEvent
    },
    [row]
  )
  expect(group.sequence).toBe('18446744073709551615')
  expect(group.changes[0].before).toEqual(row)
  expect(group.changes[0].after?.value).toEqual(proposalFeedValue(expired.next))
  expect(new TextEncoder().encode(canonicalOutputJSON(group)).length).toBeLessThanOrEqual(
    codec.limits.groupBytes
  )
})

it('rechecks actual exclusive expiry for a delayed initial or replacement plan', () => {
  const first = initial()
  expect(() => assertProposalFeedCommitTime(undefined, first, '10')).not.toThrow()
  expect(() =>
    assertProposalFeedCommitTime(undefined, first, first.next.proposal.body.expiresAt)
  ).toThrow(/expired/)
  const replacement = lifecycle().put(
    first.next,
    signed({ revision: '1', previous: first.next.proposalId, issuedAt: '11', expiresAt: '110' }),
    author,
    '11'
  )
  expect(() => assertProposalFeedCommitTime(first.next, replacement, '29')).not.toThrow()
  expect(() =>
    assertProposalFeedCommitTime(first.next, replacement, first.next.proposal.body.expiresAt)
  ).toThrow(/expired/)
})

it('checks withdrawals, reservation, future clocks and terminal recovery separately', () => {
  const first = initial(),
    withdrawal = lifecycle().put(
      first.next,
      signed({
        revision: '1',
        previous: first.next.proposalId,
        operation: 'withdraw',
        issuedAt: '11'
      }),
      author,
      '11'
    )
  expect(() =>
    assertProposalFeedCommitTime(first.next, withdrawal, first.next.proposal.body.expiresAt)
  ).toThrow(/expired/)
  expect(() => assertProposalFeedCommitTime(undefined, first, '9')).toThrow(/ahead/)
  const reserve = structuredClone(first)
  reserve.next.state = {
    status: 'finalizing',
    recordedAt: '11',
    operationId: 'aa'.repeat(32),
    txid: 'bb'.repeat(32)
  }
  expect(() => assertProposalFeedCommitTime(first.next, reserve, '29')).not.toThrow()
  expect(() =>
    assertProposalFeedCommitTime(first.next, reserve, first.next.proposal.body.expiresAt)
  ).toThrow(/expired/)
  const backwards = structuredClone(reserve)
  backwards.next.state.recordedAt = '9'
  expect(() => assertProposalFeedCommitTime(first.next, backwards, '11')).toThrow(/backwards/)
  const terminal = structuredClone(reserve)
  terminal.next.state = {
    status: 'finalization-failed',
    recordedAt: '100',
    operationId: 'aa'.repeat(32),
    txid: 'bb'.repeat(32),
    reason: 'Rejected',
    globalOutcome: 'unknown'
  }
  expect(() => assertProposalFeedCommitTime(reserve.next, terminal, '100')).not.toThrow()
  const expired = lifecycle().expire(first.next, '100')
  expect(() => assertProposalFeedCommitTime(first.next, expired, '100')).not.toThrow()
})

it('seals complete wire capacity before a future terminal event can be promised', () => {
  const minimal = proposalFeedWireLimits({ maxBytes: 4096 + 4 * 65536, maxObservations: 3 }, 4096)
  expect(minimal.maxBytes).toBe(266240)
  expect(() =>
    proposalFeedWireLimits({ ...minimal, maxBytes: minimal.maxBytes - 1 }, 4096)
  ).toThrow(/future wire group/)
  for (const maxBytes of [NaN, Infinity, 4194305, 1.5])
    expect(() => proposalFeedWireLimits({ maxBytes }, 4096)).toThrow()
  for (const maxObservations of [2, 0, NaN, 1025, 1.5])
    expect(() => proposalFeedWireLimits({ maxObservations }, 4096)).toThrow()
  expect(() => proposalFeedWireLimits({ extra: 1 } as never, 4096)).toThrow()
  const value = proposalFeedValue(initial().next)
  expect(() => assertProposalFeedWireGroup([value], minimal)).not.toThrow()
  expect(() => assertProposalFeedWireGroup([value, value], minimal)).toThrow(/wire reservation/)
  const enoughObservations = { ...minimal, maxObservations: 1024 }
  expect(() => assertProposalFeedWireGroup([value, value], enoughObservations)).toThrow(
    /wire reservation/
  )
})
