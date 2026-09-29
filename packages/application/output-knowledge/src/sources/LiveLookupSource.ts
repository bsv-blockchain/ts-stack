import {
  canonicalOutputJSON,
  closedOutputObject,
  OutputLookupTransport,
  OutputLookupServiceError,
  OutputProtocolError,
  outputU64,
  type OutputCapabilityRecoveryRequest,
  type WalletInterface
} from '@bsv/sdk'
import type { KnowledgeStore } from '../KnowledgeStore.js'
import type {
  OperationStateStore,
  OperationStateSnapshot
} from '../operations/OperationStateStore.js'
import { knowledgeMutation } from '../storage/Journal.js'
import type { Source, SourceBatch, SourceRequest } from '../ports.js'
import { parseSourceRequest } from '../validation.js'
import { pendingWork } from '../internal/pendingWork.js'
import {
  liveLookupSourceBinding,
  normalizeLiveLookupConfiguration,
  restoreLiveLookupSource,
  type LiveLookupSourceConfiguration,
  type NormalizedLiveLookupConfiguration
} from './LiveLookupConfiguration.js'
import type {
  LookupSourceStateCodec,
  LookupSourceOriginal,
  LookupSourceState
} from './LookupSourceState.js'
import { LookupSourceGuard } from './LookupSourceGuard.js'
import { LookupSourceWork } from './LookupSourceWork.js'

export interface LiveLookupSourceOptions {
  configuration: LiveLookupSourceConfiguration
  /** Already created/opened with liveLookupSourceBinding; must be durable. */
  control: OperationStateStore
  core: KnowledgeStore
  trust: OutputCapabilityRecoveryRequest
  wallet?: WalletInterface
  fetch?: typeof fetch
  /** Trusted host clock in Unix milliseconds. */
  now?: () => number
}
interface SavedState {
  revision: string
  state: LookupSourceState
}

/**
 * Durable BRC-193 pull source. Local control CAS captures complete responses;
 * the core receipt journal commits observations AND their cursor before the
 * next remote read. Recover the same original contract and Open after restart.
 */
export class LiveLookupSource implements Source {
  readonly requiredDurability = 'durable' as const
  readonly id: string
  private readonly configuration: NormalizedLiveLookupConfiguration
  private readonly guard: LookupSourceGuard
  private readonly work: LookupSourceWork
  private readonly now: () => number
  private codec!: LookupSourceStateCodec
  private transport!: OutputLookupTransport
  private requestJSON = ''
  private active = false
  private connecting = false
  private lastRequestAt?: number

  private readonly options: LiveLookupSourceOptions
  constructor(input: LiveLookupSourceOptions) {
    const options = {
      ...input,
      trust: {
        ...input.trust,
        chain: { ...input.trust.chain },
        rules: new Map(input.trust.rules),
        supportedExtensions: [...(input.trust.supportedExtensions ?? [])]
      }
    }
    this.options = options
    this.configuration = normalizeLiveLookupConfiguration(options.configuration)
    this.id = this.configuration.id
    if (options.control.durability !== 'durable')
      throw new OutputProtocolError('unsupported', 'Live lookup requires durable control storage')
    if (
      canonicalOutputJSON(options.control.configuration.binding) !==
      canonicalOutputJSON(liveLookupSourceBinding(this.configuration))
    )
      throw new OutputProtocolError('context-changed', 'Live lookup control binding changed')
    this.guard = new LookupSourceGuard(options.core, this.configuration)
    this.work = new LookupSourceWork()
    this.now = options.now ?? Date.now
  }

  /**
   * Capture/load a receipt before freezing its assigned scope. Keep this source
   * instance when retrying a cancelled or uncertain connection: its transport
   * retains capacity until even a noncancellable earlier request has settled.
   */
  async connect(signal = new AbortController().signal): Promise<SourceRequest> {
    if (this.active || this.connecting)
      throw new OutputProtocolError('limited', 'Live source connection or subscription is active')
    this.connecting = true
    try {
      return await this.connectRequest(signal)
    } finally {
      this.connecting = false
    }
  }

  private async connectRequest(signal: AbortSignal): Promise<SourceRequest> {
    const first = await this.run(signal, async abort => {
      const saved = await this.options.control.read()
      this.work.check(abort)
      closedOutputObject(saved.value.original, ['contract', 'open'])
      const original = saved.value.original as unknown as LookupSourceOriginal
      this.codec ??= restoreLiveLookupSource(
        original,
        this.configuration,
        this.options.trust,
        this.options.control.configuration.limits.stateBytes
      )
      this.codec.parse(saved.value)
      this.transport ??= new OutputLookupTransport({
        contract: original.contract,
        trust: this.options.trust,
        wallet: this.options.wallet,
        fetch: this.options.fetch,
        requestTimeoutMs: this.configuration.operationTimeoutMs,
        now: () => this.timestamp()
      })
      return this.pending(abort)
    })
    const request = parseSourceRequest({
      partition: this.configuration.partition,
      generation: this.configuration.generation,
      limits: this.configuration.limits,
      scope: first.provenance.scope,
      ...(first.checkpoint ? { checkpoint: first.checkpoint } : {})
    })
    this.requestJSON = canonicalOutputJSON(request)
    return request
  }

  private timestamp(): string {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0)
      throw new OutputProtocolError('invalid', 'Invalid live source clock')
    const value = String(Math.floor(now / 1000))
    outputU64(value)
    return value
  }
  private run<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.work.run(signal, this.configuration.operationTimeoutMs, operation)
  }
  private async read(signal: AbortSignal): Promise<SavedState> {
    const snapshot: OperationStateSnapshot = await this.options.control.read()
    this.work.check(signal)
    outputU64(snapshot.revision)
    return { revision: snapshot.revision, state: this.codec.parse(snapshot.value) }
  }
  private async save(
    saved: SavedState,
    state: LookupSourceState,
    signal: AbortSignal
  ): Promise<SavedState | undefined> {
    this.work.check(signal)
    const result = await this.options.control.compareAndSwap(
      saved.revision,
      this.codec.value(state)
    )
    this.work.check(signal)
    if (result.status === 'conflict') return undefined
    outputU64(result.revision)
    return { revision: result.revision, state }
  }

  private async checkReceipt(batch: SourceBatch, signal: AbortSignal): Promise<void> {
    const mutation = knowledgeMutation({ kind: 'receive', batch })
    const lookup = await this.options.core.getMutation(mutation.key)
    this.work.check(signal)
    if (lookup.status !== 'committed')
      throw new OutputProtocolError(
        lookup.status === 'absent' ? 'conflict' : 'unavailable',
        'Previously delivered lookup batch has no durable receipt'
      )
    if (
      lookup.entry.key !== mutation.key ||
      outputU64(lookup.entry.revision.received) === 0n ||
      canonicalOutputJSON(lookup.entry.body) !== canonicalOutputJSON(mutation.body)
    )
      throw new OutputProtocolError('equivocation', 'Previously delivered lookup receipt changed')
  }

  private async guardedState(signal: AbortSignal): Promise<SavedState | undefined> {
    const saved = await this.read(signal)
    const scope = saved.state.pending?.provenance.scope ?? saved.state.previous?.scope
    const reset = saved.state.pending?.coverage.status === 'reset-required'
    const received = await this.guard.inspect(
      saved.state.minimumReceived,
      scope,
      signal,
      saved.state,
      reset ? knowledgeMutation({ kind: 'receive', batch: saved.state.pending! }).key : undefined
    )
    this.work.check(signal)
    if (received !== saved.state.minimumReceived) {
      return this.save(saved, this.codec.reserveMinimum(saved.state, received), signal)
    }
    return saved
  }

  private async pending(signal: AbortSignal, previous?: SourceBatch): Promise<SourceBatch> {
    let attempts = 0
    const states = pendingWork(
      () => attempts++ < 8,
      () => this.guardedState(signal)
    )
    for await (const saved of states) {
      if (!saved) continue
      if (saved.state.pending !== null) {
        const batch = saved.state.pending
        const key = knowledgeMutation({ kind: 'receive', batch }).key
        if (!previous || knowledgeMutation({ kind: 'receive', batch: previous }).key !== key)
          return batch
        if (batch.coverage.status === 'reset-required')
          throw new OutputProtocolError('reset-required', 'Live lookup requires a new generation')
        const lookup = await this.options.core.getMutation(key)
        this.work.check(signal)
        const advanced = this.codec.advance(saved.state, lookup)
        if (await this.save(saved, advanced, signal)) previous = undefined
        continue
      }
      const captured = await this.capture(saved, signal)
      if (captured) return captured
    }
    throw new OutputProtocolError('limited', 'Live lookup control contention budget', true)
  }

  private async capture(saved: SavedState, signal: AbortSignal): Promise<SourceBatch | undefined> {
    const { state } = saved
    await this.pace(state, signal)
    this.work.check(signal)
    const captured = await this.lookup(state, signal)
    this.work.check(signal)
    const received = await this.guard.inspect(
      state.minimumReceived,
      captured.pending!.provenance.scope,
      signal,
      state
    )
    this.work.check(signal)
    // Other workers may have captured or completed this job while HTTP was pending.
    // A read can legitimately return different complete batches at different times.
    const current = await this.read(signal)
    if (current.state.job !== state.job || current.state.pending !== null) return undefined
    if (outputU64(received) < outputU64(current.state.minimumReceived)) return undefined
    if (
      canonicalOutputJSON([current.state.previous, current.state.previousReceipt]) !==
      canonicalOutputJSON([state.previous, state.previousReceipt])
    )
      throw new OutputProtocolError(
        'reset-required',
        'Lookup predecessor changed without a new job'
      )
    const next = this.codec.reserveMinimum(
      { ...captured, minimumReceived: current.state.minimumReceived },
      received
    )
    const result = await this.save(current, next, signal)
    return result?.state.pending ?? undefined
  }

  private expired(previous: LookupSourceState['previous']): boolean {
    return previous !== null && outputU64(this.timestamp()) >= outputU64(previous.expiresAt)
  }

  private async lookup(state: LookupSourceState, signal: AbortSignal): Promise<LookupSourceState> {
    if (this.expired(state.previous)) return this.codec.reset(state, this.timestamp())
    try {
      const packet =
        state.previous === null
          ? await this.transport.open(state.original.open, signal)
          : await this.transport.readCheckpoint(state.previous, state.original.open.limits, signal)
      const receivedAt = this.timestamp()
      this.lastRequestAt = this.now()
      this.work.check(signal)
      if (outputU64(receivedAt) >= outputU64(packet.expiresAt))
        throw new OutputProtocolError('reset-required', 'Lookup response expired before capture')
      return this.codec.capture(state, packet, receivedAt)
    } catch (error) {
      this.work.check(signal)
      // Only an established source can be invalidated. Authenticate remote
      // errors first; local transport failures never impersonate provider errors.
      const terminal =
        error instanceof OutputLookupServiceError &&
        ['reset-required', 'expired', 'unauthorized', 'context-changed', 'not-found'].includes(
          error.code
        )
      if (state.previous !== null && (terminal || this.expired(state.previous)))
        return this.codec.reset(state, this.timestamp())
      throw error
    }
  }

  private async pace(state: LookupSourceState, signal: AbortSignal): Promise<void> {
    if (state.previous === null) return
    this.timestamp()
    const atHead =
      state.previous.phase === 'live' &&
      state.previous.through === state.previous.highWater &&
      this.lastRequestAt !== undefined
    const delay = atHead
      ? Math.min(
          this.configuration.minimumPollMs,
          Math.max(0, this.lastRequestAt! + this.configuration.minimumPollMs - this.now())
        )
      : 0
    // Even a zero-wait snapshot/read yields to cancellation, expiry and other
    // sources. An immediately resolved custom fetch must not monopolize microtasks.
    await new Promise<void>(resolve => {
      const finish = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, delay)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
    this.work.check(signal)
  }

  /** Closing a local subscription cancels work; it never closes the shared remote session. */
  open(input: SourceRequest, signal: AbortSignal): AsyncIterable<SourceBatch> {
    this.work.check(signal)
    if (this.connecting)
      throw new OutputProtocolError('limited', 'Live source connection is still active')
    if (canonicalOutputJSON(parseSourceRequest(input)) !== this.requestJSON)
      throw new OutputProtocolError(
        'context-changed',
        'Live source request differs from its recovered binding'
      )
    if (this.active)
      throw new OutputProtocolError('limited', 'Live source subscription is already active')
    this.active = true
    const controller = new AbortController()
    let closed = false,
      reading = false,
      previous: SourceBatch | undefined
    const finish = (): void => {
      if (closed) return
      closed = true
      this.active = false
      controller.abort()
      signal.removeEventListener('abort', finish)
    }
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
    const iterator: AsyncIterableIterator<SourceBatch> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        if (closed) return { done: true, value: undefined }
        if (reading) throw new OutputProtocolError('limited', 'Live source pull is already pending')
        reading = true
        try {
          const batch = await this.run(controller.signal, async abort => {
            if (previous) await this.checkReceipt(previous, abort)
            return this.pending(abort, previous)
          })
          this.work.check(controller.signal)
          previous = batch
          return { done: false, value: structuredClone(batch) }
        } catch (error) {
          finish()
          throw error
        } finally {
          reading = false
        }
      },
      return: () => {
        finish()
        return Promise.resolve({ done: true, value: undefined })
      }
    }
    return iterator
  }
}
