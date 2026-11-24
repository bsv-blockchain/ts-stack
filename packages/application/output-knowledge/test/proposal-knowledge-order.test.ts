import { expect, it } from '@jest/globals'
import { outputPacketDigest, type OutputObservation, type OutputSignedProposal } from '@bsv/sdk'
import { ProposalKnowledgeViewBuilder } from '../src/proposals/ProposalKnowledgeView.js'
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
} from './proposal-client-fixture.js'

const source = {
  chain,
  provider: author,
  service: scope.service,
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'reader',
  epoch: 'one'
}
function setup(rows: ReceivedSourceGroup[]) {
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
  const pool = new ProposalVerificationPool(policy)
  pool.receive(rows, pool.stamps(rows, '10'))
  pool.apply(pool.pending().map(stamp => pool.verify(stamp)))
  const builder = new ProposalKnowledgeViewBuilder(policy, pool, rows, rows)
  for (const row of rows) expect(builder.decision(row)).toBe('ready')
  return builder
}
function head(proposal: OutputSignedProposal, id: string): OutputObservation {
  return { id, scope: source, kind: 'proposal', payload: { proposal } }
}
function report(proposal: OutputSignedProposal, id: string, remove = false): OutputObservation {
  const payload = {
    service: scope.service,
    policy: reference,
    channel: proposal.body.channel,
    proposalId: outputPacketDigest('proposal', proposal.body)
  }
  if (remove)
    return {
      id,
      scope: source,
      kind: 'proposal-remove',
      payload: { ...payload, reason: 'replaced' }
    }
  return {
    id,
    scope: source,
    kind: 'proposal-state',
    payload: { ...payload, state: { status: 'active', recordedAt: '10' } }
  }
}
function row(
  id: string,
  observations: OutputObservation[],
  phase: 'snapshot' | 'live' = 'snapshot'
): ReceivedSourceGroup {
  return {
    scope: source,
    generation: '0',
    received: '2',
    phase,
    status: 'accepted',
    group: { id, sequence: phase === 'snapshot' ? '7' : '8', observations }
  }
}

it('retains group order within one snapshot receipt sharing W despite presentation sorting', () => {
  const first = signed({ channel: '11'.repeat(32) }),
    second = signed({ channel: '22'.repeat(32) })
  const rows = [
    row('z-group', [head(first, 'z-head'), report(first, 'a-state')]),
    row('a-group', [head(second, 'z-head'), report(second, 'a-state')])
  ]
  const builder = setup(rows),
    view = builder.snapshot('11', () => true)
  expect(view.heads.map(item => item.groupId)).toEqual(['a-group', 'z-group'])
  expect(view.heads[0].order).toEqual({
    phase: 'snapshot',
    sequence: '7',
    receipt: '2',
    group: 1,
    observation: 0,
    observations: 2
  })
  expect(view.heads[1].order).toEqual({
    phase: 'snapshot',
    sequence: '7',
    receipt: '2',
    group: 0,
    observation: 0,
    observations: 2
  })
  expect(view.states.map(item => item.order?.observation)).toEqual([1, 1])
  // Returned metadata is owned; a consumer cannot alter the builder's retained order.
  view.heads[0].order!.group = 99
  expect(builder.snapshot('11', () => true).heads[0].order?.group).toBe(1)
})

it('reconstructs removal, successor and state from their original live observation positions', () => {
  const before = signed(),
    after = signed({ revision: '1', previous: outputPacketDigest('proposal', before.body) })
  const rows = [
    row('z-snapshot', [head(before, 'head'), report(before, 'state')]),
    row(
      'a-live',
      [report(before, 'z-remove', true), head(after, 'a-head'), report(after, 'b-state')],
      'live'
    )
  ]
  rows[1].received = '3'
  const view = setup(rows).snapshot('11', () => true)
  const observations = [...view.heads, ...view.states, ...view.removals]
    .filter(item => item.groupId === 'a-live')
    .sort((a, b) => a.order!.observation - b.order!.observation)
  expect(observations.map(item => item.observationId)).toEqual(['z-remove', 'a-head', 'b-state'])
  expect(observations.map(item => item.order)).toEqual(
    [0, 1, 2].map(observation => ({
      phase: 'live',
      sequence: '8',
      receipt: '3',
      group: 1,
      observation,
      observations: 3
    }))
  )
})
