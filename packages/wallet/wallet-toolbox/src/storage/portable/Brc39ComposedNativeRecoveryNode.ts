import type { WalletStorageManager } from '../WalletStorageManager'
import type { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { copyBrc38AuthenticatedPrivateStageOptions } from './Brc38AuthenticatedPrivateStageNode'
import { Brc38PendingComposedNativeTargetError } from './Brc38PendingComposedNativeTargetError'
import { restartCompletedBrc38NativeProfile } from './Brc38CompletedNativeRestartNode'
import { recoverPendingBrc39ComposedNativeImport } from './Brc39PendingComposedRecoveryNode'
import {
  recoverExpiredPendingBrc39ComposedNativeImport,
  type Brc39ExpiredPendingComposedRecoveryOptions
} from './Brc39ExpiredPendingComposedRecoveryNode'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

/** Process restart only. A retained original manager must use its owned
 * transition through the separate same-process pending recovery API. */
export interface Brc39ComposedNativeRecoveryOptions extends Omit<
  Brc39ExpiredPendingComposedRecoveryOptions,
  'originalManager'
> {
  readonly originalManager?: never
}
export interface Brc39ComposedNativeRecoveryResult {
  readonly manager: WalletStorageManager
  readonly profile: Brc38PublishedProfileNode
  readonly importId: string
  readonly originalReservationId: string
  readonly archiveSha256: string
  readonly recovered: 'COMPLETED_CURRENT' | 'LIVE_PENDING' | 'EXPIRED_PENDING'
}

/** Recover the exact named target after process/ACK loss. Completed-current
 * restart independently verifies its durable commit, actual retired source
 * and full current wallet, so successful customer writes are preserved.
 * Only the explicit absent-commit result routes to a fresh pending factory;
 * corruption, wrong identities, cancellation and cleanup failures propagate.
 * Pending recovery authenticates the complete envelope. No consumed iterator
 * is retried and no old admission deadline is renewed. */
export async function recoverBrc39ComposedNativeImport(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc39ComposedNativeRecoveryOptions
): Promise<Readonly<Brc39ComposedNativeRecoveryResult>> {
  const source = copyBrc38AuthenticatedPrivateStageOptions(selected.source),
    resources = brc38StructuredRestoreResources(
      source.limits,
      selected.merge.structuredResources,
      selected.merge.maximumStepBytes
    ),
    originalMerge = Object.freeze({
      ...selected.merge,
      structuredResources: resources,
      receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(selected.merge.receiptPolicy) })
    }),
    target = selected.targetInventory,
    sourceInventory = selected.sourceInventory,
    admission = selected.admission,
    sourceImportId = selected.sourceImportId,
    sourceBindingSha256 = selected.sourceBindingSha256,
    targetImportId = selected.targetImportId,
    executable = selected.executable,
    services = selected.services,
    recovery = Object.freeze({ ...selected.recovery }),
    binding = brc38StagingBinding(source.binding, source.limits),
    expiresAt = recovery.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    selected.originalManager !== undefined ||
    source.reservationId === undefined ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 3600000 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(targetImportId) ||
    source.crypto.signal !== originalMerge.signal ||
    resources.sourcePolicy.signal !== originalMerge.signal ||
    resources.projectionPolicy.signal !== originalMerge.signal ||
    resources.sourcePolicy.workingAllocation !== originalMerge.workingAllocation ||
    resources.projectionPolicy.workingAllocation !== originalMerge.workingAllocation ||
    source.streamedFields === undefined ||
    source.streamedTextFields === undefined ||
    source.streamedStructuredFields === undefined ||
    source.streamedStructuredFields.staging.workingAllocation !== originalMerge.workingAllocation ||
    source.streamedStructuredFields.staging.signal !== originalMerge.signal ||
    JSON.stringify(source.streamedStructuredFields.staging) !== JSON.stringify(resources.sourcePolicy)
  )
    throw new Error(
      'Named composed restart requires the original resource packet and a distinct finite process-recovery purpose'
    )
  const lifetime = new AbortController(),
    signal =
      originalMerge.signal === undefined ? lifetime.signal : AbortSignal.any([originalMerge.signal, lifetime.signal]),
    expiry = setTimeout(
      () => lifetime.abort(new Error('Named composed restart monotonic deadline expired')),
      Math.max(1, Math.ceil(deadline - performance.now()))
    ),
    check = (): void => {
      signal.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Named composed restart current purpose expired')
    },
    readPolicy = Object.freeze({
      workingAllocation: originalMerge.workingAllocation,
      maximumReadBytes: originalMerge.maximumReadBytes,
      expiresAt,
      signal
    }),
    merge = Object.freeze({
      ...originalMerge,
      signal,
      structuredResources: Object.freeze({
        ...resources,
        sourcePolicy: Object.freeze({ ...resources.sourcePolicy, signal }),
        projectionPolicy: Object.freeze({ ...resources.projectionPolicy, signal })
      })
    }),
    pendingSource = Object.freeze({
      ...source,
      crypto: Object.freeze({ ...source.crypto, signal }),
      streamedStructuredFields: Object.freeze({
        ...source.streamedStructuredFields,
        staging: Object.freeze({ ...source.streamedStructuredFields.staging, signal })
      })
    }),
    pending = Object.freeze({
      admission,
      source: pendingSource,
      merge,
      sourceInventory,
      sourceImportId,
      sourceBindingSha256,
      targetInventory: target,
      targetImportId,
      executable,
      services,
      recovery
    })
  let manager: WalletStorageManager | undefined
  try {
    check()
    let recovered: Brc39ComposedNativeRecoveryResult['recovered']
    try {
      const current = await restartCompletedBrc38NativeProfile({
        targetInventory: target,
        sourceInventory,
        importId: targetImportId,
        bindingSha256: binding.digest,
        executable,
        services,
        receiptPolicy: originalMerge.receiptPolicy,
        readPolicy
      })
      manager = current.manager
      recovered = 'COMPLETED_CURRENT'
    } catch (cause) {
      if (!Brc38PendingComposedNativeTargetError.matches(cause, targetImportId, binding.digest)) throw cause
      check()
      if (Date.now() < source.limits.expiresAt) {
        manager = (await recoverPendingBrc39ComposedNativeImport(encrypted, password, pending)).manager
        recovered = 'LIVE_PENDING'
      } else {
        manager = (await recoverExpiredPendingBrc39ComposedNativeImport(encrypted, password, pending)).manager
        recovered = 'EXPIRED_PENDING'
      }
    }
    check()
    if (manager === undefined) throw new Error('Named composed restart did not return an actual manager')
    const profile = await target.currentNativeProfile(targetImportId, binding.digest, manager, readPolicy)
    check()
    return Object.freeze({
      manager,
      profile,
      importId: targetImportId,
      originalReservationId: source.reservationId,
      archiveSha256: binding.binding.archiveSha256,
      recovered
    })
  } catch (cause) {
    if (manager !== undefined) {
      const retained = manager
      try {
        await target.closeNamedRecoveryManager(targetImportId, binding.digest, retained)
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Named composed restart retains unreturned target cleanup',
          async () => await target.closeNamedRecoveryManager(targetImportId, binding.digest, retained)
        )
      }
    }
    throw cause
  } finally {
    clearTimeout(expiry)
  }
}
