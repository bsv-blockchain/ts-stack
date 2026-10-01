import {
  canonicalOutputJSON,
  outputIdentity,
  outputPacketDigest,
  outputU64,
  OutputProtocolError,
  parseOutputScope,
  type OutputJSON,
  type OutputJSONObject,
  type OutputObservation,
  type OutputProposalState,
  type OutputScope,
  type OutputSignedProposal,
  type OutputSourceGroup
} from '@bsv/sdk'
import { outputSourceIdentity, type SourceGenerationState } from '../SourceMembership.js'
import type { ProposalKnowledgeView, ProposalObservationLocation } from './ProposalKnowledgeView.js'
import {
  ProposalChannelHeadsContract,
  type ProposalChannelQueryChange
} from './ProposalChannelHeadsContract.js'
import { ProposalPolicyRegistry } from './ProposalPolicyRegistry.js'

export interface ProposalCurrentChannelSelection {
  source: Omit<OutputScope, 'epoch'>
  parameters: OutputJSONObject
  query: OutputJSON
}
export interface CurrentProposalChannel {
  channel: string
  proposalId: string
  proposal: OutputSignedProposal
  /** An attributable provider assertion, never Bitcoin evidence or effect authority. */
  state: OutputProposalState
  membership: 'present' | 'removed'
  history: 'genesis-linked' | 'unresolved'
  /** Evaluated against the core's retained monotonic publication clock. */
  intent: 'unexpired' | 'expired'
  /** Local intent eligibility only; does not resolve unknown history or authorize an effect. */
  activeIntent: boolean
  groupId: string
}
export interface ProposalCurrentSource extends SourceGenerationState {
  consistent: boolean
  channels: CurrentProposalChannel[]
  /** Later groups cannot repair an inconsistent accepted prefix implicitly. */
  inconsistency?: { groupId: string; reason: string }
}
export interface ProposalCurrentChannelsView {
  evaluatedAt: string
  /** Independent provider/generation results; there is no cross-provider winner. */
  sources: ProposalCurrentSource[]
}
type OrderedGroup = {
  group: OutputSourceGroup
  order: NonNullable<ProposalObservationLocation['order']>
}
type Selection = ProposalCurrentChannelSelection
const same = (a: unknown, b: unknown): boolean => canonicalOutputJSON(a) === canonicalOutputJSON(b)
const key = (scope: OutputScope, generation: string): string =>
  canonicalOutputJSON({ scope, generation })

/**
 * Pure opt-in projection of BitcoinKnowledge's published proposal input. Do not pass
 * the verification worker's private history view: only the accepted source prefix
 * has currentness meaning. Legacy/manual views without order/generation facts fail
 * closed. Signature validity, source consistency, intent lifetime and host assertions
 * remain separate; this class has no wallet, transport or mutation capability.
 */
export class ProposalCurrentChannels {
  private readonly selections = new Map<string, Selection>()
  private readonly reader: string
  constructor(
    private readonly policies: ProposalPolicyRegistry,
    reader: string,
    selections: readonly ProposalCurrentChannelSelection[]
  ) {
    this.reader = outputIdentity(reader)
    if (selections.length < 1 || selections.length > 64)
      throw new OutputProtocolError('invalid', 'Install 1–64 current-channel selections')
    for (const input of selections) {
      const selection = structuredClone(input)
      const scope = parseOutputScope({ ...selection.source, epoch: 'configuration' })
      new ProposalChannelHeadsContract(policies, scope, selection.parameters, selection.query)
      const identity = outputSourceIdentity(scope)
      if (this.selections.has(identity))
        throw new OutputProtocolError('invalid', 'Duplicate current-channel selection')
      this.selections.set(identity, selection)
    }
  }

  project(input: ProposalKnowledgeView): ProposalCurrentChannelsView {
    const view = structuredClone(input)
    const now = outputU64(view.evaluatedAt)
    if (!view.sources)
      throw new OutputProtocolError(
        'unavailable',
        'Current-channel projection requires core generation state'
      )
    const seen = new Set<string>()
    const sources: ProposalCurrentSource[] = []
    for (const source of view.sources) {
      const identity = key(source.scope, source.generation)
      if (seen.has(identity))
        throw new OutputProtocolError('invalid', 'Duplicate source generation')
      seen.add(identity)
      const selected = this.selections.get(outputSourceIdentity(source.scope))
      if (!selected) continue
      if (!source.snapshot)
        throw new OutputProtocolError(
          'unavailable',
          'Current-channel projection requires a durable snapshot seed'
        )
      sources.push(this.source(view, source, selected, now))
    }
    for (const item of [...view.heads, ...view.states, ...view.removals])
      if (
        this.selections.has(outputSourceIdentity(item.scope)) &&
        !seen.has(key(item.scope, item.generation))
      )
        throw new OutputProtocolError(
          'unavailable',
          'Proposal observations lack core generation state'
        )
    return structuredClone({ evaluatedAt: view.evaluatedAt, sources })
  }

  private source(
    view: ProposalKnowledgeView,
    source: SourceGenerationState,
    selected: Selection,
    now: bigint
  ): ProposalCurrentSource {
    const contract = new ProposalChannelHeadsContract(
      this.policies,
      source.scope,
      selected.parameters,
      selected.query
    )
    let channels = new Map<string, CurrentProposalChannel>()
    const result: ProposalCurrentSource = { ...source, consistent: true, channels: [] }
    let snapshotLast = '',
      watermark: string | undefined,
      through: bigint | undefined
    for (const row of this.groups(view, source)) {
      const staged = new Map(channels)
      try {
        if (row.order.phase === 'snapshot') {
          if (
            through !== undefined ||
            (watermark !== undefined && watermark !== row.group.sequence)
          )
            this.inconsistent('Snapshot order changed')
          watermark = row.group.sequence
        } else if (row.order.phase === 'live') {
          const sequence = outputU64(row.group.sequence)
          if (sequence <= (through ?? (watermark === undefined ? -1n : outputU64(watermark))))
            this.inconsistent('Live sequence did not advance')
          through = sequence
        } else this.inconsistent('Current-channel query requires snapshot/live phases')
        const changes = contract.check(row.group, row.order.phase)
        for (const change of changes) {
          if (row.order.phase === 'snapshot') {
            if (change.channel <= snapshotLast)
              this.inconsistent('Snapshot channels are not strictly ordered')
            snapshotLast = change.channel
          }
          this.applyChange(staged, change, source, row.group.id, now)
        }
        channels = staged
      } catch (error) {
        if (!(error instanceof OutputProtocolError)) throw error
        result.consistent = false
        result.inconsistency = { groupId: row.group.id, reason: error.message }
        break
      }
    }
    result.channels = [...channels.values()].sort((a, b) =>
      a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
    )
    if (!result.consistent) for (const channel of result.channels) channel.activeIntent = false
    return result
  }

  private applyChange(
    channels: Map<string, CurrentProposalChannel>,
    change: ProposalChannelQueryChange,
    source: SourceGenerationState,
    groupId: string,
    now: bigint
  ): void {
    const previous = channels.get(change.channel)
    if (change.removed) {
      if (
        !previous ||
        previous.membership !== 'present' ||
        previous.proposalId !== change.removed.proposalId
      )
        this.inconsistent('Removal does not name the current retained head')
      channels.set(change.channel, {
        ...previous,
        membership: 'removed',
        activeIntent: false,
        groupId
      })
    }
    if (!change.head) return
    const proposal = this.policies.authorize(
      'read',
      change.head.proposal,
      source.scope,
      this.reader
    )
    const proposalId = outputPacketDigest('proposal', proposal.body)
    this.stateMatches(proposal, change.head.state)
    const history = this.relation(
      previous,
      proposal,
      change.head.state,
      change.removed !== undefined
    )
    const intent = now < outputU64(proposal.body.expiresAt) ? 'unexpired' : 'expired'
    channels.set(change.channel, {
      channel: change.channel,
      proposalId,
      proposal,
      state: change.head.state,
      membership: 'present',
      history,
      intent,
      activeIntent:
        source.current &&
        source.visible &&
        source.continuous &&
        intent === 'unexpired' &&
        change.head.state.status === 'active',
      groupId
    })
  }

  private relation(
    previous: CurrentProposalChannel | undefined,
    proposal: OutputSignedProposal,
    state: OutputProposalState,
    removed: boolean
  ): CurrentProposalChannel['history'] {
    if (!previous) return proposal.body.revision === '0' ? 'genesis-linked' : 'unresolved'
    const proposalId = outputPacketDigest('proposal', proposal.body)
    if (previous.proposalId === proposalId) {
      if (removed || !same(previous.proposal, proposal))
        this.inconsistent('An identical signed body changed its retained envelope')
      this.lifecycle(previous.state, state)
    } else {
      if (previous.membership === 'present' && !removed)
        this.inconsistent('A different head omitted its predecessor removal')
      this.policies.successor(previous.proposal, proposal)
      if (
        previous.state.status !== 'active' ||
        outputU64(state.recordedAt) >= outputU64(previous.proposal.body.expiresAt) ||
        outputU64(state.recordedAt) < outputU64(previous.state.recordedAt)
      )
        this.inconsistent('Replacement extends an inactive or expired predecessor')
      if (state.status !== (proposal.body.operation === 'withdraw' ? 'withdrawn' : 'active'))
        this.inconsistent('Replacement skipped its initial lifecycle state')
    }
    return previous.history
  }

  private stateMatches(proposal: OutputSignedProposal, state: OutputProposalState): void {
    const body = proposal.body
    if (body.revision === '0' && body.operation !== 'update')
      this.inconsistent('A channel genesis requires an update')
    if (
      (state.status === 'withdrawn') !== (body.operation === 'withdraw') ||
      (state.status === 'active' && outputU64(state.recordedAt) >= outputU64(body.expiresAt)) ||
      (state.status === 'expired' && outputU64(state.recordedAt) < outputU64(body.expiresAt))
    )
      this.inconsistent('Provider state differs from its signed head')
  }

  private lifecycle(before: OutputProposalState, after: OutputProposalState): void {
    if (same(before, after)) return
    if (outputU64(after.recordedAt) < outputU64(before.recordedAt))
      this.inconsistent('Provider lifecycle clock moved backwards')
    if (before.status === 'active' && (after.status === 'expired' || after.status === 'finalizing'))
      return
    if (
      before.status === 'finalizing' &&
      (after.status === 'finalized' || after.status === 'finalization-failed') &&
      before.operationId === after.operationId &&
      before.txid === after.txid
    )
      return
    this.inconsistent('Provider lifecycle transition is incompatible')
  }

  private groups(view: ProposalKnowledgeView, source: SourceGenerationState): OrderedGroup[] {
    const rows = new Map<string, OrderedGroup>()
    const add = (location: ProposalObservationLocation, observation: OutputObservation): void => {
      if (!same(location.scope, source.scope) || location.generation !== source.generation) return
      const order = location.order
      if (
        !order ||
        !Number.isSafeInteger(order.group) ||
        order.group < 0 ||
        !Number.isSafeInteger(order.observation) ||
        order.observation < 0 ||
        order.observation >= 1024 ||
        !Number.isSafeInteger(order.observations) ||
        order.observations < 1 ||
        order.observations > 1024 ||
        order.observation >= order.observations
      )
        throw new OutputProtocolError(
          'unavailable',
          'Current-channel projection requires retained event order'
        )
      outputU64(order.sequence)
      outputU64(order.receipt)
      let row = rows.get(location.groupId)
      if (!row) {
        row = { order, group: { id: location.groupId, sequence: order.sequence, observations: [] } }
        rows.set(location.groupId, row)
      } else if (
        row.order.phase !== order.phase ||
        row.order.sequence !== order.sequence ||
        row.order.receipt !== order.receipt ||
        row.order.group !== order.group ||
        row.order.observations !== order.observations
      )
        throw new OutputProtocolError('invalid', 'Conflicting retained group order')
      if (row.group.observations[order.observation] !== undefined)
        throw new OutputProtocolError('invalid', 'Duplicate retained observation position')
      row.group.observations[order.observation] = observation
    }
    for (const head of view.heads)
      add(head, {
        id: head.observationId,
        scope: head.scope,
        kind: 'proposal',
        payload: { proposal: head.proposal }
      })
    for (const state of view.states)
      add(state, {
        id: state.observationId,
        scope: state.scope,
        kind: 'proposal-state',
        payload: state.report
      })
    for (const removal of view.removals)
      add(removal, {
        id: removal.observationId,
        scope: removal.scope,
        kind: 'proposal-remove',
        payload: removal.report
      })
    const ordered = [...rows.values()].sort((a, b) => {
      const left = outputU64(a.order.receipt),
        right = outputU64(b.order.receipt)
      return left < right ? -1 : left > right ? 1 : a.order.group - b.order.group
    })
    const positions = new Set<number>()
    for (const row of ordered) {
      if (positions.has(row.order.group))
        throw new OutputProtocolError('invalid', 'Duplicate retained group position')
      positions.add(row.order.group)
      if (row.group.observations.length !== row.order.observations)
        throw new OutputProtocolError('unavailable', 'Current-channel group is incomplete')
      for (let index = 0; index < row.group.observations.length; index++)
        if (!row.group.observations[index])
          throw new OutputProtocolError('unavailable', 'Current-channel group is incomplete')
    }
    return ordered
  }

  private inconsistent(message: string): never {
    throw new OutputProtocolError('equivocation', message)
  }
}
