import type { Knex } from 'knex'
import type { Brc38ImportJournalReceipt } from './Brc38ImportJournalCore'
import { validPrimary, type FixedProfile, type State } from './Brc38PublishedProfileReceiptNode'

/** Shared original data checks. This function issues no profile, producer or activation authority. */
export async function verifyBrc38PublishedWalletData(
  k: Knex,
  fixed: FixedProfile,
  state: State,
  receipt: Readonly<Brc38ImportJournalReceipt>
): Promise<void> {
  const users: Array<{ userId: number; identityKey: string; activeStorage: string }> = await k('users')
    .select('userId', 'identityKey', 'activeStorage')
    .limit(2)
  const settings: Array<{ chain: string; storageIdentityKey: string }> = await k('settings')
    .select('chain', 'storageIdentityKey')
    .limit(2)
  if (
    receipt.state !== 'COMPLETE' ||
    receipt.nextRow !== fixed.admission.totalRows ||
    users.length !== 1 ||
    users[0]?.userId !== fixed.admission.scope.userId ||
    users[0].identityKey !== fixed.binding.identityKey ||
    settings.length !== 1 ||
    settings[0]?.chain !== fixed.binding.chain ||
    settings[0].storageIdentityKey !== fixed.binding.targetStorageIdentityKey ||
    !validPrimary(state, users[0].activeStorage, fixed.binding.targetStorageIdentityKey, fixed)
  )
    throw new Error('Published profile native identity, chain, completion or primary differs')
}
