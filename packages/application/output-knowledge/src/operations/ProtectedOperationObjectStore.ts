import type { OutputJSONObject } from '@bsv/sdk'

/** Requests, retained contracts and delivered results use distinct original bindings.
 * Local immutable-object custody. A receipt proves retention, never validity or usability. */
export interface ProtectedOperationObjectReceipt {
  id: string
  bindingDigest: string
  maximumBytes: number
  bytes: number
  digest: string
}
export interface ProtectedOperationObjectReservation {
  id: string
  bindingDigest: string
  maximumBytes: number
}
export type ProtectedOperationObjectStatus =
  | { state: 'absent' }
  | { state: 'reserved'; reservation: ProtectedOperationObjectReservation }
  | { state: 'stored'; receipt: ProtectedOperationObjectReceipt; bytes: Uint8Array }
export interface ProtectedOperationObjectConfiguration {
  /** Independently retained original installation identity, not created during reopen. */
  storeId: string
  recipient: string
  /** Public installation binding only. Per-object bindings live in protected records. */
  binding: OutputJSONObject
  maximumObjects: number
  maximumObjectBytes: number
}
export interface ProtectedOperationObjectStore {
  readonly durability: 'durable'
  readonly configuration: ProtectedOperationObjectConfiguration
  /** Explicit, idempotent reservation before a payment; fills no object and performs no I/O to a seller. */
  reserve(
    id: string,
    originalBinding: OutputJSONObject,
    maximumBytes: number
  ): Promise<ProtectedOperationObjectReservation>
  /** Status only: absence never initializes a record. A stored object is immutable. */
  read(id: string, originalBinding: OutputJSONObject): Promise<ProtectedOperationObjectStatus>
  /** Requires an original reservation. A retry can recover only the byte-identical first object. */
  put(
    id: string,
    originalBinding: OutputJSONObject,
    bytes: Uint8Array
  ): Promise<ProtectedOperationObjectReceipt>
  close(): Promise<void>
}
