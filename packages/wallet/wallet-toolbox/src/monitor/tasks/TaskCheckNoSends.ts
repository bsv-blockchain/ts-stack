import { Monitor } from '../Monitor'
import { getProofs } from './TaskCheckForProofs'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * `TaskCheckNoSends` is a WalletMonitor task that retrieves merkle proofs for
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
 * # Aging schedule on the checkNow path
 *
 * When this task is triggered by a new block header (`checkNow = true`, wired in
 * `Monitor.processNewBlockHeader`), it does NOT scan every `nosend` row on every
 * block. The set of `nosend` rows can grow large over a wallet's lifetime
 * (txs sitting in escrow, un-aborted tests, abandoned batches), and a fast,
 * unfiltered scan on every block would do an unbounded number of external
 * `getMerklePath` lookups per block.
 *
 * Instead, the row's age (now - `created_at`) determines how often it is
 * eligible for a checkNow-triggered chain check. The schedule starts at "skip
 * entirely" for very fresh rows (to protect in-flight batched-tx workflows
 * where chained `createAction({ noSend: true, sendWith: [...] })` builds
 * deliberately keep rows in `nosend` until a single terminator broadcasts the
 * whole BEEF), then progresses to "every block", "hourly", "daily", and
 * "weekly" as rows age:
 *
 *   age < 5 min                 → skip (in-flight batch protection)
 *   5 min ≤ age < 1 hr          → check on every checkNow trigger
 *   1 hr   ≤ age < 24 hr        → check on ~hourly cadence (block-height % 6)
 *   24 hr  ≤ age < 7 days       → check on ~daily cadence  (block-height % 144)
 *   age ≥ 7 days                → check on ~weekly cadence (block-height % 1008)
 *
 * Block-height modulo gives a deterministic, stateless way to spread checks
 * for older rows; no per-row "last checked" persistence is required.
 *
 * The scheduled daily cadence (no `checkNow`) is unaffected — it still scans
 * every row regardless of age. That path is the once-per-day fallback that
 * guarantees externally-broadcast `nosend` txs are eventually recognized
 * even if the aging schedule on the checkNow path defers them.
 */
export class TaskCheckNoSends extends WalletMonitorTask {
  static readonly taskName = 'CheckNoSends'

  /**
   * An external service such as the chaintracks new block header
   * listener can set this true to cause
   */
  static checkNow = false

  /**
   * Aging-schedule constants for the `checkNow` path. Rows below `tier0FreshSkipMsecs`
   * are never checked via checkNow (batched-tx protection). Rows from tier 0 up
   * to `tier1EveryBlockMsecs` are checked on every checkNow trigger. Beyond that,
   * checks happen on `block-height % tierNBlockInterval === 0` cadences with
   * growing intervals. The scheduled daily cadence (no checkNow) is unaffected.
   */
  static readonly tier0FreshSkipMsecs   = 5 * 60 * 1000             // 5 min
  static readonly tier1EveryBlockMsecs  = 60 * 60 * 1000            // 1 hr
  static readonly tier2HourlyMsecs      = 24 * 60 * 60 * 1000       // 24 hr
  static readonly tier3DailyMsecs       = 7 * 24 * 60 * 60 * 1000   // 7 days
  static readonly tier2BlockInterval    = 6        // ~hourly on 10-min blocks
  static readonly tier3BlockInterval    = 144      // ~daily  on 10-min blocks
  static readonly tier4BlockInterval    = 1008     // ~weekly on 10-min blocks

  /**
   * Decide whether a single `nosend` row should be chain-checked on the
   * current `checkNow` trigger, based on its age and the current block
   * height. See class docstring for the full schedule.
   */
  static shouldCheckOnCheckNow (
    createdAt: Date,
    nowMs: number,
    currentBlockHeight: number
  ): boolean {
    const ageMs = nowMs - createdAt.getTime()
    if (ageMs < TaskCheckNoSends.tier0FreshSkipMsecs) return false
    if (ageMs < TaskCheckNoSends.tier1EveryBlockMsecs) return true
    if (ageMs < TaskCheckNoSends.tier2HourlyMsecs) {
      return currentBlockHeight % TaskCheckNoSends.tier2BlockInterval === 0
    }
    if (ageMs < TaskCheckNoSends.tier3DailyMsecs) {
      return currentBlockHeight % TaskCheckNoSends.tier3BlockInterval === 0
    }
    return currentBlockHeight % TaskCheckNoSends.tier4BlockInterval === 0
  }

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

    const nowMs = Date.now()

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

      // On the checkNow (block-triggered) path, apply the aging schedule
      // — see class docstring. The scheduled daily cadence is unfiltered
      // so externally-broadcast unmined nosend txs are eventually caught
      // regardless of age.
      let eligible = reqs
      if (wasCheckNow) {
        eligible = reqs.filter(r =>
          TaskCheckNoSends.shouldCheckOnCheckNow(r.created_at, nowMs, maxAcceptableHeight)
        )
        const skipped = reqs.length - eligible.length
        if (skipped > 0) {
          log += `aging schedule: skipping ${skipped} of ${reqs.length} reqs on checkNow path (block-triggered)\n`
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
