import { pendingWork } from './internal/pendingWork.js'
import {
  canonicalOutputJSON,
  incrementOutputU64,
  outputHex32,
  outputPacketDigest,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import {
  appendJournalWithRecovery,
  cloneEntry,
  knowledgeMutation,
  journalEntryBytes,
  journalPayload,
  DEFAULT_JOURNAL_LIMITS,
  type JournalEntry,
  type JournalStorage,
  type MutationLookup
} from './storage/Journal.js'
import { parsePartition, parseVerificationContext } from './validation.js'
import type {
  AcceptedInput,
  CommitResult,
  Mutation,
  OutputPartition,
  StoreRevision
} from './ports.js'

/**
 * Trusted local protocol reducer, separate from domain projection. It must check
 * all mutation semantics, crypto-result bindings and the deterministic Bitcoin
 * reconciliation result. It has no storage-write or application-action authority.
 * A read replay must reproduce recorded decisions, not assign new arrival order.
 */
export interface KnowledgeReducer {
  /** Pure local exclusive read deadline; prepare/worker still owns durable invalidation. */
  nextInvalidation?(input: AcceptedInput): string | undefined
  reduce(entries: readonly JournalEntry[], signal: AbortSignal): Promise<AcceptedInput>
  /** Validate a new transition and retain its local cryptographic replay material atomically. */
  prepare?(
    entries: readonly JournalEntry[],
    signal: AbortSignal
  ): Promise<{ input: AcceptedInput; local?: OutputJSONObject }>
}
export interface KnowledgeStoreOptions {
  partition: OutputPartition
  /** A retained resume checkpoint detects lost/incorrect durable namespaces. */
  minimumReceived?: string
  maximumEntries?: number
  maximumBytes?: number
  deadlineMs?: number
  maximumReaders?: number
  pollMs?: number
  now?: () => number
}
interface ReplayHistory {
  entries: JournalEntry[]
  received: string
  accepted: string
  bytes: number
  keys: Set<string>
}
const clone = <T>(value: T): T => structuredClone(value)

/** CAS journal port with bounded replay, exact-key recovery and ordered watches. */
export class KnowledgeStore {
  readonly partition: OutputPartition
  readonly durability: JournalStorage['durability']
  readonly journalId: string
  private readonly minimumReceived: string
  private readonly maximumEntries: number
  private readonly maximumBytes: number
  private readonly deadlineMs: number
  private readonly maximumReaders: number
  private readonly pollMs: number
  private readonly now: () => number
  private readonly nextInvalidation: KnowledgeReducer['nextInvalidation']
  private readonly shutdown = new AbortController()
  private readonly wake = new Set<() => void>()
  private readers = 0
  private watchers = 0

  constructor(
    private readonly storage: JournalStorage,
    private readonly reducer: KnowledgeReducer,
    options: KnowledgeStoreOptions
  ) {
    this.partition = Object.freeze(parsePartition(options.partition))
    this.durability = storage.durability
    this.journalId = storage.namespace
    this.minimumReceived = options.minimumReceived ?? '0'
    outputU64(this.minimumReceived)
    this.maximumEntries = options.maximumEntries ?? 4096
    this.maximumBytes = options.maximumBytes ?? 64 * 1024 * 1024
    this.deadlineMs = options.deadlineMs ?? 15000
    this.maximumReaders = options.maximumReaders ?? 16
    this.pollMs = options.pollMs ?? 250
    this.now = options.now ?? Date.now
    this.nextInvalidation = reducer.nextInvalidation?.bind(reducer)
    for (const [value, maximum] of [
      [this.maximumEntries, 4096],
      [this.maximumBytes, 64 * 1024 * 1024],
      [this.deadlineMs, 60000],
      [this.maximumReaders, 64],
      [this.pollMs, 1000]
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new OutputProtocolError('invalid', 'Invalid knowledge store bound')
  }

  private ready(signal?: AbortSignal): void {
    if (signal?.aborted || this.shutdown.signal.aborted)
      throw new OutputProtocolError('cancelled', 'Knowledge store operation cancelled')
  }

  private async bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    this.ready(signal)
    if (this.readers >= this.maximumReaders)
      throw new OutputProtocolError('limited', 'Knowledge store operation capacity')
    const controller = new AbortController(),
      cancel = (): void => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    this.shutdown.signal.addEventListener('abort', cancel, { once: true })
    let expired = false,
      abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new OutputProtocolError(
            expired ? 'limited' : 'cancelled',
            'Knowledge store operation interrupted'
          )
        )
      controller.signal.addEventListener('abort', abort, { once: true })
    })
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, this.deadlineMs)
    this.readers++
    const work = Promise.resolve()
      .then(async () => {
        this.ready(controller.signal)
        return operation(controller.signal)
      })
      .finally(() => {
        this.readers--
      })
    try {
      return await Promise.race([work, cancelled])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      this.shutdown.signal.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', abort)
    }
  }

  private async history(
    signal: AbortSignal
  ): Promise<{ entries: JournalEntry[]; revision: StoreRevision }> {
    this.ready(signal)
    const head = await this.storage.head()
    if (outputU64(head.received) < outputU64(this.minimumReceived))
      throw new OutputProtocolError('reset-required', 'Journal precedes retained resume checkpoint')
    if (head.entries > this.maximumEntries || head.bytes > this.maximumBytes)
      throw new OutputProtocolError('limited', 'Knowledge replay retention bound')
    const history: ReplayHistory = {
      entries: [],
      received: '0',
      accepted: '0',
      bytes: 0,
      keys: new Set()
    }
    const pages = pendingWork(
      () => outputU64(history.received) < outputU64(head.received),
      () => {
        this.ready(signal)
        return this.storage.read(history.received, Math.min(128, this.maximumEntries))
      }
    )
    for await (const page of pages) this.replayPage(history, page, head.received, signal)
    if (
      history.accepted !== head.accepted ||
      history.entries.length !== head.entries ||
      history.bytes !== head.bytes
    )
      throw new OutputProtocolError(
        'reset-required',
        'Journal head does not match retained history'
      )
    return {
      entries: history.entries,
      revision: { received: history.received, accepted: history.accepted }
    }
  }

  private replayPage(
    history: ReplayHistory,
    page: JournalEntry[],
    through: string,
    signal: AbortSignal
  ): void {
    if (!page.length)
      throw new OutputProtocolError('reset-required', 'Journal history is incomplete')
    const before = history.received
    for (const input of page) {
      this.ready(signal)
      if (outputU64(input.revision.received) > outputU64(through)) break
      this.replayEntry(history, input)
    }
    if (before === history.received)
      throw new OutputProtocolError('reset-required', 'Journal page made no contiguous progress')
  }

  private replayEntry(history: ReplayHistory, input: JournalEntry): void {
    const entry = cloneEntry(input)
    outputHex32(entry.key)
    if (
      history.keys.has(entry.key) ||
      outputPacketDigest('knowledge-mutation', entry.body) !== entry.key ||
      entry.revision.received !== incrementOutputU64(history.received) ||
      entry.revision.accepted !==
        (entry.body.kind === 'receive' ? history.accepted : incrementOutputU64(history.accepted))
    )
      throw new OutputProtocolError(
        'reset-required',
        'Journal integrity or revision continuity failed'
      )
    history.keys.add(entry.key)
    history.bytes += journalEntryBytes(entry)
    if (history.entries.length >= this.maximumEntries || history.bytes > this.maximumBytes)
      throw new OutputProtocolError('limited', 'Knowledge replay retention bound')
    history.entries.push(entry)
    history.received = entry.revision.received
    history.accepted = entry.revision.accepted
  }

  private async reduce(entries: JournalEntry[], signal: AbortSignal): Promise<AcceptedInput> {
    if (!entries.length)
      throw new OutputProtocolError(
        'revision-unavailable',
        'No initial verification context has been committed'
      )
    const result = await this.reducer.reduce(entries.map(cloneEntry), signal)
    this.ready(signal)
    return this.checkResult(result, entries.at(-1)!.revision)
  }

  private checkResult(result: AcceptedInput, revision: StoreRevision): AcceptedInput {
    const context = parseVerificationContext(result.context)
    if (
      canonicalOutputJSON(result.partition) !== canonicalOutputJSON(this.partition) ||
      canonicalOutputJSON(context.partition) !== canonicalOutputJSON(this.partition) ||
      result.generation !== context.generation ||
      canonicalOutputJSON(result.revision) !== canonicalOutputJSON(revision) ||
      result.reconciled.contextId !== context.id ||
      result.reconciled.journalId !== this.journalId ||
      outputU64(result.reconciled.through) > outputU64(revision.received)
    )
      throw new OutputProtocolError(
        'invalid',
        'Reducer returned an inconsistent knowledge snapshot'
      )
    // Return an owned copy even when a custom reducer retains its own references.
    return JSON.parse(canonicalOutputJSON(result)) as AcceptedInput
  }

  /** Lossless local replay input; never expose this private journal as a remote endpoint. */
  async inspect(
    signal?: AbortSignal
  ): Promise<{ entries: JournalEntry[]; revision: StoreRevision }> {
    return this.bounded(async abort => this.history(abort), signal)
  }

  /** Receipt CAS does not require assessments to remain fresh. */
  async revision(signal?: AbortSignal): Promise<StoreRevision> {
    return this.bounded(async () => {
      const head = await this.storage.head()
      if (outputU64(head.received) < outputU64(this.minimumReceived))
        throw new OutputProtocolError(
          'reset-required',
          'Journal precedes retained resume checkpoint'
        )
      outputU64(head.accepted)
      return { received: head.received, accepted: head.accepted }
    }, signal)
  }

  async getMutation(key: string): Promise<MutationLookup> {
    this.ready()
    outputHex32(key)
    return this.bounded(async () => this.storage.getMutation(key))
  }

  async commit(expected: string, input: Mutation, signal?: AbortSignal): Promise<CommitResult> {
    this.ready(signal)
    outputU64(expected)
    outputHex32(input.key)
    const mutation: Mutation = { key: input.key, body: knowledgeMutation(input.body).body }
    const prepare = await this.bounded(async abort => {
      const saved = await this.storage.getMutation(mutation.key)
      if (saved.status === 'unavailable')
        throw new OutputProtocolError('unavailable', saved.reason, true)
      if (saved.status === 'committed')
        return {
          outcome:
            canonicalOutputJSON(saved.entry.body) === canonicalOutputJSON(mutation.body)
              ? { status: 'replayed' as const, revision: saved.entry.revision }
              : {
                  status: 'equivocation' as const,
                  reason: 'Mutation key reused with different body'
                }
        }
      if (outputPacketDigest('knowledge-mutation', mutation.body) !== mutation.key)
        throw new OutputProtocolError('invalid', 'Mutation digest mismatch')
      const history = await this.history(abort)
      if (history.revision.received !== expected)
        return { outcome: { status: 'conflict' as const, reason: 'Received revision changed' } }
      const revision = {
        received: incrementOutputU64(expected),
        accepted:
          mutation.body.kind === 'receive'
            ? history.revision.accepted
            : incrementOutputU64(history.revision.accepted)
      }
      const prospective = [...history.entries, { ...mutation, revision }]
      const prepared = this.reducer.prepare
        ? await this.reducer.prepare(prospective.map(cloneEntry), abort)
        : { input: await this.reduce(prospective, abort), local: undefined }
      this.ready(abort)
      this.checkResult(prepared.input, revision)
      const local =
        prepared.local === undefined
          ? undefined
          : (JSON.parse(canonicalOutputJSON(prepared.local)) as OutputJSONObject)
      const bytes =
        history.entries.reduce((total, entry) => total + journalEntryBytes(entry), 0) +
        journalPayload(mutation, DEFAULT_JOURNAL_LIMITS, local).bytes
      if (history.entries.length >= this.maximumEntries || bytes > this.maximumBytes)
        return { outcome: { status: 'limited' as const, reason: 'Knowledge retention bound' } }
      return { outcome: undefined, local }
    }, signal)
    if (prepare.outcome) return clone(prepare.outcome)
    this.ready(signal)
    // Once append begins, cancellation cannot assert rollback. A storage error is
    // resolved by stable key; a committed result remains committed after abort.
    const result = await appendJournalWithRecovery(this.storage, expected, mutation, prepare.local)
    if (result.status === 'committed' || result.status === 'replayed')
      for (const wake of this.wake) wake()
    return result
  }

  async read(acceptedRevision?: string, signal?: AbortSignal): Promise<AcceptedInput> {
    if (acceptedRevision !== undefined) outputU64(acceptedRevision)
    return this.bounded(async abort => {
      const history = await this.history(abort),
        requested = acceptedRevision ?? history.revision.accepted
      if (outputU64(requested) > outputU64(history.revision.accepted))
        throw new OutputProtocolError('revision-unavailable', 'Accepted revision is unavailable')
      const entries = history.entries.filter(
        entry => outputU64(entry.revision.accepted) <= outputU64(requested)
      )
      if (entries.at(-1)?.revision.accepted !== requested)
        throw new OutputProtocolError('revision-unavailable', 'Accepted revision is unavailable')
      const input = await this.reduce(entries, abort)
      const milliseconds = this.now(),
        deadline = this.nextInvalidation?.(clone(input))
      if (deadline !== undefined) {
        const seconds = outputU64(deadline)
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
          throw new OutputProtocolError('invalid', 'Invalid knowledge publication clock')
        if (BigInt(milliseconds) >= seconds * 1000n)
          throw new OutputProtocolError(
            'expired',
            'Knowledge requires local expiry invalidation',
            true
          )
      }
      const now = BigInt(Math.floor(milliseconds / 1000))
      // A timer delayed by a suspended tab cannot expose expired assessments as
      // current. The runtime persists an invalidate event before the next read.
      if (
        input.assessments.some(
          row =>
            row.state !== 'stale' && row.expiresAt !== undefined && outputU64(row.expiresAt) <= now
        )
      )
        throw new OutputProtocolError(
          'expired',
          'Knowledge assessment requires local expiry invalidation'
        )
      return input
    }, signal)
  }

  async *watch(afterRevision: string, signal?: AbortSignal): AsyncIterable<AcceptedInput> {
    outputU64(afterRevision)
    this.ready(signal)
    if (this.watchers >= this.maximumReaders)
      throw new OutputProtocolError('limited', 'Knowledge watch capacity')
    this.watchers++
    let after = afterRevision
    try {
      const heads = pendingWork(
        () => true,
        () => {
          this.ready(signal)
          return this.bounded(() => this.storage.head(), signal)
        }
      )
      for await (const head of heads) {
        if (outputU64(head.accepted) < outputU64(after))
          throw new OutputProtocolError('reset-required', 'Watch revision is no longer available')
        if (head.accepted !== after) {
          const next = incrementOutputU64(after)
          yield await this.read(next, signal)
          after = next
          continue
        }
        await this.waitForChange(signal)
      }
    } finally {
      this.watchers--
    }
  }

  private async waitForChange(signal?: AbortSignal): Promise<void> {
    this.ready(signal)
    await new Promise<void>(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        this.wake.delete(done)
        signal?.removeEventListener('abort', done)
        this.shutdown.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, this.pollMs)
      this.wake.add(done)
      signal?.addEventListener('abort', done, { once: true })
      this.shutdown.signal.addEventListener('abort', done, { once: true })
      if (signal?.aborted || this.shutdown.signal.aborted) done()
    })
  }

  /** Closes publication/work first; previously committed journal facts remain. */
  async close(): Promise<void> {
    this.shutdown.abort()
    for (const wake of this.wake) wake()
    await this.storage.close()
  }
}
