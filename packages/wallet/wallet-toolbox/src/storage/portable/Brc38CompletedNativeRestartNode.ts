import type { WalletStorageManager } from '../WalletStorageManager'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import type { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { Brc38RetiredNativeReadNode, type Brc38RetiredNativeReadPolicy } from './Brc38RetiredNativeReadNode'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38CompletedNativeRestartOptions {
  readonly targetInventory: Brc38ProfileInventoryNode
  readonly sourceInventory: Brc38ProfileInventoryNode
  readonly importId: string
  readonly bindingSha256: string
  readonly executable: string
  readonly receiptPolicy: SnapshotJournalReceiptPolicy
  readonly readPolicy: Brc38RetiredNativeReadPolicy
  readonly services: WalletServices
}
export interface Brc38CompletedNativeRestartResult {
  readonly profile: Brc38PublishedProfileNode
  readonly manager: WalletStorageManager
}

/** Restart an already completed composed wallet from its actual inventories.
 * The current target is validated using its current typed wallet data, not the
 * initial READY image. Its genuine retired source is independently opened at
 * the receipt-derived address. All source read scopes drain before activation
 * acquires the target inventory operation. Pending targets remain refused.
 * A fresh current read lifetime never renews the original import admission. */
export async function restartCompletedBrc38NativeProfile(
  selected: Brc38CompletedNativeRestartOptions
): Promise<Readonly<Brc38CompletedNativeRestartResult>> {
  const target = selected.targetInventory,
    source = selected.sourceInventory,
    importId = selected.importId,
    bindingSha256 = selected.bindingSha256,
    executable = selected.executable,
    services = selected.services,
    receiptPolicy = snapshotJournalReceiptPolicy(selected.receiptPolicy),
    policy = Brc38RetiredNativeReadNode.capturePolicy(selected.readPolicy),
    deadline = performance.now() + policy.expiresAt - Date.now()
  const check = (): void => {
    policy.signal?.throwIfAborted()
    if (Date.now() >= policy.expiresAt || performance.now() >= deadline)
      throw new Error('Completed native restart exceeded its original current read lifetime')
  }
  let profile: Brc38PublishedProfileNode | undefined
  try {
    check()
    profile = await target.openCompletedComposedNativeFromInventory(
      importId,
      bindingSha256,
      executable,
      source,
      receiptPolicy,
      policy
    )
    check()
    const manager = await profile.activateCompletedComposedNative(services, policy)
    check()
    return Object.freeze({ profile, manager })
  } catch (cause) {
    if (profile !== undefined) {
      try {
        await profile.close()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Completed current restart retains actual target cleanup',
          async () => await profile!.close()
        )
      }
    }
    throw cause
  }
}
