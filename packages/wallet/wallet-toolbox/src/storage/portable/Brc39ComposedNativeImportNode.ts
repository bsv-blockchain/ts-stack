import type { WalletStorageManager } from '../WalletStorageManager'
import {
  withAuthenticatedBrc39NativeMerge,
  type Brc38AuthenticatedNativeMergeOptions,
  type Brc38AuthenticatedNativeMergeResult
} from './Brc38AuthenticatedNativeMergeNode'
import { copyBrc38AuthenticatedPrivateStageOptions } from './Brc38AuthenticatedPrivateStageNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode } from './Brc38PrivateNativeMergeNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import {
  cutoverBrc38ComposedNativeProfile,
  type Brc38ComposedNativeCutoverResult
} from './Brc38ComposedNativeCutoverNode'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc39ComposedNativeImportOptions extends Brc38AuthenticatedNativeMergeOptions {
  readonly sourceInventory: Brc38ProfileInventoryNode
  readonly sourceProfile: Brc38PublishedProfileNode
  readonly targetInventory: Brc38ProfileInventoryNode
  readonly manager: WalletStorageManager
}
export interface Brc39ComposedNativeImportResult extends Brc38ComposedNativeCutoverResult {
  /** Actual current managed profile for subsequent source operations. Every
   * later operation still reacquires current inventory/kernel membership. */
  readonly profile: Brc38PublishedProfileNode
  readonly reservationId: string
  readonly archiveSha256: string
  /** Statistics from the completed private composition, never an activation
   * grant or a claim about customer writes after provider installation. */
  readonly inventory: Brc38AuthenticatedNativeMergeResult['inventory']
}

/** Authenticated envelope -> bounded occupied merge -> independent inactive
 * publication -> actual final source retirement -> full native target
 * reconstruction -> original manager replacement. All original resource and
 * custody limits survive the handoffs. A changed source stops before its
 * retirement; interruption retains the original reservation and durable target
 * for explicit recovery. This first-attempt controller never discards an
 * existing target, creates a replacement import ID or renews expiry. */
export async function importBrc39ComposedNativeProfile(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc39ComposedNativeImportOptions
): Promise<Readonly<Brc39ComposedNativeImportResult>> {
  const storage = selected.storage,
    manager = selected.manager,
    sourceInventory = selected.sourceInventory,
    sourceProfile = selected.sourceProfile,
    targetInventory = selected.targetInventory,
    source = copyBrc38AuthenticatedPrivateStageOptions(selected.source),
    resources = brc38StructuredRestoreResources(
      source.limits,
      selected.merge.structuredResources,
      selected.merge.maximumStepBytes
    ),
    merge = Object.freeze({
      ...selected.merge,
      receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(selected.merge.receiptPolicy) }),
      structuredResources: resources
    }),
    options: Readonly<Brc38AuthenticatedNativeMergeOptions> = Object.freeze({
      storage,
      admission: selected.admission,
      source,
      merge,
      executable: selected.executable,
      maximumOperations: selected.maximumOperations,
      progress: selected.progress
    })
  Brc38PublishedProfileNode.assertNativeManagedProvider(storage, manager)
  await Brc38PublishedProfileNode.assertNativeProviderInventory(sourceProfile, storage, sourceInventory)
  return await withAuthenticatedBrc39NativeMerge(encrypted, password, options, async (reservation, result) => {
    const store = reservation.store,
      binding = store.binding
    if (binding === undefined) throw new Error('Composed import lost its original authenticated stage')
    let target: Brc38PublishedProfileNode | undefined
    try {
      target = await Brc38NativeLocalBaselineSource.with(
        storage,
        { ...binding.binding, mode: 'merge' },
        merge.receiptPolicy,
        {
          workingAllocation: merge.workingAllocation,
          maximumMetadataBytes: 131072,
          maximumReadBytes: merge.maximumReadBytes,
          expiresAt: store.limits.expiresAt,
          signal: merge.signal
        },
        async actualSource =>
          await Brc38PrivateNativeMergeNode.with(store, actualSource, merge, async actualMerge => {
            const status = await actualMerge.status()
            if (
              status.phase !== 'IMPORT' ||
              status.sourceChanged ||
              status.receipt?.state !== 'COMPLETE' ||
              status.admission === undefined
            )
              throw new Error('Composed publication requires the current completed original merge')
            return await Brc38ProfileInventoryNode.receiveComparedComposition(
              targetInventory,
              store,
              status.admission,
              actualMerge,
              merge.signal
            )
          })
      )
      // The actual receiving copy and source/merge scopes have fully drained.
      // Keep the same original authenticated kernel and its comparison freeze.
      await store.reopenComparedNativeSql()
      const cutover = await cutoverBrc38ComposedNativeProfile({
        sourceInventory,
        sourceProfile,
        sourceProvider: storage,
        manager,
        targetInventory,
        targetProfile: target,
        store,
        merge,
        executable: options.executable
      })
      return Object.freeze({
        ...cutover,
        profile: target,
        reservationId: result.reservationId,
        archiveSha256: result.archiveSha256,
        inventory: result.inventory
      })
    } catch (cause) {
      // Closing releases physical custody only. Durable READY/retirement and
      // the manager's forward barrier remain available to the recovery path.
      if (target !== undefined && !target.ownershipReleased) {
        try {
          await target.close()
        } catch (error_) {
          throw new Brc38StagingCleanupError(
            [cause, error_],
            'Composed import target retains physical cleanup',
            async () => await target!.close()
          )
        }
      }
      throw cause
    }
  })
}
