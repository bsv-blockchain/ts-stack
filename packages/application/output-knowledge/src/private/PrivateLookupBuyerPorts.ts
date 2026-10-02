import type {
  OutputJSONObject,
  OutputPaidLookupAcquire,
  OutputPaidLookupAcquired,
  OutputPaidLookupChallenge,
  OutputPaidLookupPayment
} from '@bsv/sdk'

/** Explicit durable local capability. Ordinary BRC-100 alone does not supply it. */
export interface PrivateLookupBuyerPayment {
  readonly configuration: OutputJSONObject
  /** Derivation and construction only; no allocation, signature or broadcast. */
  plan(
    operationId: string,
    challenge: OutputPaidLookupChallenge,
    derivationSuffix: string,
    signal: AbortSignal
  ): Promise<OutputJSONObject>
  /** Reconcile the original action without allocating or signing. */
  recover(plan: OutputJSONObject, signal: AbortSignal): Promise<PrivateLookupBuyerPaymentOutcome>
  /** Recover first, then perform explicitly authorized NEW preparation/signing. */
  finish(
    plan: OutputJSONObject,
    checkNewWork: () => void,
    signal: AbortSignal
  ): Promise<OutputPaidLookupPayment>
}
export type PrivateLookupBuyerPaymentOutcome =
  { state: 'absent' | 'prepared' } | { state: 'finalized'; payment: OutputPaidLookupPayment }

/** Installed application policy, independent of a seller's authenticated report. */
export interface PrivateLookupBuyerValidation {
  readonly id: string
  verify(
    request: OutputPaidLookupAcquire,
    challenge: OutputPaidLookupChallenge,
    payment: OutputPaidLookupPayment,
    delivered: OutputPaidLookupAcquired,
    signal: AbortSignal
  ): Promise<void>
  usable(delivered: OutputPaidLookupAcquired, signal: AbortSignal): Promise<boolean>
}
