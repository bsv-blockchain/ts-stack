import { HeightRange } from '../../services/chaintracker/chaintracks/util/HeightRange'
import { Monitor } from '../Monitor'
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
  reviewLog?: string
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
    const tipHeight = await chaintracks.currentHeight()
    const maxEligibleHeight = tipHeight - this.minBlockAge
    const checkpoint = await this.getLastCheckpoint()
    const lastReviewedHeight = checkpoint?.reviewedThroughHeight ?? (await this.getLastReviewedHeight())
    const startHeight = lastReviewedHeight === undefined ? 0 : lastReviewedHeight + 1
    const endHeight = Math.min(startHeight + this.maxHeightsPerRun - 1, maxEligibleHeight)
    const range = new HeightRange(startHeight, endHeight)
    const priorRetryHeights = [...new Set(checkpoint?.retryHeights ?? [])].filter(
      height => Number.isInteger(height) && height >= 0
    )
    // Retain temporarily ineligible heights if the tip retreats. Eligibility
    // limits this attempt, not the durable queue of unresolved work.
    const retryBatch =
      this.maxRetryHeightsPerRun > 0
        ? priorRetryHeights.filter(height => height <= maxEligibleHeight).slice(0, this.maxRetryHeightsPerRun)
        : []
    if (range.isEmpty && retryBatch.length === 0) return ''

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

    if (retryBatch.length > 0) {
      log += `retrying unresolved heights ${retryBatch.join(',')}\n`
      for (const height of retryBatch) mergeReview(await this.reviewHeightRange(new HeightRange(height, height)))
    }
    if (!range.isEmpty) {
      log += `reviewing heights ${range.minHeight}..${range.maxHeight} tip=${tipHeight} minAge=${this.minBlockAge} maxPerRun=${this.maxHeightsPerRun}\n`
      mergeReview(await this.reviewHeightRange(range))
    }
    log += review.log

    const attemptedRetries = new Set(retryBatch)
    // Failed attempts move behind waiting heights so persistent failures cannot
    // monopolize the next batch, including after a monitor restart.
    const retryHeights = [
      ...new Set([...priorRetryHeights.filter(height => !attemptedRetries.has(height)), ...review.unresolvedHeights])
    ]
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
      reviewLog: log
    } satisfies ReviewProvenTxsCheckpoint)
  }

  async reviewHeightRange(range: HeightRange): Promise<ReviewHeightRangeResult> {
    const result: ReviewHeightRangeResult = {
      log: '',
      reviewedHeights: 0,
      mismatchedHeights: 0,
      affectedTransactions: 0,
      updatedTransactions: 0,
      unresolvedHeights: []
    }

    if (range.isEmpty) {
      this.triggerNextMsecs = this.triggerMsecs
      return result
    }

    // If there is work to do, trigger a quick follow-up to continue processing the next range.
    this.triggerNextMsecs = this.triggerQuickMsecs

    const chaintracks = this.monitor.chaintracksWithEvents || this.monitor.chaintracks

    for (let height = range.minHeight; height <= range.maxHeight; height++) {
      result.reviewedHeights++

      const header = await chaintracks.findHeaderForHeight(height)
      if (header == null) {
        result.log += `  height ${height} canonical header unavailable\n`
        result.unresolvedHeights.push(height)
        continue
      }

      let staleRoots: string[] = []
      await this.storage.runAsStorageProvider(async sp => {
        staleRoots = await sp.findStaleMerkleRoots({ height, merkleRoot: header.merkleRoot })
      })

      if (staleRoots.length === 0) continue

      result.mismatchedHeights++
      result.log += `  height ${height} canonical ${header.merkleRoot} stale ${staleRoots.join(',')}\n`
      let unresolved = false

      for (const staleRoot of staleRoots) {
        const reprove = await this.storage.reproveHeightMerkleRoot(height, staleRoot)
        result.affectedTransactions += reprove.updated.length + reprove.unchanged.length + reprove.unavailable.length
        result.updatedTransactions += reprove.updated.length
        if (reprove.unchanged.length > 0 || reprove.unavailable.length > 0) unresolved = true
        result.log += reprove.log
      }
      if (unresolved) result.unresolvedHeights.push(height)
    }

    return result
  }

  async getLastReviewedHeight(): Promise<number | undefined> {
    const checkpoint = await this.getLastCheckpoint()
    if (checkpoint?.reviewedThroughHeight != null) return checkpoint.reviewedThroughHeight

    let lastReviewedHeight: number | undefined
    await this.storage.runAsStorageProvider(async sp => {
      // Start at height of first proven tx when it appears...
      const ptxs = await sp.findProvenTxs({ partial: {}, paged: { limit: 1, offset: 0 }, orderDescending: false })
      if (ptxs.length > 0) {
        lastReviewedHeight = ptxs[0].height - 1
      }
    })

    return lastReviewedHeight
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
      if (!event.details) continue
      try {
        const parsed = JSON.parse(event.details) as Partial<ReviewProvenTxsCheckpoint>
        if (typeof parsed.reviewedThroughHeight === 'number') {
          return parsed
        }
      } catch {
        continue
      }
    }

    return undefined
  }
}
