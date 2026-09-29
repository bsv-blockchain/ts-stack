import {
  Beef,
  Hash,
  Utils,
  canonicalOutputJSON,
  decodeOutputBytes,
  outputU64,
  OutputProtocolError
} from '@bsv/sdk'
import {
  assembleOutputEvidence,
  type EvidenceAssemblyLimits,
  type EvidencePlan
} from './EvidenceAssembler.js'
import { compareKnowledgeText } from './SourceMembership.js'
import type { EvidenceCandidate, IngressPosition, OutputChain, OutputEvidence } from './ports.js'

export interface EvidenceReceipt {
  /** Stable local identity of an observation's evidence slot, never an arrival time. */
  id: string
  group: string
  received: string
  chain: OutputChain
  evidence: OutputEvidence
}
export interface EvidenceSupport {
  basis: string
  candidate: EvidenceCandidate
  /** Exact receipts and indivisible groups whose integrity remains a prerequisite. */
  receipts: string[]
  groups: string[]
  availableAt: string
  plan: EvidencePlan
}
export interface EvidenceAlternatives {
  supports: EvidenceSupport[]
  missing: import('@bsv/sdk').OutputOutpoint[]
  complete: boolean
  /** Exhausted search is not evidence of invalidity or absence. */
  limited: boolean
}
export interface EvidencePoolLimits extends EvidenceAssemblyLimits {
  retainedBytes: number
  receipts: number
  searchStates: number
  supportReceipts: number
}
const defaults: Readonly<EvidencePoolLimits> = Object.freeze({
  bytes: 4194304,
  transactions: 4096,
  dependencies: 16384,
  retainedBytes: 16 * 1024 * 1024,
  receipts: 4096,
  searchStates: 256,
  supportReceipts: 32
})
interface Row {
  receipt: EvidenceReceipt
  plan: EvidencePlan
  bytes: number[]
}
interface Search {
  plan: EvidencePlan
  bytes: number[]
  rows: Row[]
}
interface SearchProgress {
  queue: Search[]
  seen: Set<string>
  supports: EvidenceSupport[]
  supportBodies: Set<string>
  missing: Map<string, import('@bsv/sdk').OutputOutpoint>
  limited: boolean
}
const clone = <T>(value: T): T => structuredClone(value)
const receivedThrough = (rows: readonly Row[]): bigint => {
  let maximum = 0n
  for (const row of rows) {
    const received = outputU64(row.receipt.received)
    if (received > maximum) maximum = received
  }
  return maximum
}
const compareSearch = (a: Search, b: Search): number => {
  const left = receivedThrough(a.rows),
    right = receivedThrough(b.rows)
  if (left < right) return -1
  if (left > right) return 1
  return compareKnowledgeText(
    JSON.stringify(a.rows.map(row => row.receipt.id)),
    JSON.stringify(b.rows.map(row => row.receipt.id))
  )
}

/**
 * Bounded cross-receipt dependency planning. Every alternative is still untrusted
 * and must pass EvidenceVerifier and all referenced source-group prerequisites.
 * No merge mutates another alternative or the original received bytes.
 */
export class EvidencePool {
  private readonly rows = new Map<string, Row>()
  private readonly fingerprints = new Map<string, string>()
  private readonly first = new Map<string, IngressPosition>()
  private retained = 0
  private lastReceived = '0'
  private readonly limits: Readonly<EvidencePoolLimits>

  constructor(
    readonly journalId: string,
    options: Partial<EvidencePoolLimits> = {}
  ) {
    this.limits = Object.freeze({ ...defaults, ...options })
    if (typeof journalId !== 'string' || !journalId)
      throw new OutputProtocolError('invalid', 'Journal identity is required')
    for (const [key, value] of Object.entries(this.limits))
      if (
        !Object.hasOwn(defaults, key) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > defaults[key as keyof EvidencePoolLimits]
      )
        throw new OutputProtocolError('invalid', 'Invalid evidence pool limit')
  }

  /** Supply all evidence slots of one receive mutation together for canonical indexes. */
  receive(
    received: string,
    receipts: readonly EvidenceReceipt[]
  ): { rejected: { id: string; code: string }[] } {
    if (outputU64(received) <= outputU64(this.lastReceived))
      throw new OutputProtocolError('invalid', 'Evidence receipts must replay in journal order')
    const { added, rejected, fingerprints, bytes } = this.stageReceipts(received, receipts)
    if (
      this.fingerprints.size + fingerprints.size > this.limits.receipts ||
      this.retained + bytes > this.limits.retainedBytes
    )
      throw new OutputProtocolError('limited', 'Evidence pool retention exhausted')
    const first = new Map<string, string>()
    for (const row of added)
      for (const tx of row.plan.transactions) {
        const key = canonicalOutputJSON({ chain: row.receipt.chain, txid: tx.txid })
        if (!this.first.has(key)) first.set(key, tx.txid)
      }
    const sorted = [...first].sort(
      (a, b) => compareKnowledgeText(a[1], b[1]) || compareKnowledgeText(a[0], b[0])
    )
    sorted.forEach(([key], index) => {
      if (!this.first.has(key))
        this.first.set(key, { journalId: this.journalId, position: received, index })
    })
    for (const row of added) this.rows.set(row.receipt.id, row)
    for (const [id, fingerprint] of fingerprints) this.fingerprints.set(id, fingerprint)
    this.retained += bytes
    this.lastReceived = received
    return { rejected }
  }

  private stageReceipts(
    received: string,
    receipts: readonly EvidenceReceipt[]
  ): {
    added: Row[]
    rejected: { id: string; code: string }[]
    fingerprints: Map<string, string>
    bytes: number
  } {
    const added: Row[] = [],
      rejected: { id: string; code: string }[] = []
    let bytes = 0
    const fingerprints = new Map<string, string>()
    const ids = new Set<string>()
    for (const input of receipts) {
      if (input.received !== received || !input.id || !input.group || ids.has(input.id))
        throw new OutputProtocolError('invalid', 'Inconsistent evidence receipt identity')
      ids.add(input.id)
      const text = canonicalOutputJSON(input)
      const receipt = JSON.parse(text) as EvidenceReceipt
      const { received: _received, ...identity } = receipt
      const fingerprint = Utils.toHex(
        Hash.sha256(Utils.toArray(canonicalOutputJSON(identity), 'utf8'))
      )
      const prior = this.fingerprints.get(input.id)
      if (prior !== undefined) {
        if (prior !== fingerprint)
          throw new OutputProtocolError('equivocation', 'Evidence receipt identity changed')
        continue
      }
      fingerprints.set(receipt.id, fingerprint)
      bytes += new TextEncoder().encode(text).length
      try {
        const plan = assembleOutputEvidence(receipt.evidence, receipt.chain, this.assemblyLimits())
        const binary = decodeOutputBytes(receipt.evidence.beef, this.limits.bytes)
        added.push({ receipt, plan, bytes: binary })
      } catch (error) {
        rejected.push({
          id: input.id,
          code: error instanceof OutputProtocolError ? error.code : 'invalid'
        })
      }
    }
    return { added, rejected, fingerprints, bytes }
  }

  private assemblyLimits(): EvidenceAssemblyLimits {
    return {
      bytes: this.limits.bytes,
      transactions: this.limits.transactions,
      dependencies: this.limits.dependencies
    }
  }

  firstRaw(chain: OutputChain, txid: string): IngressPosition | undefined {
    const result = this.first.get(canonicalOutputJSON({ chain, txid }))
    return result ? { ...result } : undefined
  }

  /** Owned retained receipts and parsed raw facts; no validity is implied. */
  entries(): { receipt: EvidenceReceipt; plan: EvidencePlan }[] {
    return clone([...this.rows.values()].map(({ receipt, plan }) => ({ receipt, plan })))
  }

  alternatives(
    id: string,
    options: { through?: string; allowedGroups?: ReadonlySet<string> } = {}
  ): EvidenceAlternatives {
    const initial = this.rows.get(id)
    if (!initial) throw new OutputProtocolError('invalid', 'Unknown evidence receipt')
    const through = options.through ?? this.lastReceived
    outputU64(through)
    const allowed = (row: Row): boolean =>
      outputU64(row.receipt.received) <= outputU64(through) &&
      (options.allowedGroups === undefined || options.allowedGroups.has(row.receipt.group))
    if (!allowed(initial))
      return { supports: [], missing: clone(initial.plan.missing), complete: false, limited: false }
    const chain = canonicalOutputJSON(initial.receipt.chain)
    const candidates = [...this.rows.values()].filter(
      row => allowed(row) && canonicalOutputJSON(row.receipt.chain) === chain
    )
    const progress: SearchProgress = {
      queue: [{ plan: initial.plan, bytes: initial.bytes, rows: [initial] }],
      supports: [],
      seen: new Set([JSON.stringify([initial.receipt.id])]),
      supportBodies: new Set(),
      missing: new Map(),
      limited: false
    }
    let work = 0
    while (progress.queue.length) {
      if (++work > this.limits.searchStates) {
        progress.limited = true
        break
      }
      progress.queue.sort(compareSearch)
      const current = progress.queue.shift()!
      if (current.plan.atomicBeef) this.retainSupport(initial, current, progress)
      else this.expandSearch(initial, current, candidates, progress)
    }
    return {
      supports: progress.supports,
      missing: progress.supports.length ? [] : [...progress.missing.values()],
      complete: progress.supports.length > 0,
      limited: progress.limited
    }
  }

  private retainSupport(initial: Row, current: Search, progress: SearchProgress): void {
    // Preserve the original variant when it is already independently complete.
    const binary = current.rows.length === 1 ? initial.bytes : current.plan.atomicBeef!
    const variantId = Utils.toHex(Hash.sha256(binary)),
      receipts = current.rows.map(row => row.receipt.id).sort(compareKnowledgeText)
    const key = JSON.stringify({ variantId, receipts })
    if (progress.supportBodies.has(key)) return
    progress.supportBodies.add(key)
    progress.supports.push({
      basis: initial.receipt.id,
      candidate: {
        chain: clone(initial.receipt.chain),
        evidence: { ...initial.receipt.evidence, beef: Utils.toBase64(binary) },
        variantId
      },
      receipts,
      groups: [...new Set(current.rows.map(row => row.receipt.group))].sort(compareKnowledgeText),
      availableAt: String(receivedThrough(current.rows)),
      plan: clone(current.plan)
    })
  }

  private expandSearch(
    initial: Row,
    current: Search,
    candidates: Row[],
    progress: SearchProgress
  ): void {
    const needed = current.plan.missing[0]
    if (!needed) return
    progress.missing.set(canonicalOutputJSON(needed), needed)
    if (current.rows.length >= this.limits.supportReceipts) {
      progress.limited = true
      return
    }
    for (const next of candidates) {
      if (
        current.rows.includes(next) ||
        !next.plan.transactions.some(tx => tx.txid === needed.txid)
      )
        continue
      const rows = [...current.rows, next].sort((a, b) =>
        compareKnowledgeText(a.receipt.id, b.receipt.id)
      )
      const key = JSON.stringify(rows.map(row => row.receipt.id))
      if (progress.seen.has(key)) continue
      if (progress.seen.size >= this.limits.searchStates) {
        progress.limited = true
        break
      }
      progress.seen.add(key)
      this.mergeAlternative(initial, rows, progress)
    }
  }

  private mergeAlternative(initial: Row, rows: Row[], progress: SearchProgress): void {
    try {
      const combined = Beef.fromBinaryStrict(initial.bytes)
      for (const dependency of rows)
        if (dependency !== initial) combined.mergeBeef(dependency.bytes)
      const bytes = combined.toBinary()
      const evidence = { ...initial.receipt.evidence, beef: Utils.toBase64(bytes) }
      const plan = assembleOutputEvidence(evidence, initial.receipt.chain, this.assemblyLimits())
      progress.queue.push({ plan, bytes, rows })
    } catch (error) {
      // An incompatible proof affects only this alternative. Retention/work
      // limits remain observable; they cannot turn into a negative verdict.
      if (error instanceof OutputProtocolError && error.code === 'limited') progress.limited = true
    }
  }

  /** Reconstruct a retained proof reference exactly, without copying BEEF into local metadata. */
  materialize(
    basis: string,
    receiptIds: readonly string[],
    target?: Pick<OutputEvidence, 'txid' | 'outputIndex'>
  ): EvidenceSupport {
    const initial = this.rows.get(basis)
    if (!initial || !receiptIds.includes(basis))
      throw new OutputProtocolError('reset-required', 'Original evidence receipt is unavailable')
    if (
      !receiptIds.length ||
      receiptIds.length > this.limits.supportReceipts ||
      new Set(receiptIds).size !== receiptIds.length
    )
      throw new OutputProtocolError('invalid', 'Invalid proof receipt set')
    const receipts = [...receiptIds].sort(compareKnowledgeText),
      rows = this.supportRows(initial, receipts)
    const selected = target ?? initial.receipt.evidence
    const sameSubject = selected.txid === initial.receipt.evidence.txid
    let binary = initial.bytes
    if (rows.length > 1 || !sameSubject) {
      const beef = Beef.fromBinaryStrict(initial.bytes)
      for (const row of rows) if (row !== initial) beef.mergeBeef(row.bytes)
      try {
        binary = beef.toBinaryAtomic(selected.txid)
      } catch {
        throw new OutputProtocolError('reset-required', 'Retained proof cannot be reconstructed')
      }
    }
    const evidence: OutputEvidence = {
      txid: selected.txid,
      outputIndex: selected.outputIndex,
      beef: Utils.toBase64(binary)
    }
    const plan = assembleOutputEvidence(evidence, initial.receipt.chain, this.assemblyLimits())
    if (!plan.atomicBeef)
      throw new OutputProtocolError('reset-required', 'Retained proof is incomplete')
    return {
      basis,
      receipts,
      groups: [...new Set(rows.map(row => row.receipt.group))].sort(compareKnowledgeText),
      availableAt: String(receivedThrough(rows)),
      candidate: {
        chain: clone(initial.receipt.chain),
        evidence,
        variantId: Utils.toHex(Hash.sha256(binary))
      },
      plan
    }
  }
  private supportRows(initial: Row, receipts: readonly string[]): Row[] {
    const chain = canonicalOutputJSON(initial.receipt.chain)
    return receipts.map(id => {
      const row = this.rows.get(id)
      if (!row) throw new OutputProtocolError('reset-required', 'Supporting receipt is unavailable')
      if (canonicalOutputJSON(row.receipt.chain) !== chain)
        throw new OutputProtocolError('invalid', 'Proof receipts cross configured chains')
      return row
    })
  }
}
