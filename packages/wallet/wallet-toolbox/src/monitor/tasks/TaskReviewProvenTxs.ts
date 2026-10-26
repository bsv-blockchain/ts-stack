import { HeightRange } from '../../services/chaintracker/chaintracks/util/HeightRange'
import { Monitor } from '../Monitor'
import { ReorgRecovery } from '../reorgRecovery'
import {
  MAX_MONITOR_HEIGHT,
  MAX_MONITOR_INTERVAL_MSECS,
  MAX_MONITOR_PAGE_SIZE,
  optionalMonitorInteger,
  requireMonitorInteger
} from '../monitorValidation'
import { reviewProvenTxHeights } from '../reviewProvenTxHeights'
import { WalletMonitorTask } from './WalletMonitorTask'

export interface ReviewHeightRangeResult {
  log: string
  reviewedHeights: number
  mismatchedHeights: number
  affectedTransactions: number
  updatedTransactions: number
  unresolvedHeights: number[]
}

interface ReviewProvenTxsCheckpoint {
  tipHeight: number
  minBlockAge: number
  maxHeightsPerRun: number
  startHeight: number
  reviewedThroughHeight: number
  reviewedHeights: number
  mismatchedHeights: number
  affectedTransactions: number
  updatedTransactions: number
  retryHeights?: number[]
  retryRecovery?: ReorgRecovery
  reviewLog?: string
  bootstrapComplete?: boolean
}

/**
 * Backup verification task for recent proven_txs records.
 *
 * Reorg handling should normally be driven by TaskReorg via deactivated-header events.
 * This task runs a lagged audit over recent heights and only reproves transactions when
 * the currently canonical merkleRoot at a height no longer matches stored proven_txs roots.
 */
export class TaskReviewProvenTxs extends WalletMonitorTask {
  static readonly taskName = 'ReviewProvenTxs'

  private static checkNowRequested = false
  static get checkNow(): boolean {
    return this.checkNowRequested
  }
  static set checkNow(value: boolean) {
    this.checkNowRequested = value
  }

  triggerNextMsecs: number

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute * 10,
    public maxHeightsPerRun = 100,
    public minBlockAge = 100,
    public triggerQuickMsecs = Monitor.oneMinute * 1,
    public maxRetryHeightsPerRun = 25
  ) {
    super(monitor, TaskReviewProvenTxs.taskName)
    requireMonitorInteger(triggerMsecs, 'triggerMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
    requireMonitorInteger(maxHeightsPerRun, 'maxHeightsPerRun', 0, MAX_MONITOR_PAGE_SIZE)
    requireMonitorInteger(minBlockAge, 'minBlockAge', 0, MAX_MONITOR_HEIGHT)
    requireMonitorInteger(triggerQuickMsecs, 'triggerQuickMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
    requireMonitorInteger(maxRetryHeightsPerRun, 'maxRetryHeightsPerRun', 0, MAX_MONITOR_PAGE_SIZE)
    this.triggerNextMsecs = this.triggerQuickMsecs
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskReviewProvenTxs.checkNow ||
        (this.triggerNextMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerNextMsecs)
    }
  }

  async runTask(): Promise<string> {
    TaskReviewProvenTxs.checkNow = false

    const chaintracks = this.monitor.chaintracksWithEvents || this.monitor.chaintracks
    const tipHeight = requireMonitorInteger(
      await chaintracks.currentHeight(),
      'chain tip height',
      0,
      MAX_MONITOR_HEIGHT
    )
    const maxEligibleHeight = tipHeight - this.minBlockAge
    const checkpoint = await this.getLastCheckpoint()
    const firstHeight = checkpoint?.bootstrapComplete === true ? 0 : await this.getFirstProvenHeight()
    const lastReviewedHeight = checkpoint?.reviewedThroughHeight ?? (await this.getLastReviewedHeight())
    // Empty wallets must not checkpoint empty history. Existing checkpoints below
    // the first proof can skip only that empty prefix; pending retries survive.
    const startHeight = Math.max(firstHeight ?? 0, (lastReviewedHeight ?? -1) + 1)
    const endHeight =
      firstHeight === undefined ? -1 : Math.min(startHeight + this.maxHeightsPerRun - 1, maxEligibleHeight)
    const range = new HeightRange(startHeight, endHeight)
    const retryRecovery = checkpoint?.retryRecovery ?? new ReorgRecovery()
    const retryPlan = ReorgRecovery.parse(JSON.stringify(retryRecovery)) ?? new ReorgRecovery()
    if (
      range.isEmpty &&
      (this.maxRetryHeightsPerRun === 0 || retryPlan.next(maxEligibleHeight, this.maxRetryHeightsPerRun) === undefined)
    )
      return ''

    let log = ''
    const review: ReviewHeightRangeResult = {
      log: '',
      reviewedHeights: 0,
      mismatchedHeights: 0,
      affectedTransactions: 0,
      updatedTransactions: 0,
      unresolvedHeights: []
    }
    const mergeReview = (part: ReviewHeightRangeResult): void => {
      review.log += part.log
      review.reviewedHeights += part.reviewedHeights
      review.mismatchedHeights += part.mismatchedHeights
      review.affectedTransactions += part.affectedTransactions
      review.updatedTransactions += part.updatedTransactions
      review.unresolvedHeights.push(...part.unresolvedHeights)
    }

    const retry = async (budget: number): Promise<void> => {
      if (budget === 0) return
      const batch = retryPlan.next(maxEligibleHeight, budget)
      if (batch === undefined) return
      // Remove attempted work from this run's plan even if it remains unresolved.
      retryPlan.complete(batch, [])
      log += `retrying unresolved heights ${batch[0]}..${batch[1]}\n`
      const part = await this.reviewHeightRange(new HeightRange(...batch))
      mergeReview(part)
      retryRecovery.complete(batch, part.unresolvedHeights)
      await retry(budget - (batch[1] - batch[0] + 1))
    }
    await retry(this.maxRetryHeightsPerRun)
    if (!range.isEmpty) {
      log += `reviewing heights ${range.minHeight}..${range.maxHeight} tip=${tipHeight} minAge=${this.minBlockAge} maxPerRun=${this.maxHeightsPerRun}\n`
      mergeReview(await this.reviewHeightRange(range))
    }
    log += review.log

    for (const height of review.unresolvedHeights) retryRecovery.add(height, height)
    // Keep a small compatibility summary; the compact ranges retain all work.
    const retryCount = retryRecovery.ranges.reduce((count, [min, max]) => count + max - min + 1, 0)
    const retryHeights =
      retryCount <= 128
        ? retryRecovery.ranges.flatMap(([min, max]) => Array.from({ length: max - min + 1 }, (_, index) => min + index))
        : undefined
    const reviewedThroughHeight = range.isEmpty ? (lastReviewedHeight ?? -1) : range.maxHeight

    return JSON.stringify({
      tipHeight,
      minBlockAge: this.minBlockAge,
      maxHeightsPerRun: this.maxHeightsPerRun,
      startHeight,
      reviewedThroughHeight,
      reviewedHeights: review.reviewedHeights,
      mismatchedHeights: review.mismatchedHeights,
      affectedTransactions: review.affectedTransactions,
      updatedTransactions: review.updatedTransactions,
      retryHeights,
      retryRecovery,
      reviewLog: log.slice(0, 256),
      bootstrapComplete: firstHeight !== undefined
    } satisfies ReviewProvenTxsCheckpoint)
  }

  async reviewHeightRange(range: HeightRange): Promise<ReviewHeightRangeResult> {
    // If there is work to do, trigger a quick follow-up to continue processing the next range.
    this.triggerNextMsecs = range.isEmpty ? this.triggerMsecs : this.triggerQuickMsecs

    return await reviewProvenTxHeights(this.monitor, range)
  }

  async getLastReviewedHeight(): Promise<number | undefined> {
    const checkpoint = await this.getLastCheckpoint()
    if (checkpoint?.reviewedThroughHeight != null) return checkpoint.reviewedThroughHeight

    const firstHeight = await this.getFirstProvenHeight()
    return firstHeight === undefined ? undefined : firstHeight - 1
  }

  private async getFirstProvenHeight(): Promise<number | undefined> {
    let height: number | undefined
    await this.storage.runAsStorageProvider(async sp => {
      const minimum = await sp.getProvenTxsReviewStartHeight()
      if (minimum !== undefined) height = requireMonitorInteger(minimum, 'first proven height', 0, MAX_MONITOR_HEIGHT)
    })
    return height
  }

  async getLastCheckpoint(): Promise<Partial<ReviewProvenTxsCheckpoint> | undefined> {
    let events: Array<{ details?: string }> = []
    await this.storage.runAsStorageProvider(async sp => {
      events = await sp.findMonitorEvents({
        partial: { event: TaskReviewProvenTxs.taskName },
        orderDescending: true,
        paged: { limit: 5 }
      })
    })

    for (const event of events) {
      const checkpoint = this.parseCheckpoint(event.details)
      if (checkpoint !== undefined) return checkpoint
    }
    return undefined
  }

  private parseCheckpoint(details?: string): Partial<ReviewProvenTxsCheckpoint> | undefined {
    if (details === undefined || details.length > 8192) return undefined
    try {
      const parsed: unknown = JSON.parse(details)
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      const record = parsed as Record<string, unknown>
      const reviewedThroughHeight = optionalMonitorInteger(record.reviewedThroughHeight, 0, MAX_MONITOR_HEIGHT)
      if (reviewedThroughHeight === undefined) return undefined
      const parsedRecovery =
        record.retryRecovery === undefined ? undefined : ReorgRecovery.parse(JSON.stringify(record.retryRecovery))
      if (record.retryRecovery !== undefined && parsedRecovery === undefined) return undefined
      const retryRecovery = parsedRecovery ?? this.legacyRetryRecovery(record.retryHeights)
      return { reviewedThroughHeight, retryRecovery, bootstrapComplete: record.bootstrapComplete === true }
    } catch {
      return undefined
    }
  }

  private legacyRetryRecovery(value: unknown): ReorgRecovery {
    const recovery = new ReorgRecovery()
    if (Array.isArray(value) && value.length <= 8192) {
      for (const candidate of value) {
        const height = optionalMonitorInteger(candidate, 0, MAX_MONITOR_HEIGHT)
        if (height !== undefined) recovery.add(height, height)
      }
    }
    return recovery
  }
}
