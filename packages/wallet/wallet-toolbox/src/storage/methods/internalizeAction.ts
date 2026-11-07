import type { InternalizeActionArgs } from '@bsv/sdk'
import type { StorageProvider } from '../StorageProvider'
import type { AuthId, StorageInternalizeActionResult } from '../../sdk/WalletStorage.interfaces'
import { internalizeActionCore } from './internalizeActionCore'
import type { InternalizeReceiptClaim } from './InternalizeReceiptClaim'
export type { InternalizeReceiptClaim } from './InternalizeReceiptClaim'
export { markUserInputsSpent, restoreInputsToSpendable, type SpentInputTransition } from './internalizeActionCore'

/** Preserve the historical ordinary schema, ownership, merge and receipt-fence API. */
export async function internalizeAction(
  storage: StorageProvider,
  auth: AuthId,
  args: InternalizeActionArgs,
  receipt?: InternalizeReceiptClaim
): Promise<StorageInternalizeActionResult> {
  return await internalizeActionCore(storage, auth, args, null, undefined, receipt)
}
