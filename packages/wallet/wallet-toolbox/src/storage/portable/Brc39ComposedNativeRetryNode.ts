import {
  importBrc39ComposedNativeProfile,
  type Brc39ComposedNativeImportOptions,
  type Brc39ComposedNativeImportResult
} from './Brc39ComposedNativeImportNode'
import { copyBrc38AuthenticatedPrivateStageOptions } from './Brc38AuthenticatedPrivateStageNode'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'

export interface Brc39ComposedNativeRetryOptions extends Brc39ComposedNativeImportOptions {
  /** Address DATA for the original inactive copy. No new caller-selected
   * import ID, capacity packet or deadline is created by this retry. */
  readonly inactiveTargetImportId: string
}

/** Withdraw an inactive copy while the actual original manager/source remain
 * active, then replay complete envelope authentication against the SAME live
 * private reservation. Actual native owner exclusion requires any former
 * private stage to have physically closed. The persisted merge program, finite
 * refold count, original caps and expiry survive process/SQL reacquisition.
 * A durably retired source must use pending recovery, never this retry path. */
export async function retryInactiveBrc39ComposedNativeImport(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc39ComposedNativeRetryOptions
): Promise<Readonly<Brc39ComposedNativeImportResult>> {
  const source = copyBrc38AuthenticatedPrivateStageOptions(selected.source),
    merge = Object.freeze({
      ...selected.merge,
      receiptPolicy: snapshotJournalReceiptPolicy(selected.merge.receiptPolicy),
      structuredResources: brc38StructuredRestoreResources(
        source.limits,
        selected.merge.structuredResources,
        selected.merge.maximumStepBytes
      )
    }),
    options = Object.freeze({ ...selected, source, merge }),
    inactiveTargetImportId = selected.inactiveTargetImportId,
    bound = brc38StagingBinding(source.binding, source.limits),
    expiresAt = source.limits.expiresAt,
    deadline = performance.now() + expiresAt - Date.now()
  if (
    source.reservationId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(inactiveTargetImportId)
  )
    throw new Error('Inactive retry requires its original reservation and target import address')
  const check = (): void => {
    merge.signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline)
      throw new Error('Original inactive import retry lifetime expired')
  }
  check()
  await options.targetInventory.withdrawInactiveComposed(
    inactiveTargetImportId,
    bound.digest,
    options.sourceProfile,
    options.storage,
    options.manager,
    options.sourceInventory,
    { expiresAt, signal: merge.signal }
  )
  check()
  return await importBrc39ComposedNativeProfile(encrypted, password, options)
}
