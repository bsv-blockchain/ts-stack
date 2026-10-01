import {
  outputPacketDigest,
  type OutputObservation,
  type OutputProposalState,
  type OutputScope,
  type OutputSignedProposal
} from '@bsv/sdk'
import { ProposalCurrentChannels } from '../src/proposals/ProposalCurrentChannels.js'
import type {
  ProposalKnowledgeView,
  ProposalObservationLocation
} from '../src/proposals/ProposalKnowledgeView.js'
import {
  author,
  recipient,
  createRegistry,
  reference,
  signed,
  scope
} from './proposal-client-fixture.js'
export const parameters = { policy: reference },
  query = {}
export const source: OutputScope = {
  ...scope,
  provider: author,
  access: 'reader',
  epoch: 'one',
  rulesDigest: outputPacketDigest('service-rules', {
    id: 'https://bsv.brc.dev/overlays/0194#proposal-channel-heads-v1',
    parameters
  }),
  queryDigest: outputPacketDigest('lookup-query', { service: scope.service, query })
}
export function fixture(selected = source) {
  const { epoch: _epoch, ...identity } = selected
  const projection = new ProposalCurrentChannels(createRegistry(), recipient, [
    { source: identity, parameters, query }
  ])
  const referenceFor = (proposal: OutputSignedProposal) => ({
    service: scope.service,
    policy: reference,
    channel: proposal.body.channel,
    proposalId: outputPacketDigest('proposal', proposal.body)
  })
  const pair = (
    proposal = signed(),
    state: OutputProposalState = { status: 'active', recordedAt: '10' }
  ): OutputObservation[] => [
    { id: 'head', scope: selected, kind: 'proposal', payload: { proposal } },
    {
      id: 'state',
      scope: selected,
      kind: 'proposal-state',
      payload: { ...referenceFor(proposal), state }
    }
  ]
  const removal = (proposal: OutputSignedProposal): OutputObservation => ({
    id: 'removed',
    scope: selected,
    kind: 'proposal-remove',
    payload: { ...referenceFor(proposal), reason: 'left query' }
  })
  const view: ProposalKnowledgeView = {
    evaluatedAt: '20',
    heads: [],
    states: [],
    removals: [],
    sources: [
      {
        scope: selected,
        generation: '0',
        current: true,
        visible: true,
        continuous: true,
        complete: true,
        snapshot: true
      }
    ]
  }
  let position = 0
  const append = (
    phase: 'snapshot' | 'live',
    observations: OutputObservation[],
    sequence = phase === 'snapshot' ? '0' : String(position)
  ): void => {
    const group = position++,
      groupId = String(100 - group)
    for (const [index, item] of observations.entries()) {
      const origin: ProposalObservationLocation = {
        scope: selected,
        generation: '0',
        groupId,
        observationId: String(index),
        order: {
          phase,
          sequence,
          receipt: String(group + 1),
          group,
          observation: index,
          observations: observations.length
        }
      }
      if (item.kind === 'proposal')
        view.heads.unshift({
          ...origin,
          proposal: item.payload.proposal,
          proposalId: outputPacketDigest('proposal', item.payload.proposal.body),
          firstReceivedAt: '10',
          lifetime: 'unexpired',
          continuous: true
        })
      else if (item.kind === 'proposal-state')
        view.states.unshift({ ...origin, report: item.payload })
      else if (item.kind === 'proposal-remove')
        view.removals.unshift({ ...origin, report: item.payload })
    }
  }
  const result = () => projection.project(view).sources[0]
  return { projection, view, pair, removal, append, result }
}
export const successor = (
  prior: OutputSignedProposal,
  changes: Parameters<typeof signed>[0] = {}
): OutputSignedProposal =>
  signed({
    channel: prior.body.channel,
    revision: String(BigInt(prior.body.revision) + 1n),
    previous: outputPacketDigest('proposal', prior.body),
    ...changes
  })
