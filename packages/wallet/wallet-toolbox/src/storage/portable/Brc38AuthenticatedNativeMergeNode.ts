import type { StorageKnex } from '../StorageKnex'
import type { Brc38StagingAdmissionNode, Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import {
  stageAuthenticatedBrc39PrivateImport,
  authenticateBrc39PrivateNativeImport,
  copyBrc38AuthenticatedPrivateStageOptions,
  type Brc38AuthenticatedPrivateStageOptions
} from './Brc38AuthenticatedPrivateStageNode'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import {
  runBrc38PrivateNativeMerge,
  type Brc38PrivateNativeComposedInventory,
  type Brc38PrivateNativeMergeRunnerProgress
} from './Brc38PrivateNativeMergeRunnerNode'
import type { Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { reserveBrc38NativeIncomingIds } from './Brc38NativeIncomingIdReservationNode'

export interface Brc38AuthenticatedNativeMergeOptions {
  readonly storage: StorageKnex
  readonly admission: Brc38StagingAdmissionNode
  readonly source: Brc38AuthenticatedPrivateStageOptions
  readonly merge: Brc38PrivateNativeMergeOptions
  readonly executable: string
  readonly maximumOperations: number
  /** Called after authentication/handoff or a fully drained runner operation.
   * Synchronous observation only. Throwing may lose an ACK but preserves the
   * original reservation; an observer cannot run inside a native writer. */
  readonly progress?: (
    value: Readonly<{
      reservationId: string
      phase: 'AUTHENTICATED' | 'MERGE'
      operation?: Readonly<Brc38PrivateNativeMergeRunnerProgress>
    }>
  ) => void
}
export interface Brc38AuthenticatedNativeMergeResult {
  readonly reservationId: string
  readonly archiveSha256: string
  readonly inventory: Readonly<Brc38PrivateNativeComposedInventory>
  readonly inactive: true
}
/** Bounded identity DATA for resuming the same reservation. Its cause retains
 * any concrete cleanup owner; it grants no authentication or publication. */
export class Brc38AuthenticatedNativeMergeInterruptedError extends Error {
  constructor(
    readonly reservationId: string,
    cause: unknown
  ) {
    super('Authenticated native merge stopped; resume the original private reservation', { cause })
    this.name = 'Brc38AuthenticatedNativeMergeInterruptedError'
  }
}
function invalid(): never {
  throw new Error('Authenticated native merge changed its original source, owner or resources')
}

/** Complete encrypted envelope -> independently composed occupied candidate.
 * Initial staging is authenticated before its stock SQL owner drains and the
 * actual reservation acquires native ownership. Resume freshly authenticates
 * the complete envelope against the immutable originals through that owner.
 * Original deadlines, shared capacity and episode/mapping/journal caps remain.
 * The actual source reserves bounded AUTOINCREMENT holes before copying;
 * existing logical wallet rows, profile selection and archived operational
 * state remain unchanged. No publication, activation or provider registration
 * takes place. The source wallet continues serving while private work runs. */
export async function mergeAuthenticatedBrc39NativeInactive(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedNativeMergeOptions
): Promise<Readonly<Brc38AuthenticatedNativeMergeResult>> {
  return await withAuthenticatedBrc39NativeMerge(encrypted, password, selected, async (_, result) => result)
}

/** Internal lifecycle adapter for the composed publication controller. The
 * callback receives the actual authenticated owner before physical close;
 * every publication/cutover phase must independently verify that owner and
 * the current source. Neither inventory statistics nor this callback supplies
 * target admission. Physical cleanup is awaited before the result escapes. */
export async function withAuthenticatedBrc39NativeMerge<T>(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedNativeMergeOptions,
  complete: (reservation: Brc38StagingReservation, result: Readonly<Brc38AuthenticatedNativeMergeResult>) => Promise<T>
): Promise<T> {
  const storage = selected.storage,
    root = storage.knex,
    admission = selected.admission,
    source = copyBrc38AuthenticatedPrivateStageOptions(selected.source),
    executable = selected.executable,
    maximumOperations = selected.maximumOperations,
    progress = selected.progress,
    resources = brc38StructuredRestoreResources(
      source.limits,
      selected.merge.structuredResources,
      selected.merge.maximumStepBytes
    ),
    merge: Readonly<Brc38PrivateNativeMergeOptions> = Object.freeze({
      receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(selected.merge.receiptPolicy) }),
      maximumStepRows: selected.merge.maximumStepRows,
      maximumStepBytes: selected.merge.maximumStepBytes,
      maximumMappedIds: selected.merge.maximumMappedIds,
      maximumJournalLogicalBytes: selected.merge.maximumJournalLogicalBytes,
      maximumLocalRows: selected.merge.maximumLocalRows,
      maximumReadBytes: selected.merge.maximumReadBytes,
      workingAllocation: selected.merge.workingAllocation,
      services: selected.merge.services,
      signal: selected.merge.signal,
      structuredResources: resources
    }),
    expiresAt = source.limits.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    source.streamedFields === undefined ||
    source.streamedTextFields === undefined ||
    source.streamedStructuredFields === undefined ||
    typeof executable !== 'string' ||
    executable.length < 1 ||
    executable.length > 4096 ||
    !Number.isSafeInteger(maximumOperations) ||
    maximumOperations < 1 ||
    maximumOperations > 100000000 ||
    (progress !== undefined && typeof progress !== 'function') ||
    source.crypto.signal !== merge.signal ||
    resources.sourcePolicy.signal !== merge.signal ||
    resources.projectionPolicy.signal !== merge.signal ||
    source.streamedStructuredFields.staging.signal !== merge.signal ||
    source.streamedStructuredFields.staging.workingAllocation !== merge.workingAllocation ||
    resources.sourcePolicy.workingAllocation !== merge.workingAllocation ||
    resources.projectionPolicy.workingAllocation !== merge.workingAllocation ||
    JSON.stringify(source.streamedStructuredFields.staging) !== JSON.stringify(resources.sourcePolicy)
  )
    invalid()
  const check = (): void => {
    merge.signal?.throwIfAborted()
    if (storage.knex !== root || storage.toDb() !== root || Date.now() >= expiresAt || performance.now() >= deadline)
      invalid()
  }
  const observe = (
    reservationId: string,
    phase: 'AUTHENTICATED' | 'MERGE',
    operation?: Readonly<Brc38PrivateNativeMergeRunnerProgress>
  ): void => {
    check()
    if (progress !== undefined) {
      const returned: unknown = progress(
        Object.freeze({ reservationId, phase, ...(operation === undefined ? {} : { operation }) })
      )
      if (returned !== undefined) throw new TypeError('Native merge progress must be a synchronous observer')
    }
    check()
  }
  async function* input(): AsyncGenerator<Uint8Array> {
    for await (const bytes of encrypted) {
      check()
      yield bytes
      check()
    }
  }
  let reservation: Brc38StagingReservation | undefined,
    iterator: ReturnType<typeof runBrc38PrivateNativeMerge> | undefined
  // A failed physical drain is retained in a retryable error rather than
  // pretending the kernel owner closed or deleting its durable reservation.
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = []
    if (iterator !== undefined) {
      try {
        await iterator.return(undefined as never)
        iterator = undefined
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (reservation !== undefined) {
      try {
        await reservation.store.close()
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length !== 0)
      throw new Brc38StagingCleanupError(failures, 'Authenticated native merge retains physical cleanup', cleanup)
  }
  try {
    check()
    const staged =
      source.reservationId === undefined
        ? await stageAuthenticatedBrc39PrivateImport(input(), password, admission, source)
        : await authenticateBrc39PrivateNativeImport(input(), password, admission, source, executable)
    reservation = staged.reservation
    check()
    if (source.reservationId === undefined) {
      await reservation.store.close()
      check()
      reservation = await admission.resumeNative(reservation.id, source.limits, source.binding, executable)
    }
    check()
    // The candidate requires these genuine source-primary ranges before
    // preparing incoming IDs. Reauthentication/resume reuses the original
    // immutable ranges; no consumed ID, deadline or resource cap is reset.
    await reserveBrc38NativeIncomingIds(
      storage,
      {
        identityKey: source.binding.identityKey,
        chain: source.binding.chain,
        targetStorageIdentityKey: source.binding.targetStorageIdentityKey,
        mode: 'merge'
      },
      merge.receiptPolicy,
      reservation.store,
      { workingAllocation: merge.workingAllocation, signal: merge.signal }
    )
    check()
    observe(reservation.id, 'AUTHENTICATED')
    iterator = runBrc38PrivateNativeMerge(
      reservation.store,
      storage,
      {
        identityKey: source.binding.identityKey,
        chain: source.binding.chain,
        targetStorageIdentityKey: source.binding.targetStorageIdentityKey,
        mode: 'merge'
      },
      merge,
      maximumOperations
    )
    for (;;) {
      check()
      const next = await iterator.next()
      if (next.done) {
        iterator = undefined
        const result = Object.freeze({
          reservationId: reservation.id,
          archiveSha256: staged.archiveSha256,
          inventory: next.value,
          inactive: true as const
        })
        const completed = await complete(reservation, result)
        await cleanup()
        check()
        return completed
      }
      observe(reservation.id, 'MERGE', next.value)
    }
  } catch (cause) {
    let failure = cause
    try {
      await cleanup()
    } catch (error_) {
      failure = new Brc38StagingCleanupError(
        [cause, error_],
        'Authenticated native merge stopped with retained cleanup',
        async () => {
          if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
          await cleanup()
        }
      )
    }
    const reservationId = reservation?.id ?? source.reservationId
    if (reservationId !== undefined) throw new Brc38AuthenticatedNativeMergeInterruptedError(reservationId, failure)
    throw failure
  }
}
