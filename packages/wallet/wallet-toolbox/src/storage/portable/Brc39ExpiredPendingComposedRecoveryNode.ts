import { WalletStorageManager } from '../WalletStorageManager'
import { Brc38PublishedProfileNode, type Brc38PendingNativeManagerRecovery } from './Brc38PublishedProfileNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode } from './Brc38PrivateNativeMergeNode'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc39RecoveryAuthenticationNode } from './Brc39RecoveryAuthenticationNode'
import { Brc39RecoveryIncomingComparisonNode } from './Brc39RecoveryIncomingComparisonNode'
import { Brc38NativeRecoveryTemporaryQuota } from './Brc38NativeRecoveryScratchNode'
import { copyBrc38AuthenticatedPrivateStageOptions } from './Brc38AuthenticatedPrivateStageNode'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc39PendingComposedRecoveryOptions } from './Brc39PendingComposedRecoveryNode'

export interface Brc39ExpiredPendingComposedRecoveryOptions extends Brc39PendingComposedRecoveryOptions {
  /** Original import address DATA, independently checked against the copied
   * complete active episode and actual retired source's named target. */
  readonly targetImportId: string
  readonly recovery: Readonly<{
    privateParent: string
    expiresAt: number
    temporaryQuota: Brc38NativeRecoveryTemporaryQuota
  }>
}
export interface Brc39ExpiredPendingComposedRecoveryResult {
  readonly manager: WalletStorageManager
  readonly originalReservationId: string
  readonly archiveSha256: string
  readonly importId: string
}
/** Original address DATA and concrete cleanup cause only. Recovery never
 * resumes the expired staging reservation, and a lost commit ACK may require
 * the separate completed-current restart path. */
export class Brc39ExpiredPendingRecoveryInterruptedError extends Error {
  constructor(
    readonly originalReservationId: string,
    readonly importId: string,
    cause: unknown
  ) {
    super('Expired pending recovery stopped; recover the named pending or completed target', { cause })
    this.name = 'Brc39ExpiredPendingRecoveryInterruptedError'
  }
}
/** An expired reservation never regains mutable import admission. This NEW
 * finite purpose reauthenticates the whole encrypted envelope in a separate
 * reservation, copies the permanent pending target, compares all incoming
 * bytes, reconstructs all47 retired local semantics and independently resumes
 * the original named target. Original binding/expiry/budgets stay DATA. */
export async function recoverExpiredPendingBrc39ComposedNativeImport(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc39ExpiredPendingComposedRecoveryOptions
): Promise<Readonly<Brc39ExpiredPendingComposedRecoveryResult>> {
  const original = copyBrc38AuthenticatedPrivateStageOptions(selected.source),
    admission = selected.admission,
    sourceInventory = selected.sourceInventory,
    targetInventory = selected.targetInventory,
    sourceImportId = selected.sourceImportId,
    sourceBindingSha256 = selected.sourceBindingSha256,
    targetImportId = selected.targetImportId,
    executable = selected.executable,
    services = selected.services,
    recovery = Object.freeze({
      privateParent: selected.recovery.privateParent,
      expiresAt: selected.recovery.expiresAt,
      temporaryQuota: selected.recovery.temporaryQuota
    }),
    originalManager =
      selected.originalManager === undefined
        ? undefined
        : Object.freeze({
            profile: selected.originalManager.profile,
            provider: selected.originalManager.provider,
            manager: selected.originalManager.manager
          }),
    resources = brc38StructuredRestoreResources(
      original.limits,
      selected.merge.structuredResources,
      selected.merge.maximumStepBytes
    ),
    originalMerge = Object.freeze({
      ...selected.merge,
      receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(selected.merge.receiptPolicy) }),
      structuredResources: resources
    }),
    binding = brc38StagingBinding(original.binding, original.limits),
    expiresAt = recovery.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    !Number.isSafeInteger(original.limits.expiresAt) ||
    original.limits.expiresAt < 1 ||
    original.limits.expiresAt > Date.now() ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 3600000 ||
    original.reservationId === undefined ||
    original.streamedFields === undefined ||
    original.streamedTextFields === undefined ||
    original.streamedStructuredFields === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(targetImportId) ||
    original.crypto.signal !== originalMerge.signal ||
    resources.sourcePolicy.signal !== originalMerge.signal ||
    resources.projectionPolicy.signal !== originalMerge.signal ||
    resources.sourcePolicy.workingAllocation !== originalMerge.workingAllocation ||
    resources.projectionPolicy.workingAllocation !== originalMerge.workingAllocation ||
    original.streamedStructuredFields.staging.workingAllocation !== originalMerge.workingAllocation ||
    original.streamedStructuredFields.staging.signal !== originalMerge.signal ||
    JSON.stringify(original.streamedStructuredFields.staging) !== JSON.stringify(resources.sourcePolicy) ||
    !(recovery.temporaryQuota instanceof Brc38NativeRecoveryTemporaryQuota)
  )
    throw new Error(
      'Expired encrypted pending recovery requires original immutable resources and a distinct finite purpose'
    )
  // Reserve external derived indexes as well as the two independently charged
  // SQL families. A failed concrete drain retains this reservation until retry.
  const derivedExtent = Brc38NativeRecoveryTemporaryQuota.prototype.claim.call(
    recovery.temporaryQuota,
    resources.maximumCombinedTemporaryBytes
  )
  let cleanupRetained = false,
    installedManager: WalletStorageManager | undefined
  const lifetime = new AbortController(),
    signal =
      originalMerge.signal === undefined ? lifetime.signal : AbortSignal.any([originalMerge.signal, lifetime.signal]),
    merge = Object.freeze({
      ...originalMerge,
      signal,
      structuredResources: Object.freeze({
        ...resources,
        sourcePolicy: Object.freeze({ ...resources.sourcePolicy, signal }),
        projectionPolicy: Object.freeze({ ...resources.projectionPolicy, signal })
      })
    }),
    expiry = setTimeout(
      () => lifetime.abort(new Error('Expired pending recovery original captured monotonic deadline expired')),
      Math.max(1, Math.ceil(deadline - performance.now()))
    )
  const check = (): void => {
      signal.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Expired pending recovery new operation lifetime expired')
    },
    policy = Object.freeze({
      workingAllocation: merge.workingAllocation,
      maximumReadBytes: merge.maximumReadBytes,
      expiresAt,
      signal: merge.signal
    }),
    scratchPolicy = Object.freeze({
      ...policy,
      privateParent: recovery.privateParent,
      maximumPhysicalBytes: original.limits.maximumPhysicalBytes,
      temporaryQuota: recovery.temporaryQuota
    })
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
          async retired => {
            check()
            const origin = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(retired)
            if (origin.retirement.target.rootId !== targetInventory.rootId)
              throw new Error('Expired pending recovery names another actual target inventory')
            return await targetInventory.withExpiredPendingRecoveryCopy(
              targetImportId,
              binding.digest,
              executable,
              retired,
              scratchPolicy,
              async (scratch, activate) => {
                check()
                return await Brc39RecoveryAuthenticationNode.with(
                  encrypted,
                  password,
                  { original, admission, temporaryQuota: recovery.temporaryQuota, expiresAt, executable, signal },
                  async fresh =>
                    await KnexBrc38StagingStore.withRecoveryComparison(
                      scratch,
                      fresh,
                      original.limits,
                      executable,
                      async candidate =>
                        await Brc39RecoveryIncomingComparisonNode.with(
                          fresh,
                          candidate,
                          policy,
                          async incoming =>
                            await Brc38PrivateNativeMergeNode.with(candidate, retired, merge, async actual => {
                              check()
                              incoming.assertRetained()
                              const status = await actual.status()
                              if (
                                status.phase !== 'IMPORT' ||
                                status.sourceChanged ||
                                status.receipt?.state !== 'COMPLETE' ||
                                status.admission?.scope.importId !== targetImportId ||
                                candidate.binding?.digest !== binding.digest
                              )
                                throw new Error(
                                  'Expired recovery copied candidate is not the original complete named import'
                                )
                              // The actual continuation independently reconstructs all47
                              // rows and fields before reacquiring/admitting the target.
                              const manager = await activate(incoming, actual, services, replacement)
                              installedManager = manager
                              return manager
                            })
                        )
                    )
                )
              }
            )
          }
        )
    )
  try {
    check()
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
    return Object.freeze({
      manager,
      originalReservationId: original.reservationId,
      archiveSha256: binding.binding.archiveSha256,
      importId: targetImportId
    })
  } catch (cause) {
    // A new manager has not been returned to the caller. Physically close its
    // exact target on a later source/scratch cleanup failure, preserving the
    // durable completed lifecycle for explicit current restart. An original
    // manager may already have installed the valid target and stays available.
    const closeTarget = async (): Promise<void> => {
        if (originalManager === undefined && installedManager !== undefined)
          await targetInventory.closeNamedRecoveryManager(targetImportId, binding.digest, installedManager)
      },
      cleanup = async (): Promise<void> => {
        await closeTarget()
        if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
        derivedExtent.close()
      }
    let failure = cause
    try {
      await closeTarget()
    } catch (error_) {
      cleanupRetained = true
      failure = new Brc38StagingCleanupError(
        [cause, error_],
        'Expired recovery retains unreturned target and temporary cleanup',
        cleanup
      )
    }
    if (!cleanupRetained && cause instanceof Brc38StagingCleanupError) {
      cleanupRetained = true
      failure = new Brc38StagingCleanupError(
        [cause],
        'Expired recovery retains derived-index extent until concrete physical drain',
        cleanup
      )
    }
    throw new Brc39ExpiredPendingRecoveryInterruptedError(original.reservationId, targetImportId, failure)
  } finally {
    clearTimeout(expiry)
    if (!cleanupRetained) derivedExtent.close()
  }
}
