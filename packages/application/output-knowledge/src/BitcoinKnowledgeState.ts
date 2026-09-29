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
  readonly membership = new SourceMembershipLedger()
  readonly ledger: VerificationLedger
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
    this.pool = new EvidencePool(options.journalId, {
      retainedBytes: this.limits.pendingBytes,
      dependencies: this.limits.dependencies
    })
    this.ledger = new VerificationLedger(options.nonFinal)
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
    if (body.kind === 'context') {
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
    } else {
      // Any source may contribute facts only after the local partition/chain has been established.
      void this.context
      if (body.kind === 'receive') this.receive(body, revision.received)
      else if (body.kind === 'invalidate') {
        closedOutputObject(body, ['kind', 'generation', 'assessmentIds', 'reason'])
        if (body.generation !== this.context.generation)
          throw new OutputProtocolError('context-changed', 'Invalidation generation changed')
        if (!Array.isArray(body.assessmentIds) || !body.reason || typeof body.reason !== 'string')
          throw new OutputProtocolError('invalid', 'Invalid assessment invalidation')
        const existing = new Set(this.snapshot().assessments.map(row => row.id)),
          seen = new Set<string>()
        for (const id of body.assessmentIds) {
          outputHex32(id)
          if (!existing.has(id) || seen.has(id))
            throw new OutputProtocolError(
              'invalid',
              'Unknown or duplicated assessment invalidation'
            )
          seen.add(id)
          this.invalidated.add(id)
        }
      } else if (body.kind !== 'accept' && body.kind !== 'reconcile') {
        throw new OutputProtocolError('unsupported', 'Unknown knowledge mutation kind')
      }
    }
    this.revision = { ...revision }
    this.changed()
    if (local !== undefined) this.applyLocal(local)
    if (body.kind === 'accept' || body.kind === 'reconcile') {
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
      if (body.kind === 'accept') {
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
        this.changed()
      } else {
        if (body.generation !== this.context.generation)
          throw new OutputProtocolError('context-changed', 'Reconciliation generation changed')
        this.membership.acceptCompletions()
        this.changed()
      }
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
    this.membership.receive(batch, received)
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
    for (const { receipt, plan } of this.pool.entries()) {
      const slot = this.slots.get(receipt.id)!
      if (
        slot.observation.kind === 'spend' &&
        plan.target &&
        !plan.target.inputs.some(input =>
          equal(input, slot.observation.kind === 'spend' ? slot.observation.payload.previous : null)
        )
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
    if (row.status !== 'pending') return undefined
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
        return {
          ...retained,
          validation: usable.length
            ? candidate.validation
            : candidate.validation === 'verified'
              ? 'unresolved'
              : candidate.validation,
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
    const observed = new Map<string, OutputOutpoint>()
    for (const row of this.membership.groups())
      if (row.status === 'accepted')
        for (const observation of row.group.observations) {
          const outpoint =
            observation.kind === 'output'
              ? {
                  chain: observation.scope.chain,
                  txid: observation.payload.evidence.txid,
                  outputIndex: observation.payload.evidence.outputIndex
                }
              : observation.kind === 'spend'
                ? observation.payload.previous
                : undefined
          if (outpoint) observed.set(canonicalOutputJSON(outpoint), outpoint)
        }
    const assessments = [...observed]
      .sort(([a], [b]) => compareKnowledgeText(a, b))
      .map(([, outpoint]): Currentness => {
        const spends = reconciled.transactions.filter(
            row =>
              row.dependencies.some(input => equal(input, outpoint)) &&
              (row.status === 'included' || row.status === 'selected-final')
          ),
          origin = reconciled.transactions.find(row => row.txid === outpoint.txid)
        const state: Currentness['state'] = spends.length
          ? 'spent'
          : origin?.status === 'conflicting' || origin?.status === 'dependent-conflict'
            ? 'conflicted'
            : origin?.status === 'unresolved' ||
                origin?.status === 'limited' ||
                reconciled.transactions.some(
                  row =>
                    row.status === 'unresolved' &&
                    row.dependencies.some(input => equal(input, outpoint))
                )
              ? 'stale'
              : 'unknown'
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
          ].sort()
        }
        let id = outputPacketDigest('assessment', body)
        if (this.invalidated.has(id)) {
          body.state = 'stale'
          id = outputPacketDigest('assessment', body)
        }
        return { id, ...body }
      })
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
  private holdIncompleteAnchorClosures(candidates: ReconciliationCandidate[]): void {
    const byId = new Map(candidates.map(candidate => [candidate.txid, candidate]))
    for (const candidate of candidates) {
      if (!candidate.placement) continue
      const seen = new Set<string>(),
        pending = [candidate.txid]
      let complete = true,
        work = 0
      while (pending.length) {
        if (++work > 16384)
          throw new OutputProtocolError('limited', 'Chain ancestor publication bound')
        const txid = pending.pop()!
        if (seen.has(txid)) continue
        seen.add(txid)
        const known = byId.get(txid)
        if (!known) continue
        if (known.validation !== 'verified') {
          complete = false
          break
        }
        for (const input of this.plan().candidates.get(txid)!.raw.inputs) pending.push(input.txid)
      }
      if (!complete) {
        delete candidate.placement
        candidate.pendingSupport = true
      }
    }
  }

  pendingBytes(): number {
    return new TextEncoder().encode(
      canonicalOutputJSON(this.membership.groups().filter(row => row.status === 'pending'))
    ).length
  }
}
