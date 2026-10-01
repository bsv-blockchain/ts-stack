import {
  canonicalOutputJSON,
  outputPacketDigest,
  OutputProtocolError,
  parseOutputScope,
  type OutputJSON,
  type OutputJSONObject,
  type OutputObservation,
  type OutputScope,
  type OutputSignedProposal,
  type OutputSourceGroup,
  type OutputProposalState
} from '@bsv/sdk'
import { ProposalPolicyRegistry } from './ProposalPolicyRegistry.js'
import { ProposalChannelHeadsQuery } from './ProposalChannelHeadsQuery.js'

type Removal = Extract<OutputObservation, { kind: 'proposal-remove' }>['payload']
export interface ProposalChannelQueryChange {
  channel: string
  removed?: Removal
  head?: { proposal: OutputSignedProposal; state: OutputProposalState }
}
const same = (a: unknown, b: unknown): boolean => canonicalOutputJSON(a) === canonicalOutputJSON(b)

/**
 * Query grammar after bounded authenticated transport parsing, before receipt.
 * This is not signature/policy verification, history selection or effect authority.
 */
export class ProposalChannelHeadsContract {
  private readonly scope: OutputScope
  private readonly policy: { id: string; digest: string }
  private readonly channels: Set<string> | undefined

  constructor(
    registry: ProposalPolicyRegistry,
    scope: OutputScope,
    parameters: OutputJSONObject,
    query: OutputJSON
  ) {
    const rule = new ProposalChannelHeadsQuery(registry)
    const normalized = rule.parameters(parameters)
    const selected = rule.query(query, normalized) as { channels?: string[] }
    this.scope = parseOutputScope(scope)
    this.policy = normalized.policy as { id: string; digest: string }
    this.channels = selected.channels && new Set(selected.channels)
    if (
      scope.rulesDigest !==
        outputPacketDigest('service-rules', { id: rule.id, parameters: normalized }) ||
      scope.queryDigest !==
        outputPacketDigest('lookup-query', { service: scope.service, query: selected })
    )
      throw new OutputProtocolError(
        'context-changed',
        'Current-channel query differs from selected scope'
      )
  }

  check(group: OutputSourceGroup, phase: 'snapshot' | 'live'): ProposalChannelQueryChange[] {
    const observations = group.observations
    if (
      observations.length === 0 ||
      observations.length > 1024 ||
      (phase === 'snapshot' && observations.length !== 2)
    )
      this.invalid('Current-channel group has an invalid observation count')
    for (const observation of observations)
      if (!same(observation.scope, this.scope))
        this.invalid('Current-channel observation scope changed')
    const changes: ProposalChannelQueryChange[] = []
    let position = 0,
      previous = ''
    while (position < observations.length) {
      const initial = observations[position]
      let removed: Removal | undefined
      let channel: string
      if (initial.kind === 'proposal-remove') {
        if (phase !== 'live') this.invalid('Snapshot cannot remove a channel')
        removed = initial.payload
        channel = this.reference(removed)
        position++
      } else if (initial.kind === 'proposal') channel = this.proposal(initial.payload.proposal)
      else this.invalid('Expected a channel head or an authorized identifier removal')
      if (channel <= previous) this.invalid('Current-channel changes must be unique and sorted')
      previous = channel
      const change: ProposalChannelQueryChange = { channel, ...(removed ? { removed } : {}) }
      const next = observations[position]
      if (next?.kind === 'proposal' && next.payload.proposal.body.channel === channel) {
        const proposal = next.payload.proposal
        this.proposal(proposal)
        const state = observations[position + 1]
        if (
          state?.kind !== 'proposal-state' ||
          this.reference(state.payload) !== channel ||
          state.payload.proposalId !== outputPacketDigest('proposal', proposal.body)
        )
          this.invalid('Current-channel head must be followed by its exact state')
        if (
          removed &&
          (proposal.body.previous !== removed.proposalId ||
            removed.proposalId === state.payload.proposalId)
        )
          this.invalid('Replacement does not name the removed predecessor')
        change.head = { proposal, state: state.payload.state }
        position += 2
      } else if (!removed) this.invalid('Current-channel state pair is incomplete')
      changes.push(change)
    }
    return structuredClone(changes)
  }

  private reference(value: {
    service: string
    policy: { id: string; digest: string }
    channel: string
  }): string {
    if (
      value.service !== this.scope.service ||
      !same(value.policy, this.policy) ||
      (this.channels !== undefined && !this.channels.has(value.channel))
    )
      this.invalid('Channel is outside the selected query')
    return value.channel
  }
  private proposal(value: OutputSignedProposal): string {
    if (!same(value.body.chain, this.scope.chain)) this.invalid('Proposal chain differs from query')
    return this.reference(value.body)
  }
  private invalid(message: string): never {
    throw new OutputProtocolError('equivocation', message)
  }
}
