import { pendingWork } from './internal/pendingWork.js'
import {
  canonicalOutputJSON,
  outputHex32,
  outputString,
  outputU64,
  OutputProtocolError
} from '@bsv/sdk'
import { KnowledgeStore } from './KnowledgeStore.js'
import { RuntimeEvents } from './RuntimeEvents.js'
import { knowledgeMutation } from './storage/Journal.js'
import {
  parseSourceBatch,
  parseSourceRequest,
  parseProjection,
  parseVerificationContext,
  runtimeLimits
} from './validation.js'
import type {
  AcceptedInput,
  DomainProjector,
  Projection,
  RuntimeEvent,
  RuntimeLimits,
  Source,
  SourceRequest,
  VerificationContext
} from './ports.js'

/** Trusted protocol worker. Ingestion/projection never receives an ActionPort. */
export interface OutputKnowledgeWorker {
  /** One bounded pass over durable pending work, also persisting due invalidations. */
  advance(store: KnowledgeStore, signal: AbortSignal): Promise<void>
  pendingBytes(store: KnowledgeStore, signal: AbortSignal): Promise<number>
  /**
   * Optional earliest exclusive invalidation time in U64 epoch seconds for this
   * accepted input, including non-Bitcoin state such as proposal activity.
   * This pure local method must not consult mutable remote state or perform I/O.
   * advance() must durably invalidate due state; this hook only schedules work
   * and prevents a delayed worker from publishing an expired projection.
   */
  nextInvalidation?(input: AcceptedInput): string | undefined
}
export interface OutputKnowledgeOptions {
  store: KnowledgeStore
  worker: OutputKnowledgeWorker
  projector?: DomainProjector
  limits?: Partial<RuntimeLimits>
  supportedExtensions?: readonly string[]
  maximumSources?: number
  now?: () => number
}
export interface SourceSubscription {
  done: Promise<void>
  close(): void
}

/**
 * Progressive ingress, durable acknowledgement, serialized protocol work and a
 * last-moment projection publication gate. Bitcoin/group decisions belong to the
 * protocol worker/reducer; application interpretation belongs to the projector.
 */
export class OutputKnowledge {
  readonly limits: Readonly<RuntimeLimits>
  private readonly abort = new AbortController()
  private readonly sources = new Map<string, AbortController>()
  private readonly observers = new Set<RuntimeEvents>()
  private readonly maximumSources: number
  private readonly now: () => number
  private readonly projectorPolicy: string | undefined
  private readonly nextInvalidation: OutputKnowledgeWorker['nextInvalidation']
  private gate = 0
  private projection: { value: Projection; input: AcceptedInput } | undefined
  private ingest: Promise<void> = Promise.resolve()
  private work: Promise<void> | undefined
  private dirty = false
  private contextChanges = 0
  private runningOperations = 0
  private expiry: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: OutputKnowledgeOptions) {
    this.options = Object.freeze({
      ...options,
      supportedExtensions: Object.freeze([...(options.supportedExtensions ?? [])])
    })
    this.limits = Object.freeze(runtimeLimits(options.limits))
    this.maximumSources =
      options.maximumSources ??
      Math.min(4, Math.floor(this.limits.pendingBytes / this.limits.batchBytes))
    if (
      !Number.isSafeInteger(this.maximumSources) ||
      this.maximumSources < 1 ||
      this.maximumSources > 16 ||
      this.maximumSources * this.limits.batchBytes > this.limits.pendingBytes
    )
      throw new OutputProtocolError('invalid', 'Invalid source concurrency bound')
    this.now = options.now ?? Date.now
    this.nextInvalidation = options.worker.nextInvalidation?.bind(options.worker)
    this.projectorPolicy = options.projector
      ? outputHex32(options.projector.policyDigest)
      : undefined
  }
  private ready(): void {
    if (this.abort.signal.aborted)
      throw new OutputProtocolError('cancelled', 'Output runtime is closed')
  }
  private emit(event: RuntimeEvent): void {
    if (this.abort.signal.aborted) return
    const text = JSON.stringify(event)
    for (const observer of this.observers) observer.push(text)
  }
  private error(error: unknown, source?: string): void {
    if (this.abort.signal.aborted) return
    const code = error instanceof OutputProtocolError ? error.code : 'unavailable'
    this.emit({
      kind: 'error',
      ...(source ? { source } : {}),
      code,
      message: `Output runtime ${code}`,
      retryable: ['limited', 'unavailable', 'conflict', 'expired'].includes(code)
    })
  }

  events(signal = this.abort.signal): AsyncIterable<RuntimeEvent> {
    this.ready()
    if (signal.aborted) throw new OutputProtocolError('cancelled', 'Runtime observer cancelled')
    if (this.observers.size >= 8)
      throw new OutputProtocolError('limited', 'Runtime observer capacity')
    const observer = new RuntimeEvents(signal, () => this.observers.delete(observer))
    this.observers.add(observer)
    return observer
  }

  /** Caller-established scope and generation are frozen before opening a source. */
  attach(source: Source, input: SourceRequest): SourceSubscription {
    this.ready()
    const sourceId = outputString(source.id)
    if (source.requiredDurability === 'durable' && this.options.store.durability !== 'durable')
      throw new OutputProtocolError(
        'unsupported',
        'Source acknowledgement requires durable storage'
      )
    if (this.sources.has(sourceId))
      throw new OutputProtocolError('conflict', 'Source adapter is already attached')
    if (this.sources.size >= this.maximumSources)
      throw new OutputProtocolError('limited', 'Source concurrency capacity')
    const request = parseSourceRequest(input)
    if (
      canonicalOutputJSON(request.partition) !== canonicalOutputJSON(this.options.store.partition)
    )
      throw new OutputProtocolError('unauthorized', 'Source partition differs from active store')
    const requestedLimits = runtimeLimits(request.limits)
    for (const key of Object.keys(this.limits) as (keyof RuntimeLimits)[])
      if (requestedLimits[key] > this.limits[key])
        throw new OutputProtocolError('invalid', 'Source request exceeds runtime limits')
    const controller = new AbortController(),
      stop = (): void => controller.abort()
    this.abort.signal.addEventListener('abort', stop, { once: true })
    this.sources.set(sourceId, controller)
    const done = (async () => {
      try {
        for await (const raw of source.open(
          JSON.parse(canonicalOutputJSON(request)) as SourceRequest,
          controller.signal
        )) {
          if (controller.signal.aborted) break
          const batch = parseSourceBatch(
            raw,
            { ...request, adapter: sourceId },
            requestedLimits,
            this.options.supportedExtensions
          )
          const pending = this.ingest.then(async () => {
            this.ready()
            if (controller.signal.aborted)
              throw new OutputProtocolError('cancelled', 'Source subscription cancelled')
            const bytes = new TextEncoder().encode(canonicalOutputJSON(batch)).length
            const pendingBytes = await this.operation(signal =>
              this.options.worker.pendingBytes(this.options.store, signal)
            )
            if (
              !Number.isSafeInteger(pendingBytes) ||
              pendingBytes < 0 ||
              pendingBytes + bytes > this.limits.pendingBytes
            )
              throw new OutputProtocolError('limited', 'Durable pending evidence capacity')
            const mutation = knowledgeMutation({ kind: 'receive', batch })
            for (let attempt = 0; attempt < 8; attempt++) {
              if (controller.signal.aborted)
                throw new OutputProtocolError('cancelled', 'Source subscription cancelled')
              const current = await this.options.store.revision(controller.signal)
              const result = await this.options.store.commit(
                current.received,
                mutation,
                controller.signal
              )
              if (result.status === 'conflict') continue
              if ('reason' in result) throw new OutputProtocolError(result.status, result.reason)
              this.gate++
              this.projection = undefined
              this.schedule()
              return
            }
            throw new OutputProtocolError('conflict', 'Source commit contention budget')
          })
          this.ingest = pending.then(
            () => {},
            () => {}
          )
          await pending // Pulling the next source item acknowledges only durable receipt.
        }
      } catch (error) {
        if (!controller.signal.aborted) this.error(error, sourceId)
        throw error
      } finally {
        this.abort.signal.removeEventListener('abort', stop)
        this.sources.delete(sourceId)
      }
    })()
    // Consumers may choose to await done; background source failure is also an event.
    void done.catch(() => {})
    return { done, close: stop }
  }

  /** Explicitly closes the old publication gate before a local context transition. */
  async setContext(input: VerificationContext): Promise<void> {
    this.ready()
    const context = parseVerificationContext(input)
    if (
      canonicalOutputJSON(context.partition) !== canonicalOutputJSON(this.options.store.partition)
    )
      throw new OutputProtocolError(
        'unauthorized',
        'Use a separate store/runtime for another account partition'
      )
    const mutation = knowledgeMutation({ kind: 'context', context })
    this.gate++
    this.projection = undefined
    this.contextChanges++
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const expected = (await this.options.store.revision(this.abort.signal)).received
        const result = await this.options.store.commit(expected, mutation, this.abort.signal)
        if (result.status === 'conflict') continue
        if ('reason' in result) throw new OutputProtocolError(result.status, result.reason)
        this.schedule()
        return
      }
      throw new OutputProtocolError('conflict', 'Context commit contention budget')
    } finally {
      this.contextChanges--
      if (this.dirty) this.schedule()
    }
  }

  private async operation<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.ready()
    if (this.runningOperations >= this.limits.verificationConcurrency)
      throw new OutputProtocolError('limited', 'Runtime work capacity')
    const controller = new AbortController(),
      cancel = (): void => controller.abort()
    this.abort.signal.addEventListener('abort', cancel, { once: true })
    let expired = false,
      rejectAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () =>
        reject(
          new OutputProtocolError(expired ? 'limited' : 'cancelled', 'Runtime work interrupted')
        )
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, this.limits.deadlineMs)
    try {
      this.runningOperations++
      const work = Promise.resolve()
        .then(() => task(controller.signal))
        .finally(() => {
          this.runningOperations--
        })
      return await Promise.race([work, aborted])
    } finally {
      clearTimeout(timer)
      this.abort.signal.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', rejectAbort)
    }
  }

  private schedule(): void {
    if (this.abort.signal.aborted) return
    this.dirty = true
    if (this.work || this.contextChanges > 0) return
    this.work = this.drain()
      .catch(error => {
        this.error(error)
        throw error
      })
      .finally(() => {
        this.work = undefined
        if (this.dirty && !this.abort.signal.aborted) this.schedule()
      })
    void this.work.catch(() => {})
  }
  private async drain(): Promise<void> {
    const inputs = pendingWork(
      () => this.dirty && !this.abort.signal.aborted,
      async () => {
        this.dirty = false
        return this.operation(async signal => {
          await this.options.worker.advance(this.options.store, signal)
          try {
            return await this.options.store.read(undefined, signal)
          } catch (error) {
            if (!(error instanceof OutputProtocolError) || error.code !== 'expired') throw error
            this.projection = undefined
            // Time may cross an expiry after the worker returns. Allow one
            // recovery pass within this operation's original deadline; a worker
            // that still cannot invalidate must fail closed without a retry loop.
            await this.options.worker.advance(this.options.store, signal)
            return this.options.store.read(undefined, signal)
          }
        })
      }
    )
    for await (const input of inputs) {
      if (this.contextChanges > 0) {
        this.dirty = true
        return
      }
      this.emit({ kind: 'knowledge', input })
      this.armExpiry(input)
      if (!this.options.projector) continue
      this.requirePublicationWindow(input)
      const gate = this.gate,
        projector = this.options.projector
      if (projector.policyDigest !== this.projectorPolicy)
        throw new OutputProtocolError(
          'context-changed',
          'Projector policy changed; construct a new runtime'
        )
      const projection = await this.operation(signal =>
        projector.project(JSON.parse(canonicalOutputJSON(input)) as AcceptedInput, signal)
      )
      const owned = parseProjection(projection)
      if (
        owned.acceptedRevision !== input.revision.accepted ||
        owned.generation !== input.generation ||
        owned.contextId !== input.context.id
      )
        throw new OutputProtocolError(
          'invalid',
          'Projector returned a different knowledge checkpoint'
        )
      const current = await this.options.store.read(undefined, this.abort.signal)
      this.ready()
      if (this.contextChanges > 0) {
        this.dirty = true
        return
      }
      if (gate !== this.gate || !this.sameCheckpoint(current, input)) {
        this.dirty = true
        continue
      }
      this.requirePublicationWindow(current)
      // No await between this final gate and making the owned result observable.
      this.projection = { value: owned, input }
      this.emit({ kind: 'projection', projection: owned, knowledgeRevision: input.revision })
    }
  }
  private sameCheckpoint(a: AcceptedInput, b: AcceptedInput): boolean {
    return (
      canonicalOutputJSON(a.partition) === canonicalOutputJSON(b.partition) &&
      a.generation === b.generation &&
      a.context.id === b.context.id &&
      a.revision.received === b.revision.received &&
      a.revision.accepted === b.revision.accepted
    )
  }
  private clock(): bigint {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0)
      throw new OutputProtocolError('invalid', 'Invalid runtime publication clock')
    return BigInt(now)
  }
  private deadline(input: AcceptedInput): bigint | undefined {
    const deadlines = input.assessments
      .filter(row => row.state !== 'stale' && row.expiresAt !== undefined)
      .map(row => outputU64(row.expiresAt!))
    const extra = this.nextInvalidation?.(JSON.parse(canonicalOutputJSON(input)) as AcceptedInput)
    if (extra !== undefined) deadlines.push(outputU64(extra))
    return deadlines.reduce<bigint | undefined>(
      (earliest, value) => (earliest === undefined || value < earliest ? value : earliest),
      undefined
    )
  }
  private expired(input: AcceptedInput): boolean {
    const deadline = this.deadline(input)
    return deadline !== undefined && this.clock() >= deadline * 1000n
  }
  private requirePublicationWindow(input: AcceptedInput): void {
    if (!this.expired(input)) return
    this.projection = undefined
    throw new OutputProtocolError('expired', 'Due knowledge invalidation has not committed', true)
  }
  private armExpiry(input: AcceptedInput): void {
    clearTimeout(this.expiry)
    const earliest = this.deadline(input)
    if (earliest === undefined) return
    const remaining = earliest * 1000n - this.clock()
    // A stalled/incorrect worker cannot create a tight automatic retry loop.
    // Publishing and reading remain closed until a later pass commits invalidation.
    if (remaining <= 0n) return
    const delay = Math.max(1, Math.min(60000, Number(remaining)))
    this.expiry = setTimeout(() => {
      try {
        if (this.clock() >= earliest * 1000n) {
          this.gate++
          this.projection = undefined
          this.schedule()
        } else this.armExpiry(input)
      } catch (error) {
        this.gate++
        this.projection = undefined
        this.error(error)
      }
    }, delay)
  }
  async flush(): Promise<void> {
    this.ready()
    await this.ingest
    if (!this.work) this.schedule()
    for await (const _ of pendingWork(
      () => this.work !== undefined,
      () => this.work!
    )) {
      // Each settled pass can schedule another; pull it only after settlement.
    }
  }
  async readProjection(): Promise<Projection | undefined> {
    this.ready()
    const saved = this.projection,
      gate = this.gate
    if (!saved || this.contextChanges > 0) return undefined
    const current = await this.options.store.read(undefined, this.abort.signal)
    if (this.abort.signal.aborted || gate !== this.gate) return undefined
    if (this.expired(current) || this.expired(saved.input)) {
      this.gate++
      this.projection = undefined
      this.schedule()
      return undefined
    }
    return !this.abort.signal.aborted &&
      this.options.projector?.policyDigest === this.projectorPolicy &&
      this.sameCheckpoint(current, saved.input)
      ? (JSON.parse(canonicalOutputJSON(saved.value)) as Projection)
      : undefined
  }
  async close(): Promise<void> {
    this.gate++
    this.projection = undefined
    this.abort.abort()
    clearTimeout(this.expiry)
    for (const source of this.sources.values()) source.abort()
    for (const observer of this.observers) observer.close()
    this.observers.clear()
    await this.options.store.close()
  }
}
