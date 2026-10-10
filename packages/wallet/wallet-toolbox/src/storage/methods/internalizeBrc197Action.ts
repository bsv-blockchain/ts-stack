import type { StorageProvider } from '../StorageProvider'
import type { AuthId, StorageInternalizeActionResult } from '../../sdk/WalletStorage.interfaces'
import {
  BRC197_INTERNALIZATION_PROFILE,
  ownBrc197InternalizeActionArgs,
  type Brc197InternalizeActionArgs
} from '../../sdk/Brc197Internalization'
import { internalizeActionCore } from './internalizeActionCore'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/** Shares the complete existing evidence, transactional ownership and rollback pipeline. */
export async function internalizeBrc197Action(
  storage: StorageProvider,
  auth: AuthId,
  args: Brc197InternalizeActionArgs
): Promise<StorageInternalizeActionResult> {
  const owned = ownBrc197InternalizeActionArgs(args)
  const owner = { ...auth }
  if (!Number.isSafeInteger(owner.userId) || owner.userId! <= 0)
    throw new WERR_INVALID_PARAMETER('auth', 'an authenticated storage user')
  const users = await storage.findUsers({ partial: { userId: owner.userId, identityKey: owner.identityKey } })
  if (users.length !== 1) throw new WERR_INVALID_PARAMETER('auth', 'the authenticated storage user identity')
  return await internalizeActionCore(storage, owner, owned, BRC197_INTERNALIZATION_PROFILE)
}
