import { awaitFromSync } from '../../utility/promiseFromSync'
import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import type { StorageWriterAdmission } from '../../storage/StorageActiveWrite'
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
  static get checkNow(): boolean {
    return this.checkNowRequested
  }
  static set checkNow(value: boolean) {
    this.checkNowRequested = value
  }

  constructor(
    monitor: Monitor,
    public triggerMsecs = 1000 * 60 * 15,
    public agedMsecs = 1000 * 60 * 5
  ) {
    super(monitor, TaskReviewStatus.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs
    }
  }

  async runTask(): Promise<string> {
    let log = ''

    const agedLimit = new Date(Date.now() - this.agedMsecs)
    const selected = await this.storage.runAsStorageProvider(async sp => ({
      provider: sp,
      independent: typeof sp.supportsPrimaryWriteFences === 'function' && (await sp.supportsPrimaryWriteFences())
    }))
    let r: { log: string }
    if (selected.independent) {
      const admission: StorageWriterAdmission = async operation =>
        await this.storage.runAsStorageProvider(
          current =>
            awaitFromSync(() => {
              if (current !== selected.provider)
                throw new WERR_NOT_ACTIVE('Review preparation belongs to a replaced provider')
              return operation()
            }),
          true
        )
      const reconciliation = await selected.provider.reconcileCompletedProvenTxReqs(admission)
      const review = await selected.provider.reviewStatus({ agedLimit, admission })
      r = { log: reconciliation.log + review.log }
    } else
      r = await this.storage.runAsStorageProvider(async sp => {
        const reconciliation = await sp.reconcileCompletedProvenTxReqs()
        const review = await sp.reviewStatus({ agedLimit })
        return { log: reconciliation.log + review.log }
      })

    if (r.log.length > 0) log += `${r.log}`

    return log
  }
}
