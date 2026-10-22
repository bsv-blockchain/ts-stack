import { nativeTestExecutable } from './Brc38NativeTestPath'
import type { Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { installBrc38PrivateNativeCandidateSchema } from './Brc38PrivateNativeRestoreNode'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'

export interface Brc38NativePrivateContractFixture {
  readonly privateIndexParent: string
  readonly store: KnexBrc38StagingStore
  readonly storage: StorageKnex
  readonly expiresAt: number
  check(): void
  withRead<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  withWriter<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
}

/** Concrete authenticated owner and fresh current candidate. The callback
 * runs before journal sealing, and all genuine read leases drain in the store.
 * Whole-feature success explicitly admits 16 MiB each for physical storage
 * and decoded/working allocation, with the original 64 KiB serialized rows. Small-budget
 * controls may explicitly retain 4 MiB; neither path changes product defaults.
 * An additional post-sealing observation shares the same original deadline.
 * This helper never exports, publishes or registers the candidate as primary. */
export async function withBrc38NativePrivateContractFixture(
  work: (fixture: Brc38NativePrivateContractFixture) => Promise<void>,
  phase: 'before-journal' | 'after-journal' = 'before-journal',
  maximumPhysicalBytes = 16777216,
  afterJournal?: (fixture: Brc38NativePrivateContractFixture) => Promise<void>,
  maximumRowAllocationBytes = 16777216,
  transform?: Parameters<typeof previewPrivateFixture>[1],
  streamedStructured = false
): Promise<void> {
  if (phase !== 'before-journal' && phase !== 'after-journal')
    throw new RangeError('Explicit native fixture phase required')
  const fixture = await previewPrivateFixture(
    undefined,
    transform,
    65536,
    maximumPhysicalBytes,
    maximumRowAllocationBytes,
    streamedStructured
  )
  let failed = false,
    failure: unknown
  try {
    const { root, value, selected } = fixture
    await value.reservation.store.close()
    const reservation = await root.resumeNative(
      value.reservation.id,
      selected.limits,
      selected.binding,
      nativeTestExecutable()
    )
    fixture.held.push(reservation)
    const store = reservation.store,
      expiresAt = Math.min(store.limits.expiresAt, Date.now() + 120000),
      monotonicDeadline = performance.now() + expiresAt - Date.now(),
      check = (): void => {
        if (Date.now() >= expiresAt || performance.now() >= monotonicDeadline)
          throw new Error('Native private contract exceeded its original finite lifetime')
        store.assertPrivateNativeDestination(store.knex)
      },
      transaction = async <T>(readOnly: boolean, operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
        check()
        const result = await store.withPrivateNativeDatabase(
          readOnly,
          async database =>
            await database.transaction(async trx => {
              if (readOnly) store.assertPrivateNativeReadTransaction(trx)
              else store.assertPrivateNativeWriteTransaction(trx)
              const result = await operation(trx)
              check()
              return result
            })
        )
        check()
        return result
      }
    const destination = (operation: () => Promise<void>): Promise<void> =>
      streamedStructured
        ? store.withAuthenticatedPrivateStructuredDestination(operation)
        : store.withAuthenticatedPrivateDestination(operation)
    await destination(async () => {
      const storage = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions(selected.binding.chain),
        knex: store.knex,
        snapshotSync: false
      })
      const run = async (operation = work): Promise<void> => {
        await storage.makeAvailable()
        await operation({
          store,
          storage,
          expiresAt,
          check,
          privateIndexParent: fixture.directory,
          withRead: async operation => await transaction(true, operation),
          withWriter: async operation => await transaction(false, operation)
        })
      }
      await installBrc38PrivateNativeCandidateSchema(
        storage,
        store,
        selected.binding.targetStorageIdentityKey,
        {
          receiptPolicy: previewReceiptPolicy,
          maximumStepRows: 16,
          maximumStepBytes: selected.limits.maximumRowAllocationBytes,
          maximumMappedIds: 1000,
          maximumJournalLogicalBytes: 516096
        },
        true,
        true,
        false,
        phase === 'before-journal' ? async () => await run() : undefined
      )
      if (phase === 'after-journal') await run()
      if (afterJournal !== undefined) await run(afterJournal)
      check()
    })
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await fixture.close()
  } catch (cause) {
    throw new AggregateError(
      failed ? [failure, cause] : [cause],
      'Native private contract retains original cleanup owners'
    )
  }
  if (failed) throw failure
}
