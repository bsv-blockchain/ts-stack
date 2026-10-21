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
  /** Check original domain terms and selected material before any new quote or payment.
   * Null challenge checks discovery; a retained challenge must also match those terms.
   * This must not allocate, sign, broadcast, or release delivered plaintext.
   */
  preflight(
    request: OutputPaidLookupAcquire,
    challenge: OutputPaidLookupChallenge | null,
    signal: AbortSignal
  ): Promise<void>
  verify(
    request: OutputPaidLookupAcquire,
    challenge: OutputPaidLookupChallenge,
    payment: OutputPaidLookupPayment,
    delivered: OutputPaidLookupAcquired,
    signal: AbortSignal
  ): Promise<void>
  usable(delivered: OutputPaidLookupAcquired, signal: AbortSignal): Promise<boolean>
}
