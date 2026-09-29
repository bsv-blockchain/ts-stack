import { canonicalOutputJSON, outputU64, OutputProtocolError } from '@bsv/sdk'
import type { AssembledRawTransaction } from './EvidenceAssembler.js'
import { EvidencePool, type EvidenceSupport } from './EvidencePool.js'
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
export interface EvidenceWorkPlan {
  groups: EvidenceGroupRequirement[]
  slots: Map<string, Bundle[]>
  candidates: Map<string, { raw: AssembledRawTransaction; bundles: Bundle[] }>
  proofs: Map<string, EvidenceSupport>
  limited: boolean
}
export interface EvidenceReadiness {
  candidates: ReconciliationCandidate[]
  /** Earliest whole-group cryptographic readiness in the current context. */
  groups: Map<string, string>
}
const keyOf = (support: EvidenceSupport): string => proofReferenceKey(proofReference(support))
const maximum = (...values: bigint[]): bigint => values.reduce((a, b) => (a > b ? a : b), 0n)

/** Bounded local plan. No planning operation declares validity or assigns completion order. */
export function planKnowledgeEvidence(
  pool: EvidencePool,
  groups: readonly EvidenceGroupRequirement[],
  options: { maximumWork?: number; maximumProofs?: number } = {}
): EvidenceWorkPlan {
  const maximumWork = options.maximumWork ?? 1000000,
    maximumProofs = options.maximumProofs ?? 4096
  for (const [value, bound] of [
    [maximumWork, 1000000],
    [maximumProofs, 4096]
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > bound)
      throw new OutputProtocolError('invalid', 'Invalid evidence planning bound')
  let work = 0
  const charge = (): void => {
    if (++work > maximumWork)
      throw new OutputProtocolError('limited', 'Evidence planning work exhausted')
  }
  const groupIds = new Set(groups.map(group => group.id)),
    slots = new Map<string, Bundle[]>(),
    proofs = new Map<string, EvidenceSupport>(),
    candidates: EvidenceWorkPlan['candidates'] = new Map()
  if (groupIds.size !== groups.length || groups.length > 4096)
    throw new OutputProtocolError('invalid', 'Duplicate or excessive evidence groups')
  const receiptIds = new Set<string>()
  for (const group of groups) {
    outputU64(group.received)
    for (const id of group.receipts) {
      if (receiptIds.has(id))
        throw new OutputProtocolError('invalid', 'Evidence slot belongs to multiple groups')
      receiptIds.add(id)
      slots.set(id, [])
    }
  }
  const rows = pool.entries(),
    known = new Set(rows.map(row => row.receipt.id))
  let limited = false
  const addRaw = (raw: AssembledRawTransaction): void => {
    const prior = candidates.get(raw.txid)
    if (prior && prior.raw.rawTransaction !== raw.rawTransaction)
      throw new OutputProtocolError('equivocation', 'Raw transaction identity changed')
    if (!prior) candidates.set(raw.txid, { raw, bundles: [] })
  }
  const closure = (
    raw: AssembledRawTransaction,
    rows: Map<string, AssembledRawTransaction>
  ): AssembledRawTransaction[] => {
    const found = new Map<string, AssembledRawTransaction>(),
      pending = [raw]
    while (pending.length) {
      charge()
      const next = pending.pop()!
      if (found.has(next.txid)) continue
      found.set(next.txid, next)
      if (next.merkleRoot !== undefined) continue
      for (const input of next.inputs) {
        charge()
        const parent = rows.get(input.txid)
        if (parent) pending.push(parent)
      }
    }
    return [...found.values()].sort((a, b) => compareKnowledgeText(a.txid, b.txid))
  }
  for (const { receipt, plan } of rows) {
    charge()
    if (!receiptIds.has(receipt.id) || !groupIds.has(receipt.group))
      throw new OutputProtocolError('invalid', 'Evidence receipt has no source group')
    if (plan.target)
      for (const raw of closure(
        plan.target,
        new Map(plan.transactions.map(raw => [raw.txid, raw]))
      ))
        addRaw(raw)
    const alternatives = pool.alternatives(receipt.id)
    limited ||= alternatives.limited
    for (const support of alternatives.supports) {
      const rawById = new Map(support.plan.transactions.map(raw => [raw.txid, raw])),
        needed = closure(support.plan.target!, rawById),
        targets = new Map<string, EvidenceSupport>()
      for (const raw of needed) {
        charge()
        addRaw(raw)
        const proof =
          raw.txid === support.candidate.evidence.txid
            ? support
            : pool.materialize(support.basis, support.receipts, { txid: raw.txid, outputIndex: 0 })
        const key = keyOf(proof)
        if (!proofs.has(key) && proofs.size >= maximumProofs)
          throw new OutputProtocolError('limited', 'Evidence proof count exhausted')
        proofs.set(key, proof)
        targets.set(raw.txid, proof)
      }
      for (const raw of needed) {
        const derived = targets.get(raw.txid)!,
          bundle = {
            support: derived,
            proofs: closure(raw, rawById).map(parent => keyOf(targets.get(parent.txid)!))
          }
        candidates.get(raw.txid)!.bundles.push(bundle)
        if (raw.txid === support.candidate.evidence.txid) slots.get(receipt.id)!.push(bundle)
      }
    }
  }
  // Malformed/txid-only slots remain requirements, so their valid siblings cannot leak.
  for (const id of receiptIds) if (!known.has(id)) slots.set(id, [])
  return {
    groups: JSON.parse(canonicalOutputJSON(groups)) as EvidenceGroupRequirement[],
    slots,
    candidates,
    proofs,
    limited
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
  const end = outputU64(through),
    bound = options.maximumWork ?? 1000000
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 1000000)
    throw new OutputProtocolError('invalid', 'Invalid readiness work bound')
  if (!frontiers.length || frontiers[0].at !== '0')
    throw new OutputProtocolError('reset-required', 'Initial readiness context is unavailable')
  for (let i = 0; i < frontiers.length; i++)
    if (
      outputU64(frontiers[i].at) > end ||
      (i && outputU64(frontiers[i].at) <= outputU64(frontiers[i - 1].at))
    )
      throw new OutputProtocolError('invalid', 'Invalid readiness context order')
  let work = 0
  const charge = (): void => {
    if (++work > bound) throw new OutputProtocolError('limited', 'Readiness work exhausted')
  }
  const never = end + 1n,
    orders = new Map<string, CandidateOrder>(),
    pending = new Set<string>(),
    historical = new Map<string, Record<string, ReconciliationCandidate['validation']>>(),
    historicalAt = new Map<string, Record<string, string>>(),
    historicalPending = new Map<string, Record<string, boolean>>(),
    current = new Map<string, ReconciliationCandidate['validation']>(),
    placement = new Map<string, NonNullable<ReconciliationCandidate['placement']>>(),
    anchors = new Map<string, Map<string, bigint>>()
  let currentGroups = new Map<string, bigint>()
  for (let index = 0; index < frontiers.length; index++) {
    const { context } = frontiers[index],
      start = outputU64(frontiers[index].at),
      last = index === frontiers.length - 1,
      stop = last ? end : outputU64(frontiers[index + 1].at) - 1n,
      statusCache = new Map<Bundle, 'verified' | 'invalid' | 'pending'>()
    const status = (bundle: Bundle): 'verified' | 'invalid' | 'pending' => {
      const cached = statusCache.get(bundle)
      if (cached) return cached
      let result: 'verified' | 'invalid' | 'pending' = 'verified'
      for (const key of bundle.proofs) {
        charge()
        const check = ledger.get(proofReference(plan.proofs.get(key)!), context.id)
        if (check?.status === 'invalid') {
          result = 'invalid'
          break
        }
        if (check?.status !== 'verified') result = 'pending'
      }
      statusCache.set(bundle, result)
      return result
    }
    const at = (bundle: Bundle, groups: ReadonlyMap<string, bigint>): bigint => {
      let result = maximum(start, outputU64(bundle.support.availableAt))
      for (const group of bundle.support.groups) {
        charge()
        result = maximum(result, groups.get(group) ?? never)
      }
      return result > stop ? never : result
    }
    const groupReadiness = (optimistic: boolean): Map<string, bigint> => {
      let result = new Map(
        plan.groups.map(group => [
          group.id,
          group.enabled && outputU64(group.received) <= stop ? outputU64(group.received) : never
        ])
      )
      // All values increase monotonically through this finite set of receipt positions.
      for (let iteration = 0; iteration <= plan.groups.length; iteration++) {
        let changed = false
        const next = new Map(result)
        for (const group of plan.groups) {
          charge()
          if (!group.enabled || result.get(group.id) === never) continue
          let ready = maximum(start, outputU64(group.received))
          for (const slot of group.receipts) {
            let minimum = never
            for (const bundle of plan.slots.get(slot) ?? []) {
              charge()
              const outcome = status(bundle)
              if (outcome === 'invalid' || (!optimistic && outcome !== 'verified')) continue
              const value = at(bundle, result)
              if (value < minimum) minimum = value
            }
            ready = maximum(ready, minimum)
          }
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
    const verifiedGroups = groupReadiness(false),
      possibleGroups = groupReadiness(true)
    if (last) currentGroups = verifiedGroups
    const contextAnchors = new Map<string, bigint>()
    anchors.set(context.id, contextAnchors)
    for (const [txid, candidate] of plan.candidates) {
      let best = never,
        unfinished = never,
        invalid = 0,
        available = 0
      for (const bundle of candidate.bundles) {
        charge()
        if (outputU64(bundle.support.availableAt) > stop) continue
        available++
        const outcome = status(bundle),
          possible = at(bundle, possibleGroups),
          definite = at(bundle, verifiedGroups)
        if (outcome === 'invalid') {
          invalid++
          continue
        }
        if (outcome === 'pending' || possible < definite) {
          if (possible < unfinished) unfinished = possible
        }
        if (outcome !== 'verified' || definite === never) continue
        if (definite < best) best = definite
        const check = ledger.get(proofReference(bundle.support), context.id)
        if (check?.placement) {
          if (definite < (contextAnchors.get(txid) ?? never)) contextAnchors.set(txid, definite)
          if (last) {
            const claim = { contextId: context.id, ...check.placement },
              prior = placement.get(txid)
            if (prior && canonicalOutputJSON(prior) !== canonicalOutputJSON(claim))
              throw new OutputProtocolError(
                'context-changed',
                'One transaction has contradictory selected-chain placement'
              )
            placement.set(txid, claim)
          }
        }
      }
      const validation: ReconciliationCandidate['validation'] =
        best !== never
          ? 'verified'
          : available > 0 && invalid === available
            ? 'invalid'
            : plan.limited
              ? 'limited'
              : 'unresolved'
      const decisions = historical.get(txid) ?? {}
      decisions[context.id] = validation
      historical.set(txid, decisions)
      if (best !== never) {
        const positions = historicalAt.get(txid) ?? {}
        positions[context.id] = String(best)
        historicalAt.set(txid, positions)
      }
      if (last) current.set(txid, validation)
      if (unfinished !== never && (best === never || unfinished <= best)) pending.add(txid)
      const barriers = historicalPending.get(txid) ?? {}
      barriers[context.id] = pending.has(txid)
      historicalPending.set(txid, barriers)
      if (best !== never && !orders.has(txid)) {
        const firstRaw = pool.firstRaw(context.view.chain, txid)
        if (!firstRaw)
          throw new OutputProtocolError(
            'reset-required',
            'Raw transaction ingress position is unavailable'
          )
        orders.set(txid, { firstRaw, readyAt: String(best), depth: 0, readyContextId: context.id })
      }
    }
  }
  const depths = new Map<string, number>(),
    visiting = new Set<string>()
  const depth = (txid: string): number => {
    charge()
    const prior = depths.get(txid)
    if (prior !== undefined) return prior
    if (visiting.has(txid)) throw new OutputProtocolError('invalid', 'Cyclic evidence dependencies')
    const order = orders.get(txid)
    if (!order) return 0
    visiting.add(txid)
    let result = 0
    const isAnchor = (id: string): boolean =>
      (anchors.get(order.readyContextId)?.get(id) ?? never) <= outputU64(order.readyAt)
    if (!isAnchor(txid))
      for (const input of plan.candidates.get(txid)!.raw.inputs) {
        const parent = orders.get(input.txid)
        if (parent?.readyAt === order.readyAt && !isAnchor(input.txid))
          result = Math.max(result, 1 + depth(input.txid))
      }
    visiting.delete(txid)
    depths.set(txid, result)
    return result
  }
  const chain = frontiers.at(-1)!.context.view.chain
  return {
    groups: new Map(
      [...currentGroups].filter(([, at]) => at !== never).map(([id, at]) => [id, String(at)])
    ),
    candidates: [...plan.candidates]
      .sort(([a], [b]) => compareKnowledgeText(a, b))
      .map(([txid, candidate]) => {
        const firstRaw = pool.firstRaw(chain, txid)
        if (!firstRaw)
          throw new OutputProtocolError(
            'reset-required',
            'Raw transaction ingress position is unavailable'
          )
        const order = orders.get(txid),
          selectedPlacement = placement.get(txid)
        return {
          txid,
          rawTransaction: candidate.raw.rawTransaction,
          evidenceIds: [
            ...new Set(candidate.bundles.map(bundle => bundle.support.candidate.variantId))
          ].sort(),
          firstRaw,
          ...(order ? { order: { ...order, depth: depth(txid) } } : {}),
          validation: current.get(txid) ?? 'unresolved',
          historicalValidation: historical.get(txid) ?? {},
          historicalSupportAt: historicalAt.get(txid) ?? {},
          historicalPending: historicalPending.get(txid) ?? {},
          historicalAnchors: Object.fromEntries(
            [...anchors].flatMap(([contextId, values]) => {
              const at = values.get(txid)
              return at === undefined ? [] : [[contextId, String(at)]]
            })
          ),
          pendingSupport: pending.has(txid),
          ...(selectedPlacement ? { placement: selectedPlacement } : {})
        }
      })
  }
}
