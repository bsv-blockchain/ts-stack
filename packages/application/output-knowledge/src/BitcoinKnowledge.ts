import {
  canonicalOutputJSON,
  incrementOutputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import {
  BitcoinKnowledgeState,
  type BitcoinKnowledgeStateOptions
} from './BitcoinKnowledgeState.js'
import {
  knowledgeLocalFrame,
  proofReference,
  checkRetainedProof,
  type VerifiedWork
} from './VerificationLedger.js'
import { knowledgeMutation, type JournalEntry } from './storage/Journal.js'
import type { KnowledgeReducer, KnowledgeStore } from './KnowledgeStore.js'
import type { OutputKnowledgeWorker } from './OutputKnowledge.js'
import type { AcceptedInput, EvidenceVerifier } from './ports.js'
import { runtimeLimits } from './validation.js'
import type { EvidenceSupport } from './EvidencePool.js'

export interface BitcoinKnowledgeOptions extends BitcoinKnowledgeStateOptions {
  verifier: EvidenceVerifier
  /** Maximum individual proof/context checks in one scheduled pass. */
  maximumChecks?: number
  now?: () => number
}
interface PreparedWork {
  parent: string
  local: OutputJSONObject
}

/**
 * Default Bitcoin protocol reducer/worker. Cryptographic results are local replay
 * material; source assertions and domain-projector output cannot insert verdicts.
 * Instances are bound to one journal and account partition.
 */
export class BitcoinKnowledge implements KnowledgeReducer, OutputKnowledgeWorker {
  private readonly maximumChecks: number
  private readonly now: () => number
  private readonly staged = new Map<string, PreparedWork>()
  private advancing = false
  private readonly options: BitcoinKnowledgeOptions

  constructor(options: BitcoinKnowledgeOptions) {
    this.maximumChecks = options.maximumChecks ?? 4096
    if (
      !Number.isSafeInteger(this.maximumChecks) ||
      this.maximumChecks < 1 ||
      this.maximumChecks > 4096
    )
      throw new OutputProtocolError('invalid', 'Invalid proof-check budget')
    this.now = options.now ?? Date.now
    this.options = {
      ...options,
      partition: { ...options.partition },
      ...(options.limits ? { limits: { ...options.limits } } : {}),
      supportedExtensions: [...(options.supportedExtensions ?? [])]
    }
    // Validate immutable configuration before opening sources or a journal mutation.
    const initial = new BitcoinKnowledgeState(this.options)
    this.options.partition = initial.partition
    this.options.sourceCurrentness = initial.sourceCurrentness.rules
  }
  private localFrame(work: VerifiedWork[]): OutputJSONObject {
    return knowledgeLocalFrame(this.options.nonFinal, work, this.options.sourceCurrentness)
  }
  private ready(signal: AbortSignal): void {
    if (signal.aborted)
      throw new OutputProtocolError('cancelled', 'Bitcoin knowledge work cancelled')
  }
  private async replay(
    entries: readonly JournalEntry[],
    signal: AbortSignal
  ): Promise<BitcoinKnowledgeState> {
    const state = new BitcoinKnowledgeState(this.options),
      deadline = this.now() + runtimeLimits(this.options.limits).deadlineMs
    for (let index = 0; index < entries.length; index++) {
      if (index > 0 && index % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
      this.ready(signal)
      if (this.now() >= deadline)
        throw new OutputProtocolError('limited', 'Bitcoin journal replay deadline exhausted', true)
      state.apply(entries[index])
    }
    return state
  }
  private parent(entries: readonly JournalEntry[]): string {
    const last = entries.at(-1)
    return last
      ? canonicalOutputJSON({
          key: last.key,
          revision: last.revision,
          localDigest: last.localDigest ?? null
        })
      : 'empty'
  }
  async reduce(entries: readonly JournalEntry[], signal: AbortSignal): Promise<AcceptedInput> {
    return (await this.replay(entries, signal)).snapshot()
  }
  async prepare(
    entries: readonly JournalEntry[],
    signal: AbortSignal
  ): Promise<{ input: AcceptedInput; local?: OutputJSONObject }> {
    this.ready(signal)
    const entry = entries.at(-1)
    if (!entry) throw new OutputProtocolError('invalid', 'Missing prospective journal transition')
    const prior = entries.slice(0, -1),
      state = await this.replay(prior, signal)
    let local: OutputJSONObject | undefined
    if (entry.body.kind === 'context') local = this.localFrame([])
    if (entry.body.kind === 'accept' || entry.body.kind === 'reconcile') {
      const staged = this.staged.get(entry.key)
      if (staged?.parent === this.parent(prior)) local = staged.local
      else {
        const work = await this.collect(state, signal)
        local = this.localFrame(work.additions)
      }
    }
    this.ready(signal)
    state.apply(entry, local)
    return { input: state.snapshot(), ...(local ? { local } : {}) }
  }

  private async collect(
    state: BitcoinKnowledgeState,
    signal: AbortSignal,
    until = this.now() + state.limits.deadlineMs
  ): Promise<{ additions: VerifiedWork[]; exhausted: boolean }> {
    const additions: VerifiedWork[] = [],
      plan = state.plan(),
      budget = {
        checks: 0,
        limited: false,
        deadline: Math.min(until, this.now() + state.limits.deadlineMs)
      }
    for (const support of plan.proofs.values()) {
      const result = await this.collectProof(state, support, signal, budget)
      if (result.work.checks.length) additions.push(result.work)
      if (result.exhausted) return { additions, exhausted: true }
    }
    return { additions, exhausted: plan.limited || budget.limited }
  }

  private async collectProof(
    state: BitcoinKnowledgeState,
    support: EvidenceSupport,
    signal: AbortSignal,
    budget: { checks: number; limited: boolean; deadline: number }
  ): Promise<{ work: VerifiedWork; exhausted: boolean }> {
    const proof = proofReference(support),
      work: VerifiedWork = { proof, checks: [] }
    for (let index = 0; index < state.frontiers.length; index++) {
      this.ready(signal)
      const frontier = state.frontiers[index],
        next = state.frontiers[index + 1]
      if (next && BigInt(support.availableAt) >= BigInt(next.at)) continue
      const previous = state.ledger.get(proof, frontier.context.id)
      if (previous?.status === 'verified' || previous?.status === 'invalid') continue
      if (budget.checks >= this.maximumChecks || this.now() >= budget.deadline)
        return { work, exhausted: true }
      budget.checks++
      const check = await checkRetainedProof(
        this.options.verifier,
        support,
        frontier.context,
        signal,
        {
          now: this.now,
          deadlineMs: Math.max(1, Math.floor(budget.deadline - this.now()))
        }
      )
      budget.limited ||= check.status === 'limited'
      if (canonicalOutputJSON(check) !== (previous ? canonicalOutputJSON(previous) : 'absent'))
        work.checks.push(check)
    }
    return { work, exhausted: false }
  }

  async pendingBytes(store: KnowledgeStore, signal: AbortSignal): Promise<number> {
    this.checkStore(store)
    return (await this.replay((await store.inspect(signal)).entries, signal)).pendingBytes()
  }
  private checkStore(store: KnowledgeStore): void {
    if (
      store.journalId !== this.options.journalId ||
      canonicalOutputJSON(store.partition) !== canonicalOutputJSON(this.options.partition)
    )
      throw new OutputProtocolError(
        'unauthorized',
        'Bitcoin worker is bound to another journal partition'
      )
  }

  /** Persist verification, then accept complete source groups in deterministic receipt order. */
  async advance(store: KnowledgeStore, signal: AbortSignal): Promise<void> {
    this.checkStore(store)
    this.ready(signal)
    if (this.advancing)
      throw new OutputProtocolError('limited', 'Bitcoin worker pass already in progress')
    this.advancing = true
    const deadline = this.now() + runtimeLimits(this.options.limits).deadlineMs
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await this.pass(store, signal, deadline)
          return
        } catch (error) {
          if (!(error instanceof OutputProtocolError) || error.code !== 'conflict') throw error
          if (this.now() >= deadline)
            throw new OutputProtocolError(
              'limited',
              'Knowledge contention deadline exhausted',
              true
            )
        }
      }
      throw new OutputProtocolError(
        'conflict',
        'Knowledge contention attempt budget exhausted',
        true
      )
    } finally {
      this.advancing = false
      this.staged.clear()
    }
  }
  private async pass(store: KnowledgeStore, signal: AbortSignal, deadline: number): Promise<void> {
    await this.expireAssessments(store, signal)
    const history = await store.inspect(signal),
      state = await this.replay(history.entries, signal),
      work = await this.collect(state, signal, deadline),
      local = this.localFrame(work.additions)
    state.applyLocal(local)
    const row = state.membership
      .groups()
      .find(
        group =>
          group.status === 'pending' &&
          state.membership.isCurrent(group.scope, group.generation) &&
          state.groupDecision(group)
      )
    if (
      work.additions.length ||
      row ||
      state.membership.hasPendingCompletion() ||
      state.membership.hasPendingContinuity()
    ) {
      const revision = {
          received: incrementOutputU64(history.revision.received),
          accepted: incrementOutputU64(history.revision.accepted)
        },
        mutation = knowledgeMutation(state.transition(revision, row))
      this.staged.set(mutation.key, { parent: this.parent(history.entries), local })
      try {
        const result = await store.commit(history.revision.received, mutation, signal)
        if ('reason' in result)
          throw new OutputProtocolError(result.status, result.reason, result.status === 'conflict')
      } finally {
        this.staged.delete(mutation.key)
      }
    }
    // Each source group changes membership as one atomic accepted revision. This
    // loop performs no new crypto work and never pulls unbounded source input.
    for (let count = 0; count < 4096; count++) {
      this.ready(signal)
      const latest = await store.inspect(signal),
        current = await this.replay(latest.entries, signal),
        group = current.membership
          .groups()
          .find(
            value =>
              value.status === 'pending' &&
              current.membership.isCurrent(value.scope, value.generation) &&
              current.groupDecision(value)
          )
      if (!group) break
      if (this.now() >= deadline)
        throw new OutputProtocolError(
          'limited',
          'Group acceptance work retained for another bounded pass',
          true
        )
      const revision = {
          received: incrementOutputU64(latest.revision.received),
          accepted: incrementOutputU64(latest.revision.accepted)
        },
        mutation = knowledgeMutation(current.transition(revision, group))
      this.staged.set(mutation.key, {
        parent: this.parent(latest.entries),
        local: this.localFrame([])
      })
      try {
        const result = await store.commit(latest.revision.received, mutation, signal)
        if ('reason' in result)
          throw new OutputProtocolError(result.status, result.reason, result.status === 'conflict')
      } finally {
        this.staged.delete(mutation.key)
      }
    }
    await this.expireAssessments(store, signal)
    if (work.exhausted)
      throw new OutputProtocolError(
        'limited',
        'Evidence work retained; another bounded pass is required',
        true
      )
  }
  private async expireAssessments(store: KnowledgeStore, signal: AbortSignal): Promise<void> {
    if (!this.options.sourceCurrentness?.length) return
    // Replay is clock-independent. Expiry is a separate durable accepted event,
    // so a sleeping browser or restart cannot renew a provider report.
    const history = await store.inspect(signal),
      state = await this.replay(history.entries, signal),
      snapshot = state.snapshot(),
      milliseconds = this.now()
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      throw new OutputProtocolError('invalid', 'Invalid currentness clock')
    const now = BigInt(Math.floor(milliseconds / 1000))
    const assessmentIds = snapshot.assessments
      .filter(
        row => row.state !== 'stale' && row.expiresAt !== undefined && BigInt(row.expiresAt) <= now
      )
      .map(row => row.id)
    if (!assessmentIds.length) return
    const mutation = knowledgeMutation({
      kind: 'invalidate',
      generation: snapshot.generation,
      assessmentIds,
      reason: 'Currentness lifetime expired'
    })
    const result = await store.commit(history.revision.received, mutation, signal)
    if ('reason' in result)
      throw new OutputProtocolError(result.status, result.reason, result.status === 'conflict')
  }
}
