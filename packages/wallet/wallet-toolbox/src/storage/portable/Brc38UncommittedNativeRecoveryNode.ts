import { WalletStorageManager } from '../WalletStorageManager'
import type { StorageKnex } from '../StorageKnex'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import type { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38RetiredNativeReadNode, type Brc38RetiredNativeReadPolicy } from './Brc38RetiredNativeReadNode'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38UncommittedNativeRecoveryOptions {
  readonly originalProfile: Brc38PublishedProfileNode
  readonly originalProvider: StorageKnex
  readonly manager: WalletStorageManager
  readonly inventory: Brc38ProfileInventoryNode
  /** Required when the original current wallet was itself composed earlier. */
  readonly priorSourceInventory?: Brc38ProfileInventoryNode
  readonly executable: string
  readonly readPolicy: Brc38RetiredNativeReadPolicy
  readonly receiptPolicy: SnapshotJournalReceiptPolicy
  readonly services: WalletServices
}
export interface Brc38UncommittedNativeRecoveryResult {
  readonly profile: Brc38PublishedProfileNode
  readonly provider: StorageKnex
  readonly manager: WalletStorageManager
}

/** Recover a no-decision source freeze. The original manager remains blocked
 * while the real frozen owner/catalog are inspected and physically drained.
 * Fresh inventory/kernel reopening must still prove the source ACTIVE/current,
 * exact original binding and absence of retirement before preparing a new
 * provider for the SAME wallet. Committed retirement always refuses. This
 * imports no payload and never reactivates a durably retired source. */
export async function recoverUncommittedBrc38NativeSource(
  selected: Brc38UncommittedNativeRecoveryOptions
): Promise<Readonly<Brc38UncommittedNativeRecoveryResult>> {
  const original = selected.originalProfile,
    provider = selected.originalProvider,
    manager = selected.manager,
    root = selected.inventory,
    prior = selected.priorSourceInventory,
    executable = selected.executable,
    services = selected.services,
    policy = Brc38RetiredNativeReadNode.capturePolicy(selected.readPolicy),
    receiptPolicy = snapshotJournalReceiptPolicy(selected.receiptPolicy),
    deadline = performance.now() + policy.expiresAt - Date.now()
  const check = (): void => {
    policy.signal?.throwIfAborted()
    if (Date.now() >= policy.expiresAt || performance.now() >= deadline)
      throw new Error('Uncommitted native source recovery expired')
  }
  return (await WalletStorageManager.prototype.withOwnedProviderTransition.call(
    manager,
    provider,
    policy,
    async transition => {
      check()
      const address = await Brc38PublishedProfileNode.closeUncommittedNativeOriginal(
        original,
        provider,
        manager,
        transition,
        root
      )
      check()
      let profile: Brc38PublishedProfileNode | undefined
      try {
        if (address.composed && prior === undefined)
          throw new Error('Current composed source recovery requires its actual previous source inventory')
        profile = address.composed
          ? await root.openCompletedComposedNativeFromInventory(
              address.importId,
              address.bindingSha256,
              executable,
              prior!,
              receiptPolicy,
              policy
            )
          : await root.openNative(address.importId, address.bindingSha256, executable)
        check()
        const replacement = await profile.installUncommittedCurrentRecovery(
          root,
          { original, provider, manager, transition },
          policy,
          services
        )
        return Object.freeze({ profile, provider: replacement, manager })
      } catch (cause) {
        if (profile !== undefined) {
          try {
            await profile.close()
          } catch (error_) {
            throw new Brc38StagingCleanupError(
              [cause, error_],
              'Uncommitted native recovery retains its actual reopened owner',
              async () => await profile!.close()
            )
          }
        }
        throw cause
      }
    }
  )) as Readonly<Brc38UncommittedNativeRecoveryResult>
}
