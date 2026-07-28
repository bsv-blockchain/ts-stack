import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Notify Transaction records of changes in ProvenTxReq records they may have missed.
 *
 * The `notified` property flags reqs that do not need to be checked.
 *
 * Looks for aged Transactions with provenTxId with status != 'completed', sets status to 'completed'.
 *
 * Looks for reqs with 'invalid' status that have corresonding transactions with status other than 'failed'.
 */
export class TaskReviewStatus extends WalletMonitorTask {
  static readonly taskName = 'ReviewStatus'

  /**
   * Set to true to trigger running this task
   */
  private static checkNowRequested = false
  static get checkNow (): boolean { return this.checkNowRequested }
  static set checkNow (value: boolean) { this.checkNowRequested = value }

  constructor (
    monitor: Monitor,
    public triggerMsecs = 1000 * 60 * 15,
    public agedMsecs = 1000 * 60 * 5
  ) {
    super(monitor, TaskReviewStatus.taskName)
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs
    }
  }

  async runTask (): Promise<string> {
    let log = ''

    const agedLimit = new Date(Date.now() - this.agedMsecs)
    const r = await this.storage.runAsStorageProvider(async sp => {
      // Reconcile completed-but-unnotified proof requests first. This path
      // restores failed transaction bookkeeping before completion; the generic
      // reviewStatus SQL repair cannot reconstruct that state after changing a
      // failed row directly to completed.
      const reconciliation = await sp.reconcileCompletedProvenTxReqs()
      const review = await sp.reviewStatus({ agedLimit })
      return { log: reconciliation.log + review.log }
    })

    if (r.log.length > 0) log += `${r.log}`

    return log
  }
}
