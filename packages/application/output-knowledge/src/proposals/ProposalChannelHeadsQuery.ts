import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputString,
  outputPacketDigest,
  OutputProtocolError,
  parseOutputProposalFinalizeResponse,
  outputU64,
  type OutputProposalGetResponse,
  type OutputJSON,
  type OutputJSONObject,
  type OutputSignedProposal
} from '@bsv/sdk'
import type {
  LookupQueryPolicy,
  LookupQueryContext,
  LookupObservationTemplate
} from '../lookup/LookupQueryPolicy.js'
import type { LookupIndexRow, LookupIndexGroup } from '../lookup/LookupIndexCodec.js'
import { ProposalPolicyRegistry } from './ProposalPolicyRegistry.js'
import { compareKnowledgeText } from '../SourceMembership.js'

type Head = OutputProposalGetResponse
const same = (a: unknown, b: unknown): boolean => canonicalOutputJSON(a) === canonicalOutputJSON(b)

/** Pure current-channel mapping. Durable capture and current disclosure are separate host ports. */
export class ProposalChannelHeadsQuery implements LookupQueryPolicy {
  readonly id = 'https://bsv.brc.dev/overlays/0194#proposal-channel-heads-v1'
  constructor(private readonly policies: ProposalPolicyRegistry) {}

  parameters(input: unknown): OutputJSONObject {
    closedOutputObject(input, ['policy'])
    closedOutputObject(input.policy, ['id', 'digest'])
    const policy = { id: outputString(input.policy.id), digest: outputHex32(input.policy.digest) }
    if (
      !this.policies.describe().some(item => item.id === policy.id && item.digest === policy.digest)
    )
      throw new OutputProtocolError('unsupported', 'Proposal query policy is not installed')
    return { policy }
  }

  query(input: OutputJSON, parameters: OutputJSONObject): OutputJSON {
    this.parameters(parameters)
    closedOutputObject(input, [], ['channels'])
    if (input.channels === undefined) return {}
    if (!Array.isArray(input.channels) || input.channels.length < 1 || input.channels.length > 256)
      throw new OutputProtocolError('invalid', 'Proposal query requires 1–256 selected channels')
    const channels = input.channels.map(value => outputHex32(value))
    if (channels.some((value, index) => index > 0 && channels[index - 1] >= value))
      throw new OutputProtocolError('invalid', 'Proposal query channels must be unique and sorted')
    return { channels }
  }

  snapshot(row: LookupIndexRow, context: LookupQueryContext): LookupObservationTemplate[] {
    const head = this.visible(row, context)
    return head ? this.head(head) : []
  }

  transition(group: LookupIndexGroup, context: LookupQueryContext): LookupObservationTemplate[] {
    const observations: LookupObservationTemplate[] = []
    const changes = [...group.changes].sort((a, b) => compareKnowledgeText(a.key, b.key))
    for (const change of changes) {
      const before = change.before && this.visible(change.before, context)
      const after = change.after && this.visible(change.after, context)
      if (change.before && change.after && Boolean(before) !== Boolean(after))
        throw new OutputProtocolError('reset-required', 'Proposal query visibility changed')
      if (before && after && same(before, after)) continue
      if (
        before &&
        (!after || this.identifier(before.proposal) !== this.identifier(after.proposal))
      )
        observations.push({
          kind: 'proposal-remove',
          payload: {
            ...this.reference(before.proposal),
            reason: 'Channel head left this query'
          }
        })
      if (after) observations.push(...this.head(after))
    }
    return observations
  }

  private visible(row: LookupIndexRow, context: LookupQueryContext): Head | undefined {
    if (context.principal === null)
      throw new OutputProtocolError(
        'unauthorized',
        'Proposal query requires an authenticated reader'
      )
    const parameters = this.parameters(context.parameters)
    const query = this.query(context.query, parameters) as { channels?: string[] }
    closedOutputObject(row.value.data, ['version', 'proposal', 'state'])
    if (row.value.data.version !== 1)
      throw new OutputProtocolError('invalid', 'Unsupported proposal query row format')
    const proposal = this.policies.validate(row.value.data.proposal, {
      chain: context.scope.chain,
      service: context.scope.service
    })
    const { body } = proposal
    if (row.key !== proposalChannelIndexKey(proposal))
      throw new OutputProtocolError('invalid', 'Proposal query row changed its channel key')
    const state = parseOutputProposalFinalizeResponse({
      version: 1,
      proposalId: this.identifier(proposal),
      state: row.value.data.state
    }).state
    if (
      (state.status === 'withdrawn') !== (body.operation === 'withdraw') ||
      (state.status === 'active' && outputU64(state.recordedAt) >= outputU64(body.expiresAt)) ||
      (state.status === 'expired' && outputU64(state.recordedAt) < outputU64(body.expiresAt))
    )
      throw new OutputProtocolError('invalid', 'Proposal query state differs from its signed head')
    if (
      !same(body.policy, parameters.policy) ||
      (query.channels && !query.channels.includes(body.channel))
    )
      return undefined
    if (!this.policies.permits('read', proposal, context.principal)) return undefined
    return { version: 1, proposal, state }
  }

  private identifier(proposal: OutputSignedProposal): string {
    return outputPacketDigest('proposal', proposal.body)
  }
  private reference(proposal: OutputSignedProposal) {
    const { service, policy, channel } = proposal.body
    return { service, policy, channel, proposalId: this.identifier(proposal) }
  }
  private head(head: Head): LookupObservationTemplate[] {
    return [
      { kind: 'proposal', payload: { proposal: head.proposal } },
      { kind: 'proposal-state', payload: { ...this.reference(head.proposal), state: head.state } }
    ]
  }
}

/** One current row per policy/channel in a chain/service-bound private index. */
export function proposalChannelIndexKey(proposal: OutputSignedProposal): string {
  return outputHex32(proposal.body.policy.digest) + outputHex32(proposal.body.channel)
}
