import type { Wallet } from '../../Wallet'
import type { AuthId, StorageInternalizeActionResult } from '../../sdk/WalletStorage.interfaces'
import {
  BRC197_INTERNALIZATION_PROFILE,
  ownBrc197InternalizeActionArgs,
  type Brc197InternalizeActionArgs
} from '../../sdk/Brc197Internalization'
import { internalizeActionCore } from './internalizeActionCore'

/** Explicit local fixed-profile entry; no caller-selected validator or commit bypass. */
export async function internalizeBrc197Action(
  wallet: Wallet,
  auth: AuthId,
  args: Brc197InternalizeActionArgs
): Promise<StorageInternalizeActionResult> {
  return await internalizeActionCore(wallet, auth, ownBrc197InternalizeActionArgs(args), BRC197_INTERNALIZATION_PROFILE)
}
