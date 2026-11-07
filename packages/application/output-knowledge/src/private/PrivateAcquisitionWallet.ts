import type {
  PrivateAcquisitionProgress,
  PrivateAcquisitionWalletReceipt
} from './PrivateAcquisitionProgress.js'
export type PrivateAcquisitionWalletOutcome =
  | { state: 'absent' | 'unknown' }
  | { state: 'rejected'; operationId: string; reason: string }
  | { state: 'accepted'; receipt: PrivateAcquisitionWalletReceipt }

/**
 * Installed native credit capability. Acceptance requires atomic credit/receipt
 * ownership or equivalent durable idempotency; ordinary internalizeAction is not
 * sufficient. Caller first commits funding-pending with the exact operation.
 * Physical calls remain charged to bounded work until settled despite cancellation.
 */
export interface PrivateAcquisitionWallet {
  status(
    state: PrivateAcquisitionProgress,
    signal: AbortSignal
  ): Promise<PrivateAcquisitionWalletOutcome>
  internalize(
    state: PrivateAcquisitionProgress,
    signal: AbortSignal
  ): Promise<PrivateAcquisitionWalletOutcome>
}
