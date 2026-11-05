import { expect, it } from '@jest/globals'
import { verifyOutputPacket, type OutputProposalState, type OutputSignedProposal } from '@bsv/sdk'
import { ProposalCurrentChannels } from '../src/proposals/ProposalCurrentChannels.js'
import { author, recipient, outsider, createRegistry, signed } from './proposal-client-fixture.js'
import { fixture, successor, parameters, query, source } from './proposal-current-fixture.js'

it('follows retained whole-group order rather than reversed presentation IDs or timestamps', () => {
  const f = fixture(),
    first = signed(),
    next = successor(first)
  f.append('snapshot', f.pair(first))
  f.append('live', [f.removal(first), ...f.pair(next)])
  const projected = f.result()
  expect(projected.consistent).toBe(true)
  expect(projected.channels).toEqual([
    expect.objectContaining({
      proposal: next,
      history: 'genesis-linked',
      activeIntent: true,
      membership: 'present'
    })
  ])
  projected.channels[0].proposal.body.payload = ''
  expect(f.result().channels[0].proposal).toEqual(next)
})

it('keeps an unknown snapshot predecessor unresolved even after a valid successor', () => {
  const f = fixture(),
    first = signed({ revision: '4', previous: 'ab'.repeat(32) }),
    next = successor(first)
  f.append('snapshot', f.pair(first))
  f.append('live', [f.removal(first), ...f.pair(next)])
  expect(f.result().channels[0]).toMatchObject({ proposal: next, history: 'unresolved' })
  expect(f.result().consistent).toBe(true)
})

it('removes active intent at the local deadline without changing the provider assertion', () => {
  const f = fixture(),
    proposal = signed()
  f.append('snapshot', f.pair(proposal))
  f.view.evaluatedAt = '99'
  expect(f.result().channels[0]).toMatchObject({ activeIntent: true, intent: 'unexpired' })
  f.view.evaluatedAt = '100'
  expect(f.result().channels[0]).toMatchObject({
    activeIntent: false,
    intent: 'expired',
    state: { status: 'active' }
  })
})

it('preserves finalization reservation and distinguishes provider outcomes from Bitcoin evidence', () => {
  const f = fixture(),
    proposal = signed(),
    binding = { operationId: 'request', txid: 'aa'.repeat(32) }
  f.append('snapshot', f.pair(proposal))
  f.append('live', f.pair(proposal, { status: 'finalizing', recordedAt: '20', ...binding }))
  f.view.evaluatedAt = '101'
  expect(f.result().channels[0]).toMatchObject({
    activeIntent: false,
    state: { status: 'finalizing' },
    intent: 'expired'
  })
  f.append(
    'live',
    f.pair(proposal, {
      status: 'finalization-failed',
      recordedAt: '110',
      ...binding,
      reason: 'rejected',
      globalOutcome: 'unknown'
    })
  )
  expect(f.result()).toMatchObject({
    consistent: true,
    channels: [{ state: { status: 'finalization-failed', globalOutcome: 'unknown' } }]
  })
})

it('treats removal only as query membership loss and retains attributable signed history', () => {
  const f = fixture(),
    proposal = signed()
  f.append('snapshot', f.pair(proposal))
  f.append('live', [f.removal(proposal)])
  expect(f.result().channels[0]).toMatchObject({
    membership: 'removed',
    activeIntent: false,
    proposal,
    state: { status: 'active' }
  })
})

it('rejects same-revision forks, skipped predecessors and installed-policy invalid successor edges', () => {
  for (const make of [
    (_first: OutputSignedProposal) =>
      signed({ payload: signed({ operation: 'withdraw' }).body.payload, expiresAt: '90' }),
    (first: OutputSignedProposal) => successor(first, { revision: '2' }),
    (first: OutputSignedProposal) =>
      successor(first, { recipients: [author, recipient, outsider].sort() })
  ]) {
    const f = fixture(),
      first = signed(),
      next = make(first)
    f.append('snapshot', f.pair(first))
    f.append('live', [f.removal(first), ...f.pair(next)])
    const result = f.result()
    expect(result.consistent).toBe(false)
    expect(result.inconsistency?.groupId).toBe('99')
    expect(result.channels[0]).toMatchObject({ proposal: first, activeIntent: false })
  }
})

it('does not partially apply a group when a later channel has an invalid transition', () => {
  const f = fixture(),
    one = signed({ channel: '11'.repeat(32) }),
    two = signed({ channel: '22'.repeat(32) })
  f.append('snapshot', f.pair(one))
  f.append('snapshot', f.pair(two))
  f.append('live', [
    f.removal(one),
    ...f.pair(successor(one)),
    f.removal(two),
    ...f.pair(successor(two, { recipients: [author, recipient, outsider].sort() }))
  ])
  expect(f.result()).toMatchObject({
    consistent: false,
    channels: [
      { proposal: one, activeIntent: false },
      { proposal: two, activeIntent: false }
    ]
  })
})

it.each([
  {
    before: { status: 'expired', recordedAt: '100' },
    after: { status: 'active', recordedAt: '10' }
  },
  {
    before: { status: 'finalizing', recordedAt: '20', operationId: 'one', txid: 'aa'.repeat(32) },
    after: {
      status: 'finalization-failed',
      recordedAt: '30',
      operationId: 'two',
      txid: 'aa'.repeat(32),
      reason: 'no',
      globalOutcome: 'unknown'
    }
  },
  { before: { status: 'active', recordedAt: '10' }, after: { status: 'expired', recordedAt: '99' } }
] as { before: OutputProposalState; after: OutputProposalState }[])(
  'retains incompatible provider lifecycle states as explicit inconsistency: $before.status',
  ({ before, after }) => {
    const f = fixture(),
      proposal = signed()
    f.append('snapshot', f.pair(proposal, before))
    f.append('live', f.pair(proposal, after))
    expect(f.result()).toMatchObject({
      consistent: false,
      channels: [{ state: before, activeIntent: false }]
    })
  }
)

it('keeps independent providers and a stale generation without inventing a winner', () => {
  const a = fixture(),
    b = fixture({ ...source, provider: outsider })
  a.append('snapshot', a.pair(signed()))
  b.append('snapshot', b.pair(signed({ revision: '2', previous: 'ab'.repeat(32) })))
  a.view.sources![0].current = false
  a.view.sources![0].continuous = false
  const selections = [source, b.view.sources![0].scope].map(({ epoch: _epoch, ...source }) => ({
    source,
    parameters,
    query
  }))
  const projection = new ProposalCurrentChannels(createRegistry(), recipient, selections)
  const combined = {
    evaluatedAt: '20',
    sources: [...a.view.sources!, ...b.view.sources!],
    heads: [...a.view.heads, ...b.view.heads],
    states: [...a.view.states, ...b.view.states],
    removals: []
  }
  expect(projection.project(combined).sources).toMatchObject([
    { current: false, channels: [{ activeIntent: false, history: 'genesis-linked' }] },
    { current: true, channels: [{ activeIntent: true, history: 'unresolved' }] }
  ])
})

it('represents an empty complete replacement generation and retires old activity', () => {
  const f = fixture()
  f.append('snapshot', f.pair())
  Object.assign(f.view.sources![0], { current: false, visible: false, continuous: false })
  f.view.sources!.push({
    ...f.view.sources![0],
    generation: '1',
    current: true,
    visible: true,
    continuous: true,
    complete: true,
    snapshot: true
  })
  expect(f.projection.project(f.view).sources).toMatchObject([
    { generation: '0', channels: [{ activeIntent: false }] },
    { generation: '1', complete: true, channels: [] }
  ])
})

it('refuses missing, duplicate or partial event-order facts rather than guessing', () => {
  const f = fixture()
  f.append('snapshot', f.pair())
  const original = structuredClone(f.view)
  delete f.view.sources
  expect(() => f.result()).toThrow('generation state')
  Object.assign(f.view, structuredClone(original))
  delete f.view.heads[0].order
  expect(() => f.result()).toThrow('retained event order')
  Object.assign(f.view, structuredClone(original))
  f.view.heads[0].order!.observation = 0
  f.view.heads[0].order!.observations = 3
  f.view.states[0].order!.observations = 3
  expect(() => f.result()).toThrow('incomplete')
  Object.assign(f.view, structuredClone(original))
  f.view.heads[0].order!.observation = 1
  expect(() => f.result()).toThrow('Duplicate retained observation')
  Object.assign(f.view, structuredClone(original))
  f.view.sources!.push(structuredClone(f.view.sources![0]))
  expect(() => f.result()).toThrow('Duplicate source generation')
  Object.assign(f.view, structuredClone(original))
  f.view.sources = []
  expect(() => f.result()).toThrow('generation state')
})

it('fails closed on missing initial pairs, head changes without removal and unordered snapshots', () => {
  for (const mode of ['pair', 'replacement', 'order']) {
    const f = fixture(),
      one = signed({ channel: '11'.repeat(32) }),
      two = signed({ channel: '22'.repeat(32) })
    if (mode === 'pair') f.append('snapshot', [f.pair(one)[0]])
    if (mode === 'replacement') {
      f.append('snapshot', f.pair(one))
      f.append('live', f.pair(successor(one)))
    }
    if (mode === 'order') {
      f.append('snapshot', f.pair(two))
      f.append('snapshot', f.pair(one))
    }
    expect(f.result().consistent).toBe(false)
  }
})

it('never calls a revision-zero withdrawal a genesis-linked active channel', () => {
  const f = fixture(),
    withdrawn = signed({ operation: 'withdraw' })
  f.append('snapshot', f.pair(withdrawn, { status: 'withdrawn', recordedAt: '10' }))
  expect(f.result()).toMatchObject({ consistent: false, channels: [] })
})

it('requires explicit bounded selections and ignores independently unselected sources', () => {
  const { epoch: _epoch, ...selected } = source
  const selection = { source: selected, parameters, query }
  for (const selections of [[], Array.from({ length: 65 }, () => selection)])
    expect(() => new ProposalCurrentChannels(createRegistry(), recipient, selections)).toThrow(
      '1–64'
    )
  expect(
    () => new ProposalCurrentChannels(createRegistry(), recipient, [selection, selection])
  ).toThrow('Duplicate current-channel')
  const f = fixture({ ...source, provider: outsider })
  f.append('snapshot', f.pair())
  const projection = new ProposalCurrentChannels(createRegistry(), recipient, [selection])
  expect(projection.project(f.view).sources).toEqual([])
  f.view.sources![0].snapshot = false
  expect(() => f.result()).toThrow('durable snapshot seed')
})

it('orders multiple groups in one receipt by retained group position', () => {
  const f = fixture(),
    first = signed(),
    second = successor(first),
    third = successor(second)
  f.append('snapshot', f.pair(first))
  f.append('live', [f.removal(first), ...f.pair(second)])
  f.append('live', [f.removal(second), ...f.pair(third)])
  for (const item of [...f.view.heads, ...f.view.states, ...f.view.removals])
    if (item.order!.phase === 'live') item.order!.receipt = '2'
  expect(f.result()).toMatchObject({ consistent: true, channels: [{ proposal: third }] })
})

it('accepts a valid withdrawal successor while preserving signed terminal intent', () => {
  const f = fixture(),
    first = signed(),
    withdrawn = successor(first, { operation: 'withdraw' })
  f.append('snapshot', f.pair(first))
  f.append('live', [
    f.removal(first),
    ...f.pair(withdrawn, { status: 'withdrawn', recordedAt: '20' })
  ])
  expect(f.result()).toMatchObject({
    consistent: true,
    channels: [{ proposal: withdrawn, activeIntent: false, state: { status: 'withdrawn' } }]
  })
})

it('does not accept replacements of terminal, expired or later-recorded predecessor states', () => {
  const cases: { before: OutputProposalState; after: OutputProposalState }[] = [
    {
      before: { status: 'expired', recordedAt: '100' },
      after: { status: 'active', recordedAt: '101' }
    },
    {
      before: { status: 'active', recordedAt: '10' },
      after: { status: 'active', recordedAt: '100' }
    },
    {
      before: { status: 'active', recordedAt: '20' },
      after: { status: 'active', recordedAt: '19' }
    },
    {
      before: { status: 'active', recordedAt: '10' },
      after: { status: 'finalizing', recordedAt: '20', operationId: 'job', txid: 'aa'.repeat(32) }
    }
  ]
  for (const { before, after } of cases) {
    const f = fixture(),
      first = signed(),
      next = successor(first, { issuedAt: '20', expiresAt: '110' })
    f.append('snapshot', f.pair(first, before))
    f.append('live', [f.removal(first), ...f.pair(next, after)])
    expect(f.result()).toMatchObject({
      consistent: false,
      channels: [{ proposal: first, activeIntent: false }]
    })
  }
})

it('preserves identical repeated state without inventing a replacement', () => {
  const f = fixture(),
    proposal = signed()
  f.append('snapshot', f.pair(proposal))
  f.append('live', f.pair(proposal))
  expect(f.result()).toMatchObject({
    consistent: true,
    channels: [{ proposal, history: 'genesis-linked' }]
  })
})

it('accepts the first live pair after a durable empty snapshot at sequence zero', () => {
  const f = fixture(),
    proposal = signed()
  f.append('live', f.pair(proposal), '0')
  expect(f.result()).toMatchObject({
    consistent: true,
    channels: [{ proposal, history: 'genesis-linked', activeIntent: true }]
  })
})

it('refuses a different valid signed envelope for the same retained proposal body', () => {
  const f = fixture(),
    first = signed(),
    repeated = signed(first.body)
  expect(repeated.body).toEqual(first.body)
  expect(repeated.signature).not.toBe(first.signature)
  expect(verifyOutputPacket('proposal', first, author)).toBe(true)
  expect(verifyOutputPacket('proposal', repeated, author)).toBe(true)
  f.append('snapshot', f.pair(first))
  f.append('live', f.pair(repeated))
  expect(f.result()).toMatchObject({
    consistent: false,
    inconsistency: { reason: 'An identical signed body changed its retained envelope' },
    channels: [{ proposal: first, activeIntent: false }]
  })
})

it('does not infer current membership from an unknown removal identifier', () => {
  const f = fixture(),
    first = signed(),
    unknown = signed({ expiresAt: '90' })
  f.append('snapshot', f.pair(first))
  f.append('live', [f.removal(unknown)])
  expect(f.result()).toMatchObject({
    consistent: false,
    channels: [{ proposal: first, membership: 'present', activeIntent: false }]
  })
})

it('rejects changed snapshot watermark, late snapshot groups, finite groups and regressed live sequence', () => {
  for (const mode of ['watermark', 'late', 'finite', 'sequence']) {
    const f = fixture(),
      first = signed({ channel: '11'.repeat(32) }),
      second = signed({ channel: '22'.repeat(32) })
    f.append('snapshot', f.pair(first))
    if (mode === 'watermark') f.append('snapshot', f.pair(second), '1')
    if (mode === 'late') {
      f.append('live', f.pair(first))
      f.append('snapshot', f.pair(second))
    }
    if (mode === 'sequence') f.append('live', f.pair(first), '0')
    if (mode === 'finite')
      for (const item of [...f.view.heads, ...f.view.states]) item.order!.phase = 'finite'
    expect(f.result().consistent).toBe(false)
  }
})

it('rejects inconsistent, duplicated and sparse retained group coordinates', () => {
  const first = signed({ channel: '11'.repeat(32) }),
    second = signed({ channel: '22'.repeat(32) })
  const f = fixture()
  f.append('snapshot', f.pair(first))
  f.append('snapshot', f.pair(second))
  const original = structuredClone(f.view)
  f.view.states[0].order!.receipt = '99'
  expect(() => f.result()).toThrow('Conflicting retained group order')
  Object.assign(f.view, structuredClone(original))
  for (const item of [...f.view.heads, ...f.view.states]) item.order!.group = 0
  expect(() => f.result()).toThrow('Duplicate retained group position')
  Object.assign(f.view, structuredClone(original))
  f.view.states[0].order!.observation = 2
  f.view.states[0].order!.observations = 3
  f.view.heads[0].order!.observations = 3
  expect(() => f.result()).toThrow('incomplete')
})

it.each([
  { group: -1 },
  { group: 0.5 },
  { observation: -1 },
  { observation: 0.5 },
  { observation: 1024 },
  { observations: 0 },
  { observations: 0.5 },
  { observations: 1025 },
  { observation: 2 },
  { observation: 1, observations: 1 }
])('refuses unusable retained coordinates before projecting any channel: %j', change => {
  const f = fixture()
  f.append('snapshot', f.pair())
  Object.assign(f.view.heads[0].order!, change)
  expect(() => f.result()).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Current-channel projection requires retained event order'
    })
  )
})

it.each([
  { phase: 'live' },
  { sequence: '1' },
  { receipt: '2' },
  { group: 1 },
  { observations: 3 }
])('refuses conflicting whole-group coordinates: %j', change => {
  const f = fixture()
  f.append('snapshot', f.pair())
  Object.assign(f.view.states[0].order!, change)
  expect(() => f.result()).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Conflicting retained group order' })
  )
})

it('distinguishes a bounded incomplete group from an invalid coordinate or duplicate position', () => {
  const f = fixture()
  f.append('snapshot', f.pair())
  for (const item of [...f.view.heads, ...f.view.states]) item.order!.observations = 1024
  expect(() => f.result()).toThrow(
    expect.objectContaining({ code: 'unavailable', message: 'Current-channel group is incomplete' })
  )
  for (const item of [...f.view.heads, ...f.view.states]) item.order!.observations = 2
  f.view.heads[0].order!.observation = 1
  expect(() => f.result()).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Duplicate retained observation position' })
  )
})

it('accepts exactly64 independent selections and retains precise configuration refusal identities', () => {
  const { epoch: _epoch, ...identity } = source,
    selection = { source: identity, parameters, query },
    selections = Array.from({ length: 64 }, (_, i) => ({
      ...selection,
      source: { ...identity, provider: `selected-provider-${i}` }
    }))
  expect(
    new ProposalCurrentChannels(createRegistry(), recipient, selections).project({
      evaluatedAt: '20',
      sources: [],
      heads: [],
      states: [],
      removals: []
    })
  ).toEqual({ evaluatedAt: '20', sources: [] })
  for (const entries of [[], [...selections, selection]])
    expect(() => new ProposalCurrentChannels(createRegistry(), recipient, entries)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Install 1–64 current-channel selections'
      })
    )
  expect(
    () => new ProposalCurrentChannels(createRegistry(), recipient, [selection, selection])
  ).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Duplicate current-channel selection' })
  )
})

it.each([
  {
    before: { status: 'active', recordedAt: '10' },
    after: { status: 'expired', recordedAt: '100' }
  },
  {
    before: { status: 'active', recordedAt: '10' },
    after: { status: 'finalizing', recordedAt: '10', operationId: 'job', txid: 'aa'.repeat(32) }
  },
  {
    before: { status: 'finalizing', recordedAt: '20', operationId: 'job', txid: 'aa'.repeat(32) },
    after: { status: 'finalized', recordedAt: '100', operationId: 'job', txid: 'aa'.repeat(32) }
  },
  {
    before: { status: 'finalizing', recordedAt: '20', operationId: 'job', txid: 'aa'.repeat(32) },
    after: {
      status: 'finalization-failed',
      recordedAt: '20',
      operationId: 'job',
      txid: 'aa'.repeat(32),
      reason: 'Rejected',
      globalOutcome: 'unknown'
    }
  }
] as { before: OutputProposalState; after: OutputProposalState }[])(
  'retains a valid provider lifecycle transition without changing the signed head: $before.status → $after.status',
  ({ before, after }) => {
    const f = fixture(),
      proposal = signed()
    f.append('snapshot', f.pair(proposal, before))
    f.append('live', f.pair(proposal, after))
    expect(f.result()).toMatchObject({
      consistent: true,
      channels: [{ proposal, state: after, activeIntent: false }]
    })
  }
)

it.each([
  {
    before: { status: 'active', recordedAt: '20' },
    after: { status: 'active', recordedAt: '19' },
    reason: 'Provider lifecycle clock moved backwards'
  },
  {
    before: { status: 'active', recordedAt: '10' },
    after: { status: 'active', recordedAt: '11' },
    reason: 'Provider lifecycle transition is incompatible'
  },
  {
    before: { status: 'expired', recordedAt: '100' },
    after: { status: 'finalizing', recordedAt: '101', operationId: 'job', txid: 'aa'.repeat(32) },
    reason: 'Provider lifecycle transition is incompatible'
  },
  {
    before: { status: 'finalizing', recordedAt: '20', operationId: 'job', txid: 'aa'.repeat(32) },
    after: { status: 'finalized', recordedAt: '21', operationId: 'job', txid: 'bb'.repeat(32) },
    reason: 'Provider lifecycle transition is incompatible'
  }
] as { before: OutputProposalState; after: OutputProposalState; reason: string }[])(
  'retains the preceding whole group when the provider lifecycle is inconsistent: $reason',
  ({ before, after, reason }) => {
    const f = fixture(),
      proposal = signed()
    f.append('snapshot', f.pair(proposal, before))
    f.append('live', f.pair(proposal, after))
    expect(f.result()).toMatchObject({
      consistent: false,
      inconsistency: { groupId: '99', reason },
      channels: [{ proposal, state: before, activeIntent: false }]
    })
  }
)

it.each([
  { status: 'active', recordedAt: '100' },
  { status: 'expired', recordedAt: '99' },
  { status: 'withdrawn', recordedAt: '10' }
] as OutputProposalState[])(
  'refuses a provider state inconsistent with the signed operation or expiry: $status',
  state => {
    const f = fixture()
    f.append('snapshot', f.pair(signed(), state))
    expect(f.result()).toMatchObject({
      consistent: false,
      inconsistency: { reason: 'Provider state differs from its signed head' },
      channels: []
    })
  }
)
