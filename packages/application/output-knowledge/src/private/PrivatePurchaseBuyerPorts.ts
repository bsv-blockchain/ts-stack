import type {
  OutputJSONObject,
  OutputPurchasePrepare,
  OutputSignedPurchaseTerms,
  OutputPurchaseSubmit,
  OutputPurchaseEnvelope
} from '@bsv/sdk'
/** Explicit durable wallet owner. A normal BRC100 wallet alone cannot reconcile
 * lost action replies and therefore is not an interchangeable implementation. */
export interface PrivatePurchaseBuyerPayment {
  readonly configuration: OutputJSONObject
  /** Guaranteed complete canonical submission bound, checked before new signing. */
  readonly maximumCandidateBytes: number
  /** Read-only original construction and independent lineage checks, no allocation/signing. */
  plan(
    operationId: string,
    request: OutputPurchasePrepare,
    terms: OutputSignedPurchaseTerms,
    signal: AbortSignal
  ): Promise<OutputJSONObject>
  /** Consult only the original native action. Unknown effects must remain unresolved. */
  recover(plan: OutputJSONObject, signal: AbortSignal): Promise<PrivatePurchaseBuyerPaymentOutcome>
  /** Reconcile first; explicitly permitted new work is fenced by original cutoff/currentness. */
  finish(
    plan: OutputJSONObject,
    checkNewWork: () => void,
    signal: AbortSignal
  ): Promise<OutputPurchaseSubmit>
}
export type PrivatePurchaseBuyerPaymentOutcome =
  { state: 'absent' | 'prepared' } | { state: 'finalized'; candidate: OutputPurchaseSubmit }
/** Installed independent application domain. Seller signatures and STEAK alone
 * never establish Script/lineage, release satisfaction, License or usable keys. */
export interface PrivatePurchaseBuyerValidation {
  readonly id: string
  preflight(
    request: OutputPurchasePrepare,
    terms: OutputSignedPurchaseTerms | null,
    signal: AbortSignal
  ): Promise<void>
  verify(
    request: OutputPurchasePrepare,
    terms: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit,
    delivered: OutputPurchaseEnvelope,
    signal: AbortSignal
  ): Promise<void>
  usable(delivered: OutputPurchaseEnvelope, signal: AbortSignal): Promise<boolean>
}
