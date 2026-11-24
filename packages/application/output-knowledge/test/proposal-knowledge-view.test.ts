import { describe, expect, it } from '@jest/globals'
import { outputPacketDigest, type OutputObservation, type OutputProposalState } from '@bsv/sdk'
import {
  ProposalKnowledgeViewBuilder,
  proposalViewDeadline
} from '../src/proposals/ProposalKnowledgeView.js'
import { ProposalVerificationPool } from '../src/proposals/ProposalVerificationPool.js'
import { ProposalSourcePolicy } from '../src/proposals/ProposalSourcePolicy.js'
import type { ReceivedSourceGroup } from '../src/SourceMembership.js'
import {
  author,
  recipient,
  createRegistry,
  reference,
  signed,
  chain,
  scope
} from './proposal-fixture.js'
const source = {
  chain,
  provider: author,
  service: 'ls_documents',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'reader',
  epoch: 'one'
}
function setup() {
  const { epoch: _epoch, ...selection } = source
  const policy = new ProposalSourcePolicy(createRegistry(), recipient, [
    {
      source: selection,
      proposalService: scope.service,
      policy: reference,
      maxLifetimeSeconds: '90',
      futureSkewSeconds: '2'
    }
  ])
  return { policy, pool: new ProposalVerificationPool(policy) }
}
function head(proposal = signed()): OutputObservation {
  return { id: 'head', scope: source, kind: 'proposal', payload: { proposal } }
}
function state(
  status: OutputProposalState = { status: 'active', recordedAt: '10' },
  proposal = signed()
): OutputObservation {
  return {
    id: 'state',
    scope: source,
    kind: 'proposal-state',
    payload: {
      service: scope.service,
      policy: reference,
      channel: proposal.body.channel,
      proposalId: outputPacketDigest('proposal', proposal.body),
      state: status
    }
  }
}
function row(observations: OutputObservation[], id = 'group'): ReceivedSourceGroup {
  return {
    scope: source,
    generation: '0',
    received: '2',
    phase: 'finite',
    status: 'pending',
    group: { id, sequence: '0', observations }
  }
}
function qualify(pool: ProposalVerificationPool, rows: ReceivedSourceGroup[]) {
  pool.receive(rows, pool.stamps(rows, '10'))
  pool.apply(pool.pending().map(stamp => pool.verify(stamp)))
}
describe('attributable proposal knowledge without implicit channel selection', () => {
  it('exposes exact signed heads and exclusive expiry without fabricating Bitcoin facts or active-channel status', () => {
    const { policy, pool } = setup(),
      input = row([head(), state()])
    qualify(pool, [input])
    const builder = new ProposalKnowledgeViewBuilder(policy, pool, [input])
    expect(builder.decision(input)).toBe('ready')
    expect(builder.snapshot('99', () => true).heads).toEqual([])
    input.status = 'accepted'
    const accepted = new ProposalKnowledgeViewBuilder(policy, pool, [input], [input])
    const view = accepted.snapshot('99', () => true)
    expect(view.heads[0]).toMatchObject({
      firstReceivedAt: '10',
      lifetime: 'unexpired',
      continuous: true
    })
    expect(proposalViewDeadline(view)).toBe('100')
    expect(view.states[0].report.state.status).toBe('active')
    expect(accepted.snapshot('100', () => false).heads[0]).toMatchObject({
      lifetime: 'expired',
      continuous: false
    })
    expect(proposalViewDeadline(accepted.snapshot('100', () => false))).toBeUndefined()
    expect(Object.keys(view).sort()).toEqual(['evaluatedAt', 'heads', 'removals', 'states'])
  })
  it('requires same-group or already published authenticated support for a state-only group', () => {
    const { policy, pool } = setup(),
      first = row([head()], 'head'),
      next = row([state()], 'state')
    qualify(pool, [first, next])
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [first, next]).decision(next)).toBe(
      'pending'
    )
    first.status = 'accepted'
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [first, next]).decision(next)).toBe(
      'pending'
    )
    expect(
      new ProposalKnowledgeViewBuilder(policy, pool, [first, next], [first]).decision(next)
    ).toBe('ready')
  })
  it('never borrows authenticated support from another source generation', () => {
    const { policy, pool } = setup(),
      first = row([head()], 'head'),
      next = row([state()], 'state')
    first.status = 'accepted'
    next.generation = '1'
    qualify(pool, [first, next])
    expect(
      new ProposalKnowledgeViewBuilder(policy, pool, [first, next], [first]).decision(next)
    ).toBe('pending')
  })
  it.each(['service', 'policy'] as const)('rejects a %s mismatch before publication', field => {
    const { policy, pool } = setup(),
      report = state()
    if (report.kind !== 'proposal-state') throw Error('fixture')
    if (field === 'service') report.payload.service = 'other'
    else report.payload.policy = { ...reference, digest: 'ff'.repeat(32) }
    const input = row([head(), report])
    qualify(pool, [input])
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [input]).decision(input)).toBe(
      'quarantined'
    )
  })
  it.each<OutputProposalState>([
    { status: 'active', recordedAt: '100' },
    { status: 'expired', recordedAt: '99' },
    { status: 'withdrawn', recordedAt: '10' }
  ])('rejects a lifecycle assertion inconsistent with its exact signed head: %j', report => {
    const { policy, pool } = setup(),
      input = row([head(), state(report)])
    qualify(pool, [input])
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [input]).decision(input)).toBe(
      'quarantined'
    )
  })
  it('preserves finalizing reports after signed expiry without cancelling their reserved work', () => {
    const { policy, pool } = setup(),
      report: OutputProposalState = {
        status: 'finalizing',
        recordedAt: '99',
        operationId: 'purchase',
        txid: '05'.repeat(32)
      },
      input = row([head(), state(report)])
    qualify(pool, [input])
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [input]).decision(input)).toBe('ready')
    input.status = 'accepted'
    const view = new ProposalKnowledgeViewBuilder(policy, pool, [input], [input]).snapshot(
      '101',
      () => true
    )
    expect(view.heads[0].lifetime).toBe('expired')
    expect(view.states[0].report.state).toEqual(report)
  })
  it('quarantines invalid author signature even beside unresolved provider reports', () => {
    const { policy, pool } = setup(),
      proposal = signed()
    proposal.signature = 'AQ=='
    const input = row([state(), head(proposal)])
    qualify(pool, [input])
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [input]).decision(input)).toBe(
      'quarantined'
    )
  })
  it('owns input and result bytes, and does not change a retained report when time advances', () => {
    const { policy, pool } = setup(),
      input = row([head(), state()])
    qualify(pool, [input])
    input.status = 'accepted'
    const builder = new ProposalKnowledgeViewBuilder(policy, pool, [input], [input])
    input.group.observations = []
    const one = builder.snapshot('99', () => true)
    one.heads[0].proposal.signature = 'AQ=='
    one.states = []
    const two = builder.snapshot('100', () => true)
    expect(two.heads[0].proposal.signature).not.toBe('AQ==')
    expect(two.states).toHaveLength(1)
  })
  it('does not infer a single winner when a query returns multiple authenticated histories', () => {
    const { policy, pool } = setup(),
      first = row([head()], 'a'),
      second = row([head(signed({ channel: '08'.repeat(32) }))], 'b')
    qualify(pool, [first, second])
    first.status = second.status = 'accepted'
    const a = new ProposalKnowledgeViewBuilder(
      policy,
      pool,
      [first, second],
      [first, second]
    ).snapshot('50', () => true)
    const b = new ProposalKnowledgeViewBuilder(
      policy,
      pool,
      [second, first],
      [second, first]
    ).snapshot('50', () => true)
    const withoutOrder = (view: typeof a) => ({
      ...view,
      heads: view.heads.map(({ order: _order, ...head }) => head)
    })
    expect(withoutOrder(a)).toEqual(withoutOrder(b))
    expect(a.heads.map(head => head.order?.group)).toEqual([0, 1])
    expect(b.heads.map(head => head.order?.group)).toEqual([1, 0])
    expect(a.heads).toHaveLength(2)
  })

  it('retains a provider removal as an attributable report without erasing signed intent', () => {
    const { policy, pool } = setup(),
      proposal = signed(),
      first = row([head(proposal)], 'head')
    const removal: OutputObservation = {
      id: 'removed-head',
      scope: source,
      kind: 'proposal-remove',
      payload: {
        service: scope.service,
        policy: reference,
        channel: proposal.body.channel,
        proposalId: outputPacketDigest('proposal', proposal.body),
        reason: 'Provider no longer advertises this intent'
      }
    }
    const next = row([removal], 'removal')
    qualify(pool, [first, next])
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [first, next]).decision(next)).toBe(
      'pending'
    )
    first.status = 'accepted'
    expect(
      new ProposalKnowledgeViewBuilder(policy, pool, [first, next], [first]).decision(next)
    ).toBe('ready')
    next.status = 'accepted'
    const view = new ProposalKnowledgeViewBuilder(
      policy,
      pool,
      [first, next],
      [first, next]
    ).snapshot('20', () => true)
    expect(view.heads).toHaveLength(1)
    expect(view.heads[0].proposal).toEqual(proposal)
    expect(view.removals).toEqual([
      {
        scope: source,
        generation: '0',
        groupId: 'removal',
        observationId: 'removed-head',
        order: {
          phase: 'finite',
          sequence: '0',
          receipt: '2',
          group: 1,
          observation: 0,
          observations: 1
        },
        report: removal.payload
      }
    ])
  })

  it('does not expose unverified or quarantined signed heads even if a caller labels them accepted', () => {
    const { policy, pool } = setup(),
      input = row([head()])
    expect(new ProposalKnowledgeViewBuilder(policy, pool, [input]).decision(input)).toBe('pending')
    input.status = 'accepted'
    expect(
      new ProposalKnowledgeViewBuilder(policy, pool, [input], [input]).snapshot('20', () => true)
        .heads
    ).toEqual([])
    qualify(pool, [input])
    input.status = 'quarantined'
    const next = row([state()], 'report')
    const view = new ProposalKnowledgeViewBuilder(policy, pool, [input, next], [input])
    expect(view.decision(next)).toBe('pending')
    expect(view.snapshot('20', () => true).heads).toEqual([])
  })

  it('chooses the earliest exclusive expiry across independently authenticated channels', () => {
    const { policy, pool } = setup(),
      first = row([head(signed({ expiresAt: '100' }))], 'a'),
      second = row([head(signed({ expiresAt: '80', channel: '08'.repeat(32) }))], 'b')
    qualify(pool, [first, second])
    first.status = second.status = 'accepted'
    const builder = new ProposalKnowledgeViewBuilder(policy, pool, [first, second], [first, second])
    expect(proposalViewDeadline(builder.snapshot('79', () => true))).toBe('80')
    expect(proposalViewDeadline(builder.snapshot('80', () => true))).toBe('100')
    expect(proposalViewDeadline(builder.snapshot('100', () => true))).toBeUndefined()
  })
})
