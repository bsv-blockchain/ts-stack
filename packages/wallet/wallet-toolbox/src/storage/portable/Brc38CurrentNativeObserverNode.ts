import {
  hasBrc38NativeIncomingIdReservationSchema,
  installBrc38NativeIncomingIdReservationSchema
} from './Brc38NativeIncomingIdReservationSchemaNode'
import { migrateSnapshotJournalSqliteSourceAddition } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import type { StorageKnex } from '../StorageKnex'
import { WalletStorageManager } from '../WalletStorageManager'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import type { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  hasBrc38NativeLocalBaselineGenerationSchema,
  readBrc38NativeLocalBaselineGeneration,
  installBrc38NativeLocalBaselineGeneration,
  copyBrc38NativeLocalBaselineBootstrapPage,
  beginBrc38NativeLocalBaselineEpochRecovery,
  retireBrc38NativeLocalBaselineEpochPage,
  activateBrc38NativeLocalBaselineRecoveredEpoch,
  type Brc38NativeLocalBaselineGeneration
} from './Brc38NativeLocalBaselineGenerationNode'

export interface Brc38CurrentNativeObserverOptions {
  readonly maximumRows: number
  readonly ceiling: SnapshotJournalRevision
  readonly maximumStepRows: number
  readonly maximumOperations: number
  readonly expiresAt: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly signal?: AbortSignal
  /** Explicit recovery of this disabled epoch only. Its original candidates
   * remain invalid; the durable reset selects a different epoch. */
  readonly recoverDisabledEpoch?: string
}
export interface Brc38CurrentNativeObserverProgress {
  readonly operation: number
  readonly phase: 'retiring' | 'bootstrap' | 'complete'
  readonly generation: Readonly<Brc38NativeLocalBaselineGeneration>
}

/** Install/bootstrap current all47 observation, or explicitly recover a
 * disabled epoch. Each step holds the actual manager queue and one short
 * native writer. Progress is DATA emitted only after both have drained. A
 * lost acknowledgement or cancellation resumes the persisted cursor without
 * replacing the epoch or silently increasing its original row/revision caps.
 * This is current wallet maintenance, never import-reservation renewal. */
export function bootstrapCurrentBrc38NativeObserver(
  profile: Brc38PublishedProfileNode,
  provider: StorageKnex,
  manager: WalletStorageManager,
  inventory: Brc38ProfileInventoryNode,
  selected: Brc38CurrentNativeObserverOptions
): AsyncGenerator<Readonly<Brc38CurrentNativeObserverProgress>, void, void> {
  const options = Object.freeze({
      maximumRows: selected.maximumRows,
      ceiling: snapshotJournalRevision(selected.ceiling),
      maximumStepRows: selected.maximumStepRows,
      maximumOperations: selected.maximumOperations,
      expiresAt: selected.expiresAt,
      signal: selected.signal,
      recoverDisabledEpoch: selected.recoverDisabledEpoch
    }),
    working = brc38WorkingAllocation(selected.workingAllocation),
    root = provider.knex,
    now = Date.now(),
    deadline = performance.now() + options.expiresAt - now
  if (
    working === undefined ||
    !Number.isSafeInteger(options.maximumRows) ||
    options.maximumRows < 1 ||
    options.maximumRows > 10000000 ||
    options.ceiling === '0' ||
    !Number.isSafeInteger(options.maximumStepRows) ||
    options.maximumStepRows < 1 ||
    options.maximumStepRows > 128 ||
    !Number.isSafeInteger(options.maximumOperations) ||
    options.maximumOperations < 1 ||
    options.maximumOperations > 20000000 ||
    !Number.isSafeInteger(options.expiresAt) ||
    options.expiresAt <= now ||
    options.expiresAt > now + 3600000 ||
    (options.recoverDisabledEpoch !== undefined &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(options.recoverDisabledEpoch))
  )
    throw new RangeError('Current native observer requires finite original maintenance bounds')
  const check = (): void => {
    options.signal?.throwIfAborted()
    if (
      Date.now() >= options.expiresAt ||
      performance.now() >= deadline ||
      provider.knex !== root ||
      provider.toDb() !== root
    )
      throw new Error('Current native observer maintenance lifetime or provider changed')
    Brc38PublishedProfileNode.assertNativeManagedProvider(provider, manager)
  }
  return (async function* (): AsyncGenerator<Readonly<Brc38CurrentNativeObserverProgress>, void, void> {
    const frame = working.claim(131072)
    try {
      for (let operation = 1; operation <= options.maximumOperations; operation++) {
        check()
        const progress = (await WalletStorageManager.prototype.runAsSync.call(manager, async active => {
          check()
          if (active !== provider) throw new Error('Current observer manager selected another provider')
          await Brc38PublishedProfileNode.assertNativeObserverMaintenance(profile, provider, manager, inventory)
          check()
          const state = await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(provider, async writer => {
            check()
            const local = await hasBrc38NativeLocalBaselineGenerationSchema(writer),
              reservations = await hasBrc38NativeIncomingIdReservationSchema(writer)
            if (!local || !reservations) {
              if (!local && options.recoverDisabledEpoch !== undefined)
                throw new Error('Disabled observer recovery requires its existing epoch')
              // These observers extend the already-bound operational source.
              // Use its existing atomic migration protocol: live receipts must
              // drain, exact plans stay valid and the old epoch cannot resume.
              await migrateSnapshotJournalSqliteSourceAddition(
                writer,
                async () => {
                  check()
                  if (!local) await installBrc38NativeLocalBaselineGeneration(writer, options)
                  // Incoming counter ranges are part of explicit source setup,
                  // never DDL hidden in an ordinary import/read. Reuse the
                  // actual generation's original capacity, including recovery.
                  const generation = await readBrc38NativeLocalBaselineGeneration(writer)
                  if (!reservations) await installBrc38NativeIncomingIdReservationSchema(writer, generation.maximumRows)
                  check()
                },
                writer.client.config.migrations
              )
            }
            let current = await readBrc38NativeLocalBaselineGeneration(writer)
            if (options.recoverDisabledEpoch !== undefined) {
              if (current.epoch === options.recoverDisabledEpoch) {
                if (current.enabled) throw new Error('Explicit observer recovery cannot replace an enabled epoch')
                await beginBrc38NativeLocalBaselineEpochRecovery(writer, {
                  expectedEpoch: options.recoverDisabledEpoch,
                  maximumRows: options.maximumRows,
                  ceiling: options.ceiling
                })
                const retired = await retireBrc38NativeLocalBaselineEpochPage(
                  writer,
                  options.recoverDisabledEpoch,
                  options.maximumStepRows
                )
                if (!retired.ready) {
                  check()
                  return await readBrc38NativeLocalBaselineGeneration(writer)
                }
              }
              // Also proves an idempotent retry belongs to this exact persisted
              // recovery, rather than accepting an arbitrary different epoch.
              current = await activateBrc38NativeLocalBaselineRecoveredEpoch(writer, options.recoverDisabledEpoch)
            }
            if (current.maximumRows !== options.maximumRows || current.ceiling !== options.ceiling)
              throw new Error('Current observer differs from its original logical reservation')
            if (!current.enabled)
              throw new Error('Current observer is exhausted; explicit disabled epoch recovery is required')
            const next = current.complete
              ? current
              : await copyBrc38NativeLocalBaselineBootstrapPage(writer, options.maximumStepRows)
            check()
            return next
          })
          check()
          await Brc38PublishedProfileNode.assertNativeObserverMaintenance(profile, provider, manager, inventory)
          check()
          return state
        })) as Readonly<Brc38NativeLocalBaselineGeneration>
        check()
        const phase = progress.enabled
          ? progress.complete
            ? 'complete'
            : 'bootstrap'
          : options.recoverDisabledEpoch === progress.epoch
            ? 'retiring'
            : undefined
        if (phase === undefined) throw new Error('Current observer bootstrap exhausted its original reservation')
        yield Object.freeze({ operation, phase, generation: progress })
        if (phase === 'complete') return
        // Caller observers and this scheduling point own no queue or SQL lease.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      throw new Error('Current native observer exceeded its finite operation budget')
    } finally {
      frame.close()
    }
  })()
}
