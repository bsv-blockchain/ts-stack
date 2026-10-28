import { WalletStorageManager } from '../WalletStorageManager'
import type { StorageKnex } from '../StorageKnex'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import { Brc38PrivateCompositionRequiredError } from './Brc38PrivateLocalCandidateNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38NativeRetirementRecord } from './Brc38NativeRetirementNode'

type Outcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; cause: unknown }>
/** A finite settlement handshake, never source/target admission authority. */
function settlement<T>(): { promise: Promise<Outcome<T>>; settle: (outcome: Outcome<T>) => void } {
  let resolve!: (outcome: Outcome<T>) => void
  return {
    promise: new Promise<Outcome<T>>(yes => {
      resolve = yes
    }),
    settle: value => resolve(value)
  }
}
export interface Brc38ComposedNativeCutoverOptions {
  readonly sourceInventory: Brc38ProfileInventoryNode
  readonly sourceProfile: Brc38PublishedProfileNode
  readonly sourceProvider: StorageKnex
  readonly manager: WalletStorageManager
  readonly targetInventory: Brc38ProfileInventoryNode
  readonly targetProfile: Brc38PublishedProfileNode
  /** Actual authenticated owner of the SAME original reservation. Its original
   * retained kernel may reopen comparison SQL after publication copy; all
   * copy scopes must have settled before this controller enters. */
  readonly store: KnexBrc38StagingStore
  readonly merge: Brc38PrivateNativeMergeOptions
  readonly executable: string
}
export interface Brc38ComposedNativeCutoverResult {
  readonly provider: StorageKnex
  readonly retirement: Readonly<Brc38NativeRetirementRecord>
}

/** One prepared cutover attempt. All byte/semantic comparisons precede the
 * short source writer; a changed source stops before any retirement. The
 * actual original manager queue remains owned across source snapshot drain,
 * physical old-kernel closure, fresh retired-source reconstruction, full
 * target native admission and installation. Each phase independently checks
 * genuine owners; the handshake's records never enable a later phase.
 *
 * This component does not open/authenticate an envelope, publish READY, renew
 * a reservation, retry a stale target, or implement process-restart recovery. */
export async function cutoverBrc38ComposedNativeProfile(
  selected: Brc38ComposedNativeCutoverOptions
): Promise<Readonly<Brc38ComposedNativeCutoverResult>> {
  const sourceInventory = selected.sourceInventory,
    sourceProfile = selected.sourceProfile,
    provider = selected.sourceProvider,
    manager = selected.manager,
    targetInventory = selected.targetInventory,
    target = selected.targetProfile,
    store = selected.store,
    executable = selected.executable,
    root = provider.knex,
    binding = store.binding,
    working = brc38WorkingAllocation(selected.merge.workingAllocation),
    resources = brc38StructuredRestoreResources(
      store.limits,
      selected.merge.structuredResources,
      selected.merge.maximumStepBytes,
      store.directory
    ),
    options: Readonly<Brc38PrivateNativeMergeOptions> = Object.freeze({
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
    expiresAt = Math.min(store.limits.expiresAt, Date.now() + 3600000),
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    binding === undefined ||
    sourceProfile === target ||
    typeof executable !== 'string' ||
    executable.length < 1 ||
    executable.length > 4096 ||
    resources.sourcePolicy.workingAllocation !== working ||
    resources.projectionPolicy.workingAllocation !== working ||
    resources.sourcePolicy.signal !== options.signal ||
    resources.projectionPolicy.signal !== options.signal
  )
    throw new Error('Composed cutover differs from its original owners or resource packet')
  const sourcePolicy = Object.freeze({
      workingAllocation: working,
      maximumMetadataBytes: 131072,
      maximumReadBytes: options.maximumReadBytes,
      expiresAt,
      signal: options.signal
    }),
    readPolicy = Object.freeze({
      workingAllocation: working,
      maximumReadBytes: options.maximumReadBytes,
      expiresAt,
      signal: options.signal
    }),
    selection = Object.freeze({ ...binding.binding, mode: 'merge' as const }),
    decided = settlement<Readonly<Brc38NativeRetirementRecord>>(),
    drained = settlement<void>(),
    check = (): void => {
      options.signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Original composed cutover resource lifetime expired or changed')
    },
    frame = working.claim(131072)
  const pending: { transition?: Promise<Readonly<Brc38ComposedNativeCutoverResult>> } = {}
  try {
    check()
    store.assertPrivateNativeDestination(store.knex)
    Brc38PublishedProfileNode.assertNativeManagedProvider(provider, manager)
    await Brc38PublishedProfileNode.assertNativeProviderInventory(sourceProfile, provider, sourceInventory)
    await Brc38NativeLocalBaselineSource.with(
      provider,
      selection,
      options.receiptPolicy,
      sourcePolicy,
      async source =>
        await Brc38PrivateNativeMergeNode.with(
          store,
          source,
          options,
          async merge =>
            await Brc38ProfileInventoryNode.withCurrentComposedTargetInspection(
              targetInventory,
              target,
              merge,
              store,
              source,
              async inspection => {
                check()
                if (provider.knex !== root || provider.toDb() !== root || pending.transition !== undefined)
                  throw new Error('Original composed cutover provider or controller changed')
                const admit: WalletStorageManager['withOwnedProviderTransition'] =
                  WalletStorageManager.prototype.withOwnedProviderTransition.bind(manager)
                pending.transition = admit(provider, { expiresAt, signal: options.signal }, async scope => {
                  try {
                    check()
                    const final = await Brc38NativeLocalBaselineSource.withCurrentDataFence(
                      source,
                      async writer =>
                        await Brc38PublishedProfileNode.retireNativeSourceFromComposedInspection(
                          target,
                          inspection,
                          source,
                          manager,
                          scope,
                          writer
                        ),
                      scope
                    )
                    if (!final.current) throw new Brc38PrivateCompositionRequiredError(final.generation.revision)
                    decided.settle({ ok: true, value: final.value })
                    const physical = await drained.promise
                    if (!physical.ok) throw physical.cause
                    check()
                    // The actual source writer, snapshot and current merge/read
                    // callbacks have settled. Closing inside them would deadlock.
                    await Brc38PublishedProfileNode.closeRetiredNativeManagedOriginal(
                      sourceProfile,
                      provider,
                      manager,
                      scope,
                      sourceInventory
                    )
                    if (!sourceProfile.ownershipReleased)
                      throw new Error('Retired original source still owns physical cleanup')
                    check()
                    const replacement = await Brc38ProfileInventoryNode.withRetiredNativeProfileRead(
                      sourceInventory,
                      sourceProfile,
                      executable,
                      readPolicy,
                      async reader =>
                        await Brc38NativeLocalBaselineSource.withRetired(
                          reader,
                          options.receiptPolicy,
                          sourcePolicy,
                          async retired =>
                            await Brc38PrivateNativeMergeNode.with(
                              store,
                              retired,
                              options,
                              async actual =>
                                await Brc38ProfileInventoryNode.admitAndReplaceRetiredComposedTarget(
                                  targetInventory,
                                  target,
                                  actual,
                                  store,
                                  retired,
                                  sourceProfile,
                                  provider,
                                  manager,
                                  scope,
                                  executable,
                                  options.services
                                )
                            )
                        )
                    )
                    return Object.freeze({ provider: replacement, retirement: final.value })
                  } catch (cause) {
                    decided.settle({ ok: false, cause })
                    throw cause
                  }
                })
                // Acquisition can fail before the manager callback starts. Wake
                // the source/target scopes and observe the rejected promise now.
                void pending.transition.catch(cause => {
                  decided.settle({ ok: false, cause })
                })
                const decision = await decided.promise
                if (!decision.ok) throw decision.cause
              }
            )
        )
    )
    drained.settle({ ok: true, value: undefined })
    if (pending.transition === undefined)
      throw new Error('Composed cutover never acquired its actual manager transition')
    return await pending.transition
  } catch (cause) {
    drained.settle({ ok: false, cause })
    if (pending.transition !== undefined) {
      try {
        await pending.transition
      } catch (error_) {
        if (error_ !== cause)
          throw new AggregateError([cause, error_], 'Composed cutover and retained transition both failed')
      }
    }
    throw cause
  } finally {
    frame.close()
  }
}
