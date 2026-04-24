import { TableProvenTx } from '../../index.client'
import { BlockHeader } from '../../services/chaintracker/chaintracks/Api/BlockHeaderApi'
import { DeactivedHeader, Monitor } from '../Monitor'
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
 */
export class TaskReorg extends WalletMonitorTask {
  static taskName = 'Reorg'

  process: DeactivedHeader[] = []

  constructor(
    monitor: Monitor,
    public agedMsecs = Monitor.oneMinute * 10,
    public maxRetries = 3
  ) {
    super(monitor, TaskReorg.taskName)
  }

  /**
   * Shift aged deactivated headers onto `process` array.
   * @param nowMsecsSinceEpoch current time in milliseconds since epoch.
   * @returns `run` true iff there are aged deactivated headers to process.
   */
  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    const cutoff = nowMsecsSinceEpoch - this.agedMsecs
    const q = this.monitor.deactivatedHeaders
    while (q.length > 0 && cutoff > q[0].whenMsecs) {
      // Prepare to process deactivated headers that have aged sufficiently (agedMsecs)
      const header = q.shift()!
      this.process.push(header)
    }
    return {
      run: this.process.length > 0
    }
  }

  async runTask(): Promise<string> {
    let log = ''

    for (;;) {
      // Loop over deactivated headers to process
      const header = this.process.shift()
      if (!header) break

      const r = await this.storage.reproveHeader(header.header.hash)

      log += r.log

      if (r.unavailable.length > 0 || r.unchanged.length > 0) {
        if (header.tries + 1 >= this.maxRetries) {
          log += `      maximum retries ${this.maxRetries} exceeded\n`
        } else {
          log += `    retrying...\n`
          this.monitor.deactivatedHeaders.push({
            header: header.header,
            whenMsecs: Date.now(),
            tries: header.tries + 1
          })
        }
      }
    }

    return log
  }
}
