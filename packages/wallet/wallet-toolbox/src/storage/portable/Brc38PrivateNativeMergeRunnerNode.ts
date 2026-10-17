import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import {
  Brc38PrivateNativeMergeNode,
  type Brc38PrivateNativeMergeOptions,
  type Brc38PrivateNativeMergeProgress
} from './Brc38PrivateNativeMergeNode'
import { Brc38PrivateCompositionRequiredError } from './Brc38PrivateLocalCandidateNode'
import { brc38DestinationSelection, type Brc38DestinationSelection } from './Brc38KnexDestinationFence'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'

export type Brc38PrivateNativeComposedInventory = Awaited<
  ReturnType<Brc38PrivateNativeMergeNode['inspectComposedRows']>
>
export type Brc38PrivateNativeMergeRunnerProgress = Readonly<{
  operation: number
  elapsedMilliseconds: number
  progress: Readonly<Brc38PrivateNativeMergeProgress> | Readonly<{ phase: 'SOURCE_CHANGED'; sourceRevision: string }>
}>
function invalid(originalFailure?: Readonly<{ cause: unknown }>): never {
  throw new Error(
    'Private native merge runner differs from its original owner, source selection or finite resource lifetime',
    originalFailure
  )
}
/** Actual bounded implementation runner. Each operation reopens a genuine
 * source snapshot, reopens durable candidate/receipt state, and drains BOTH
 * scoped actors before yielding. A lost response is never local completion:
 * the next operation reads actual destination custody. Source mutation during
 * full comparison starts the existing bounded refold on a NEW source view.
 *
 * Progress and the final all47 comparison are DATA only. No publication,
 * manager registration, provider selection or cutover is performed. Original
 * three-refold/episode, operation, UTC/monotonic and resource ceilings remain;
 * a busy/expired program stops with durable private custody intact. */
export function runBrc38PrivateNativeMerge(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  selectedSource: Brc38DestinationSelection,
  selected: Brc38PrivateNativeMergeOptions,
  selectedMaximumOperations: number
): AsyncGenerator<Brc38PrivateNativeMergeRunnerProgress, Readonly<Brc38PrivateNativeComposedInventory>> {
  const source = brc38DestinationSelection(selectedSource),
    binding = store.binding,
    root = storage.knex,
    expiresAt = store.limits.expiresAt,
    started = performance.now(),
    deadline = started + Math.max(0, expiresAt - Date.now()),
    maximumOperations = selectedMaximumOperations,
    working = brc38WorkingAllocation(selected.workingAllocation),
    resources = brc38StructuredRestoreResources(
      store.limits,
      selected.structuredResources,
      selected.maximumStepBytes,
      store.directory
    ),
    options: Readonly<Brc38PrivateNativeMergeOptions> = Object.freeze({
      receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(selected.receiptPolicy) }),
      maximumStepRows: selected.maximumStepRows,
      maximumStepBytes: selected.maximumStepBytes,
      maximumMappedIds: selected.maximumMappedIds,
      maximumJournalLogicalBytes: selected.maximumJournalLogicalBytes,
      maximumLocalRows: selected.maximumLocalRows,
      maximumReadBytes: selected.maximumReadBytes,
      workingAllocation: selected.workingAllocation,
      services: selected.services,
      signal: selected.signal,
      structuredResources: resources
    })
  if (
    binding === undefined ||
    working === undefined ||
    source.mode !== 'merge' ||
    source.identityKey !== binding.binding.identityKey ||
    source.chain !== binding.binding.chain ||
    source.targetStorageIdentityKey !== binding.binding.targetStorageIdentityKey ||
    !Number.isSafeInteger(maximumOperations) ||
    maximumOperations < 1 ||
    maximumOperations > 100000000 ||
    resources.sourcePolicy.workingAllocation !== working ||
    resources.projectionPolicy.workingAllocation !== working ||
    resources.sourcePolicy.signal !== options.signal ||
    resources.projectionPolicy.signal !== options.signal
  )
    invalid()
  const check = (originalFailure?: Readonly<{ cause: unknown }>): void => {
    options.signal?.throwIfAborted()
    if (
      store.binding !== binding ||
      storage.knex !== root ||
      storage.toDb() !== root ||
      Date.now() >= expiresAt ||
      performance.now() >= deadline
    )
      invalid(originalFailure)
    store.assertPrivateNativeDestination(store.knex)
  }
  // Capture requested DATA synchronously before a caller can mutate it or
  // queue next(). Acquire working lifetime only when the iterator actually runs.
  return (async function* (): AsyncGenerator<
    Brc38PrivateNativeMergeRunnerProgress,
    Readonly<Brc38PrivateNativeComposedInventory>
  > {
    for (let operation = 1; operation <= maximumOperations; operation++) {
      check()
      const frame = working.claim(131072)
      let result:
        | Readonly<{ progress: Readonly<Brc38PrivateNativeMergeProgress> }>
        | Readonly<{ inventory: Readonly<Brc38PrivateNativeComposedInventory> }>
        | Readonly<{ changed: string }>
      try {
        result = await Brc38NativeLocalBaselineSource.with(
          storage,
          source,
          options.receiptPolicy,
          {
            workingAllocation: working,
            maximumMetadataBytes: 131072,
            maximumReadBytes: options.maximumReadBytes,
            expiresAt,
            signal: options.signal
          },
          async actual =>
            await Brc38PrivateNativeMergeNode.with(store, actual, options, async merge => {
              const status = await merge.status()
              // A changed fresh source needs the normal durable refold step;
              // only an unchanged completed episode reaches full comparison.
              if (status.phase === 'IMPORT' && !status.sourceChanged && status.receipt?.state === 'COMPLETE')
                return Object.freeze({ inventory: await merge.inspectComposedRows() })
              return Object.freeze({ progress: await merge.step() })
            })
        )
      } catch (cause) {
        // Keep a failed operation available when the original owner gate also
        // refuses; retaining its cause never admits an expired or changed owner.
        check({ cause })
        if (!(cause instanceof Brc38PrivateCompositionRequiredError)) throw cause
        result = Object.freeze({ changed: cause.sourceRevision })
      } finally {
        frame.close()
      }
      // Every physical read scope and queued source/merge operation has drained
      // before user progress or the result can leave this generator.
      check()
      if ('inventory' in result) return result.inventory
      yield Object.freeze({
        operation,
        elapsedMilliseconds: Math.max(0, performance.now() - started),
        progress:
          'changed' in result
            ? Object.freeze({ phase: 'SOURCE_CHANGED' as const, sourceRevision: result.changed })
            : result.progress
      })
      check()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    throw new Error(
      'Original private native merge operation bound reached; durable custody remains available for an admitted retry'
    )
  })()
}
