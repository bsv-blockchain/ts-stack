import { HeightRange } from '../../services/chaintracker/chaintracks/util/HeightRange'
import { DeactivedHeader, Monitor } from '../Monitor'
import { MAX_MONITOR_PAGE_SIZE, requireMonitorInteger } from '../monitorValidation'
import { ReorgRecovery } from '../reorgRecovery'
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
 * `maxRetries` (default 3) bounds these aged per-header attempts only. With `recentDepth`
 * enabled, journaled height recovery remains eligible for canonical retries until resolved.
 *
 * With `recentDepth` enabled, every processed new tip routinely schedules a recent-height
 * review. Most normal reviews find no canonical proof mismatch. Generating new proven_txs
 * records intentionally lags new block generation to minimize disruptive proof updates.
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
 * Recovery ranges are persisted before remote work. Unresolved heights survive restart and
 * window aging, and are retried once per minute even if the chain tip does not change.
 * The durable last processed height also queues the gap observed after monitor downtime.
 * TaskReviewProvenTxs separately audits age-eligible history forward. An arbitrary historical
 * reorg below both forward cursors requires separate ancestry reconciliation.
 */
export class TaskReorg extends WalletMonitorTask {
  static readonly taskName = 'Reorg'

  process: DeactivedHeader[] = []

  /**
   * Hash of the last processed new block header whose recent heights have been reviewed.
   */
  private recovery = new ReorgRecovery()
  private recoveryLoaded = false
  private lastRecentAttempt = 0

  override async asyncSetup(): Promise<void> {
    if (this.recoveryLoaded || this.recentDepth === 0) return
    await this.storage.runAsStorageProvider(async sp => {
      const events = await sp.findMonitorEvents({
        partial: { event: 'ReorgRecovery' },
        orderDescending: true,
        paged: { limit: 5 }
      })
      for (const event of events) {
        if (!event.details) continue
        const checkpoint = ReorgRecovery.parse(event.details)
        if (checkpoint) {
          this.recovery = checkpoint
          break
        }
      }
    })
    this.recoveryLoaded = true
  }

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
   * a new block header has been processed since the last recent-height review,
   * or unresolved durable work is due for its one-minute retry.
   */
  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    const cutoff = nowMsecsSinceEpoch - this.agedMsecs
    const q = this.monitor.deactivatedHeaders
    while (q.length > 0 && cutoff > q[0].whenMsecs) {
      const header = this.monitor.shiftDeactivatedHeader()
      if (header != null) this.process.push(header)
    }
    return {
      run:
        this.process.length > 0 ||
        this.recentReviewDue() ||
        (this.recentDepth > 0 &&
          this.recovery.ranges.length > 0 &&
          nowMsecsSinceEpoch - this.lastRecentAttempt >= Monitor.oneMinute)
    }
  }

  private recentReviewDue(): boolean {
    const tip = this.monitor.lastNewHeader
    return this.recentDepth > 0 && tip != null && tip.hash !== this.recovery.reviewedHash
  }

  /**
   * Reviews the stored proofs of the `recentDepth` heights ending at the last processed new block header.
   */
  private async reviewRecentHeights(): Promise<string> {
    await this.asyncSetup()
    const tip = this.monitor.lastNewHeader
    if (tip == null || this.recentDepth === 0) return ''
    this.lastRecentAttempt = Date.now()
    const retryBatch = this.recovery.next(tip.height, this.recentDepth)
    const freshBatch: [number, number] | undefined = this.recentReviewDue()
      ? [Math.max(0, tip.height - this.recentDepth + 1), tip.height]
      : undefined
    if (freshBatch) {
      const priorHeight = this.recovery.reviewedHeight
      // Recover the gap observed while the monitor was stopped, in bounded later batches.
      const gapStart =
        priorHeight === undefined
          ? freshBatch[0]
          : Math.min(freshBatch[0], Math.max(0, priorHeight - this.recentDepth + 1))
      this.recovery.add(gapStart, tip.height)
      this.recovery.reviewedHash = tip.hash
      this.recovery.reviewedHeight = tip.height
    }
    if (!freshBatch && !retryBatch) return ''
    // Write intent before network work: process interruption retains both batches.
    await this.monitor.logEvent('ReorgRecovery', JSON.stringify(this.recovery))
    let log = freshBatch ? await this.reviewBatch(freshBatch) : ''
    // Old unresolved work gets its own bounded budget, so new tips cannot starve it.
    if (retryBatch && (!freshBatch || retryBatch[0] < freshBatch[0] || retryBatch[1] > freshBatch[1])) {
      log += await this.reviewBatch(retryBatch)
    }
    return log
  }

  private async reviewBatch(batch: [number, number]): Promise<string> {
    const range = new HeightRange(...batch)
    const r = await reviewProvenTxHeights(this.monitor, range)
    const intent = this.recovery.clone()
    this.recovery.complete(batch, r.unresolvedHeights)
    try {
      await this.monitor.logEvent('ReorgRecovery', JSON.stringify(this.recovery))
    } catch (error) {
      this.recovery = intent
      throw error
    }
    if (r.log.length === 0) return ''
    return `reviewing recent heights ${range.minHeight}..${range.maxHeight}\n` + r.log
  }

  async runTask(): Promise<string> {
    await this.asyncSetup()
    if (this.recentDepth > 0 && this.process.length > 0) {
      for (const header of this.process) this.recovery.add(header.header.height, header.header.height)
      await this.monitor.logEvent('ReorgRecovery', JSON.stringify(this.recovery))
    }
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
