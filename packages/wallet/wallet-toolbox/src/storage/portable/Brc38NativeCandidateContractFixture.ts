import { nativeTestExecutable } from './Brc38NativeTestPath'
import type { Knex } from 'knex'
import { composedNativeFixture } from './Brc38ComposedNativeFixture'
import { seedComposedAuxiliaryFixture, assertComposedAuxiliaryFixture } from './Brc38ComposedAuxiliaryFixture'
import { withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import {
  readIndependentNativeInventory,
  wipeIndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { authenticatedStagePassword } from './Brc38AuthenticatedPrivateStageFixture'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateLocalCandidate } from './Brc38PrivateLocalCandidateNode'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import type { Brc38DestinationSelection } from './Brc38KnexDestinationFence'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'

export type Brc38NativeCandidateContractFixture = Parameters<
  Parameters<typeof withBrc38NativeCandidateContractFixture>[0]
>[0]

/** Genuine published all47 source plus a separately authenticated incoming
 * archive and native candidate. Every helper receives actual actors, original
 * shared working allocation and original expiry. This opens no fabricated
 * provider and offers no publication/activation/production-ready verdict. */
export async function withBrc38NativeCandidateContractFixture(
  work: (fixture: {
    readonly source: Awaited<ReturnType<typeof composedNativeFixture>>
    readonly store: KnexBrc38StagingStore
    readonly options: Awaited<ReturnType<typeof composedNativeFixture>>['merge']
    readonly selection: Brc38DestinationSelection
    readonly initial: Awaited<ReturnType<typeof readIndependentNativeInventory>>
    readonly auxiliary: Awaited<ReturnType<typeof seedComposedAuxiliaryFixture>>
    check(): void
    withSource<T>(operation: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
    withCandidate<T>(operation: (candidate: Brc38PrivateLocalCandidate) => Promise<T>): Promise<T>
    withRead<T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T>
    withWriter<T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T>
    prepareCopied(): Promise<void>
    /** Only after the source/candidate callback has drained. Retain the exact
     * reservation, binding, resource packet and original expiry. */
    reopen(): Promise<void>
    readCandidate(): Promise<Awaited<ReturnType<typeof readIndependentNativeInventory>>>
  }) => Promise<void>,
  selected: Readonly<{
    prepareSource?: (source: Awaited<ReturnType<typeof composedNativeFixture>>) => Promise<void>
    lifetimeMs?: number
    maximumSourceReadBytes?: 32 | 1024
    /** Explicit supported full-workflow read selection; existing callers stay 1 KiB. */
    maximumNativeReadBytes?: 1024 | 16384
    customize?: Parameters<typeof composedNativeFixture>[1]
  }> = {}
): Promise<void> {
  const source = await composedNativeFixture(
    nativeTestExecutable(),
    selected.customize,
    selected.lifetimeMs,
    undefined,
    undefined,
    undefined,
    { maximumReadBytes: selected.maximumNativeReadBytes ?? 1024 }
  )
  let initial: Awaited<ReturnType<typeof readIndependentNativeInventory>> | undefined,
    failed = false,
    failure: unknown
  try {
    const auxiliary = await seedComposedAuxiliaryFixture(source.storage, source.manager)
    await assertComposedAuxiliaryFixture(source.manager, auxiliary)
    // Deleted high IDs are genuine AUTOINCREMENT history, not max(rowid).
    await source.manager.runAsStorageProvider(async active => {
      if (active !== source.storage) throw new Error('Candidate fixture selected another current source')
      await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(source.storage, async writer => {
        const when = new Date('2026-10-08T00:00:00.000Z'),
          userId = source.manager.getActiveUser().userId,
          basketId = await source.storage.insertOutputBasket(
            {
              basketId: 1600,
              userId,
              created_at: when,
              updated_at: when,
              name: 'independent deleted high basket',
              isDeleted: false,
              numberOfDesiredUTXOs: 7,
              minimumDesiredUTXOValue: 11
            },
            writer
          )
        if (basketId !== 1600 || (await writer('output_baskets').where({ basketId, userId }).delete()) !== 1)
          throw new Error('Candidate fixture did not preserve the independently authored deleted high ID')
      })
    })
    await selected.prepareSource?.(source)
    source.check()
    initial = await withComposedFixtureRead(source.manager, readIndependentNativeInventory)
    const chain = source.storage.chain
    if (chain !== 'main' && chain !== 'test') throw new Error('Native fixture chain differs')
    const selection: Brc38DestinationSelection = {
        identityKey: source.manager.getActiveUser().identityKey,
        chain,
        targetStorageIdentityKey: source.manager.getActiveStore(),
        mode: 'merge'
      },
      staged = await stageAuthenticatedBrc39PrivateImport(
        source.chunks(),
        authenticatedStagePassword,
        source.admission,
        source.source
      )
    source.retainCleanup(async () => await staged.reservation.store.close())
    await staged.reservation.store.close()
    const reservation = await source.admission.resumeNative(
        staged.reservation.id,
        source.source.limits,
        source.source.binding,
        source.executable
      ),
      options = { ...source.merge, maximumStepRows: 1 }
    let store = reservation.store
    const check = (): void => {
      source.check()
      store.assertPrivateNativeDestination(store.knex)
      if (Date.now() >= store.limits.expiresAt)
        throw new Error('Candidate fixture exceeded its original private lifetime')
    }
    source.retainCleanup(async () => await reservation.store.close())
    const withSource = async <T>(operation: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T> => {
        check()
        return await Brc38NativeLocalBaselineSource.with(
          source.storage,
          selection,
          previewReceiptPolicy,
          {
            workingAllocation: options.workingAllocation,
            maximumMetadataBytes: 65536,
            maximumReadBytes: selected.maximumSourceReadBytes ?? options.maximumReadBytes,
            expiresAt: store.limits.expiresAt
          },
          operation
        )
      },
      withCandidate = async <T>(operation: (candidate: Brc38PrivateLocalCandidate) => Promise<T>): Promise<T> =>
        await withSource(async retained => await Brc38PrivateLocalCandidate.with(store, retained, options, operation)),
      transaction = async <T>(readOnly: boolean, operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
        await store.withAuthenticatedPrivateStructuredDestination(
          async () =>
            await store.withPrivateNativeDatabase(
              readOnly,
              async database =>
                await database.transaction(async trx => {
                  if (readOnly) store.assertPrivateNativeReadTransaction(trx)
                  else store.assertPrivateNativeWriteTransaction(trx)
                  check()
                  const result = await operation(trx)
                  check()
                  return result
                })
            )
        ),
      withRead = async <T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
        await transaction(true, operation),
      withWriter = async <T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
        await transaction(false, operation),
      prepareCopied = async (): Promise<void> => {
        let complete = false
        for (let operation = 0; !complete && operation < 4096; operation++) {
          await withCandidate(async candidate => {
            const progress = await candidate.step()
            complete = progress.recoveryRequired && progress.garbageComplete
          })
          check()
        }
        if (!complete) throw new Error('Actual candidate did not catch up within its original finite operation guard')
      }
    const reopen = async (): Promise<void> => {
      check()
      await store.close()
      const resumed = await source.admission.resumeNative(
        reservation.id,
        source.source.limits,
        source.source.binding,
        source.executable
      )
      source.retainCleanup(async () => await resumed.store.close())
      store = resumed.store
      check()
    }
    await work({
      source,
      get store() {
        return store
      },
      options,
      selection,
      initial,
      auxiliary,
      check,
      withSource,
      withCandidate,
      withRead,
      withWriter,
      prepareCopied,
      reopen,
      readCandidate: async () => await withRead(readIndependentNativeInventory)
    })
    check()
    if (options.workingAllocation.used !== 0)
      throw new Error('Candidate contract retained its shared working allowance')
  } catch (cause) {
    failed = true
    failure = cause
  }
  if (initial !== undefined) wipeIndependentNativeInventory(initial)
  try {
    await source.close()
  } catch (cause) {
    throw new AggregateError(
      failed ? [failure, cause] : [cause],
      'Native candidate contract retains original source and incoming owners'
    )
  }
  if (failed) throw failure
}
