import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Handles transactions which do not have terminal status and have not been
 * updated for an extended time period.
 *
 * Calls `updateTransactionStatus` to set `status` to `failed`.
 * This returns inputs to spendable status and verifies that any
 * outputs are not spendable.
 */

export class TaskFailAbandoned extends WalletMonitorTask {
  static taskName = 'FailAbandoned'

  constructor(
    monitor: Monitor,
    public triggerMsecs = 1000 * 60 * 5
  ) {
    super(monitor, TaskFailAbandoned.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: nowMsecsSinceEpoch > this.lastRunMsecsSinceEpoch + this.triggerMsecs
    }
  }

  async runTask(): Promise<string> {
    let log = ''
    const limit = 100
    let offset = 0
    for (;;) {
      const now = new Date()
      const abandoned = new Date(now.getTime() - this.monitor.options.abandonedMsecs)
      const done = await this.storage.runAsStorageProvider(async sp => {
        const txsAll = await sp.findTransactions({
          partial: {},
          status: ['unprocessed', 'unsigned'],
          paged: { limit, offset }
        })
        const txs = txsAll.filter(t => t.updated_at && t.updated_at < abandoned)
        for (const tx of txs) {
          await sp.updateTransactionStatus('failed', tx.transactionId)
          log += `updated tx ${tx.transactionId} status to 'failed'\n`
        }
        return txs.length < limit
      })
      if (done) break
      offset += limit
    }
    return log
  }
}
