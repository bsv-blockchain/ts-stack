import {
  canonicalOutputJSON,
  outputU64,
  OutputProtocolError,
  type OutputObservation,
  type OutputScope,
  type OutputSourceGroup
} from '@bsv/sdk'
import type { Coverage, SourceBatch, SourceMembership } from './ports.js'

export function compareKnowledgeText(a: string, b: string): number {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

/** A new epoch changes continuity, not the identity of the source being refreshed. */
export function outputSourceIdentity(scope: OutputScope): string {
  const { epoch: _epoch, ...identity } = scope
  return canonicalOutputJSON(identity)
}
export function outputGroupIdentity(
  scope: OutputScope,
  generation: string,
  groupId: string
): string {
  return canonicalOutputJSON({ scope, generation, groupId })
}
export interface ReceivedSourceGroup {
  scope: OutputScope
  generation: string
  group: OutputSourceGroup
  phase: Coverage['phase']
  received: string
  status: 'pending' | 'accepted' | 'quarantined'
}
interface Generation {
  scope: OutputScope
  generation: string
  groups: ReceivedSourceGroup[]
  byId: Map<string, ReceivedSourceGroup>
  observations: Map<string, string>
  sequenceGroups: Map<string, string>
  snapshotWatermark?: string
  receivedSnapshotComplete: boolean
  receivedFiniteComplete: boolean
  completionAccepted: boolean
  liveStarted: boolean
  through?: string
  unavailable: boolean
  retired: boolean
}
interface Family {
  highest: Generation
  visible?: Generation
}
const copy = <T>(value: T): T => structuredClone(value)

function membershipOutpoint(
  observation: OutputObservation
): SourceMembership['outpoint'] | undefined {
  if (observation.kind === 'output')
    return {
      chain: observation.scope.chain,
      txid: observation.payload.evidence.txid,
      outputIndex: observation.payload.evidence.outputIndex
    }
  if (observation.kind === 'withdraw') return observation.payload.outpoint
  return undefined
}
function compareGeneration(a: string, b: string): number {
  const left = outputU64(a),
    right = outputU64(b)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Deterministic reducer of already schema-checked journal receipts and whole-group
 * decisions. It handles membership only: absence never creates a Bitcoin spend.
 * Rebuild from the retained journal before committing a prospective mutation, so
 * a rejected receipt cannot partially mutate the authoritative state.
 */
export class SourceMembershipLedger {
  private readonly families = new Map<string, Family>()
  private readonly generations = new Map<string, Generation>()
  // Observation identities belong to the complete source scope (including its
  // epoch), not a local refresh generation. Preserve them when retiring a seed.
  private readonly observationIdentities = new Map<string, Map<string, string>>()

  receive(input: SourceBatch, received: string): void {
    outputU64(received)
    const batch = copy(input),
      { scope, generation } = batch.provenance,
      familyKey = outputSourceIdentity(scope),
      family = this.families.get(familyKey),
      scopeKey = canonicalOutputJSON(scope),
      identities = new Map(this.observationIdentities.get(scopeKey)),
      active = this.stageGeneration(scope, generation, batch.coverage.phase, family)
    this.checkCoverage(active, batch.coverage)
    for (const group of batch.groups)
      this.stageGroup(active, group, batch.coverage.phase, identities, received)
    this.finishReceipt(active, batch.coverage)
    const replacing = family !== undefined && active.generation !== family.highest.generation
    if (replacing) family.highest.retired = true
    const visible =
      family !== undefined && family.visible === family.highest && !replacing
        ? active
        : family?.visible
    this.generations.set(canonicalOutputJSON({ scope, generation }), active)
    this.observationIdentities.set(scopeKey, identities)
    this.families.set(familyKey, { highest: active, ...(visible ? { visible } : {}) })
    this.publishCompleted(familyKey)
  }

  private stageGeneration(
    scope: OutputScope,
    generation: string,
    phase: Coverage['phase'],
    family?: Family
  ): Generation {
    if (!family || outputU64(generation) > outputU64(family.highest.generation)) {
      if (phase === 'live')
        throw new OutputProtocolError(
          'reset-required',
          'A new source generation requires a snapshot'
        )
      return {
        scope,
        generation,
        groups: [],
        byId: new Map(),
        observations: new Map(),
        sequenceGroups: new Map(),
        receivedSnapshotComplete: false,
        receivedFiniteComplete: false,
        completionAccepted: false,
        liveStarted: false,
        unavailable: false,
        retired: false
      }
    }
    if (
      generation !== family.highest.generation ||
      canonicalOutputJSON(scope) !== canonicalOutputJSON(family.highest.scope)
    )
      throw new OutputProtocolError('context-changed', 'Retired source generation or changed epoch')
    return {
      ...family.highest,
      groups: [...family.highest.groups],
      byId: new Map(family.highest.byId),
      observations: new Map(family.highest.observations),
      sequenceGroups: new Map(family.highest.sequenceGroups)
    }
  }

  private checkCoverage(active: Generation, coverage: Coverage): void {
    const phase = coverage.phase
    if (active.unavailable)
      throw new OutputProtocolError('reset-required', 'Source continuity requires a new generation')
    if (phase === 'snapshot') {
      if (coverage.through === undefined)
        throw new OutputProtocolError('invalid', 'Snapshot watermark is required')
      if (active.snapshotWatermark !== undefined && active.snapshotWatermark !== coverage.through)
        throw new OutputProtocolError('equivocation', 'Snapshot watermark changed')
      active.snapshotWatermark = coverage.through
    }
    if (
      phase === 'live' &&
      (!active.receivedSnapshotComplete || active.snapshotWatermark === undefined)
    )
      throw new OutputProtocolError('reset-required', 'Live changes precede the completed snapshot')
    if (
      (phase === 'finite' && active.snapshotWatermark !== undefined) ||
      (phase !== 'finite' && active.groups.some(row => row.phase === 'finite'))
    )
      throw new OutputProtocolError('invalid', 'Mixed finite and durable source generation')
  }

  private stageGroup(
    active: Generation,
    group: OutputSourceGroup,
    phase: Coverage['phase'],
    identities: Map<string, string>,
    received: string
  ): void {
    const prior = active.byId.get(group.id)
    if (prior) {
      if (prior.phase !== phase || canonicalOutputJSON(prior.group) !== canonicalOutputJSON(group))
        throw new OutputProtocolError('equivocation', 'Source group identity was reused')
      return
    }
    if (
      (phase === 'snapshot' && (active.receivedSnapshotComplete || active.liveStarted)) ||
      (phase === 'finite' && active.receivedFiniteComplete)
    )
      throw new OutputProtocolError(
        'equivocation',
        'Completed source snapshot acquired another group'
      )
    if (phase === 'live') this.stageLiveSequence(active, group)
    this.stageObservationIdentities(active, group, identities)
    const row: ReceivedSourceGroup = {
      scope: active.scope,
      generation: active.generation,
      group,
      phase,
      received,
      status: 'pending'
    }
    active.byId.set(group.id, row)
    active.groups.push(row)
  }

  private stageLiveSequence(active: Generation, group: OutputSourceGroup): void {
    if (outputU64(group.sequence) <= outputU64(active.through ?? active.snapshotWatermark!))
      throw new OutputProtocolError(
        'equivocation',
        'New live group predates the received watermark'
      )
    if (active.sequenceGroups.has(group.sequence))
      throw new OutputProtocolError('equivocation', 'Live sequence was reused')
    active.sequenceGroups.set(group.sequence, group.id)
  }

  private stageObservationIdentities(
    active: Generation,
    group: OutputSourceGroup,
    identities: Map<string, string>
  ): void {
    for (const observation of group.observations) {
      if (active.observations.has(observation.id))
        throw new OutputProtocolError('equivocation', 'Observation belongs to another source group')
      const encoded = canonicalOutputJSON(observation),
        previous = identities.get(observation.id)
      if (previous !== undefined && previous !== encoded)
        throw new OutputProtocolError(
          'equivocation',
          'Observation identity changed within the source epoch'
        )
      identities.set(observation.id, encoded)
      active.observations.set(observation.id, encoded)
    }
  }

  private finishReceipt(active: Generation, coverage: Coverage): void {
    if (coverage.phase === 'live') active.liveStarted = true
    if (
      coverage.through !== undefined &&
      (active.through === undefined || outputU64(coverage.through) > outputU64(active.through))
    )
      active.through = coverage.through
    if (coverage.status === 'complete') {
      if (coverage.phase === 'snapshot') active.receivedSnapshotComplete = true
      if (coverage.phase === 'finite') active.receivedFiniteComplete = true
    }
    if (coverage.status === 'reset-required') active.unavailable = true
  }

  decide(
    scope: OutputScope,
    generation: string,
    groupId: string,
    verdict: 'accepted' | 'quarantined'
  ): void {
    const active = this.generations.get(canonicalOutputJSON({ scope, generation }))
    if (!active || active.retired)
      throw new OutputProtocolError('context-changed', 'Source group generation is retired')
    const row = active.byId.get(groupId)
    if (!row) throw new OutputProtocolError('invalid', 'Unknown source group')
    if (row.status !== 'pending' && row.status !== verdict)
      throw new OutputProtocolError('equivocation', 'Whole-group outcome changed')
    row.status = verdict
    if (verdict === 'quarantined') active.unavailable = true
    if (verdict === 'accepted' && this.canComplete(active)) active.completionAccepted = true
    this.publishCompleted(outputSourceIdentity(scope))
  }

  private canComplete(active: Generation): boolean {
    return (
      !active.unavailable &&
      !active.completionAccepted &&
      (active.receivedSnapshotComplete || active.receivedFiniteComplete) &&
      active.groups.filter(row => row.phase !== 'live').every(row => row.status === 'accepted')
    )
  }
  hasPendingCompletion(): boolean {
    return [...this.families.values()].some(family => this.canComplete(family.highest))
  }
  /** Called only inside an accepted mutation, including an empty completion boundary. */
  acceptCompletions(): void {
    for (const [key, family] of this.families)
      if (this.canComplete(family.highest)) {
        family.highest.completionAccepted = true
        this.publishCompleted(key)
      }
  }

  private publishCompleted(familyKey: string): void {
    const family = this.families.get(familyKey)!,
      active = family.highest
    if (active.unavailable) return
    const seed = active.groups.filter(row => row.phase !== 'live')
    const complete = active.completionAccepted && seed.every(row => row.status === 'accepted')
    // Initial ingestion can progress. A replacement generation swaps only after
    // its complete seed qualifies; old membership remains explicitly stale meanwhile.
    if (complete || !family.visible) family.visible = active
  }

  private publishedRows(active: Generation): ReceivedSourceGroup[] {
    const seed = active.groups.filter(row => row.phase !== 'live')
    const result: ReceivedSourceGroup[] = []
    // Snapshot pages share a watermark, so receipt order is their membership
    // order. A later verified page must not pass an unfinished earlier page.
    for (const row of seed) {
      if (row.status !== 'accepted') return result
      result.push(row)
    }
    if (!active.receivedSnapshotComplete) return result
    const live = active.groups
      .filter(row => row.phase === 'live')
      .sort((a, b) => (outputU64(a.group.sequence) < outputU64(b.group.sequence) ? -1 : 1))
    for (const row of live) {
      if (row.status !== 'accepted') break
      result.push(row)
    }
    return result
  }

  private generationMemberships(visible: Generation): SourceMembership[] {
    const rows = new Map<string, SourceMembership>()
    for (const row of this.publishedRows(visible))
      for (const observation of row.group.observations) {
        const outpoint = membershipOutpoint(observation)
        if (!outpoint) continue
        rows.set(canonicalOutputJSON(outpoint), {
          scope: row.scope,
          generation: row.generation,
          outpoint,
          present: observation.kind === 'output',
          phase: row.phase,
          sequence: row.group.sequence,
          observationId: observation.id
        })
      }
    return [...rows.values()]
  }

  memberships(): SourceMembership[] {
    const result = [...this.families.values()].flatMap(({ visible }) =>
      visible ? this.generationMemberships(visible) : []
    )
    result.sort(
      (a, b) =>
        compareKnowledgeText(canonicalOutputJSON(a.scope), canonicalOutputJSON(b.scope)) ||
        compareGeneration(a.generation, b.generation) ||
        compareKnowledgeText(a.outpoint.chain.network, b.outpoint.chain.network) ||
        compareKnowledgeText(a.outpoint.chain.genesisHash, b.outpoint.chain.genesisHash) ||
        compareKnowledgeText(a.outpoint.txid, b.outpoint.txid) ||
        a.outpoint.outputIndex - b.outpoint.outputIndex
    )
    return copy(result)
  }

  observations(): OutputObservation[] {
    const result: OutputObservation[] = []
    for (const { visible } of this.families.values())
      if (visible)
        for (const row of this.publishedRows(visible)) result.push(...row.group.observations)
    result.sort(
      (a, b) =>
        compareKnowledgeText(canonicalOutputJSON(a.scope), canonicalOutputJSON(b.scope)) ||
        compareKnowledgeText(a.id, b.id)
    )
    return copy(result)
  }

  publishedGroups(): ReceivedSourceGroup[] {
    return copy(
      [...this.families.values()].flatMap(({ visible }) =>
        visible ? this.publishedRows(visible) : []
      )
    )
  }
  isContinuous(scope: OutputScope, generation: string): boolean {
    const family = this.families.get(outputSourceIdentity(scope))
    return (
      family !== undefined &&
      family.visible === family.highest &&
      this.isCurrent(scope, generation) &&
      !family.highest.unavailable &&
      family.highest.groups.every(row => row.status === 'accepted')
    )
  }

  groups(): ReceivedSourceGroup[] {
    return copy([...this.generations.values()].flatMap(active => active.groups))
  }
  isCurrent(scope: OutputScope, generation: string): boolean {
    const active = this.families.get(outputSourceIdentity(scope))?.highest
    return (
      active?.generation === generation &&
      canonicalOutputJSON(active.scope) === canonicalOutputJSON(scope)
    )
  }
  pending(): { scope: OutputScope; groupId: string; reason: string }[] {
    const result: { scope: OutputScope; groupId: string; reason: string }[] = []
    for (const { highest } of this.families.values())
      for (const row of highest.groups) {
        if (row.status !== 'accepted')
          result.push({
            scope: row.scope,
            groupId: row.group.id,
            reason:
              row.status === 'quarantined'
                ? 'Source group quarantined; generation reset required'
                : 'Whole-group verification pending'
          })
      }
    return copy(result)
  }
}
