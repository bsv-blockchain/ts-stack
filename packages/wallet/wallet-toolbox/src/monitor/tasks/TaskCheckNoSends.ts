import { Monitor } from '../Monitor'
import { getProofs } from './TaskCheckForProofs'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * `TaskCheckNoSends` is a WalletMonitor task that retreives merkle proofs for
 * 'nosend' transactions that MAY have been shared externally.
 *
 * Unlike intentionally processed transactions, 'nosend' transactions are fully valid
 * transactions which have not been processed by the wallet.
 *
 * By default, this task runs once a day to check if any 'nosend' transaction has
 * managed to get mined by some external process.
 *
 * If a proof is obtained and validated, a new ProvenTx record is created and
 * the original ProvenTxReq status is advanced to 'notifying'.
 *
 * Freshness gate on the checkNow path: when this task is triggered by a new
 * block header (via `checkNow = true`, wired in Monitor.processNewBlockHeader),
 * it skips `nosend` rows whose `created_at` is more recent than
 * `checkNowFreshnessSkipMsecs`. This avoids hammering external proof services
 * with `getMerklePath` lookups for `nosend` rows that are part of an in-flight
 * batched-tx workflow (chained `createAction({ noSend: true, sendWith: [...] })`
 * builds, broadcast all-at-once by the terminator). Those rows are not yet
 * on chain by design; chain-checking them produces "not found" responses and
 * wastes round-trips. Externally-broadcast `nosend` txs (the original use
 * case in the paragraphs above) are still caught by either the unfiltered
 * daily cadence or the next block-triggered run after the threshold elapses.
 */
export class TaskCheckNoSends extends WalletMonitorTask {
  static readonly taskName = 'CheckNoSends'

  /**
   * An external service such as the chaintracks new block header
   * listener can set this true to cause
   */
  static checkNow = false

  /**
   * When `checkNow` triggers a run, `nosend` rows newer than this threshold
   * are skipped for chain-status lookup. The scheduled daily cadence is
   * unaffected (no filter applied there). See class docstring for the
   * rationale.
   */
  static readonly checkNowFreshnessSkipMsecs = 5 * 60 * 1000 // 5 minutes

  constructor (
    monitor: Monitor,
    public triggerMsecs = Monitor.oneDay * 1
  ) {
    super(monitor, TaskCheckNoSends.taskName)
  }

  /**
   * Normally triggered by checkNow getting set by new block header found event from chaintracks
   */
  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskCheckNoSends.checkNow ||
        (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async runTask (): Promise<string> {
    let log = ''
    const wasCheckNow = TaskCheckNoSends.checkNow
    const countsAsAttempt = wasCheckNow
    TaskCheckNoSends.checkNow = false

    const maxAcceptableHeight = this.monitor.lastNewHeader?.height
    if (maxAcceptableHeight === undefined) {
      return log
    }

    // Only applied on the block-triggered (`checkNow`) path. Daily cadence
    // scans everything so externally-broadcast unmined txs still get
    // recognized eventually regardless of age.
    const freshnessCutoff = wasCheckNow
      ? Date.now() - TaskCheckNoSends.checkNowFreshnessSkipMsecs
      : undefined

    const limit = 100
    let offset = 0
    for (;;) {
      const reqs = await this.storage.findProvenTxReqs({
        partial: {},
        status: ['nosend'],
        paged: { limit, offset }
      })
      if (reqs.length === 0) break
      log += `${reqs.length} reqs with status 'nosend'\n`

      let eligible = reqs
      if (freshnessCutoff !== undefined) {
        eligible = reqs.filter(r => r.created_at.getTime() <= freshnessCutoff)
        const skipped = reqs.length - eligible.length
        if (skipped > 0) {
          log += `skipping ${skipped} of ${reqs.length} reqs newer than ${TaskCheckNoSends.checkNowFreshnessSkipMsecs / 1000}s on checkNow path (in-flight batched-tx workflow protection)\n`
        }
      }

      if (eligible.length > 0) {
        const r = await getProofs(this, eligible, maxAcceptableHeight, 2, countsAsAttempt, false)
        log += `${r.log}\n`
      }
      if (reqs.length < limit) break
      offset += limit
    }
    return log
  }
}
