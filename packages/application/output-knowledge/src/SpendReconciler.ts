import {
  Transaction,
  decodeOutputBytes,
  outputHex32,
  outputU32,
  outputU64,
  OutputProtocolError,
  canonicalOutputJSON
} from '@bsv/sdk'
import { compareKnowledgeText } from './SourceMembership.js'
import type {
  CandidateOrder,
  ChainView,
  IngressPosition,
  ReconciledState,
  ReconciledTransaction,
  SourceMembership,
  VerificationContext
} from './ports.js'

/** Local assembler output, never a source-supplied verification assertion. */
export interface ReconciliationCandidate {
  txid: string
  rawTransaction: string
  evidenceIds: string[]
  firstRaw: IngressPosition
  order?: CandidateOrder
  validation: 'verified' | 'invalid' | 'unresolved' | 'limited' | 'unsupported'
  /** Retained per-context crypto decisions; a missing entry is unresolved. */
  historicalValidation?: Record<string, ReconciliationCandidate['validation']>
  /** First sufficient receipt frontier for each immutable verification context. */
  historicalSupportAt?: Record<string, string>
  /** Barriers active by a historical context; later work cannot erase prior replacements. */
  historicalPending?: Record<string, boolean>
  /** Verified anchor support available in each retained context, without backdating. */
  historicalAnchors?: Record<string, string>
  /** An earlier potentially sufficient support set still awaiting verification. */
  pendingSupport: boolean
  /** Supplied only after verification against the selected immutable chain view. */
  placement?: { contextId: string; blockHash: string; height: string }
}
export type ReconciliationContext = Pick<VerificationContext, 'id' | 'view'>
export interface ReconciliationFrontier {
  at: string
  context: ReconciliationContext
}
export interface ReconciliationRequest {
  journalId: string
  through: string
  context: ReconciliationContext
  contexts: ReconciliationFrontier[]
  nonFinal: boolean
  candidates: ReconciliationCandidate[]
  memberships: SourceMembership[]
  maximumWork?: number
}

interface Node {
  candidate: ReconciliationCandidate
  transaction: Transaction
  inputs: string[]
  parents: string[]
  anchor: boolean
}
interface Eligible {
  at: string
  contextId: string
}
type Replacement = ReconciledState['replacements'][number]
const compareInteger = (a: string, b: string): number => {
  const left = outputU64(a),
    right = outputU64(b)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const compareText = compareKnowledgeText

/** Pinned post-Genesis strict locktime boundary, not wall-clock freshness. */
export function isOutputTransactionFinal(
  transaction: Transaction,
  view: Pick<ChainView, 'tipHeight' | 'medianTimePast'>
): boolean {
  const lockTime = outputU32(transaction.lockTime)
  const sequences = transaction.inputs.map(input => outputU32(input.sequence ?? 0xffffffff))
  return (
    lockTime === 0 ||
    sequences.every(sequence => sequence === 0xffffffff) ||
    BigInt(lockTime) <
      (lockTime < 500000000 ? outputU64(view.tipHeight) + 1n : outputU64(view.medianTimePast))
  )
}

function inputVector(transaction: Transaction): string[] {
  return transaction.inputs.map(
    input => `${outputHex32(input.sourceTXID)}:${outputU32(input.sourceOutputIndex)}`
  )
}

/** Pairwise sequences, identical ordered inputs and a still non-final predecessor. */
export function canReplaceOutputTransaction(
  previous: Transaction,
  next: Transaction,
  view: Pick<ChainView, 'tipHeight' | 'medianTimePast'>
): boolean {
  if (isOutputTransactionFinal(previous, view)) return false
  const a = inputVector(previous),
    b = inputVector(next)
  if (a.length !== b.length || a.some((input, index) => input !== b[index])) return false
  let increased = false
  for (let i = 0; i < a.length; i++) {
    const oldSequence = outputU32(previous.inputs[i].sequence ?? 0xffffffff)
    const newSequence = outputU32(next.inputs[i].sequence ?? 0xffffffff)
    if (newSequence < oldSequence) return false
    increased ||= newSequence > oldSequence
  }
  return increased
}

function compareOrder(a: Node, b: Node): number {
  const x = a.candidate.order,
    y = b.candidate.order
  if (!x && !y) return compareText(a.candidate.txid, b.candidate.txid)
  if (!x) return 1
  if (!y) return -1
  return (
    compareInteger(x.readyAt, y.readyAt) ||
    x.depth - y.depth ||
    compareInteger(x.firstRaw.position, y.firstRaw.position) ||
    x.firstRaw.index - y.firstRaw.index ||
    compareText(a.candidate.txid, b.candidate.txid)
  )
}

/**
 * Deterministic BRC-192 selection over locally verified and journal-ordered work.
 * It does not validate Script, accept provider claims of inclusion or perform
 * wallet actions. The knowledge store supplies only its own assembler results.
 */
export function reconcileOutputSpends(request: ReconciliationRequest): ReconciledState {
  return new SpendSelection(request).run()
}

class SpendSelection {
  private readonly nodes = new Map<string, Node>()
  private readonly sorted: Node[]
  private readonly pending = new Set<string>()
  private readonly components: string[][] = []
  private readonly componentByTx = new Map<string, string[]>()
  private readonly selected = new Set<string>()
  private readonly forced = new Set<string>()
  private readonly reservations = new Map<string, string>()
  private readonly historicalConflicts = new Set<string>()
  private readonly eligible = new Map<string, Eligible>()
  private readonly replacements: Replacement[] = []
  private readonly replaced = new Set<string>()
  private readonly previous = new Map<string, string>()
  private readonly rows = new Map<string, ReconciledTransaction>()
  private readonly contexts: ReconciliationFrontier[]
  private work = 0
  private readonly maximumWork: number

  constructor(private readonly request: ReconciliationRequest) {
    this.maximumWork = request.maximumWork ?? 1_000_000
    if (
      !Number.isSafeInteger(this.maximumWork) ||
      this.maximumWork < 1 ||
      this.maximumWork > 10_000_000
    )
      throw new OutputProtocolError('invalid', 'Invalid reconciliation work bound')
    if (request.candidates.length > 4096 || request.contexts.length > 4096)
      throw new OutputProtocolError('limited', 'Reconciliation history bound')
    outputU64(request.through)
    this.contexts = [...request.contexts].sort((a, b) => compareInteger(a.at, b.at))
    this.validateContexts()
    for (const candidate of request.candidates) this.add(candidate)
    this.sorted = [...this.nodes.values()].sort(compareOrder)
    this.findForcedAncestors()
  }

  private findForcedAncestors(): void {
    const pending = this.sorted.filter(node => node.anchor)
    while (pending.length) {
      this.charge()
      const node = pending.pop()!
      if (this.forced.has(node.candidate.txid)) continue
      if (node.candidate.validation !== 'verified')
        throw new OutputProtocolError(
          'context-changed',
          'Selected chain ancestor has not been validated'
        )
      this.forced.add(node.candidate.txid)
      for (const parent of node.parents) {
        const known = this.nodes.get(parent)
        if (known && !this.forced.has(parent)) pending.push(known)
      }
    }
  }

  private charge(amount = 1): void {
    this.work += amount
    if (this.work > this.maximumWork)
      throw new OutputProtocolError('limited', 'Reconciliation work exhausted')
  }

  private validateContexts(): void {
    if (this.contexts.length === 0 || this.contexts[0].at !== '0')
      throw new OutputProtocolError('reset-required', 'Initial chain context is unavailable')
    const identities = new Map<string, string>()
    for (let i = 0; i < this.contexts.length; i++) {
      const frontier = this.contexts[i]
      const bytes = canonicalOutputJSON(frontier.context)
      if (
        (i > 0 && compareInteger(frontier.at, this.contexts[i - 1].at) <= 0) ||
        compareInteger(frontier.at, this.request.through) > 0
      )
        throw new OutputProtocolError('invalid', 'Invalid context journal order')
      if (
        canonicalOutputJSON(frontier.context.view.chain) !==
        canonicalOutputJSON(this.request.context.view.chain)
      )
        throw new OutputProtocolError('context-changed', 'Chain identity changed inside journal')
      if (identities.has(frontier.context.id) && identities.get(frontier.context.id) !== bytes)
        throw new OutputProtocolError('equivocation', 'Chain context identity was reused')
      identities.set(frontier.context.id, bytes)
    }
    if (
      canonicalOutputJSON(this.contextAt(this.request.through)) !==
      canonicalOutputJSON(this.request.context)
    )
      throw new OutputProtocolError('context-changed', 'Active context differs from journal')
  }

  private contextAt(at: string): ReconciliationContext {
    let result = this.contexts[0].context
    for (const frontier of this.contexts) {
      this.charge()
      if (compareInteger(frontier.at, at) > 0) break
      result = frontier.context
    }
    return result
  }

  private add(candidate: ReconciliationCandidate): void {
    const transaction = Transaction.fromBinary(decodeOutputBytes(candidate.rawTransaction))
    if (transaction.id('hex') !== candidate.txid || this.nodes.has(candidate.txid))
      throw new OutputProtocolError(
        'invalid',
        'Duplicate or inconsistent reconciliation transaction'
      )
    if (
      candidate.firstRaw.journalId !== this.request.journalId ||
      compareInteger(candidate.firstRaw.position, this.request.through) > 0
    )
      throw new OutputProtocolError('invalid', 'Foreign ingress position')
    outputU32(candidate.firstRaw.index)
    for (const [contextId, at] of Object.entries(candidate.historicalSupportAt ?? {})) {
      const frontier = this.contexts.find(item => item.context.id === contextId)
      if (
        !frontier ||
        compareInteger(at, frontier.at) < 0 ||
        compareInteger(at, this.request.through) > 0 ||
        this.contextAt(at).id !== contextId
      )
        throw new OutputProtocolError('invalid', 'Invalid historical support frontier')
    }
    if (candidate.order) {
      if (
        canonicalOutputJSON(candidate.order.firstRaw) !== canonicalOutputJSON(candidate.firstRaw) ||
        compareInteger(candidate.order.readyAt, candidate.firstRaw.position) < 0 ||
        compareInteger(candidate.order.readyAt, this.request.through) > 0 ||
        this.contextAt(candidate.order.readyAt).id !== candidate.order.readyContextId
      )
        throw new OutputProtocolError('invalid', 'Invalid candidate readiness order')
      outputU32(candidate.order.depth)
    }
    const anchor =
      candidate.validation === 'verified' &&
      candidate.placement?.contextId === this.request.context.id
    if (candidate.placement) {
      outputHex32(candidate.placement.blockHash)
      outputU64(candidate.placement.height)
    }
    const inputs = inputVector(transaction).filter(
      input => !anchor || input !== `${'0'.repeat(64)}:4294967295`
    )
    if (new Set(inputs).size !== inputs.length)
      throw new OutputProtocolError('invalid', 'Repeated transaction input')
    const node: Node = {
      candidate,
      transaction,
      inputs,
      parents: [...new Set(inputs.map(input => input.slice(0, 64)))],
      anchor
    }
    this.charge(inputs.length)
    this.nodes.set(candidate.txid, node)
    this.rows.set(candidate.txid, {
      txid: candidate.txid,
      evidenceIds: [...new Set(candidate.evidenceIds)].sort(compareText),
      firstRaw: { ...candidate.firstRaw },
      ...(candidate.order
        ? { order: { ...candidate.order, firstRaw: { ...candidate.firstRaw } } }
        : {}),
      status: 'unresolved',
      reason: 'Required evidence is incomplete',
      dependencies: transaction.inputs.map(input => ({
        chain: { ...this.request.context.view.chain },
        txid: input.sourceTXID!,
        outputIndex: input.sourceOutputIndex
      })),
      conflictsWith: []
    })
  }

  private dependencyEdges(): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>(),
      spenders = new Map<string, string[]>()
    const connect = (a: string, b: string): void => {
      edges.get(a)!.add(b)
      edges.get(b)!.add(a)
    }
    for (const id of this.nodes.keys()) edges.set(id, new Set())
    for (const [id, node] of this.nodes) {
      for (const parent of node.parents) {
        this.charge()
        if (this.nodes.has(parent) && !this.nodes.get(parent)!.anchor) connect(id, parent)
      }
      for (const input of node.inputs) {
        this.charge()
        const prior = spenders.get(input)
        if (prior) {
          connect(id, prior[0])
          prior.push(id)
        } else spenders.set(input, [id])
      }
    }
    return edges
  }

  private findPendingComponents(): void {
    const edges = this.dependencyEdges(),
      visited = new Set<string>()
    for (const id of this.nodes.keys()) {
      if (visited.has(id)) continue
      const { component, unfinished } = this.connectedComponent(id, edges, visited)
      if (!unfinished) continue
      component.sort(compareText)
      this.components.push(component)
      for (const item of component) {
        this.pending.add(item)
        this.componentByTx.set(item, component)
      }
    }
  }

  private connectedComponent(
    id: string,
    edges: Map<string, Set<string>>,
    visited: Set<string>
  ): { component: string[]; unfinished: boolean } {
    const component: string[] = [],
      queue = [id]
    let unfinished = false
    while (queue.length) {
      const next = queue.pop()!
      if (visited.has(next)) continue
      visited.add(next)
      component.push(next)
      unfinished ||= this.nodes.get(next)!.candidate.pendingSupport
      for (const neighbor of edges.get(next)!) {
        this.charge()
        if (!visited.has(neighbor)) queue.push(neighbor)
      }
    }
    return { component, unfinished }
  }

  private reserveAnchors(): void {
    this.selected.clear()
    this.reservations.clear()
    for (const node of this.sorted) {
      if (!this.forced.has(node.candidate.txid)) continue
      const id = node.candidate.txid
      this.selected.add(id)
      for (const input of node.inputs) {
        this.charge()
        if (this.reservations.has(input) && this.reservations.get(input) !== id)
          throw new OutputProtocolError(
            'context-changed',
            'Selected chain contains contradictory spends'
          )
        this.reservations.set(input, id)
      }
    }
  }

  private parentsUsable(node: Node, context: ReconciliationContext, at?: string): boolean {
    for (const id of node.parents) {
      this.charge()
      const parent = this.nodes.get(id)
      const anchorAt = parent?.candidate.historicalAnchors?.[context.id]
      // A historical chain anchor establishes a usable predecessor at that old
      // frontier even while its placement in today's view awaits revalidation.
      // It cannot defeat a contradictory choice forced by the current chain.
      if (
        parent &&
        at !== undefined &&
        anchorAt !== undefined &&
        compareInteger(anchorAt, at) <= 0 &&
        parent.candidate.historicalValidation?.[context.id] === 'verified' &&
        !this.competing(parent).some(competitor => competitor !== id && this.forced.has(competitor))
      )
        continue
      if (
        !parent ||
        !this.selected.has(id) ||
        (!this.forced.has(id) && !isOutputTransactionFinal(parent.transaction, context.view))
      )
        return false
    }
    return true
  }

  private competing(node: Node): string[] {
    this.charge(node.inputs.length)
    return [
      ...new Set(
        node.inputs
          .map(input => this.reservations.get(input))
          .filter((id): id is string => id !== undefined)
      )
    ].sort(compareText)
  }
  private select(node: Node): void {
    this.selected.add(node.candidate.txid)
    for (const input of node.inputs) this.reservations.set(input, node.candidate.txid)
  }
  private usable(node: Node, context: ReconciliationContext, at: string): boolean {
    const blocked = this.componentByTx.get(node.candidate.txid)?.some(id => {
      this.charge()
      const candidate = this.nodes.get(id)!.candidate
      return candidate.historicalPending === undefined
        ? candidate.pendingSupport
        : candidate.historicalPending[context.id] === true
    })
    return (
      !blocked &&
      (node.candidate.historicalSupportAt === undefined ||
        (node.candidate.historicalSupportAt[context.id] !== undefined &&
          compareInteger(node.candidate.historicalSupportAt[context.id], at) <= 0)) &&
      (node.candidate.historicalValidation === undefined
        ? node.candidate.validation
        : node.candidate.historicalValidation[context.id]) === 'verified' &&
      node.candidate.order !== undefined
    )
  }

  private replay(): void {
    this.reserveAnchors()
    const frontiers = [
      ...new Set([
        ...this.contexts.map(item => item.at),
        ...this.sorted.flatMap(node =>
          node.candidate.order ? [node.candidate.order.readyAt] : []
        ),
        ...this.sorted.flatMap(node => Object.values(node.candidate.historicalSupportAt ?? {})),
        this.request.through
      ])
    ].sort(compareInteger)
    for (const at of frontiers) {
      const context = this.contextAt(at)
      for (const node of this.sorted) this.replayNode(node, context, at)
    }
  }

  private replayNode(node: Node, context: ReconciliationContext, at: string): void {
    this.charge()
    const id = node.candidate.txid
    if (
      this.forced.has(id) ||
      this.selected.has(id) ||
      this.historicalConflicts.has(id) ||
      this.replaced.has(id) ||
      !this.usable(node, context, at)
    )
      return
    if (
      compareInteger(node.candidate.order!.readyAt, at) > 0 ||
      !this.parentsUsable(node, context, at)
    )
      return
    if (!this.request.nonFinal && !isOutputTransactionFinal(node.transaction, context.view)) return
    if (!this.eligible.has(id)) this.eligible.set(id, { at, contextId: context.id })
    const competitors = this.competing(node)
    const prior = competitors.length === 1 ? this.nodes.get(competitors[0]) : undefined
    if (
      competitors.length &&
      (!prior ||
        this.forced.has(prior.candidate.txid) ||
        !canReplaceOutputTransaction(prior.transaction, node.transaction, context.view))
    ) {
      this.historicalConflicts.add(id)
      return
    }
    if (prior) this.replace(prior, id, at, context.id)
    this.select(node)
  }

  private replace(prior: Node, id: string, at: string, contextId: string): void {
    const previous = prior.candidate.txid
    this.selected.delete(previous)
    this.replaced.add(previous)
    this.previous.set(id, previous)
    this.replacements.push({ previous, replacement: id, at, contextId })
    for (const input of prior.inputs) this.reservations.delete(input)
  }

  private root(id: string): string {
    let current = id
    while (this.previous.has(current)) {
      this.charge()
      current = this.previous.get(current)!
    }
    return current
  }
  private status(
    node: Node,
    status: ReconciledTransaction['status'],
    reason: string,
    conflicts: string[] = []
  ): void {
    const row = this.rows.get(node.candidate.txid)!
    row.status = status
    row.reason = reason
    row.conflictsWith = conflicts
  }

  private rebuild(): void {
    this.reserveAnchors()
    const priority = new Map(
      this.sorted.map(node => [node.candidate.txid, this.root(node.candidate.txid)])
    )
    const sorted = [...this.sorted].sort((a, b) => {
      const ra = priority.get(a.candidate.txid)!,
        rb = priority.get(b.candidate.txid)!
      return (
        compareInteger(
          this.eligible.get(ra)?.at ?? this.request.through,
          this.eligible.get(rb)?.at ?? this.request.through
        ) ||
        compareOrder(this.nodes.get(ra)!, this.nodes.get(rb)!) ||
        compareOrder(a, b)
      )
    })
    for (const node of this.topologicalOrder(sorted)) this.rebuildNode(node)
  }

  private topologicalOrder(sorted: Node[]): Node[] {
    // Stable topological ordering preserves reservation priority among available
    // nodes while ensuring changed current-view eligibility cannot put a child
    // ahead of its parent. Unknown parents remain unresolved in parentsUsable.
    const remaining = new Map(sorted.map(node => [node.candidate.txid, node]))
    const ordered: Node[] = []
    while (remaining.size) {
      let next: Node | undefined
      for (const candidate of remaining.values()) {
        this.charge(1 + candidate.parents.length)
        if (!candidate.parents.some(parent => remaining.has(parent))) {
          next = candidate
          break
        }
      }
      if (!next) throw new OutputProtocolError('invalid', 'Cyclic transaction dependencies')
      remaining.delete(next.candidate.txid)
      ordered.push(next)
    }
    return ordered
  }

  private rebuildNode(node: Node): void {
    this.charge()
    const id = node.candidate.txid
    if (this.forced.has(id)) {
      this.status(
        node,
        'included',
        node.anchor
          ? 'Verified inclusion in selected chain'
          : 'Validated ancestor of selected-chain transaction'
      )
      return
    }
    if (this.pending.has(id)) {
      this.status(node, 'unresolved', 'Earlier complete support is still being verified')
      return
    }
    if (node.candidate.validation !== 'verified') {
      this.status(node, node.candidate.validation, 'Evidence has not qualified for selection')
      return
    }
    if (!node.candidate.order) {
      this.status(node, 'unresolved', 'Earliest sufficient evidence is unavailable')
      return
    }
    if (this.replaced.has(id)) {
      this.status(
        node,
        'conflicting',
        'Replaced at a retained non-final frontier',
        this.replacements
          .filter(row => row.previous === id)
          .map(row => row.replacement)
          .sort(compareText)
      )
      return
    }
    if (!this.parentsUsable(node, this.request.context)) {
      this.status(
        node,
        'dependent-conflict',
        'Parent is missing, unselected or currently non-final',
        node.parents.filter(parent => !this.selected.has(parent)).sort(compareText)
      )
      return
    }
    if (
      !this.request.nonFinal &&
      !isOutputTransactionFinal(node.transaction, this.request.context.view)
    ) {
      this.status(node, 'unsupported', 'Non-final selection is disabled')
      return
    }
    if (!this.eligible.has(id))
      this.eligible.set(id, { at: this.request.through, contextId: this.request.context.id })
    const competitors = this.competing(node)
    if (competitors.length) {
      this.status(
        node,
        'conflicting',
        'Input already reserved by an eligible selection',
        competitors
      )
      return
    }
    this.select(node)
    this.status(
      node,
      isOutputTransactionFinal(node.transaction, this.request.context.view)
        ? 'selected-final'
        : 'selected-non-final',
      'Selected by durable local eligibility order'
    )
  }

  run(): ReconciledState {
    this.findPendingComponents()
    this.replay()
    this.rebuild()
    for (const [id, row] of this.rows) {
      const eligible = this.eligible.get(id),
        previous = this.previous.get(id)
      if (eligible) row.eligible = { ...eligible }
      if (previous) row.replaces = previous
    }
    this.components.sort((a, b) => compareText(a[0], b[0]))
    return {
      profile: 'https://bsv.brc.dev/apps/0192#bitcoin-spend-reconciliation-v1',
      nonFinal: this.request.nonFinal,
      journalId: this.request.journalId,
      through: this.request.through,
      contextId: this.request.context.id,
      transactions: [...this.rows.values()].sort((a, b) => compareText(a.txid, b.txid)),
      memberships: structuredClone(this.request.memberships),
      replacements: this.replacements,
      pendingComponents: this.components.map(txids => ({
        txids,
        reason: 'Complete evidence verification pending'
      }))
    }
  }
}
