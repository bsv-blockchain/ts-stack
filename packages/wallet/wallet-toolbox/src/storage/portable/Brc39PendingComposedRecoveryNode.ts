import { WalletStorageManager } from '../WalletStorageManager'
import type { StorageKnex } from '../StorageKnex'
import { Brc38PublishedProfileNode, type Brc38PendingNativeManagerRecovery } from './Brc38PublishedProfileNode'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import type { Brc38StagingAdmissionNode, Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import {
  authenticateBrc39PrivateNativeImport,
  copyBrc38AuthenticatedPrivateStageOptions,
  type Brc38AuthenticatedPrivateStageOptions
} from './Brc38AuthenticatedPrivateStageNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { Brc38AuthenticatedNativeMergeInterruptedError } from './Brc38AuthenticatedNativeMergeNode'

export interface Brc39PendingComposedRecoveryOptions {
  readonly admission: Brc38StagingAdmissionNode
  readonly source: Brc38AuthenticatedPrivateStageOptions
  readonly merge: Brc38PrivateNativeMergeOptions
  readonly sourceInventory: Brc38ProfileInventoryNode
  /** Original address DATA: actual inventory and retired kernel independently
   * validate this exact source. Wrong addresses cannot pick another target. */
  readonly sourceImportId: string
  readonly sourceBindingSha256: string
  readonly targetInventory: Brc38ProfileInventoryNode
  readonly executable: string
  readonly services: WalletServices
  /** Optional exact target address for controllers routing an interrupted import. */
  readonly targetImportId?: string
  /** Resume behind the existing manager's retirement barrier. Omit only for
   * process restart, where no original in-memory manager remains. */
  readonly originalManager?: Readonly<{
    profile: Brc38PublishedProfileNode
    provider: StorageKnex
    manager: WalletStorageManager
  }>
}
export interface Brc39PendingComposedRecoveryResult {
  readonly manager: WalletStorageManager
  readonly reservationId: string
  readonly archiveSha256: string
}

/** Resume a pending composition in a new process while the ORIGINAL private
 * reservation is still live. Fresh complete envelope authentication precedes
 * a genuine retired-source snapshot, complete candidate reconstruction and
 * independent target activation. No live source provider/old manager is opened
 * or reactivated. Expired reservations and completed current profiles require
 * their separate recovery policies; this path never renews an import lease. */
export async function recoverPendingBrc39ComposedNativeImport(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc39PendingComposedRecoveryOptions
): Promise<Readonly<Brc39PendingComposedRecoveryResult>> {
  const source = copyBrc38AuthenticatedPrivateStageOptions(selected.source),
    sourceInventory = selected.sourceInventory,
    targetInventory = selected.targetInventory,
    sourceImportId = selected.sourceImportId,
    sourceBindingSha256 = selected.sourceBindingSha256,
    admission = selected.admission,
    executable = selected.executable,
    services = selected.services,
    targetImportId = selected.targetImportId,
    originalManager =
      selected.originalManager === undefined
        ? undefined
        : Object.freeze({
            profile: selected.originalManager.profile,
            provider: selected.originalManager.provider,
            manager: selected.originalManager.manager
          }),
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
    expiresAt = source.limits.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    source.reservationId === undefined ||
    source.streamedFields === undefined ||
    source.streamedTextFields === undefined ||
    source.streamedStructuredFields === undefined ||
    source.crypto.signal !== merge.signal ||
    resources.sourcePolicy.signal !== merge.signal ||
    resources.projectionPolicy.signal !== merge.signal ||
    resources.sourcePolicy.workingAllocation !== merge.workingAllocation ||
    resources.projectionPolicy.workingAllocation !== merge.workingAllocation ||
    source.streamedStructuredFields.staging.workingAllocation !== merge.workingAllocation ||
    source.streamedStructuredFields.staging.signal !== merge.signal ||
    JSON.stringify(source.streamedStructuredFields.staging) !== JSON.stringify(resources.sourcePolicy)
  )
    throw new Error('Pending encrypted recovery differs from its original authenticated resource packet')
  const check = (): void => {
    merge.signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline)
      throw new Error('Original pending composition recovery lifetime expired')
  }
  let reservation: Brc38StagingReservation | undefined,
    installedManager: WalletStorageManager | undefined,
    installedImportId: string | undefined,
    installedBindingSha256: string | undefined
  const cleanup = async (): Promise<void> => {
    await reservation?.store.close()
  }
  try {
    check()
    const authenticated = await authenticateBrc39PrivateNativeImport(encrypted, password, admission, source, executable)
    reservation = authenticated.reservation
    const store = reservation.store,
      policy = Object.freeze({
        workingAllocation: merge.workingAllocation,
        maximumReadBytes: merge.maximumReadBytes,
        expiresAt,
        signal: merge.signal
      })
    check()
    const recover = async (replacement?: Brc38PendingNativeManagerRecovery): Promise<WalletStorageManager> =>
      await Brc38ProfileInventoryNode.withRetiredNativeRead(
        sourceInventory,
        sourceImportId,
        sourceBindingSha256,
        executable,
        policy,
        async reader =>
          await Brc38NativeLocalBaselineSource.withRetired(
            reader,
            merge.receiptPolicy,
            { ...policy, maximumMetadataBytes: 131072 },
            async retired =>
              await Brc38PrivateNativeMergeNode.with(store, retired, merge, async actual => {
                check()
                const origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(retired),
                  status = await actual.status()
                if (
                  origin.retirement.target.rootId !== targetInventory.rootId ||
                  status.phase !== 'IMPORT' ||
                  status.sourceChanged ||
                  status.receipt?.state !== 'COMPLETE' ||
                  status.admission === undefined ||
                  (targetImportId !== undefined && status.admission.scope.importId !== targetImportId)
                )
                  throw new Error(
                    'Pending recovery requires the original durably complete candidate and named target inventory'
                  )
                const manager = await targetInventory.recoverPendingComposedNative(
                  status.admission.scope.importId,
                  store.binding!.digest,
                  executable,
                  actual,
                  store,
                  retired,
                  services,
                  replacement
                )
                installedManager = manager
                installedImportId = status.admission.scope.importId
                installedBindingSha256 = store.binding!.digest
                return manager
              })
          )
      )
    const manager =
      originalManager === undefined
        ? await recover()
        : ((await WalletStorageManager.prototype.withOwnedProviderTransition.call(
            originalManager.manager,
            originalManager.provider,
            { expiresAt, signal: merge.signal },
            async transition => {
              check()
              await Brc38PublishedProfileNode.closeRetiredNativeManagedOriginal(
                originalManager.profile,
                originalManager.provider,
                originalManager.manager,
                transition,
                sourceInventory
              )
              return await recover({
                original: originalManager.profile,
                provider: originalManager.provider,
                manager: originalManager.manager,
                transition
              })
            }
          )) as WalletStorageManager)
    await cleanup()
    check()
    return Object.freeze({ manager, reservationId: reservation.id, archiveSha256: authenticated.archiveSha256 })
  } catch (cause) {
    let failure = cause
    const closeUnreturned = async (): Promise<void> => {
        if (
          originalManager === undefined &&
          installedManager !== undefined &&
          installedImportId !== undefined &&
          installedBindingSha256 !== undefined
        )
          await targetInventory.closeNamedRecoveryManager(installedImportId, installedBindingSha256, installedManager)
      },
      drain = async (): Promise<void> => {
        await closeUnreturned()
        await cleanup()
      }
    try {
      await drain()
    } catch (error_) {
      failure = new Brc38StagingCleanupError(
        [cause, error_],
        'Pending encrypted composition retains unreturned target or private cleanup',
        async () => {
          await closeUnreturned()
          if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
          await cleanup()
        }
      )
    }
    throw new Brc38AuthenticatedNativeMergeInterruptedError(reservation?.id ?? source.reservationId, failure)
  }
}
