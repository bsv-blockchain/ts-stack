import type { OutputPurchaseSubmit } from '@bsv/sdk'
import type { PrivatePurchaseOriginal } from './PrivatePurchaseContracts.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'

/** Installed durable proof custody. The original financial candidate and first
 * delivered result remain separate immutable records. This port does not
 * establish Script validity, inclusion or selected-chain authority. */
export interface PrivatePurchaseEvidence {
  readonly id: string
  reserve(original: PrivatePurchaseOriginal, clock: () => string, guard: ProtectedLedgerGuard): void
  read(
    original: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseEvidenceView
  propose(
    original: PrivatePurchaseOriginal,
    candidate: OutputPurchaseSubmit,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseEvidencePlan
}
export interface PrivatePurchaseEvidenceView {
  candidate: OutputPurchaseSubmit | null
  /** Recheck exact original native proof revision inside the effect's writer gate. */
  checkCurrent: ProtectedLedgerGuard
}
export interface PrivatePurchaseEvidencePlan extends PrivatePurchaseEvidenceView {
  candidate: OutputPurchaseSubmit
  /** Call only after independent verification of incoming AND combined evidence.
   * Authorization and both verification contexts must still hold at commit. */
  retain(clock: () => string, guard: ProtectedLedgerGuard): void
}
