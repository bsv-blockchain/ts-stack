import { HeightRange } from '../../services/chaintracker/chaintracks/util/HeightRange'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

export interface ReviewHeightRangeResult {
  log: string
  reviewedHeights: number
  mismatchedHeights: number
  affectedTransactions: number
  updatedTransactions: number
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
  static taskName = 'ReviewProvenTxs'

  static checkNow = false

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute * 10,
    public maxHeightsPerRun = 100,
    public minBlockAge = 100
  ) {
    super(monitor, TaskReviewProvenTxs.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskReviewProvenTxs.checkNow ||
        (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async reviewHeightRange(range: HeightRange): Promise<ReviewHeightRangeResult> {
    const result: ReviewHeightRangeResult = {
      log: '',
      reviewedHeights: 0,
      mismatchedHeights: 0,
      affectedTransactions: 0,
      updatedTransactions: 0
    }

    if (range.isEmpty) return result

    const chaintracks = this.monitor.chaintracksWithEvents || this.monitor.chaintracks

    for (let height = range.minHeight; height <= range.maxHeight; height++) {
      result.reviewedHeights++

      const header = await chaintracks.findHeaderForHeight(height)
      if (!header) {
        result.log += `  height ${height} canonical header unavailable\n`
        continue
      }

      let staleRoots: string[] = []
      await this.storage.runAsStorageProvider(async sp => {
        staleRoots = await sp.findStaleMerkleRoots({ height, merkleRoot: header.merkleRoot })
      })

      if (staleRoots.length === 0) continue

      result.mismatchedHeights++
      result.log += `  height ${height} canonical ${header.merkleRoot} stale ${staleRoots.join(',')}\n`

      for (const staleRoot of staleRoots) {
        const reprove = await this.storage.reproveHeightMerkleRoot(height, staleRoot)
        result.affectedTransactions += reprove.updated.length + reprove.unchanged.length + reprove.unavailable.length
        result.updatedTransactions += reprove.updated.length
        result.log += reprove.log
      }
    }

    return result
  }

  async getLastReviewedHeight(): Promise<number | undefined> {
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
          return parsed.reviewedThroughHeight
        }
      } catch {
        continue
      }
    }

    return undefined
  }

  async runTask(): Promise<string> {
    TaskReviewProvenTxs.checkNow = false

    const chaintracks = this.monitor.chaintracksWithEvents || this.monitor.chaintracks
    const tipHeight = await chaintracks.currentHeight()
    const maxEligibleHeight = tipHeight - this.minBlockAge
    const lastReviewedHeight = await this.getLastReviewedHeight()
    const startHeight = lastReviewedHeight === undefined ? 0 : lastReviewedHeight + 1
    const endHeight = Math.min(startHeight + this.maxHeightsPerRun - 1, maxEligibleHeight)
    const range = new HeightRange(startHeight, endHeight)
    if (range.isEmpty) return ''

    let log = `reviewing heights ${range.minHeight}..${range.maxHeight} tip=${tipHeight} minAge=${this.minBlockAge} maxPerRun=${this.maxHeightsPerRun}\n`
    const review = await this.reviewHeightRange(range)
    log += review.log

    return JSON.stringify({
      tipHeight,
      minBlockAge: this.minBlockAge,
      maxHeightsPerRun: this.maxHeightsPerRun,
      startHeight,
      reviewedThroughHeight: range.maxHeight,
      reviewedHeights: review.reviewedHeights,
      mismatchedHeights: review.mismatchedHeights,
      affectedTransactions: review.affectedTransactions,
      updatedTransactions: review.updatedTransactions,
      reviewLog: log
    } satisfies ReviewProvenTxsCheckpoint)
  }
}
