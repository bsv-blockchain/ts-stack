import { Brc38StagingCleanupError } from '../../portable/Brc38StagingCleanupError'
import type { SnapshotJournalDelta } from './SnapshotJournalTypes'
import type { SnapshotJournalDestinationStageReceipt } from './SnapshotJournalDestinationStage'
import type { SnapshotJournalPromotionCursor } from './SnapshotJournalDestinationPromotion'
import { KnexSnapshotJournalDataContentReceipts } from './KnexSnapshotJournalDataContentReceipts'
import type {
  SnapshotJournalWriterAdmission,
  SnapshotJournalDestinationLimits,
  SnapshotJournalCutoverSource,
  SnapshotJournalReceiver
} from './SnapshotJournalProvider'
export type {
  SnapshotJournalWriterAdmission,
  SnapshotJournalDestinationLimits,
  SnapshotJournalCutoverSource
} from './SnapshotJournalProvider'
import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { SnapshotJournalReconciliationSource } from './SnapshotJournalCapture'
import {
  snapshotJournalRevision,
  compareSnapshotJournalRevisions,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { readSnapshotJournalCaptureConfiguration } from './SnapshotJournalLifecycle'
import { verifySnapshotJournalDestinationSchema } from './SnapshotJournalDestinationSchema'
import {
  beginSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationWindow,
  withSnapshotJournalDestinationWindowFence,
  succeedSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationSuccessorWindow,
  readSnapshotJournalStoredWindow,
  retireSnapshotJournalDestinationWindow,
  replaceSnapshotJournalDestinationWindow,
  selectSnapshotJournalDestinationPrimary,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'
import { stageSnapshotJournalCapturedPage } from './SnapshotJournalCapturedPage'
import { readSnapshotJournalDestinationPromotionPage } from './SnapshotJournalDestinationStage'
import {
  promoteSnapshotJournalDestinationBatch,
  readSnapshotJournalPromotionCursor
} from './SnapshotJournalDestinationPromotion'
import { SnapshotJournalPreparedEntityMerge } from './SnapshotJournalEntityMerge'
import {
  withdrawSnapshotJournalEntity,
  withdrawUnseenSnapshotJournalMemberships,
  withdrawUnseenSnapshotJournalIdentityMappings
} from './SnapshotJournalWithdrawals'
import { cleanupSnapshotJournalRetirements } from './SnapshotJournalRetirementCleanup'
import {
  cleanupSnapshotJournalAcknowledgedWindow,
  cleanupSnapshotJournalWindowCustody,
  requireSnapshotJournalWindowClean
} from './SnapshotJournalWindowCleanup'
import { snapshotJournalLineage, snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'
import {
  cleanupUnseenSnapshotJournalProvenance,
  readSnapshotJournalProvenancePage,
  type SnapshotJournalProvenancePage
} from './SnapshotJournalProvenance'
import {
  beginSnapshotJournalProgress,
  advanceSnapshotJournalProgress,
  readSnapshotJournalProgress,
  type SnapshotJournalProgress
} from './SnapshotJournalProgress'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal destination differs from its currently admitted source or checkpoint')
}

/** Concrete local SQL receiver. The caller must use its ACTUAL authenticated
 * manager/provider queue; the callback is scheduling, never authority. Every
 * short operation opens a fresh physical writer, checks full actual migration,
 * schema/backend/profile and window, commits, and awaits native closure while
 * retaining queue ownership. All source/proof I/O occurs outside that writer.
 * Operational source provenance stays separate from native sync cursors.
 */
export class KnexSnapshotJournalDestination implements SnapshotJournalReceiver {
  #busy = false
  private readonly root: Knex
  private constructor(
    private readonly storage: StorageKnex,
    private readonly source: SnapshotJournalReconciliationSource,
    readonly binding: Readonly<SnapshotJournalDestinationBinding>,
    private readonly limits: SnapshotJournalDestinationLimits,
    private readonly admission: SnapshotJournalWriterAdmission,
    private readonly signal?: AbortSignal
  ) {
    this.root = storage.knex
  }

  static async begin(
    storage: StorageKnex,
    source: SnapshotJournalReconciliationSource,
    low: SnapshotJournalRevision,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal,
    bootstrap?: true,
    preferIncremental?: true
  ): Promise<{ destination: KnexSnapshotJournalDestination; checkpoint: SnapshotJournalDestinationCheckpoint }> {
    signal?.throwIfAborted()
    if (
      (bootstrap !== undefined && bootstrap !== true) ||
      (preferIncremental !== undefined && preferIncremental !== true)
    )
      invalid()
    if (
      !source.isOpen ||
      typeof admission !== 'function' ||
      !Number.isSafeInteger(limits.maximumChanges) ||
      limits.maximumChanges < 1 ||
      limits.maximumChanges > 32 ||
      !Number.isSafeInteger(limits.maximumAllocationBytes) ||
      limits.maximumAllocationBytes < 1 ||
      limits.maximumAllocationBytes > 16777216
    )
      invalid()
    await source.verifyLive()
    const root = storage.knex,
      contentRevision = await source.readContentRevision?.()
    if (storage.knex !== root) invalid()
    const begin = await admission(
      async () =>
        await source.withCommitFence(
          async () =>
            await storage.runSnapshotJournalWriter(
              async (trx, backend) => {
                if (storage.knex !== root || backend === source.receiptBinding.backend) invalid()
                await storage.assertFinancialDataWriteAdmission(
                  source.receiptBinding.identityKey,
                  source.receiptBinding.storageIdentity,
                  trx
                )
                await verifySnapshotJournalDestinationSchema(trx)
                await readSnapshotJournalCaptureConfiguration(trx)
                const mysql = ['mysql', 'mysql2'].includes(String(trx.client.config.client))
                const users: Array<{ userId: unknown; activeStorage: unknown; identityKey: unknown }> = await trx(
                  'users'
                )
                  .where('identityKey', source.receiptBinding.identityKey)
                  .select(
                    'userId',
                    trx.raw('substr(identityKey,1,131) AS identityKey'),
                    trx.raw('substr(activeStorage,1,257) AS activeStorage')
                  )
                  .limit(2)
                const settings: Array<{ storageIdentityKey: unknown; chain: unknown }> = await trx('settings')
                  .select(
                    trx.raw('substr(storageIdentityKey,1,257) AS storageIdentityKey'),
                    trx.raw('substr(chain,1,9) AS chain')
                  )
                  .limit(2)
                if (
                  users.length !== 1 ||
                  settings.length !== 1 ||
                  users[0].identityKey !== source.receiptBinding.identityKey ||
                  !Number.isSafeInteger(Number(users[0].userId)) ||
                  Number(users[0].userId) < 1 ||
                  typeof settings[0].storageIdentityKey !== 'string' ||
                  settings[0].chain !== source.receiptBinding.chain ||
                  !(users[0].activeStorage === null || typeof users[0].activeStorage === 'string')
                )
                  invalid()
                const destinationUserId = Number(users[0].userId)
                const epochs: Array<{ epoch: unknown }> = await trx('snapshot_sync_primary_epochs')
                  .where('userId', destinationUserId)
                  .select(trx.raw(mysql ? 'CAST(epoch AS CHAR) AS epoch' : 'CAST(epoch AS TEXT) AS epoch'))
                  .limit(2)
                if (epochs.length > 1) invalid()
                const binding: SnapshotJournalDestinationBinding = {
                  lineageVersion: 2,
                  ...(bootstrap === true ? { bootstrap: true as const } : {}),
                  source: { ...source.receiptBinding },
                  receipt: { ...source.receipt },
                  low: snapshotJournalRevision(low),
                  destinationBackend: backend,
                  destinationStorageIdentity: settings[0].storageIdentityKey,
                  destinationUserId,
                  primaryEpoch: snapshotJournalRevision(epochs[0]?.epoch ?? '0'),
                  activeStorage: users[0].activeStorage
                }
                const previous = bootstrap === true ? await readSnapshotJournalStoredWindow(trx, binding) : undefined
                if (previous?.binding.fieldEncoding !== undefined) invalid()
                if (
                  previous !== undefined &&
                  (previous.retired || JSON.stringify(previous.binding) !== JSON.stringify(binding))
                ) {
                  // Verify replacement eligibility BEFORE retiring or cleaning old data.
                  if (
                    previous.binding.lineageVersion !== 2 ||
                    snapshotJournalLineage(previous.binding) !== snapshotJournalLineage(binding)
                  )
                    invalid()
                  const incremental =
                    preferIncremental === true &&
                    !previous.retired &&
                    previous.checkpoint.phase === 'acknowledged' &&
                    snapshotJournalAssociationGeneration(previous.binding) ===
                      snapshotJournalAssociationGeneration(binding) &&
                    compareSnapshotJournalRevisions(source.receipt.floor, previous.binding.receipt.highWater) <= 0 &&
                    compareSnapshotJournalRevisions(previous.binding.receipt.highWater, source.receipt.highWater) <=
                      0 &&
                    (await new KnexSnapshotJournalDataContentReceipts(storage, root).destinationMatches(
                      trx as Knex.Transaction,
                      previous.binding,
                      previous.checkpoint
                    )) !== false
                  if (incremental) {
                    delete binding.bootstrap
                    binding.low = previous.binding.receipt.highWater
                  }
                  return { binding, checkpoint: undefined, previous, incremental }
                }
                const existing = await readSnapshotJournalDestinationWindow(trx, binding)
                const checkpoint =
                  existing ??
                  (await beginSnapshotJournalDestinationWindow(trx, binding, randomBytes(32).toString('hex')))
                if (checkpoint.sequence === 0) await beginSnapshotJournalProgress(trx, binding, checkpoint)
                else await readSnapshotJournalProgress(trx, binding, checkpoint)
                await new KnexSnapshotJournalDataContentReceipts(storage, root).pending(
                  trx as Knex.Transaction,
                  binding,
                  checkpoint,
                  source.snapshotId,
                  contentRevision,
                  { sourceStorage: source.sourceStorage, user: source.user, primary: source.primary }
                )
                if (storage.knex !== root) invalid()
                return { binding, checkpoint, previous: undefined, incremental: false }
              },
              undefined,
              signal
            )
        )
    )
    let checkpoint = begin.checkpoint
    if (begin.previous !== undefined) {
      const previous = begin.previous
      const writer = <T>(apply: (trx: Knex) => Promise<T>) =>
        admission(
          async () =>
            await source.withCommitFence(
              async () =>
                await storage.runSnapshotJournalWriter(
                  async (trx, backend) => {
                    if (backend !== begin.binding.destinationBackend) invalid()
                    await verifySnapshotJournalDestinationSchema(trx)
                    await readSnapshotJournalCaptureConfiguration(trx)
                    return await apply(trx)
                  },
                  begin.binding.destinationBackend,
                  signal
                )
            )
        )
      await source.verifyLive()
      if (!begin.incremental)
        await writer(
          async trx => await retireSnapshotJournalDestinationWindow(trx, previous.binding, previous.checkpoint)
        )
      let clean = false
      while (!clean) {
        signal?.throwIfAborted()
        await source.verifyLive()
        clean = (
          await writer(async trx =>
            begin.incremental
              ? await cleanupSnapshotJournalAcknowledgedWindow(trx, previous.binding, previous.checkpoint)
              : await cleanupSnapshotJournalWindowCustody(trx, previous.binding, previous.checkpoint)
          )
        ).complete
        if (!clean) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      await source.verifyLive()
      checkpoint = await writer(async trx => {
        const requireClean = async (fenced: Knex) =>
          await requireSnapshotJournalWindowClean(fenced, previous.binding, previous.checkpoint)
        const next = begin.incremental
          ? await succeedSnapshotJournalDestinationWindow(
              trx,
              previous.binding,
              previous.checkpoint,
              begin.binding,
              randomBytes(32).toString('hex'),
              requireClean
            )
          : await replaceSnapshotJournalDestinationWindow(
              trx,
              previous.binding,
              previous.checkpoint,
              begin.binding,
              randomBytes(32).toString('hex'),
              requireClean
            )
        await beginSnapshotJournalProgress(trx, begin.binding, next)
        await new KnexSnapshotJournalDataContentReceipts(storage, root).pending(
          trx as Knex.Transaction,
          begin.binding,
          next,
          source.snapshotId,
          contentRevision,
          { sourceStorage: source.sourceStorage, user: source.user, primary: source.primary }
        )
        if (storage.knex !== root) invalid()
        return next
      })
    }
    await source.verifyLive()
    if (storage.knex !== root || checkpoint === undefined) invalid()
    return {
      destination: new KnexSnapshotJournalDestination(
        storage,
        source,
        Object.freeze({
          ...begin.binding,
          source: Object.freeze({ ...begin.binding.source }),
          receipt: Object.freeze({ ...begin.binding.receipt })
        }),
        { ...limits },
        admission,
        signal
      ),
      checkpoint
    }
  }

  private async physicalWriter<T>(apply: (trx: Knex) => Promise<T>, observe = false): Promise<T> {
    if (this.storage.knex !== this.root) invalid()
    return await this.storage.runSnapshotJournalWriter(
      async (trx, backend) => {
        if (this.storage.knex !== this.root || backend !== this.binding.destinationBackend) invalid()
        if (!observe)
          await this.storage.assertFinancialDataWriteAdmission(
            this.binding.source.identityKey,
            this.binding.source.storageIdentity,
            trx
          )
        await verifySnapshotJournalDestinationSchema(trx)
        await readSnapshotJournalCaptureConfiguration(trx)
        const result = await apply(trx)
        if (this.storage.knex !== this.root) invalid()
        return result
      },
      this.binding.destinationBackend,
      observe ? undefined : this.signal
    )
  }
  private async writer<T>(apply: (trx: Knex) => Promise<T>, observe = false, fenceSource = this.source): Promise<T> {
    const commit = async () => await this.physicalWriter(apply, observe)
    return await this.admission(
      async () => (observe ? await commit() : await fenceSource.withCommitFence(commit)),
      observe ? 'observe' : undefined
    )
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.#busy) invalid()
    this.#busy = true
    try {
      return await run()
    } finally {
      this.#busy = false
    }
  }

  /** Fresh destination custody after a lost reply, including an expired source.
   * This method performs no source write/cutover admission and advances nothing. */
  async checkpoint(): Promise<SnapshotJournalDestinationCheckpoint> {
    return await this.exclusive(
      async () =>
        await this.writer(async trx => {
          const state = await readSnapshotJournalDestinationWindow(trx, this.binding)
          if (state === undefined) invalid()
          return state
        }, true)
    )
  }

  async status(): Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; progress: SnapshotJournalProgress }> {
    return await this.exclusive(
      async () =>
        await this.writer(async trx => {
          const checkpoint = await readSnapshotJournalDestinationWindow(trx, this.binding)
          if (checkpoint === undefined) invalid()
          return { checkpoint, progress: await readSnapshotJournalProgress(trx, this.binding, checkpoint) }
        }, true)
    )
  }

  /** Explicit manager primary coordination after complete reconciliation. Each
   * contributor opens a fresh actual retained source outside the manager queue.
   * The final short admission holds their SQL data fences through one target
   * update/physical close. A changed source returns false without activation;
   * the caller must reconcile another window first. Never exposed by RPC. */
  async selectPrimary(
    expected: SnapshotJournalDestinationCheckpoint,
    activeStorage: string,
    sources: readonly SnapshotJournalCutoverSource[],
    onSelected?: (changed: boolean) => void
  ): Promise<boolean> {
    return await this.exclusive(async () => {
      if (
        expected.phase !== 'acknowledged' ||
        sources.length < 1 ||
        sources.length > 8 ||
        new Set(sources.map(value => value.source.receiptBinding.backend)).size !== sources.length ||
        sources.some(
          value =>
            !value.source.isOpen ||
            value.source.receiptBinding.backend === this.binding.destinationBackend ||
            value.source.receiptBinding.identityKey !== this.binding.source.identityKey ||
            value.source.receiptBinding.chain !== this.binding.source.chain
        )
      )
        invalid()
      const original = sources.find(
        value =>
          snapshotJournalReceiptBinding(value.source.receiptBinding) ===
          snapshotJournalReceiptBinding(this.binding.source)
      )
      if (
        original === undefined ||
        original.since !== this.binding.receipt.highWater ||
        original.source.primary.epoch !== this.source.primary.epoch ||
        original.source.primary.activeStorage !== this.source.primary.activeStorage
      )
        invalid()
      // This can scan several bounded metadata pages. It must finish before
      // joining manager ownership; the final fence checks only the short gap
      // after each freshly captured current view, excluding clock-only events.
      for (const value of sources) if (await value.source.hasChangesSince(value.since)) return false
      const commit = async (): Promise<boolean> => {
        const selected = await this.physicalWriter(async trx => {
          const receipts = new KnexSnapshotJournalDataContentReceipts(this.storage, this.root)
          // Do not restamp unrelated drift as a completed copied postimage.
          if ((await receipts.destinationMatches(trx as Knex.Transaction, this.binding, expected)) === false)
            return false
          await selectSnapshotJournalDestinationPrimary(
            trx,
            this.binding,
            expected,
            activeStorage,
            async (fenced, userId) => await this.storage.updateUser(userId, { activeStorage }, fenced)
          )
          await receipts.recordPrimarySelection(trx as Knex.Transaction, this.binding, expected, activeStorage)
          return true
        })
        if (selected) onSelected?.(activeStorage !== this.binding.activeStorage)
        return selected
      }
      const fence = async (index: number): Promise<boolean> => {
        if (index === sources.length) return await commit()
        const value = sources[index]
        const result = await value.source.withCurrentDataFence(
          value.source.receipt.highWater,
          async () => await fence(index + 1)
        )
        return result.current && result.value
      }
      return await this.admission(async () => await fence(0))
    })
  }

  async intake(expected: SnapshotJournalDestinationCheckpoint): Promise<SnapshotJournalDestinationCheckpoint> {
    return await this.exclusive(async () => {
      await this.source.verifyLive()
      const result = await stageSnapshotJournalCapturedPage(
        this.source,
        this.binding,
        expected,
        this.limits,
        async apply => await this.writer(apply),
        this.signal,
        async (trx, committed) => {
          await advanceSnapshotJournalProgress(trx, this.binding, expected, committed.checkpoint, {
            pages: 1,
            examined: committed.result.examined,
            payloadBytes: committed.result.bytes
          })
        }
      )
      await this.source.verifyLive()
      return result.checkpoint
    })
  }

  /** Cleanup commits are bounded and resume actual remaining custody. Expired
   * source views cannot advance native data, but may release an ACKed stage. */
  async cleanup(expected: SnapshotJournalDestinationCheckpoint): Promise<{ removed: number; complete: boolean }> {
    return await this.exclusive(
      async () =>
        await this.writer(
          async trx => await cleanupSnapshotJournalAcknowledgedWindow(trx, this.binding, expected),
          true
        )
    )
  }

  async provenance(
    expected: SnapshotJournalDestinationCheckpoint,
    after?: number,
    maximumRows = 32,
    maximumBytes = 1048576
  ): Promise<SnapshotJournalProvenancePage> {
    return await this.exclusive(
      async () =>
        await this.writer(
          async trx =>
            await readSnapshotJournalProvenancePage(trx, this.binding, expected, after, maximumRows, maximumBytes),
          true
        )
    )
  }

  /** A fresh owned source retains the SAME epoch/schema/profile/primary lease,
   * and begins exactly at the destination-acknowledged high water. Bounded GC
   * releases its writer between commits; the final short transaction requires
   * complete cleanup and atomically installs the next window. No local progress
   * counter or different source binding can authorize succession.
   */
  async succeed(
    nextSource: SnapshotJournalReconciliationSource,
    expected: SnapshotJournalDestinationCheckpoint
  ): Promise<{ destination: KnexSnapshotJournalDestination; checkpoint: SnapshotJournalDestinationCheckpoint }> {
    return await this.exclusive(async () => {
      if (
        expected.phase !== 'acknowledged' ||
        !nextSource.isOpen ||
        nextSource.primary.epoch !== this.source.primary.epoch ||
        nextSource.primary.activeStorage !== this.source.primary.activeStorage
      )
        invalid()
      await nextSource.verifyLive()
      const { bootstrap: _bootstrap, ...previousBinding } = this.binding
      const binding: SnapshotJournalDestinationBinding = {
        ...previousBinding,
        source: { ...nextSource.receiptBinding },
        receipt: { ...nextSource.receipt },
        low: this.binding.receipt.highWater
      }
      const recovered = await this.writer(
        async trx => await readSnapshotJournalDestinationSuccessorWindow(trx, this.binding, binding),
        false,
        nextSource
      )
      let complete = false
      while (recovered === undefined && !complete) {
        this.signal?.throwIfAborted()
        await nextSource.verifyLive()
        complete = (
          await this.writer(
            async trx => await cleanupSnapshotJournalAcknowledgedWindow(trx, this.binding, expected),
            false,
            nextSource
          )
        ).complete
        if (!complete) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      const checkpoint =
        recovered ??
        (await this.writer(
          async trx => {
            const next = await succeedSnapshotJournalDestinationWindow(
              trx,
              this.binding,
              expected,
              binding,
              randomBytes(32).toString('hex'),
              async fenced => await requireSnapshotJournalWindowClean(fenced, this.binding, expected)
            )
            await beginSnapshotJournalProgress(trx, binding, next)
            return next
          },
          false,
          nextSource
        ))
      await nextSource.verifyLive()
      return {
        destination: new KnexSnapshotJournalDestination(
          this.storage,
          nextSource,
          Object.freeze({
            ...binding,
            source: Object.freeze({ ...binding.source }),
            receipt: Object.freeze({ ...binding.receipt })
          }),
          { ...this.limits },
          this.admission,
          this.signal
        ),
        checkpoint
      }
    })
  }

  /** Prepare the bounded actual next frame outside the destination writer, then
   * independently re-read it/cursor under the writer fence before application.
   * Prepared proof decisions remain attached to the actual candidate object.
   * Retirement cleanup completes before the final table can acknowledge.
   */
  async promote(
    expected: SnapshotJournalDestinationCheckpoint
  ): Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; applied: number; inserts: number; updates: number }> {
    return await this.exclusive(
      async () =>
        await promoteSnapshotJournalData(
          this.storage,
          this.binding,
          expected,
          this.limits,
          async apply => await this.writer(apply),
          async () => await this.source.verifyLive(),
          this.signal,
          async (trx, checkpoint) =>
            await new KnexSnapshotJournalDataContentReceipts(this.storage, this.root).complete(
              trx,
              this.binding,
              checkpoint
            )
        )
    )
  }
}

/** Shared semantic target operation. Actual authenticated target admission and
 * physical writer ownership remain with the concrete caller. This helper never
 * constructs a source actor/fence from DATA. Proof preparation stays outside
 * each short writer; candidate-bound decisions and ACKs remain atomic. */
export async function promoteSnapshotJournalData(
  storage: StorageKnex,
  binding: Readonly<SnapshotJournalDestinationBinding>,
  expected: SnapshotJournalDestinationCheckpoint,
  limits: SnapshotJournalDestinationLimits,
  writer: <T>(apply: (trx: Knex) => Promise<T>) => Promise<T>,
  verifyCurrent: () => Promise<void>,
  signal?: AbortSignal,
  onAcknowledged?: (trx: Knex.Transaction, checkpoint: SnapshotJournalDestinationCheckpoint) => Promise<void>
): Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; applied: number; inserts: number; updates: number }> {
  return await promoteSnapshotJournalChanges(
    binding,
    expected,
    limits,
    writer,
    verifyCurrent,
    {
      readPage: readSnapshotJournalDestinationPromotionPage,
      batch: promoteSnapshotJournalDestinationBatch,
      prepare: async (change, receipt, index) => {
        const effect = await SnapshotJournalPreparedEntityMerge.prepare(
          storage,
          binding,
          change,
          receipt,
          index,
          limits.maximumAllocationBytes,
          signal
        )
        return {
          apply: async (trx, actualBinding, state, actualChange, actualReceipt, actualIndex) =>
            await effect.apply(trx, actualBinding, state, actualChange, actualReceipt, actualIndex, limits)
        }
      }
    },
    signal,
    onAcknowledged
  )
}

export interface SnapshotJournalPreparedPromotionEffect<C> {
  apply: (
    trx: Knex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint,
    change: C,
    receipt: SnapshotJournalDestinationStageReceipt,
    index: number
  ) => Promise<{ inserts: number; updates: number }>
  /** Only genuine owned preparation has cleanup. Complete row effects omit it. */
  close?: () => Promise<void>
}
export interface SnapshotJournalPromotionOperations<C> {
  readPage: (
    trx: Knex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint
  ) => Promise<{ receipt: SnapshotJournalDestinationStageReceipt; page: { changes: readonly C[] } } | undefined>
  prepare: (
    change: C,
    receipt: SnapshotJournalDestinationStageReceipt,
    index: number
  ) => Promise<SnapshotJournalPreparedPromotionEffect<C>>
  batch: (
    trx: Knex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint,
    cursor: SnapshotJournalPromotionCursor | undefined,
    maximumChanges: number,
    apply: (trx: Knex, change: C, receipt: SnapshotJournalDestinationStageReceipt, index: number) => Promise<void>,
    finish: (trx: Knex) => Promise<boolean>
  ) => Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; applied: number }>
}

/** Actual shared cleanup/withdrawal/cursor/ACK kernel. Encoding-specific code
 * supplies a real persisted page reader and fully prepared semantic effects.
 * Preparation and physical cleanup occur outside each short target writer. */
export async function promoteSnapshotJournalChanges<C extends SnapshotJournalDelta>(
  binding: Readonly<SnapshotJournalDestinationBinding>,
  expected: SnapshotJournalDestinationCheckpoint,
  limits: SnapshotJournalDestinationLimits,
  writer: <T>(apply: (trx: Knex) => Promise<T>) => Promise<T>,
  verifyCurrent: () => Promise<void>,
  operations: SnapshotJournalPromotionOperations<C>,
  signal?: AbortSignal,
  onAcknowledged?: (trx: Knex.Transaction, checkpoint: SnapshotJournalDestinationCheckpoint) => Promise<void>
): Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; applied: number; inserts: number; updates: number }> {
  const prepared = new Map<number, SnapshotJournalPreparedPromotionEffect<C>>()
  const pendingCleanup = new Set<SnapshotJournalPreparedPromotionEffect<C>>()
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const effect of pendingCleanup) {
      try {
        await effect.close!()
        pendingCleanup.delete(effect)
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length)
      throw new Brc38StagingCleanupError(
        failures,
        'Journal promotion retains actual prepared effects until drained',
        cleanup
      )
  }
  const execute = async (): Promise<{
    checkpoint: SnapshotJournalDestinationCheckpoint
    applied: number
    inserts: number
    updates: number
  }> => {
    signal?.throwIfAborted()
    await verifyCurrent()
    const observed = await writer(
      async trx =>
        await withSnapshotJournalDestinationWindowFence(trx, binding, expected, async fenced => {
          // Old numeric associations are custody data only. Drain them between
          // pages without deleting native rows before all dependency withdrawals.
          await cleanupSnapshotJournalRetirements(
            fenced,
            binding,
            expected,
            32,
            { remaining: limits.maximumAllocationBytes },
            true
          )
          return {
            cursor: await readSnapshotJournalPromotionCursor(fenced, binding, expected),
            frame: await operations.readPage(fenced, binding, expected)
          }
        })
    )
    const start = observed.cursor?.nextChange ?? 0
    const end = Math.min(start + limits.maximumChanges, observed.frame?.page.changes.length ?? 0)
    if (observed.frame !== undefined) {
      for (let i = start; i < end; i++) {
        signal?.throwIfAborted()
        const change = observed.frame.page.changes[i]
        if (change.present) {
          const effect = await operations.prepare(change, observed.frame.receipt, i)
          prepared.set(i, effect)
          if (effect.close !== undefined) pendingCleanup.add(effect)
        }
      }
    }
    await verifyCurrent()
    let inserts = 0,
      updates = 0
    const result = await writer(async trx => {
      const committed = await operations.batch(
        trx,
        binding,
        expected,
        observed.cursor,
        limits.maximumChanges,
        async (fenced, change, receipt, index) => {
          signal?.throwIfAborted()
          if (observed.frame === undefined || receipt.digest !== observed.frame.receipt.digest) invalid()
          if (!change.present) {
            if (prepared.has(index)) invalid()
            await withdrawSnapshotJournalEntity(fenced, binding, expected, receipt.tableId, change, limits, {
              remaining: limits.maximumAllocationBytes
            })
          } else {
            const entity = prepared.get(index)
            if (entity === undefined) invalid()
            const merged = await entity.apply(fenced, binding, expected, change, receipt, index)
            inserts += merged.inserts
            updates += merged.updates
          }
        },
        async fenced => {
          if (binding.bootstrap === true && !(await cleanupUnseenSnapshotJournalProvenance(fenced, binding, expected)))
            return false
          if (
            binding.bootstrap === true &&
            !(
              await withdrawUnseenSnapshotJournalMemberships(
                fenced,
                binding,
                expected,
                limits,
                { remaining: limits.maximumAllocationBytes },
                32
              )
            ).complete
          )
            return false
          if (
            binding.bootstrap === true &&
            !(await withdrawUnseenSnapshotJournalIdentityMappings(fenced, binding, expected))
          )
            return false
          return (
            await cleanupSnapshotJournalRetirements(fenced, binding, expected, 32, {
              remaining: limits.maximumAllocationBytes
            })
          ).complete
        }
      )
      await advanceSnapshotJournalProgress(trx, binding, expected, committed.checkpoint, { inserts, updates })
      if (committed.checkpoint.phase === 'acknowledged' && onAcknowledged !== undefined)
        await onAcknowledged(trx as Knex.Transaction, committed.checkpoint)
      return committed
    })
    await verifyCurrent()
    return { checkpoint: result.checkpoint, applied: result.applied, inserts, updates }
  }
  let primaryFailed = false
  let primaryFailure: unknown
  let result: Awaited<ReturnType<typeof execute>> | undefined
  try {
    result = await execute()
  } catch (cause) {
    primaryFailed = true
    primaryFailure = cause
  }
  try {
    if (pendingCleanup.size > 0) await cleanup()
  } catch (cause) {
    if (primaryFailed)
      throw new Brc38StagingCleanupError(
        [primaryFailure, cause],
        'Journal promotion and actual preparation cleanup failed',
        cleanup
      )
    throw cause
  }
  if (primaryFailed) throw primaryFailure
  if (result === undefined) invalid()
  return result
}
