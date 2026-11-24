import type { InternalizeActionArgs } from '@bsv/sdk'
import type { Wallet } from '../../Wallet'
import type { AuthId, StorageInternalizeActionResult } from '../../sdk/WalletStorage.interfaces'
import { internalizeActionCore } from './internalizeActionCore'

/** Historical ordinary BRC-100/BRC-29 entry; schema and behavior are unchanged. */
export async function internalizeAction(
  wallet: Wallet,
  auth: AuthId,
  args: InternalizeActionArgs,
  commit?: (args: InternalizeActionArgs) => Promise<StorageInternalizeActionResult>
): Promise<StorageInternalizeActionResult> {
  return await internalizeActionCore(wallet, auth, args, null, commit)
}
