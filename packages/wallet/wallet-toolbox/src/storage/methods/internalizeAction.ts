import type { InternalizeActionArgs } from '@bsv/sdk'
import type { StorageProvider } from '../StorageProvider'
import type { AuthId, StorageInternalizeActionResult } from '../../sdk/WalletStorage.interfaces'
import type { FundingRecoveryCommit } from '../fundingRecovery/FundingRecoveryCommit'
import { internalizeActionCore } from './internalizeActionCore'
import type { InternalizeReceiptClaim } from './InternalizeReceiptClaim'
export type { InternalizeReceiptClaim } from './InternalizeReceiptClaim'
export { markUserInputsSpent, restoreInputsToSpendable, type SpentInputTransition } from './internalizeActionCore'

/** Ordinary schema, ownership, merge and funding-recovery behavior is preserved. */
export async function internalizeAction(
  storage: StorageProvider,
  auth: AuthId,
  args: InternalizeActionArgs,
  recovery?: FundingRecoveryCommit,
  receipt?: InternalizeReceiptClaim
): Promise<StorageInternalizeActionResult> {
  return await internalizeActionCore(storage, auth, args, null, recovery, receipt)
}
