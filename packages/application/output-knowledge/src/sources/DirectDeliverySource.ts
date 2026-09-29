import { canonicalOutputJSON, outputString, OutputProtocolError } from '@bsv/sdk'
import { SourceSession, type SourceBinding } from './SourceSession.js'
import type { OutputObservation, Source, SourceBatch, SourceRequest } from '../ports.js'

export interface DirectDeliverySourceOptions extends SourceBinding {
  /** Explicitly allow receipt acknowledgements from a volatile runtime. Default false. */
  allowVolatileReceipts?: boolean
  maximumQueuedDeliveries?: number
}
export interface DirectDelivery {
  /** Stable, sender-scoped transport identity. Retry the same bytes and identity. */
  id: string
  observations: OutputObservation[]
}
interface Delivery {
  batch: SourceBatch
  bytes: number
  resolve(): void
  reject(error: Error): void
}
interface Waiting {
  resolve(value: IteratorResult<SourceBatch>): void
  reject(error: Error): void
}

/**
 * Bounded push-to-pull bridge for an authenticated, locally configured peer.
 * deliver resolves only when the consumer requests the next item after committing
 * this receipt. It asserts neither evidence validity nor collection completeness.
 */
export class DirectDeliverySource implements Source {
  readonly id: string
  readonly requiredDurability: 'durable' | undefined
  private readonly session: SourceSession
  private readonly maximumQueued: number
  private active:
    | {
        request: SourceRequest
        signal: AbortSignal
        cancel(): void
        queue: Delivery[]
        bytes: number
        current?: Delivery
        waiting?: Waiting
        failure?: Error
        closed: boolean
      }
    | undefined

  constructor(options: DirectDeliverySourceOptions) {
    this.session = new SourceSession(options)
    this.id = this.session.id
    this.requiredDurability = options.allowVolatileReceipts === true ? undefined : 'durable'
    this.maximumQueued = options.maximumQueuedDeliveries ?? 16
    if (
      !Number.isSafeInteger(this.maximumQueued) ||
      this.maximumQueued < 1 ||
      this.maximumQueued > 1024
    )
      throw new OutputProtocolError('invalid', 'Invalid direct-delivery queue bound')
  }
  open(input: SourceRequest, signal: AbortSignal): AsyncIterable<SourceBatch> {
    const request = this.session.begin(input, signal)
    const active: NonNullable<DirectDeliverySource['active']> = {
      request,
      signal,
      queue: [],
      bytes: 0,
      closed: false,
      cancel: () =>
        this.finish(active, new OutputProtocolError('cancelled', 'Direct delivery cancelled'))
    }
    this.active = active
    signal.addEventListener('abort', active.cancel, { once: true })
    if (signal.aborted) active.cancel()
    const iterator: AsyncIterableIterator<SourceBatch> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        if (active.waiting)
          throw new OutputProtocolError('conflict', 'Delivery read already pending')
        if (active.failure) throw active.failure
        if (active.closed) return { done: true, value: undefined }
        if (active.current) {
          active.bytes -= active.current.bytes
          active.current.resolve()
          active.current = undefined
        }
        const delivery = active.queue.shift()
        if (delivery) {
          active.current = delivery
          return { done: false, value: delivery.batch }
        }
        return new Promise<IteratorResult<SourceBatch>>((resolve, reject) => {
          active.waiting = { resolve, reject }
        })
      },
      return: async () => {
        this.finish(active)
        return { done: true, value: undefined }
      },
      throw: async (error: unknown) => {
        this.finish(
          active,
          error instanceof Error
            ? error
            : new OutputProtocolError('unavailable', 'Delivery consumer failed')
        )
        throw active.failure
      }
    }
    return iterator
  }
  /** Transport code may acknowledge its sender only after this promise resolves. */
  deliver(input: DirectDelivery): Promise<void> {
    const active = this.active
    if (!active || active.closed)
      return Promise.reject(
        new OutputProtocolError('unavailable', 'Direct source is not open', true)
      )
    let batch: SourceBatch, bytes: number
    try {
      batch = this.session.batch(active.request, [
        { id: outputString(input.id), sequence: '0', observations: input.observations }
      ])
      bytes = new TextEncoder().encode(canonicalOutputJSON(batch)).length
      if (
        active.queue.length + (active.current ? 1 : 0) >= this.maximumQueued ||
        active.bytes + bytes > active.request.limits.pendingBytes
      )
        throw new OutputProtocolError(
          'limited',
          'Direct-delivery ingress queue overflow; reconcile the source',
          true
        )
    } catch (error) {
      if (error instanceof OutputProtocolError && error.code === 'limited')
        this.finish(active, error)
      return Promise.reject(error)
    }
    const result = new Promise<void>((resolve, reject) => {
      const delivery: Delivery = { batch, bytes, resolve, reject }
      active.bytes += bytes
      if (active.waiting) {
        active.current = delivery
        active.waiting.resolve({ done: false, value: batch })
        active.waiting = undefined
      } else active.queue.push(delivery)
    })
    // A callback transport may attach its own handler after this synchronous turn.
    void result.catch(() => {})
    return result
  }
  close(): void {
    if (this.active) this.finish(this.active)
  }
  private finish(active: NonNullable<DirectDeliverySource['active']>, error?: Error): void {
    if (active.closed) return
    active.closed = true
    active.failure = error
    const unacknowledged =
      error ??
      new OutputProtocolError('cancelled', 'Receipt acknowledgement was not confirmed', true)
    active.current?.reject(unacknowledged)
    for (const delivery of active.queue) delivery.reject(unacknowledged)
    active.current = undefined
    active.queue = []
    active.bytes = 0
    if (error) active.waiting?.reject(error)
    else active.waiting?.resolve({ done: true, value: undefined })
    active.waiting = undefined
    active.signal.removeEventListener('abort', active.cancel)
    if (this.active === active) this.active = undefined
    this.session.end()
  }
}
