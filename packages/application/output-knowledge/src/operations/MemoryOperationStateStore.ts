import { OutputProtocolError, type OutputJSONObject } from '@bsv/sdk'
import {
  OperationStateCodec,
  type OperationStateLimits,
  type OperationStateStore,
  type OperationStateSnapshot,
  type OperationStateResult,
  type StoredOperationState
} from './OperationStateStore.js'

/** Volatile reference adapter; a process loss destroys its workflow state. */
export class MemoryOperationStateStore implements OperationStateStore {
  readonly durability = 'volatile' as const
  private readonly codec: OperationStateCodec
  private row: StoredOperationState
  private closed = false

  constructor(
    readonly namespace: string,
    binding: OutputJSONObject,
    initial: OutputJSONObject,
    limits: Partial<OperationStateLimits> = {}
  ) {
    this.codec = new OperationStateCodec(namespace, binding, limits)
    this.row = this.codec.initial(initial)
  }

  private ready(): void {
    if (this.closed) throw new OutputProtocolError('unavailable', 'Operation state store is closed')
  }
  get configuration(): OperationStateStore['configuration'] {
    return this.codec.configurationValue()
  }
  async read(): Promise<OperationStateSnapshot> {
    this.ready()
    return this.codec.snapshot(this.row)
  }
  async compareAndSwap(
    expectedRevision: string,
    value: OutputJSONObject
  ): Promise<OperationStateResult> {
    this.ready()
    const { result, next } = this.codec.plan(this.row, expectedRevision, this.codec.encode(value))
    if (next) this.row = next
    return result
  }
  async close(): Promise<void> {
    this.closed = true
  }
}
