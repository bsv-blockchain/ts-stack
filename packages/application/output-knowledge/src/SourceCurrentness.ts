import {
  canonicalOutputJSON,
  outputPacketDigest,
  outputU64,
  OutputProtocolError,
  type OutputScope
} from '@bsv/sdk'
import {
  parseSourceCurrentnessRules,
  type SourceCurrentnessRule
} from './SourceCurrentnessPolicy.js'
import type { Currentness, SourceBatch, SourceMembership, VerificationContext } from './ports.js'
import {
  compareKnowledgeText,
  outputSourceIdentity,
  type ReceivedSourceGroup
} from './SourceMembership.js'

interface Receipt {
  contextId: string
  receivedAt: string
  position: string
  index: number
}
const receiptKey = (scope: OutputScope, id: string): string => canonicalOutputJSON({ scope, id })
const invalidationKey = (scope: OutputScope, contextId: string): string =>
  canonicalOutputJSON({ scope, contextId })
const later = (a: Receipt, b: Receipt): boolean =>
  outputU64(a.position) > outputU64(b.position) || (a.position === b.position && a.index > b.index)

export interface SourceCurrentnessInput {
  context: VerificationContext
  local: readonly Currentness[]
  memberships: readonly SourceMembership[]
  groups: readonly ReceivedSourceGroup[]
  /** True only for the visible active source generation with intact continuity. */
  continuous(scope: OutputScope, generation: string): boolean
  /** A provisional selected spend also prevents an unspent report becoming usable. */
  blocked(outpoint: Currentness['outpoint']): boolean
  /** Only complete, accepted, current-context proof bundles qualify. */
  evidence(scope: OutputScope, generation: string, observationId: string): string[]
}

/** Rebuilt from trusted journal receipts; no network assertion can enable a policy. */
export class SourceCurrentness {
  readonly rules: SourceCurrentnessRule[]
  private readonly configured: Map<string, SourceCurrentnessRule>
  private readonly receipts = new Map<string, Receipt>()

  constructor(rules: readonly SourceCurrentnessRule[] = []) {
    this.rules = parseSourceCurrentnessRules(rules)
    this.configured = new Map(this.rules.map(rule => [canonicalOutputJSON(rule.source), rule]))
  }

  receive(batch: SourceBatch, position: string, contextId: string): void {
    const rule = this.configured.get(outputSourceIdentity(batch.provenance.scope))
    if (!rule) return
    if (
      outputU64(batch.provenance.receivedAt) + outputU64(rule.maximumAgeSeconds) >
      18446744073709551615n
    )
      throw new OutputProtocolError('limited', 'Source currentness expiry overflow')
    let index = 0
    for (const group of batch.groups)
      for (const observation of group.observations) {
        const key = receiptKey(observation.scope, observation.id)
        if (!this.receipts.has(key)) {
          if (this.receipts.size >= 4096)
            throw new OutputProtocolError(
              'limited',
              'Source currentness receipt retention exhausted'
            )
          this.receipts.set(key, {
            contextId,
            receivedAt: batch.provenance.receivedAt,
            position,
            index
          })
        }
        index++
      }
  }

  private invalidations(groups: readonly ReceivedSourceGroup[]): Map<string, Receipt> {
    const result = new Map<string, Receipt>()
    for (const row of groups) {
      if (row.status !== 'accepted') continue
      this.retainInvalidations(row, result)
    }
    return result
  }

  private retainInvalidations(row: ReceivedSourceGroup, result: Map<string, Receipt>): void {
    for (const observation of row.group.observations) {
      if (observation.kind !== 'assessment-invalidated') continue
      const receipt = this.receipts.get(receiptKey(observation.scope, observation.id))
      if (!receipt) continue
      const key = invalidationKey(observation.scope, observation.payload.contextId),
        previous = result.get(key)
      if (!previous || later(receipt, previous)) result.set(key, receipt)
    }
  }

  assessments(input: SourceCurrentnessInput): Currentness[] {
    if (!this.rules.length) return []
    const invalidations = this.invalidations(input.groups)
    const local = new Map(input.local.map(row => [canonicalOutputJSON(row.outpoint), row]))
    const result: Currentness[] = []
    for (const member of input.memberships) {
      const assessment = this.assessMember(input, member, local, invalidations)
      if (assessment) result.push(assessment)
    }
    return result
  }

  private assessMember(
    input: SourceCurrentnessInput,
    member: SourceMembership,
    local: ReadonlyMap<string, Currentness>,
    invalidations: ReadonlyMap<string, Receipt>
  ): Currentness | undefined {
    if (!member.present) return undefined
    const rule = this.configured.get(outputSourceIdentity(member.scope)),
      receipt = this.receipts.get(receiptKey(member.scope, member.observationId))
    if (!rule || !receipt) return undefined
    const knowledge = local.get(canonicalOutputJSON(member.outpoint))
    if (!knowledge) return undefined
    const invalidation = invalidations.get(invalidationKey(member.scope, receipt.contextId))
    const evidenceIds = input.evidence(member.scope, member.generation, member.observationId)
    const stale =
      receipt.contextId !== input.context.id ||
      !input.continuous(member.scope, member.generation) ||
      (invalidation !== undefined && !later(receipt, invalidation)) ||
      !evidenceIds.length
    const state = this.state(knowledge.state, stale || input.blocked(member.outpoint))
    const expiry = outputU64(receipt.receivedAt) + outputU64(rule.maximumAgeSeconds)
    if (expiry > 18446744073709551615n)
      throw new OutputProtocolError('limited', 'Source currentness expiry overflow')
    const body: Omit<Currentness, 'id'> = {
      outpoint: member.outpoint,
      state,
      contextId: input.context.id,
      generation: input.context.generation,
      policyDigest: input.context.policyDigest,
      origin: { kind: 'source', scope: member.scope },
      evidenceIds: [...new Set(evidenceIds)].sort(compareKnowledgeText),
      expiresAt: String(expiry)
    }
    return { id: outputPacketDigest('assessment', body), ...body }
  }

  private state(local: Currentness['state'], stale: boolean): Currentness['state'] {
    // A creation proof cannot establish a spend. Keep the independent local
    // spent/conflict assessment authoritative and mark this source report stale.
    return local === 'unknown' && !stale ? 'reported-unspent' : 'stale'
  }
}
