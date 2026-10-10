import {
  canonicalOutputJSON,
  outputPacketDigest,
  outputU64,
  type OutputObservation,
  type OutputScope,
  type OutputSignedProposal
} from '@bsv/sdk'
import {
  compareKnowledgeText,
  outputGroupIdentity,
  type ReceivedSourceGroup,
  type SourceGenerationState
} from '../SourceMembership.js'
import { ProposalSourcePolicy } from './ProposalSourcePolicy.js'
import { ProposalVerificationPool } from './ProposalVerificationPool.js'

export interface ProposalObservationLocation {
  scope: OutputScope
  generation: string
  groupId: string
  observationId: string
  /** Retained event order, separate from presentation sorting. Absent on older/manual views. */
  order?: {
    phase: ReceivedSourceGroup['phase']
    sequence: string
    receipt: string
    group: number
    observation: number
    observations: number
  }
}
export interface AuthenticatedProposalHead extends ProposalObservationLocation {
  proposalId: string
  proposal: OutputSignedProposal
  firstReceivedAt: string
  /** Clock eligibility only: this is not a current-head or active-channel verdict. */
  lifetime: 'unexpired' | 'expired'
  continuous: boolean
}
type StateObservation = Extract<OutputObservation, { kind: 'proposal-state' }>
type RemovalObservation = Extract<OutputObservation, { kind: 'proposal-remove' }>
export interface ProposalKnowledgeView {
  /** Explicit core generation state. Omitted by older/manual history builders. */
  sources?: SourceGenerationState[]
  evaluatedAt: string
  /** Each exact author-signed variant; predecessor history is not implied. */
  heads: AuthenticatedProposalHead[]
  /** Provider assertions bound to an authenticated head in this source generation. */
  states: (ProposalObservationLocation & { report: StateObservation['payload'] })[]
  removals: (ProposalObservationLocation & { report: RemovalObservation['payload'] })[]
}
type Decision = 'ready' | 'pending' | 'quarantined'
type Head = {
  row: ReceivedSourceGroup
  observation: Extract<OutputObservation, { kind: 'proposal' }>
  firstReceivedAt: string
}
const same = (a: unknown, b: unknown): boolean => canonicalOutputJSON(a) === canonicalOutputJSON(b)
function headKey(
  scope: OutputScope,
  generation: string,
  payload: {
    service: string
    policy: { id: string; digest: string }
    channel: string
    proposalId: string
  }
): string {
  return canonicalOutputJSON({
    scope,
    generation,
    service: payload.service,
    policy: payload.policy,
    channel: payload.channel,
    proposalId: payload.proposalId
  })
}
function location(
  row: ReceivedSourceGroup,
  observation: OutputObservation,
  groupOrder: number,
  observationOrder: number
): ProposalObservationLocation {
  return {
    scope: row.scope,
    generation: row.generation,
    groupId: row.group.id,
    observationId: observation.id,
    order: {
      phase: row.phase,
      sequence: row.group.sequence,
      receipt: row.received,
      group: groupOrder,
      observation: observationOrder,
      observations: row.group.observations.length
    }
  }
}

/**
 * Group qualification and attributable observations, not a channel-head selector.
 * Historical queries need not return current heads. Only a separately installed
 * query contract may interpret these records as ordered channel state.
 */
export class ProposalKnowledgeViewBuilder {
  private readonly heads = new Map<string, Head[]>()
  private readonly rows: readonly ReceivedSourceGroup[]
  private readonly published: ReadonlySet<string>
  constructor(
    private readonly policy: ProposalSourcePolicy,
    private readonly pool: ProposalVerificationPool,
    rows: readonly ReceivedSourceGroup[],
    published: readonly ReceivedSourceGroup[] = []
  ) {
    this.rows = structuredClone(rows)
    this.published = new Set(
      published
        .filter(row => row.status === 'accepted')
        .map(row => outputGroupIdentity(row.scope, row.generation, row.group.id))
    )
    for (const row of this.rows) {
      if (row.status === 'quarantined') continue
      for (const observation of row.group.observations) {
        if (observation.kind !== 'proposal') continue
        const checked = pool.check(row, observation.id, observation.payload.proposal)
        if (checked?.status !== 'verified') continue
        const { proposal } = observation.payload,
          key = headKey(row.scope, row.generation, {
            ...proposal.body,
            proposalId: outputPacketDigest('proposal', proposal.body)
          }),
          existing = this.heads.get(key) ?? []
        existing.push({ row, observation, firstReceivedAt: checked.firstReceivedAt })
        this.heads.set(key, existing)
      }
    }
  }

  decision(row: ReceivedSourceGroup): Decision {
    let pending = false
    for (const observation of row.group.observations) {
      const decision = this.observationDecision(row, observation)
      if (decision === 'quarantined') return decision
      pending ||= decision === 'pending'
    }
    return pending ? 'pending' : 'ready'
  }

  private observationDecision(row: ReceivedSourceGroup, observation: OutputObservation): Decision {
    if (observation.kind === 'proposal') {
      const checked = this.pool.check(row, observation.id, observation.payload.proposal)
      if (!checked) return 'pending'
      return checked.status === 'verified' ? 'ready' : 'quarantined'
    }
    if (observation.kind === 'proposal-state' || observation.kind === 'proposal-remove')
      return this.reportDecision(row, observation)
    return 'ready'
  }

  private reportDecision(
    row: ReceivedSourceGroup,
    observation: StateObservation | RemovalObservation
  ): Decision {
    const rule = this.policy.rule(row.scope),
      payload = observation.payload
    if (!rule || payload.service !== rule.proposalService || !same(payload.policy, rule.policy))
      return 'quarantined'
    const head = this.heads
      .get(headKey(row.scope, row.generation, payload))
      ?.find(candidate => this.supports(row, candidate))
    if (!head) return 'pending'
    if (observation.kind === 'proposal-state' && !this.stateCompatible(head, observation))
      return 'quarantined'
    return 'ready'
  }

  private supports(row: ReceivedSourceGroup, candidate: Head): boolean {
    const selected = outputGroupIdentity(
      candidate.row.scope,
      candidate.row.generation,
      candidate.row.group.id
    )
    return (
      (candidate.row.status === 'accepted' && this.published.has(selected)) ||
      selected === outputGroupIdentity(row.scope, row.generation, row.group.id)
    )
  }

  private stateCompatible(head: Head, observation: StateObservation): boolean {
    const { state } = observation.payload,
      body = head.observation.payload.proposal.body
    if ((state.status === 'withdrawn') !== (body.operation === 'withdraw')) return false
    if (state.status === 'active') return outputU64(state.recordedAt) < outputU64(body.expiresAt)
    if (state.status === 'expired') return outputU64(state.recordedAt) >= outputU64(body.expiresAt)
    return true
  }

  snapshot(
    evaluatedAt: string,
    continuous: (scope: OutputScope, generation: string) => boolean,
    sources?: readonly SourceGenerationState[]
  ): ProposalKnowledgeView {
    const now = outputU64(evaluatedAt),
      view: ProposalKnowledgeView = {
        evaluatedAt,
        heads: [],
        states: [],
        removals: [],
        ...(sources === undefined ? {} : { sources: structuredClone([...sources]) })
      }
    for (const [groupOrder, row] of this.rows.entries()) {
      if (row.status !== 'accepted') continue
      for (const [observationOrder, observation] of row.group.observations.entries())
        this.append(view, row, observation, now, continuous, groupOrder, observationOrder)
    }
    const order = (a: ProposalObservationLocation, b: ProposalObservationLocation): number =>
      compareKnowledgeText(canonicalOutputJSON(a.scope), canonicalOutputJSON(b.scope)) ||
      compareKnowledgeText(a.generation, b.generation) ||
      compareKnowledgeText(a.groupId, b.groupId) ||
      compareKnowledgeText(a.observationId, b.observationId)
    view.heads.sort(order)
    view.states.sort(order)
    view.removals.sort(order)
    return structuredClone(view)
  }
  private append(
    view: ProposalKnowledgeView,
    row: ReceivedSourceGroup,
    observation: OutputObservation,
    now: bigint,
    continuous: (scope: OutputScope, generation: string) => boolean,
    groupOrder: number,
    observationOrder: number
  ): void {
    const origin = location(row, observation, groupOrder, observationOrder)
    if (observation.kind === 'proposal') {
      const { proposal } = observation.payload,
        check = this.pool.check(row, observation.id, proposal)
      if (check?.status !== 'verified') return
      view.heads.push({
        ...origin,
        proposalId: outputPacketDigest('proposal', proposal.body),
        proposal,
        firstReceivedAt: check.firstReceivedAt,
        lifetime: now < outputU64(proposal.body.expiresAt) ? 'unexpired' : 'expired',
        continuous: continuous(structuredClone(row.scope), row.generation)
      })
    } else if (observation.kind === 'proposal-state')
      view.states.push({ ...origin, report: observation.payload })
    else if (observation.kind === 'proposal-remove')
      view.removals.push({ ...origin, report: observation.payload })
  }
}

/** First exclusive clock boundary requiring a durable accepted reevaluation. */
export function proposalViewDeadline(view: ProposalKnowledgeView): string | undefined {
  let deadline: bigint | undefined
  for (const head of view.heads) {
    if (head.lifetime !== 'unexpired') continue
    const next = outputU64(head.proposal.body.expiresAt)
    if (deadline === undefined || next < deadline) deadline = next
  }
  return deadline?.toString()
}
