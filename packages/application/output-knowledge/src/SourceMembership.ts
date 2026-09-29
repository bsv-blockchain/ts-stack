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
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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
      { scope, generation } = batch.provenance
    const familyKey = outputSourceIdentity(scope),
      family = this.families.get(familyKey),
      scopeKey = canonicalOutputJSON(scope),
      identities = new Map(this.observationIdentities.get(scopeKey))
    let active: Generation
    if (!family || outputU64(generation) > outputU64(family.highest.generation)) {
      if (batch.coverage.phase === 'live')
        throw new OutputProtocolError(
          'reset-required',
          'A new source generation requires a snapshot'
        )
      active = {
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
    } else {
      if (
        generation !== family.highest.generation ||
        canonicalOutputJSON(scope) !== canonicalOutputJSON(family.highest.scope)
      )
        throw new OutputProtocolError(
          'context-changed',
          'Retired source generation or changed epoch'
        )
      active = {
        ...family.highest,
        groups: [...family.highest.groups],
        byId: new Map(family.highest.byId),
        observations: new Map(family.highest.observations),
        sequenceGroups: new Map(family.highest.sequenceGroups)
      }
    }
    const phase = batch.coverage.phase
    if (active.unavailable)
      throw new OutputProtocolError('reset-required', 'Source continuity requires a new generation')
    if (phase === 'snapshot') {
      if (batch.coverage.through === undefined)
        throw new OutputProtocolError('invalid', 'Snapshot watermark is required')
      if (
        active.snapshotWatermark !== undefined &&
        active.snapshotWatermark !== batch.coverage.through
      )
        throw new OutputProtocolError('equivocation', 'Snapshot watermark changed')
      active.snapshotWatermark = batch.coverage.through
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
    const additions: ReceivedSourceGroup[] = []
    for (const group of batch.groups) {
      const prior = active.byId.get(group.id)
      if (prior) {
        if (
          prior.phase !== phase ||
          canonicalOutputJSON(prior.group) !== canonicalOutputJSON(group)
        )
          throw new OutputProtocolError('equivocation', 'Source group identity was reused')
        continue
      }
      if (
        (phase === 'snapshot' && (active.receivedSnapshotComplete || active.liveStarted)) ||
        (phase === 'finite' && active.receivedFiniteComplete)
      )
        throw new OutputProtocolError(
          'equivocation',
          'Completed source snapshot acquired another group'
        )
      if (phase === 'live') {
        if (outputU64(group.sequence) <= outputU64(active.through ?? active.snapshotWatermark!))
          throw new OutputProtocolError(
            'equivocation',
            'New live group predates the received watermark'
          )
        if (active.sequenceGroups.has(group.sequence))
          throw new OutputProtocolError('equivocation', 'Live sequence was reused')
        active.sequenceGroups.set(group.sequence, group.id)
      }
      for (const observation of group.observations) {
        if (active.observations.has(observation.id))
          throw new OutputProtocolError(
            'equivocation',
            'Observation belongs to another source group'
          )
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
      const row: ReceivedSourceGroup = {
        scope,
        generation,
        group,
        phase,
        received,
        status: 'pending'
      }
      active.byId.set(group.id, row)
      additions.push(row)
    }
    active.groups.push(...additions)
    if (phase === 'live') active.liveStarted = true
    if (
      batch.coverage.through !== undefined &&
      (active.through === undefined ||
        outputU64(batch.coverage.through) > outputU64(active.through))
    )
      active.through = batch.coverage.through
    if (batch.coverage.status === 'complete') {
      if (phase === 'snapshot') active.receivedSnapshotComplete = true
      if (phase === 'finite') active.receivedFiniteComplete = true
    }
    if (batch.coverage.status === 'reset-required') active.unavailable = true
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
    const result = seed.filter(row => row.status === 'accepted')
    if (!active.receivedSnapshotComplete || seed.some(row => row.status !== 'accepted'))
      return result
    const live = active.groups
      .filter(row => row.phase === 'live')
      .sort((a, b) => (outputU64(a.group.sequence) < outputU64(b.group.sequence) ? -1 : 1))
    for (const row of live) {
      if (row.status !== 'accepted') break
      result.push(row)
    }
    return result
  }

  memberships(): SourceMembership[] {
    const result: SourceMembership[] = []
    for (const { visible } of this.families.values()) {
      if (!visible) continue
      const rows = new Map<string, SourceMembership>()
      for (const row of this.publishedRows(visible))
        for (const observation of row.group.observations) {
          const outpoint =
            observation.kind === 'output'
              ? {
                  chain: observation.scope.chain,
                  txid: observation.payload.evidence.txid,
                  outputIndex: observation.payload.evidence.outputIndex
                }
              : observation.kind === 'withdraw'
                ? observation.payload.outpoint
                : undefined
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
      result.push(...rows.values())
    }
    return copy(
      result.sort(
        (a, b) =>
          compareKnowledgeText(canonicalOutputJSON(a.scope), canonicalOutputJSON(b.scope)) ||
          (outputU64(a.generation) < outputU64(b.generation)
            ? -1
            : outputU64(a.generation) > outputU64(b.generation)
              ? 1
              : 0) ||
          compareKnowledgeText(a.outpoint.chain.network, b.outpoint.chain.network) ||
          compareKnowledgeText(a.outpoint.chain.genesisHash, b.outpoint.chain.genesisHash) ||
          compareKnowledgeText(a.outpoint.txid, b.outpoint.txid) ||
          a.outpoint.outputIndex - b.outpoint.outputIndex
      )
    )
  }

  observations(): OutputObservation[] {
    const result: OutputObservation[] = []
    for (const { visible } of this.families.values())
      if (visible)
        for (const row of this.publishedRows(visible)) result.push(...row.group.observations)
    return copy(
      result.sort(
        (a, b) =>
          compareKnowledgeText(canonicalOutputJSON(a.scope), canonicalOutputJSON(b.scope)) ||
          compareKnowledgeText(a.id, b.id)
      )
    )
  }
  groups(): ReceivedSourceGroup[] {
    return copy([...this.generations.values()].flatMap(active => active.groups))
  }
  isCurrent(scope: OutputScope, generation: string): boolean {
    const active = this.families.get(outputSourceIdentity(scope))?.highest
    return (
      active !== undefined &&
      active.generation === generation &&
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
