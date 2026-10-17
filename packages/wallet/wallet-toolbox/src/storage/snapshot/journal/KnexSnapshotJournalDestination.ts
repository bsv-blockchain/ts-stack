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
  private constructor(
    private readonly storage: StorageKnex,
    private readonly source: SnapshotJournalReconciliationSource,
    readonly binding: Readonly<SnapshotJournalDestinationBinding>,
    private readonly limits: SnapshotJournalDestinationLimits,
    private readonly admission: SnapshotJournalWriterAdmission,
    private readonly signal?: AbortSignal
  ) {}

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
    const begin = await admission(
      async () =>
        await source.withCommitFence(
          async () =>
            await storage.runSnapshotJournalWriter(
              async (trx, backend) => {
                if (backend === source.receiptBinding.backend) invalid()
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
                    compareSnapshotJournalRevisions(previous.binding.receipt.highWater, source.receipt.highWater) <= 0
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
        return next
      })
    }
    await source.verifyLive()
    if (checkpoint === undefined) invalid()
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
    return await this.storage.runSnapshotJournalWriter(
      async (trx, backend) => {
        if (backend !== this.binding.destinationBackend) invalid()
        await verifySnapshotJournalDestinationSchema(trx)
        await readSnapshotJournalCaptureConfiguration(trx)
        return await apply(trx)
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
        await this.physicalWriter(
          async trx =>
            await selectSnapshotJournalDestinationPrimary(
              trx,
              this.binding,
              expected,
              activeStorage,
              async (fenced, userId) => await this.storage.updateUser(userId, { activeStorage }, fenced)
            )
        )
        onSelected?.(activeStorage !== this.binding.activeStorage)
        return true
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
    return await this.exclusive(async () => {
      this.signal?.throwIfAborted()
      await this.source.verifyLive()
      const observed = await this.writer(
        async trx =>
          await withSnapshotJournalDestinationWindowFence(trx, this.binding, expected, async fenced => {
            // Old numeric associations are custody data only. Drain them between
            // pages without deleting native rows before all dependency withdrawals.
            await cleanupSnapshotJournalRetirements(
              fenced,
              this.binding,
              expected,
              32,
              { remaining: this.limits.maximumAllocationBytes },
              true
            )
            return {
              cursor: await readSnapshotJournalPromotionCursor(fenced, this.binding, expected),
              frame: await readSnapshotJournalDestinationPromotionPage(fenced, this.binding, expected)
            }
          })
      )
      const prepared = new Map<number, SnapshotJournalPreparedEntityMerge>()
      const start = observed.cursor?.nextChange ?? 0
      const end = Math.min(start + this.limits.maximumChanges, observed.frame?.page.changes.length ?? 0)
      if (observed.frame !== undefined) {
        for (let i = start; i < end; i++) {
          this.signal?.throwIfAborted()
          const change = observed.frame.page.changes[i]
          if (change.present)
            prepared.set(
              i,
              await SnapshotJournalPreparedEntityMerge.prepare(
                this.storage,
                this.binding,
                change,
                observed.frame.receipt,
                i,
                this.limits.maximumAllocationBytes,
                this.signal
              )
            )
        }
      }
      await this.source.verifyLive()
      let inserts = 0,
        updates = 0
      const result = await this.writer(async trx => {
        const committed = await promoteSnapshotJournalDestinationBatch(
          trx,
          this.binding,
          expected,
          observed.cursor,
          this.limits.maximumChanges,
          async (fenced, change, receipt, index) => {
            this.signal?.throwIfAborted()
            if (observed.frame === undefined || receipt.digest !== observed.frame.receipt.digest) invalid()
            if (!change.present) {
              if (prepared.has(index)) invalid()
              await withdrawSnapshotJournalEntity(
                fenced,
                this.binding,
                expected,
                receipt.tableId,
                change,
                this.limits,
                { remaining: this.limits.maximumAllocationBytes }
              )
            } else {
              const entity = prepared.get(index)
              if (entity === undefined) invalid()
              const merged = await entity.apply(fenced, this.binding, expected, change, receipt, index, this.limits)
              inserts += merged.inserts
              updates += merged.updates
            }
          },
          async fenced => {
            if (
              this.binding.bootstrap === true &&
              !(await cleanupUnseenSnapshotJournalProvenance(fenced, this.binding, expected))
            )
              return false
            if (
              this.binding.bootstrap === true &&
              !(
                await withdrawUnseenSnapshotJournalMemberships(
                  fenced,
                  this.binding,
                  expected,
                  this.limits,
                  { remaining: this.limits.maximumAllocationBytes },
                  32
                )
              ).complete
            )
              return false
            if (
              this.binding.bootstrap === true &&
              !(await withdrawUnseenSnapshotJournalIdentityMappings(fenced, this.binding, expected))
            )
              return false
            return (
              await cleanupSnapshotJournalRetirements(fenced, this.binding, expected, 32, {
                remaining: this.limits.maximumAllocationBytes
              })
            ).complete
          }
        )
        await advanceSnapshotJournalProgress(trx, this.binding, expected, committed.checkpoint, { inserts, updates })
        return committed
      })
      await this.source.verifyLive()
      return { checkpoint: result.checkpoint, applied: result.applied, inserts, updates }
    })
  }
}
