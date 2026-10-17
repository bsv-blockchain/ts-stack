import { HeightRange } from '../../services/chaintracker/chaintracks/util/HeightRange'
import { DeactivedHeader, Monitor } from '../Monitor'
import { MAX_MONITOR_PAGE_SIZE, requireMonitorInteger } from '../monitorValidation'
import { reviewProvenTxHeights } from '../reviewProvenTxHeights'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Check the `monitor.deactivatedHeaders` for any headers that have been deactivated.
 *
 * When headers are found, review matching ProvenTx records and update proof data as appropriate.
 *
 * New deactivated headers are pushed onto the `deactivatedHeaders` array.
 * They must be shifted out as they are processed.
 *
 * The current implementation ages deactivation notifications by 10 minutes with each retry.
 * If a successful proof update confirms original proof data after 3 retries, the original is retained.
 *
 * In normal operation there should rarely be any work for this task to perform.
 * The most common result is that there are no matching proven_txs records because
 * generating new proven_txs records intentionally lags new block generation to
 * minimize this disruption.
 *
 * It is very disruptive to update a proven_txs record because:
 * - Sync'ed storage is impacted.
 * - Generated beefs are impacted.
 * - Updated proof data may be unavailable at the time a reorg is first reported.
 *
 * Proper reorg handling also requires repairing invalid beefs for new transactions when
 * createAction fails to verify a generated beef against the chaintracker.
 *
 * Deactivated headers arrive only from chaintracks reorg events, which polling clients
 * (`supportsReorgEvents === false`) never raise and which any client can miss while the
 * monitor is not running. So once per new block header processed by TaskNewHeader, this task
 * also compares the stored merkleRoots of the most recent `recentDepth` heights with the
 * chaintracks header at each height, and reproves the transactions under any stale root.
 * A proof that cannot be replaced yet is retried at the next block while its height remains
 * within `recentDepth`. Older heights are left to TaskReviewProvenTxs.
 */
export class TaskReorg extends WalletMonitorTask {
  static readonly taskName = 'Reorg'

  process: DeactivedHeader[] = []

  /**
   * Hash of the last processed new block header whose recent heights have been reviewed.
   */
  private recentReviewedHash?: string

  /**
   * @param recentDepth number of heights, ending at the processed chain tip, whose stored proofs
   * are compared with the chaintracks header at that height once per new block. Zero disables.
   */
  constructor(
    monitor: Monitor,
    public agedMsecs = Monitor.oneMinute * 10,
    public maxRetries = 3,
    public recentDepth = 12
  ) {
    super(monitor, TaskReorg.taskName)
    requireMonitorInteger(recentDepth, 'recentDepth', 0, MAX_MONITOR_PAGE_SIZE)
  }

  /**
   * Shift aged deactivated headers onto `process` array.
   * @param nowMsecsSinceEpoch current time in milliseconds since epoch.
   * @returns `run` true iff there are aged deactivated headers to process,
   * or a new block header has been processed since the last recent-height review.
   */
  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    const cutoff = nowMsecsSinceEpoch - this.agedMsecs
    const q = this.monitor.deactivatedHeaders
    while (q.length > 0 && cutoff > q[0].whenMsecs) {
      const header = this.monitor.shiftDeactivatedHeader()
      if (header != null) this.process.push(header)
    }
    return {
      run: this.process.length > 0 || this.recentReviewDue()
    }
  }

  private recentReviewDue(): boolean {
    const tip = this.monitor.lastNewHeader
    return this.recentDepth > 0 && tip != null && tip.hash !== this.recentReviewedHash
  }

  /**
   * Reviews the stored proofs of the `recentDepth` heights ending at the last processed new block header.
   */
  private async reviewRecentHeights(): Promise<string> {
    const tip = this.monitor.lastNewHeader
    if (tip == null || !this.recentReviewDue()) return ''
    // Marked before the review: a failed or unresolved review is retried at the next block, not every tick.
    this.recentReviewedHash = tip.hash
    const range = new HeightRange(Math.max(0, tip.height - this.recentDepth + 1), tip.height)
    const r = await reviewProvenTxHeights(this.monitor, range)
    if (r.log.length === 0) return ''
    return `reviewing recent heights ${range.minHeight}..${range.maxHeight}\n` + r.log
  }

  async runTask(): Promise<string> {
    let log = ''

    for (;;) {
      // Loop over deactivated headers to process
      const header = this.process.shift()
      if (header == null) break

      const r = await this.storage.reproveHeader(header.header.hash)

      log += r.log

      if (r.unavailable.length > 0 || r.unchanged.length > 0) {
        if (header.tries + 1 >= this.maxRetries) {
          log += `      maximum retries ${this.maxRetries} exceeded\n`
        } else {
          log += '    retrying...\n'
          this.monitor.enqueueDeactivatedHeader({
            header: header.header,
            whenMsecs: Date.now(),
            tries: header.tries + 1
          })
        }
      }
    }

    log += await this.reviewRecentHeights()

    return log
  }
}
