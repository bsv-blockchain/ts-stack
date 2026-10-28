import { synchronousPromise } from '../internal/synchronousPromise.js'
import { OutputProtocolError, type OutputJSONObject } from '@bsv/sdk'
import {
  type OperationStateLimits,
  type OperationStateStore,
  type OperationStateSnapshot,
  type OperationStateResult
} from './OperationStateStore.js'
import { OperationStateCodec, type StoredOperationState } from './OperationStateCodec.js'

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
  read(): Promise<OperationStateSnapshot> {
    return synchronousPromise(() => {
      this.ready()
      return this.codec.snapshot(this.row)
    })
  }
  compareAndSwap(expectedRevision: string, value: OutputJSONObject): Promise<OperationStateResult> {
    return synchronousPromise(() => {
      this.ready()
      const { result, next } = this.codec.plan(this.row, expectedRevision, this.codec.encode(value))
      if (next) this.row = next
      return result
    })
  }
  close(): Promise<void> {
    return synchronousPromise(() => {
      this.closed = true
    })
  }
}
