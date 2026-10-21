import type { OutputJSONObject } from '@bsv/sdk'

/** Bounded local workflow state. This is not a Bitcoin receipt or remote authority. */
export interface OperationStateSnapshot {
  revision: string
  value: OutputJSONObject
}
export interface OperationStateResult {
  status: 'updated' | 'replayed' | 'conflict'
  revision: string
}
export interface OperationStateStore {
  readonly namespace: string
  readonly durability: 'volatile' | 'durable'
  /** Owned copies of the immutable binding and capacities; validate these when composing ports. */
  readonly configuration: { binding: OutputJSONObject; limits: OperationStateLimits }
  read(): Promise<OperationStateSnapshot>
  compareAndSwap(expectedRevision: string, value: OutputJSONObject): Promise<OperationStateResult>
  close(): Promise<void>
}
export interface OperationStateLimits {
  /** Includes the immutable namespace, binding and limit envelope. */
  configurationBytes: number
  /** Mutable state is stored separately from configuration. */
  stateBytes: number
}
export const DEFAULT_OPERATION_STATE_LIMITS: Readonly<OperationStateLimits> = Object.freeze({
  configurationBytes: 2 * 1024 * 1024,
  stateBytes: 4 * 1024 * 1024
})
