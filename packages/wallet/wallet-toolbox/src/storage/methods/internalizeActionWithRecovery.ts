import type { InternalizeActionArgs } from '@bsv/sdk'
import type { StorageProvider } from '../StorageProvider'
import type { AuthId, StorageInternalizeActionResult } from '../../sdk/WalletStorage.interfaces'
import type { FundingRecoveryCommit } from '../fundingRecovery/FundingRecoveryCommit'
import type { InternalizeReceiptClaim } from './InternalizeReceiptClaim'
import { internalizeActionCore } from './internalizeActionCore'

/** Explicit local funding recovery; the ordinary internalizeAction API stays unchanged. */
export async function internalizeActionWithRecovery(
  storage: StorageProvider,
  auth: AuthId,
  args: InternalizeActionArgs,
  recovery: FundingRecoveryCommit,
  receipt?: InternalizeReceiptClaim
): Promise<StorageInternalizeActionResult> {
  return await internalizeActionCore(storage, auth, args, null, recovery, receipt)
}
