import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputPacketDigest,
  outputU64,
  OutputProtocolError,
  Hash,
  Utils,
  decodeOutputBytes,
  type OutputJSONObject,
  type OutputObservation
} from '@bsv/sdk'
import { SourceCurrentness } from './SourceCurrentness.js'
import type { SourceCurrentnessRule } from './SourceCurrentnessPolicy.js'
import { EvidencePool, type EvidenceReceipt } from './EvidencePool.js'
import { factFromAssembly } from './EvidenceAssembler.js'
import {
  planKnowledgeEvidence,
  evaluateKnowledgeReadiness,
  type EvidenceContextFrontier,
  type EvidenceWorkPlan,
  type EvidenceReadiness
} from './EvidenceReadiness.js'
import {
  SourceMembershipLedger,
  outputGroupIdentity,
  compareKnowledgeText,
  type ReceivedSourceGroup
} from './SourceMembership.js'
import { VerificationLedger, proofReference } from './VerificationLedger.js'
import { reconcileOutputSpends, type ReconciliationCandidate } from './SpendReconciler.js'
import {
  parsePartition,
  parseVerificationContext,
  parseSourceBatch,
  runtimeLimits
} from './validation.js'
import type { JournalEntry } from './storage/Journal.js'
import type {
  AcceptedInput,
  Currentness,
  Mutation,
  OutputPartition,
  OutputOutpoint,
  RuntimeLimits,
  SourceBatch,
  VerificationContext,
  VerificationResult,
  StoreRevision
} from './ports.js'

export interface BitcoinKnowledgeStateOptions {
  journalId: string
  partition: OutputPartition
  nonFinal: boolean
  limits?: Partial<RuntimeLimits>
  supportedExtensions?: readonly string[]
  sourceCurrentness?: readonly SourceCurrentnessRule[]
}
interface Slot {
  receipt: EvidenceReceipt
  observation: OutputObservation
  fault?: string
}
const equal = (a: unknown, b: unknown): boolean => canonicalOutputJSON(a) === canonicalOutputJSON(b)
const groupKey = (row: ReceivedSourceGroup): string =>
  outputGroupIdentity(row.scope, row.generation, row.group.id)

/** Private deterministic protocol state, reconstructed exclusively from the local journal. */
export class BitcoinKnowledgeState {
  readonly pool: EvidencePool
  readonly membership: SourceMembershipLedger
  readonly ledger: VerificationLedger
  readonly sourceCurrentness: SourceCurrentness
  readonly contexts = new Map<string, VerificationContext>()
  readonly frontiers: EvidenceContextFrontier[] = []
  readonly partition: OutputPartition
  readonly limits: RuntimeLimits
  private readonly slots = new Map<string, Slot>()
  private readonly invalidated = new Set<string>()
  private revision: StoreRevision = { received: '0', accepted: '0' }
  private planCache?: EvidenceWorkPlan
  private readinessCache?: EvidenceReadiness

  constructor(readonly options: BitcoinKnowledgeStateOptions) {
    this.partition = parsePartition(options.partition)
    this.limits = runtimeLimits(options.limits)
    this.membership = new SourceMembershipLedger({ bytes: this.limits.pendingBytes })
    this.pool = new EvidencePool(options.journalId, {
      retainedBytes: this.limits.pendingBytes,
      dependencies: this.limits.dependencies
    })
    this.sourceCurrentness = new SourceCurrentness(options.sourceCurrentness)
    this.ledger = new VerificationLedger(options.nonFinal, this.sourceCurrentness.rules)
  }
  get context(): VerificationContext {
    const selected = this.frontiers.at(-1)?.context
    if (!selected)
      throw new OutputProtocolError(
        'revision-unavailable',
        'No initial verification context has been committed'
      )
    return selected
  }
  private changed(): void {
    this.planCache = undefined
    this.readinessCache = undefined
  }
  applyLocal(local: OutputJSONObject): void {
    this.ledger.apply(local, this.pool, this.contexts)
    this.readinessCache = undefined
  }

  /** Apply one committed prefix or one already prepared prospective transition. */
  apply(entry: JournalEntry, local = entry.local): void {
    const { body, revision } = entry
    if (body.kind === 'context') this.applyContext(body, revision, local)
    else this.applyEstablished(body, revision.received, this.context)
    this.revision = { ...revision }
    this.changed()
    if (local !== undefined) this.applyLocal(local)
    if (body.kind === 'accept' || body.kind === 'reconcile') this.applyAcceptance(body)
  }

  private applyContext(
    body: Extract<Mutation['body'], { kind: 'context' }>,
    revision: StoreRevision,
    local?: OutputJSONObject
  ): void {
    if (local === undefined)
      throw new OutputProtocolError(
        'reset-required',
        'Bitcoin journal context is missing its retained spend policy'
      )
    closedOutputObject(body, ['kind', 'context'])
    const context = parseVerificationContext(body.context),
      previous = this.frontiers.at(-1)?.context
    if (!equal(context.partition, this.partition))
      throw new OutputProtocolError('unauthorized', 'Context changed account partition')
    if (
      previous &&
      (!equal(context.view.chain, previous.view.chain) ||
        outputU64(context.generation) < outputU64(previous.generation))
    )
      throw new OutputProtocolError(
        'context-changed',
        'Configured chain changed or generation reversed'
      )
    if (this.contexts.has(context.id))
      throw new OutputProtocolError('equivocation', 'Verification context identity was reused')
    this.contexts.set(context.id, context)
    this.frontiers.push({ at: previous ? revision.received : '0', context })
  }

  private applyEstablished(
    body: Exclude<Mutation['body'], { kind: 'context' }>,
    received: string,
    context: VerificationContext
  ): void {
    // Evaluation of this.context at dispatch establishes the local partition and
    // chain before any source or acceptance operation can contribute state.
    if (body.kind === 'receive') this.receive(body, received)
    else if (body.kind === 'invalidate') this.applyInvalidation(body, context)
    else if (body.kind !== 'accept' && body.kind !== 'reconcile')
      throw new OutputProtocolError('unsupported', 'Unknown knowledge mutation kind')
  }

  private applyInvalidation(
    body: Extract<Mutation['body'], { kind: 'invalidate' }>,
    context: VerificationContext
  ): void {
    closedOutputObject(body, ['kind', 'generation', 'assessmentIds', 'reason'])
    if (body.generation !== context.generation)
      throw new OutputProtocolError('context-changed', 'Invalidation generation changed')
    if (!Array.isArray(body.assessmentIds) || !body.reason || typeof body.reason !== 'string')
      throw new OutputProtocolError('invalid', 'Invalid assessment invalidation')
    const existing = new Set(this.snapshot().assessments.map(row => row.id)),
      seen = new Set<string>()
    for (const id of body.assessmentIds) {
      outputHex32(id)
      if (!existing.has(id) || seen.has(id))
        throw new OutputProtocolError('invalid', 'Unknown or duplicated assessment invalidation')
      seen.add(id)
      this.invalidated.add(id)
    }
  }

  private applyAcceptance(body: Extract<Mutation['body'], { kind: 'accept' | 'reconcile' }>): void {
    closedOutputObject(
      body,
      body.kind === 'accept'
        ? [
            'kind',
            'scope',
            'groupId',
            'generation',
            'contextId',
            'results',
            'assessments',
            'reconciled'
          ]
        : ['kind', 'generation', 'contextId', 'reconciled', 'assessments']
    )
    if (body.contextId !== this.context.id)
      throw new OutputProtocolError('context-changed', 'Acceptance context changed')
    if (body.kind === 'accept') this.acceptGroup(body)
    else {
      if (body.generation !== this.context.generation)
        throw new OutputProtocolError('context-changed', 'Reconciliation generation changed')
      this.membership.acceptCompletions()
    }
    this.membership.acceptContinuity()
    this.changed()
    const expected = this.snapshot()
    if (
      !equal(body.reconciled, expected.reconciled) ||
      !equal(body.assessments, expected.assessments)
    )
      throw new OutputProtocolError(
        'invalid',
        'Mutation differs from deterministic protocol reconciliation'
      )
  }

  private acceptGroup(body: Extract<Mutation['body'], { kind: 'accept' }>): void {
    const row = this.membership
      .groups()
      .find(
        group =>
          group.group.id === body.groupId &&
          group.generation === body.generation &&
          equal(group.scope, body.scope)
      )
    if (!row || !this.membership.isCurrent(row.scope, row.generation))
      throw new OutputProtocolError('context-changed', 'Source group is unavailable or retired')
    const decision = this.groupDecision(row)
    if (!decision || !equal(decision.results, body.results))
      throw new OutputProtocolError(
        'invalid',
        'Acceptance differs from verified whole-group result'
      )
    this.membership.decide(row.scope, row.generation, row.group.id, decision.verdict)
  }

  private receive(body: Extract<Mutation['body'], { kind: 'receive' }>, received: string): void {
    closedOutputObject(body, ['kind', 'batch'])
    const origin = body.batch.provenance
    const batch = parseSourceBatch(
      body.batch,
      { ...origin, partition: this.partition },
      this.limits,
      this.options.supportedExtensions
    )
    if (!equal(batch.provenance.scope.chain, this.context.view.chain))
      throw new OutputProtocolError('context-changed', 'Source changed the configured chain')
    if (this.membership.receiveRetainingEquivocation(batch, received) === 'quarantined') {
      // Retain the complete receipt for recovery, but none of its siblings can
      // introduce evidence, memberships, private context or freshness claims.
      this.pool.receive(received, [])
      return
    }
    this.sourceCurrentness.receive(batch, received, this.context.id)
    this.retainEvidence(batch, received)
  }

  private retainEvidence(batch: SourceBatch, received: string): void {
    const origin = batch.provenance
    const additions: EvidenceReceipt[] = []
    for (const group of batch.groups) {
      const groupId = outputGroupIdentity(origin.scope, origin.generation, group.id)
      for (const observation of group.observations) {
        if (observation.kind !== 'output' && observation.kind !== 'spend') continue
        const evidence =
            observation.kind === 'output'
              ? observation.payload.evidence
              : {
                  txid: observation.payload.spendingTxid,
                  outputIndex: 0,
                  beef: observation.payload.beef
                },
          id = canonicalOutputJSON({ group: groupId, observation: observation.id }),
          receipt = { id, group: groupId, received, chain: origin.scope.chain, evidence }
        additions.push(receipt)
        if (!this.slots.has(id)) this.slots.set(id, { receipt, observation })
      }
    }
    const rejected = this.pool.receive(received, additions).rejected
    for (const { id, code } of rejected) this.slots.get(id)!.fault = code
    this.checkSpendClaims()
  }

  private checkSpendClaims(): void {
    for (const { receipt, plan } of this.pool.entries()) {
      const slot = this.slots.get(receipt.id)!,
        observation = slot.observation
      if (
        observation.kind === 'spend' &&
        plan.target &&
        !plan.target.inputs.some(input => equal(input, observation.payload.previous))
      )
        slot.fault = 'invalid'
    }
  }

  plan(): EvidenceWorkPlan {
    if (!this.planCache) {
      const groups = this.membership.groups().map(row => {
        const id = groupKey(row),
          slots = [...this.slots.values()].filter(slot => slot.receipt.group === id)
        return {
          id,
          received: row.received,
          receipts: slots.map(slot => slot.receipt.id),
          enabled:
            row.status !== 'quarantined' &&
            (row.status === 'accepted' || this.membership.isCurrent(row.scope, row.generation)) &&
            !slots.some(slot => slot.fault !== undefined) &&
            !row.group.observations.some(observation => observation.kind.startsWith('proposal'))
        }
      })
      this.planCache = planKnowledgeEvidence(this.pool, groups)
    }
    return this.planCache
  }
  readiness(): EvidenceReadiness {
    this.readinessCache ??= evaluateKnowledgeReadiness(
      this.pool,
      this.plan(),
      this.ledger,
      this.frontiers,
      this.revision.received
    )
    return this.readinessCache
  }

  groupDecision(
    row: ReceivedSourceGroup
  ): { verdict: 'accepted' | 'quarantined'; results: VerificationResult[] } | undefined {
    if (row.status !== 'pending' || !this.membership.canAccept(row.scope, row.generation))
      return undefined
    const id = groupKey(row),
      slots = [...this.slots.values()].filter(slot => slot.receipt.group === id),
      context = this.context,
      results: VerificationResult[] = []
    let bad = false
    for (const slot of slots) {
      const bundles = this.plan().slots.get(slot.receipt.id) ?? []
      const verified = bundles.find(
        bundle => this.ledger.get(proofReference(bundle.support), context.id)?.status === 'verified'
      )
      if (
        slot.fault === 'invalid' ||
        (!verified &&
          bundles.length > 0 &&
          bundles.every(
            bundle =>
              this.ledger.get(proofReference(bundle.support), context.id)?.status === 'invalid'
          ))
      ) {
        bad = true
        results.push({
          status: 'invalid',
          contextId: context.id,
          variantId: Utils.toHex(Hash.sha256(decodeOutputBytes(slot.receipt.evidence.beef))),
          reason: 'Source evidence does not fulfill its asserted observation',
          dependencies: []
        })
      } else if (verified) {
        const check = this.ledger.get(proofReference(verified.support), context.id)!
        results.push({
          status: 'verified',
          contextId: context.id,
          variantId: verified.support.candidate.variantId,
          fact: factFromAssembly(context.view.chain, verified.support.plan.target!),
          ...(check.placement ? { placement: check.placement } : {})
        })
      } else {
        results.push({
          status: slot.fault === 'limited' ? 'limited' : 'unresolved',
          contextId: context.id,
          variantId: Utils.toHex(Hash.sha256(decodeOutputBytes(slot.receipt.evidence.beef))),
          reason: 'Whole-group cryptographic evidence is incomplete',
          dependencies: []
        })
      }
    }
    if (bad) return { verdict: 'quarantined', results }
    if (!this.readiness().groups.has(id)) return undefined
    return { verdict: 'accepted', results }
  }

  /** Build a prospective accept/reconcile mutation; the reducer independently checks it. */
  transition(revision: StoreRevision, row?: ReceivedSourceGroup): Mutation['body'] {
    const context = this.context,
      decision = row ? this.groupDecision(row) : undefined
    if (row && !decision)
      throw new OutputProtocolError('unavailable', 'Source group has not qualified')
    this.revision = { ...revision }
    if (row) this.membership.decide(row.scope, row.generation, row.group.id, decision!.verdict)
    else this.membership.acceptCompletions()
    this.membership.acceptContinuity()
    this.changed()
    const snapshot = this.snapshot()
    return row
      ? {
          kind: 'accept',
          scope: row.scope,
          groupId: row.group.id,
          generation: row.generation,
          contextId: context.id,
          results: decision!.results,
          assessments: snapshot.assessments,
          reconciled: snapshot.reconciled
        }
      : {
          kind: 'reconcile',
          generation: context.generation,
          contextId: context.id,
          assessments: snapshot.assessments,
          reconciled: snapshot.reconciled
        }
  }

  snapshot(): AcceptedInput {
    const context = this.context,
      readiness = this.readiness(),
      accepted = new Set(
        this.membership
          .groups()
          .filter(row => row.status === 'accepted')
          .map(groupKey)
      ),
      qualifies = (txid: string, contextId: string) =>
        this.plan()
          .candidates.get(txid)!
          .bundles.filter(
            bundle =>
              bundle.support.groups.every(group => accepted.has(group)) &&
              bundle.proofs.every(
                key =>
                  this.ledger.get(proofReference(this.plan().proofs.get(key)!), contextId)
                    ?.status === 'verified'
              )
          ),
      candidates = readiness.candidates.map((candidate): ReconciliationCandidate => {
        const usable = qualifies(candidate.txid, context.id),
          { placement: _placement, ...retained } = candidate
        const placed = usable
          .map(bundle => this.ledger.get(proofReference(bundle.support), context.id))
          .find(check => check?.placement)?.placement
        let validation = candidate.validation
        if (validation === 'verified' && !usable.length) validation = 'unresolved'
        return {
          ...retained,
          validation,
          pendingSupport:
            candidate.pendingSupport || (candidate.validation === 'verified' && !usable.length),
          ...(placed ? { placement: { contextId: context.id, ...placed } } : {})
        }
      })
    this.holdIncompleteAnchorClosures(candidates)
    const reconciled = reconcileOutputSpends({
      journalId: this.options.journalId,
      through: this.revision.received,
      context,
      contexts: this.frontiers,
      nonFinal: this.options.nonFinal,
      candidates,
      memberships: this.membership.memberships()
    })
    const facts = [...this.plan().candidates]
      .filter(([txid]) =>
        this.frontiers.some(frontier => qualifies(txid, frontier.context.id).length > 0)
      )
      .map(([, candidate]) => factFromAssembly(context.view.chain, candidate.raw))
      .sort((a, b) => compareKnowledgeText(a.txid, b.txid))
    const assessments = this.observedOutpoints().map((outpoint): Currentness => {
      const spends = reconciled.transactions.filter(
        row =>
          row.dependencies.some(input => equal(input, outpoint)) &&
          (row.status === 'included' || row.status === 'selected-final')
      )
      const state = assessmentState(outpoint, reconciled, spends.length > 0)
      const body: Omit<Currentness, 'id'> = {
        outpoint,
        state,
        contextId: context.id,
        generation: context.generation,
        policyDigest: context.policyDigest,
        origin: { kind: 'local' },
        evidenceIds: [
          ...new Set(
            spends.flatMap(row =>
              qualifies(row.txid, context.id).map(bundle => bundle.support.candidate.variantId)
            )
          )
        ].sort(compareKnowledgeText)
      }
      return this.assessment(body)
    })
    this.appendSourceAssessments(assessments, reconciled, context, accepted)
    if (this.ledger.version === 3 || this.sourceCurrentness.rules.length)
      assessments.sort((a, b) => compareKnowledgeText(a.id, b.id))
    return {
      partition: this.partition,
      generation: context.generation,
      revision: { ...this.revision },
      context,
      observations: this.membership.observations(),
      facts,
      assessments,
      reconciled,
      pendingGroups: this.membership.pending()
    }
  }
  private appendSourceAssessments(
    assessments: Currentness[],
    reconciled: AcceptedInput['reconciled'],
    context: VerificationContext,
    accepted: ReadonlySet<string>
  ): void {
    if (this.sourceCurrentness.rules.length) {
      const sourceEvidence = this.sourceEvidence(context.id, accepted)
      const usableTransactions = new Set(
        reconciled.transactions
          .filter(
            row =>
              row.status === 'included' ||
              row.status === 'selected-final' ||
              row.status === 'selected-non-final'
          )
          .map(row => row.txid)
      )
      const provisionalSpends = new Set(
        reconciled.transactions
          .filter(row => row.status === 'selected-non-final')
          .flatMap(row => row.dependencies.map(input => canonicalOutputJSON(input)))
      )
      assessments.push(
        ...this.sourceCurrentness
          .assessments({
            context,
            local: assessments,
            memberships: reconciled.memberships,
            groups: this.membership.publishedGroups(),
            continuous: (scope, generation) => this.membership.isContinuous(scope, generation),
            blocked: outpoint =>
              !usableTransactions.has(outpoint.txid) ||
              provisionalSpends.has(canonicalOutputJSON(outpoint)),
            evidence: (scope, generation, observationId) =>
              sourceEvidence.get(canonicalOutputJSON({ scope, generation, observationId })) ?? []
          })
          .map(({ id: _id, ...body }) => this.assessment(body))
      )
    }
  }

  private sourceEvidence(contextId: string, accepted: ReadonlySet<string>): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (const row of this.membership.publishedGroups())
      for (const observation of row.group.observations) {
        if (observation.kind !== 'output') continue
        const id = canonicalOutputJSON({ group: groupKey(row), observation: observation.id })
        const variants = (this.plan().slots.get(id) ?? [])
          .filter(
            bundle =>
              bundle.support.groups.every(group => accepted.has(group)) &&
              bundle.proofs.every(
                key =>
                  this.ledger.get(proofReference(this.plan().proofs.get(key)!), contextId)
                    ?.status === 'verified'
              )
          )
          .map(bundle => bundle.support.candidate.variantId)
        result.set(
          canonicalOutputJSON({
            scope: row.scope,
            generation: row.generation,
            observationId: observation.id
          }),
          variants
        )
      }
    return result
  }

  private assessment(body: Omit<Currentness, 'id'>): Currentness {
    let id = outputPacketDigest('assessment', body)
    if (this.invalidated.has(id)) {
      body.state = 'stale'
      id = outputPacketDigest('assessment', body)
    }
    return { id, ...body }
  }

  private observedOutpoints(): OutputOutpoint[] {
    const observed = new Map<string, OutputOutpoint>()
    for (const row of this.membership.groups()) {
      if (row.status !== 'accepted') continue
      for (const observation of row.group.observations) {
        const outpoint = observedOutpoint(observation)
        if (outpoint) observed.set(canonicalOutputJSON(outpoint), outpoint)
      }
    }
    return [...observed]
      .sort(([a], [b]) => compareKnowledgeText(a, b))
      .map(([, outpoint]) => outpoint)
  }

  private holdIncompleteAnchorClosures(candidates: ReconciliationCandidate[]): void {
    const byId = new Map(candidates.map(candidate => [candidate.txid, candidate]))
    for (const candidate of candidates) {
      if (candidate.placement && !this.anchorClosureComplete(candidate.txid, byId)) {
        delete candidate.placement
        candidate.pendingSupport = true
      }
    }
  }

  private anchorClosureComplete(
    start: string,
    byId: ReadonlyMap<string, ReconciliationCandidate>
  ): boolean {
    const seen = new Set<string>(),
      pending = [start]
    let work = 0
    while (pending.length) {
      if (++work > 16384)
        throw new OutputProtocolError('limited', 'Chain ancestor publication bound')
      const txid = pending.pop()!
      if (seen.has(txid)) continue
      seen.add(txid)
      const known = byId.get(txid)
      if (!known) continue
      if (known.validation !== 'verified') return false
      for (const input of this.plan().candidates.get(txid)!.raw.inputs) pending.push(input.txid)
    }
    return true
  }

  pendingBytes(): number {
    return (
      this.membership.quarantineBytes() +
      new TextEncoder().encode(
        canonicalOutputJSON(this.membership.groups().filter(row => row.status === 'pending'))
      ).length
    )
  }
}

function observedOutpoint(observation: OutputObservation): OutputOutpoint | undefined {
  if (observation.kind === 'output')
    return {
      chain: observation.scope.chain,
      txid: observation.payload.evidence.txid,
      outputIndex: observation.payload.evidence.outputIndex
    }
  if (observation.kind === 'spend') return observation.payload.previous
  return undefined
}

function assessmentState(
  outpoint: OutputOutpoint,
  reconciled: AcceptedInput['reconciled'],
  spent: boolean
): Currentness['state'] {
  if (spent) return 'spent'
  const origin = reconciled.transactions.find(row => row.txid === outpoint.txid)
  if (origin?.status === 'conflicting' || origin?.status === 'dependent-conflict')
    return 'conflicted'
  if (
    origin?.status === 'unresolved' ||
    origin?.status === 'limited' ||
    reconciled.transactions.some(
      row => row.status === 'unresolved' && row.dependencies.some(input => equal(input, outpoint))
    )
  )
    return 'stale'
  return 'unknown'
}
