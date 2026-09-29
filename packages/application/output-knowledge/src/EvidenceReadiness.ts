import { canonicalOutputJSON, outputU64, OutputProtocolError } from '@bsv/sdk'
import type { AssembledRawTransaction, EvidencePlan } from './EvidenceAssembler.js'
import { EvidencePool, type EvidenceReceipt, type EvidenceSupport } from './EvidencePool.js'
import { compareKnowledgeText } from './SourceMembership.js'
import { proofReference, proofReferenceKey, VerificationLedger } from './VerificationLedger.js'
import type { ReconciliationCandidate } from './SpendReconciler.js'
import type { CandidateOrder, VerificationContext } from './ports.js'

export interface EvidenceGroupRequirement {
  id: string
  received: string
  /** All evidence-bearing observation slots in this indivisible group. */
  receipts: string[]
  /** False for quarantined, unauthorized or unsupported groups. */
  enabled: boolean
}
export interface EvidenceContextFrontier {
  at: string
  context: VerificationContext
}
interface Bundle {
  support: EvidenceSupport
  /** Exact target and its required ancestor checks, excluding unrelated bundle entries. */
  proofs: string[]
}
interface EvidenceCandidateBundles {
  raw: AssembledRawTransaction
  bundles: Bundle[]
}
export interface EvidenceWorkPlan {
  groups: EvidenceGroupRequirement[]
  slots: Map<string, Bundle[]>
  candidates: Map<string, EvidenceCandidateBundles>
  proofs: Map<string, EvidenceSupport>
  limited: boolean
}
export interface EvidenceReadiness {
  candidates: ReconciliationCandidate[]
  /** Earliest whole-group cryptographic readiness in the current context. */
  groups: Map<string, string>
}
type BundleStatus = 'verified' | 'invalid' | 'pending'
type Validation = ReconciliationCandidate['validation']
type Placement = NonNullable<ReconciliationCandidate['placement']>
const keyOf = (support: EvidenceSupport): string => proofReferenceKey(proofReference(support))
const maximum = (...values: bigint[]): bigint => {
  let result = 0n
  for (const value of values) if (value > result) result = value
  return result
}

/** Bounded local plan. No planning operation declares validity or assigns completion order. */
export function planKnowledgeEvidence(
  pool: EvidencePool,
  groups: readonly EvidenceGroupRequirement[],
  options: { maximumWork?: number; maximumProofs?: number } = {}
): EvidenceWorkPlan {
  return new EvidencePlanner(pool, groups, options).plan()
}

class EvidencePlanner {
  private readonly maximumWork: number
  private readonly maximumProofs: number
  private work = 0
  private readonly groupIds: Set<string>
  private readonly receiptIds = new Set<string>()
  private readonly slots = new Map<string, Bundle[]>()
  private readonly proofs = new Map<string, EvidenceSupport>()
  private readonly candidates: EvidenceWorkPlan['candidates'] = new Map()
  private limited = false

  constructor(
    private readonly pool: EvidencePool,
    private readonly groups: readonly EvidenceGroupRequirement[],
    options: { maximumWork?: number; maximumProofs?: number }
  ) {
    this.maximumWork = options.maximumWork ?? 1000000
    this.maximumProofs = options.maximumProofs ?? 4096
    for (const [value, bound] of [
      [this.maximumWork, 1000000],
      [this.maximumProofs, 4096]
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > bound)
        throw new OutputProtocolError('invalid', 'Invalid evidence planning bound')
    this.groupIds = new Set(groups.map(group => group.id))
    if (this.groupIds.size !== groups.length || groups.length > 4096)
      throw new OutputProtocolError('invalid', 'Duplicate or excessive evidence groups')
    this.registerSlots()
  }

  private registerSlots(): void {
    for (const group of this.groups) {
      outputU64(group.received)
      for (const id of group.receipts) {
        if (this.receiptIds.has(id))
          throw new OutputProtocolError('invalid', 'Evidence slot belongs to multiple groups')
        this.receiptIds.add(id)
        this.slots.set(id, [])
      }
    }
  }

  private charge(): void {
    if (++this.work > this.maximumWork)
      throw new OutputProtocolError('limited', 'Evidence planning work exhausted')
  }

  plan(): EvidenceWorkPlan {
    const rows = this.pool.entries(),
      known = new Set(rows.map(row => row.receipt.id))
    for (const row of rows) this.addReceipt(row.receipt, row.plan)
    // Malformed/txid-only slots remain requirements, so their valid siblings cannot leak.
    for (const id of this.receiptIds) if (!known.has(id)) this.slots.set(id, [])
    return {
      groups: JSON.parse(canonicalOutputJSON(this.groups)) as EvidenceGroupRequirement[],
      slots: this.slots,
      candidates: this.candidates,
      proofs: this.proofs,
      limited: this.limited
    }
  }

  private addRaw(raw: AssembledRawTransaction): void {
    const prior = this.candidates.get(raw.txid)
    if (prior && prior.raw.rawTransaction !== raw.rawTransaction)
      throw new OutputProtocolError('equivocation', 'Raw transaction identity changed')
    if (!prior) this.candidates.set(raw.txid, { raw, bundles: [] })
  }

  private closure(
    raw: AssembledRawTransaction,
    rows: Map<string, AssembledRawTransaction>
  ): AssembledRawTransaction[] {
    const found = new Map<string, AssembledRawTransaction>(),
      pending = [raw]
    while (pending.length) {
      this.charge()
      const next = pending.pop()!
      if (found.has(next.txid)) continue
      found.set(next.txid, next)
      if (next.merkleRoot !== undefined) continue
      for (const input of next.inputs) {
        this.charge()
        const parent = rows.get(input.txid)
        if (parent) pending.push(parent)
      }
    }
    return [...found.values()].sort((a, b) => compareKnowledgeText(a.txid, b.txid))
  }

  private addReceipt(receipt: EvidenceReceipt, plan: EvidencePlan): void {
    this.charge()
    if (!this.receiptIds.has(receipt.id) || !this.groupIds.has(receipt.group))
      throw new OutputProtocolError('invalid', 'Evidence receipt has no source group')
    if (plan.target)
      for (const raw of this.closure(
        plan.target,
        new Map(plan.transactions.map(raw => [raw.txid, raw]))
      ))
        this.addRaw(raw)
    const alternatives = this.pool.alternatives(receipt.id)
    this.limited ||= alternatives.limited
    for (const support of alternatives.supports) this.addSupport(receipt.id, support)
  }

  private addSupport(slot: string, support: EvidenceSupport): void {
    const rawById = new Map(support.plan.transactions.map(raw => [raw.txid, raw])),
      needed = this.closure(support.plan.target!, rawById),
      targets = new Map<string, EvidenceSupport>()
    for (const raw of needed) {
      this.charge()
      this.addRaw(raw)
      const proof =
        raw.txid === support.candidate.evidence.txid
          ? support
          : this.pool.materialize(support.basis, support.receipts, {
              txid: raw.txid,
              outputIndex: 0
            })
      const key = keyOf(proof)
      if (!this.proofs.has(key) && this.proofs.size >= this.maximumProofs)
        throw new OutputProtocolError('limited', 'Evidence proof count exhausted')
      this.proofs.set(key, proof)
      targets.set(raw.txid, proof)
    }
    for (const raw of needed) {
      const bundle: Bundle = {
        support: targets.get(raw.txid)!,
        proofs: this.closure(raw, rawById).map(parent => keyOf(targets.get(parent.txid)!))
      }
      this.candidates.get(raw.txid)!.bundles.push(bundle)
      if (raw.txid === support.candidate.evidence.txid) this.slots.get(slot)!.push(bundle)
    }
  }
}

/**
 * Minimum-of-maxima readiness over immutable receipt/context frontiers. Whole-group
 * dependencies use a monotone fixed point, including mutually supporting groups.
 * Every increase is a retained receipt position; worker finishing time is absent.
 */
export function evaluateKnowledgeReadiness(
  pool: EvidencePool,
  plan: EvidenceWorkPlan,
  ledger: VerificationLedger,
  frontiers: readonly EvidenceContextFrontier[],
  through: string,
  options: { maximumWork?: number } = {}
): EvidenceReadiness {
  return new ReadinessEvaluation(pool, plan, ledger, frontiers, through, options).evaluate()
}

interface CandidateReadiness {
  best: bigint
  unfinished: bigint
  invalid: number
  available: number
}

/** One immutable chain/context interval, sharing the evaluation's work budget. */
class ContextReadiness {
  private readonly statusCache = new Map<Bundle, BundleStatus>()
  readonly anchors = new Map<string, bigint>()
  readonly placements = new Map<string, Placement>()

  constructor(
    private readonly plan: EvidenceWorkPlan,
    private readonly ledger: VerificationLedger,
    readonly context: VerificationContext,
    private readonly range: { start: bigint; stop: bigint; never: bigint; last: boolean },
    private readonly charge: () => void
  ) {}

  private status(bundle: Bundle): BundleStatus {
    const cached = this.statusCache.get(bundle)
    if (cached) return cached
    let result: BundleStatus = 'verified'
    for (const key of bundle.proofs) {
      this.charge()
      const check = this.ledger.get(proofReference(this.plan.proofs.get(key)!), this.context.id)
      if (check?.status === 'invalid') {
        result = 'invalid'
        break
      }
      if (check?.status !== 'verified') result = 'pending'
    }
    this.statusCache.set(bundle, result)
    return result
  }

  private at(bundle: Bundle, groups: ReadonlyMap<string, bigint>): bigint {
    let result = maximum(this.range.start, outputU64(bundle.support.availableAt))
    for (const group of bundle.support.groups) {
      this.charge()
      result = maximum(result, groups.get(group) ?? this.range.never)
    }
    return result > this.range.stop ? this.range.never : result
  }

  private slotReadiness(
    slot: string,
    groups: ReadonlyMap<string, bigint>,
    optimistic: boolean
  ): bigint {
    let minimum = this.range.never
    for (const bundle of this.plan.slots.get(slot) ?? []) {
      this.charge()
      const outcome = this.status(bundle)
      if (outcome === 'invalid' || (!optimistic && outcome !== 'verified')) continue
      const value = this.at(bundle, groups)
      if (value < minimum) minimum = value
    }
    return minimum
  }

  private groupAt(
    group: EvidenceGroupRequirement,
    groups: ReadonlyMap<string, bigint>,
    optimistic: boolean
  ): bigint {
    let ready = maximum(this.range.start, outputU64(group.received))
    for (const slot of group.receipts)
      ready = maximum(ready, this.slotReadiness(slot, groups, optimistic))
    return ready
  }

  groupReadiness(optimistic: boolean): Map<string, bigint> {
    let result = new Map(
      this.plan.groups.map(group => [
        group.id,
        group.enabled && outputU64(group.received) <= this.range.stop
          ? outputU64(group.received)
          : this.range.never
      ])
    )
    // All values increase monotonically through this finite set of receipt positions.
    for (let iteration = 0; iteration <= this.plan.groups.length; iteration++) {
      let changed = false
      const next = new Map(result)
      for (const group of this.plan.groups) {
        this.charge()
        if (!group.enabled || result.get(group.id) === this.range.never) continue
        const ready = this.groupAt(group, result, optimistic)
        if (ready !== result.get(group.id)) {
          next.set(group.id, ready)
          changed = true
        }
      }
      result = next
      if (!changed) return result
    }
    throw new OutputProtocolError('limited', 'Group readiness did not converge within its bound')
  }

  candidate(
    txid: string,
    bundles: Bundle[],
    verifiedGroups: ReadonlyMap<string, bigint>,
    possibleGroups: ReadonlyMap<string, bigint>
  ): CandidateReadiness {
    const result: CandidateReadiness = {
      best: this.range.never,
      unfinished: this.range.never,
      invalid: 0,
      available: 0
    }
    for (const bundle of bundles)
      this.includeBundle(txid, bundle, verifiedGroups, possibleGroups, result)
    return result
  }

  private includeBundle(
    txid: string,
    bundle: Bundle,
    verifiedGroups: ReadonlyMap<string, bigint>,
    possibleGroups: ReadonlyMap<string, bigint>,
    result: CandidateReadiness
  ): void {
    this.charge()
    if (outputU64(bundle.support.availableAt) > this.range.stop) return
    result.available++
    const outcome = this.status(bundle),
      possible = this.at(bundle, possibleGroups),
      definite = this.at(bundle, verifiedGroups)
    if (outcome === 'invalid') {
      result.invalid++
      return
    }
    if ((outcome === 'pending' || possible < definite) && possible < result.unfinished)
      result.unfinished = possible
    if (outcome !== 'verified' || definite === this.range.never) return
    if (definite < result.best) result.best = definite
    this.retainPlacement(txid, bundle, definite)
  }

  private retainPlacement(txid: string, bundle: Bundle, definite: bigint): void {
    const check = this.ledger.get(proofReference(bundle.support), this.context.id)
    if (!check?.placement) return
    if (definite < (this.anchors.get(txid) ?? this.range.never)) this.anchors.set(txid, definite)
    if (!this.range.last) return
    const claim = { contextId: this.context.id, ...check.placement },
      prior = this.placements.get(txid)
    if (prior && canonicalOutputJSON(prior) !== canonicalOutputJSON(claim))
      throw new OutputProtocolError(
        'context-changed',
        'One transaction has contradictory selected-chain placement'
      )
    this.placements.set(txid, claim)
  }
}

class ReadinessEvaluation {
  private readonly end: bigint
  private readonly never: bigint
  private readonly bound: number
  private work = 0
  private readonly orders = new Map<string, CandidateOrder>()
  private readonly pending = new Set<string>()
  private readonly historical = new Map<string, Record<string, Validation>>()
  private readonly historicalAt = new Map<string, Record<string, string>>()
  private readonly historicalPending = new Map<string, Record<string, boolean>>()
  private readonly current = new Map<string, Validation>()
  private readonly placement = new Map<string, Placement>()
  private readonly anchors = new Map<string, Map<string, bigint>>()
  private currentGroups = new Map<string, bigint>()
  private readonly depths = new Map<string, number>()
  private readonly visiting = new Set<string>()

  constructor(
    private readonly pool: EvidencePool,
    private readonly plan: EvidenceWorkPlan,
    private readonly ledger: VerificationLedger,
    private readonly frontiers: readonly EvidenceContextFrontier[],
    through: string,
    options: { maximumWork?: number }
  ) {
    this.end = outputU64(through)
    this.never = this.end + 1n
    this.bound = options.maximumWork ?? 1000000
    if (!Number.isSafeInteger(this.bound) || this.bound < 1 || this.bound > 1000000)
      throw new OutputProtocolError('invalid', 'Invalid readiness work bound')
    if (!frontiers.length || frontiers[0].at !== '0')
      throw new OutputProtocolError('reset-required', 'Initial readiness context is unavailable')
    for (let i = 0; i < frontiers.length; i++)
      if (
        outputU64(frontiers[i].at) > this.end ||
        (i && outputU64(frontiers[i].at) <= outputU64(frontiers[i - 1].at))
      )
        throw new OutputProtocolError('invalid', 'Invalid readiness context order')
  }

  private charge(): void {
    if (++this.work > this.bound)
      throw new OutputProtocolError('limited', 'Readiness work exhausted')
  }

  evaluate(): EvidenceReadiness {
    for (let index = 0; index < this.frontiers.length; index++) this.evaluateContext(index)
    const chain = this.frontiers.at(-1)!.context.view.chain
    return {
      groups: new Map(
        [...this.currentGroups]
          .filter(([, at]) => at !== this.never)
          .map(([id, at]) => [id, String(at)])
      ),
      candidates: [...this.plan.candidates]
        .sort(([a], [b]) => compareKnowledgeText(a, b))
        .map(([txid, candidate]) => this.reconcileCandidate(txid, candidate, chain))
    }
  }

  private evaluateContext(index: number): void {
    const { context } = this.frontiers[index],
      start = outputU64(this.frontiers[index].at),
      last = index === this.frontiers.length - 1,
      stop = last ? this.end : outputU64(this.frontiers[index + 1].at) - 1n,
      interval = new ContextReadiness(
        this.plan,
        this.ledger,
        context,
        { start, stop, never: this.never, last },
        () => this.charge()
      )
    const verifiedGroups = interval.groupReadiness(false),
      possibleGroups = interval.groupReadiness(true)
    if (last) this.currentGroups = verifiedGroups
    this.anchors.set(context.id, interval.anchors)
    for (const [txid, candidate] of this.plan.candidates) {
      const readiness = interval.candidate(txid, candidate.bundles, verifiedGroups, possibleGroups)
      this.retainCandidate(txid, context, last, readiness)
      const placement = interval.placements.get(txid)
      if (placement) this.placement.set(txid, placement)
    }
  }

  private validation(readiness: CandidateReadiness): Validation {
    if (readiness.best !== this.never) return 'verified'
    if (readiness.available > 0 && readiness.invalid === readiness.available) return 'invalid'
    return this.plan.limited ? 'limited' : 'unresolved'
  }

  private retainCandidate(
    txid: string,
    context: VerificationContext,
    last: boolean,
    { best, unfinished, invalid, available }: CandidateReadiness
  ): void {
    const validation = this.validation({ best, unfinished, invalid, available })
    const decisions = this.historical.get(txid) ?? {}
    decisions[context.id] = validation
    this.historical.set(txid, decisions)
    if (best !== this.never) {
      const positions = this.historicalAt.get(txid) ?? {}
      positions[context.id] = String(best)
      this.historicalAt.set(txid, positions)
    }
    if (last) this.current.set(txid, validation)
    if (unfinished !== this.never && (best === this.never || unfinished <= best))
      this.pending.add(txid)
    const barriers = this.historicalPending.get(txid) ?? {}
    barriers[context.id] = this.pending.has(txid)
    this.historicalPending.set(txid, barriers)
    if (best !== this.never && !this.orders.has(txid)) {
      const firstRaw = this.requireFirstRaw(context.view.chain, txid)
      this.orders.set(txid, {
        firstRaw,
        readyAt: String(best),
        depth: 0,
        readyContextId: context.id
      })
    }
  }

  private requireFirstRaw(
    chain: VerificationContext['view']['chain'],
    txid: string
  ): NonNullable<ReturnType<EvidencePool['firstRaw']>> {
    const firstRaw = this.pool.firstRaw(chain, txid)
    if (!firstRaw)
      throw new OutputProtocolError(
        'reset-required',
        'Raw transaction ingress position is unavailable'
      )
    return firstRaw
  }

  private isAnchor(txid: string, order: CandidateOrder): boolean {
    return (
      (this.anchors.get(order.readyContextId)?.get(txid) ?? this.never) <= outputU64(order.readyAt)
    )
  }

  private depth(txid: string): number {
    this.charge()
    const prior = this.depths.get(txid)
    if (prior !== undefined) return prior
    if (this.visiting.has(txid))
      throw new OutputProtocolError('invalid', 'Cyclic evidence dependencies')
    const order = this.orders.get(txid)
    if (!order) return 0
    this.visiting.add(txid)
    let result = 0
    if (!this.isAnchor(txid, order))
      for (const input of this.plan.candidates.get(txid)!.raw.inputs) {
        const parent = this.orders.get(input.txid)
        if (parent?.readyAt === order.readyAt && !this.isAnchor(input.txid, order))
          result = Math.max(result, 1 + this.depth(input.txid))
      }
    this.visiting.delete(txid)
    this.depths.set(txid, result)
    return result
  }

  private reconcileCandidate(
    txid: string,
    candidate: EvidenceCandidateBundles,
    chain: VerificationContext['view']['chain']
  ): ReconciliationCandidate {
    const firstRaw = this.requireFirstRaw(chain, txid),
      order = this.orders.get(txid),
      selectedPlacement = this.placement.get(txid)
    return {
      txid,
      rawTransaction: candidate.raw.rawTransaction,
      evidenceIds: [
        ...new Set(candidate.bundles.map(bundle => bundle.support.candidate.variantId))
      ].sort(compareKnowledgeText),
      firstRaw,
      ...(order ? { order: { ...order, depth: this.depth(txid) } } : {}),
      validation: this.current.get(txid) ?? 'unresolved',
      historicalValidation: this.historical.get(txid) ?? {},
      historicalSupportAt: this.historicalAt.get(txid) ?? {},
      historicalPending: this.historicalPending.get(txid) ?? {},
      historicalAnchors: Object.fromEntries(
        [...this.anchors].flatMap(([contextId, values]) => {
          const at = values.get(txid)
          return at === undefined ? [] : [[contextId, String(at)]]
        })
      ),
      pendingSupport: this.pending.has(txid),
      ...(selectedPlacement ? { placement: selectedPlacement } : {})
    }
  }
}
