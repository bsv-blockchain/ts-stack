import { awaitFromSync } from '../../utility/promiseFromSync'
import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import type { StorageWriterAdmission } from '../../storage/StorageActiveWrite'
import { Monitor } from '../Monitor'
import { optionalMonitorInteger } from '../monitorValidation'
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

  private static readonly progressEvent = 'ReviewStatusProgress'
  private progress = { transaction: 0, request: 0 }
  private requestReviewAfter = 0

  override async asyncSetup(): Promise<void> {
    const events = await this.storage.runAsStorageProvider(sp =>
      sp.findMonitorEvents({
        partial: { event: TaskReviewStatus.progressEvent },
        orderDescending: true,
        paged: { limit: 5 }
      })
    )
    for (const event of events) {
      try {
        const value = JSON.parse(event.details ?? '') as Record<string, unknown>
        const transaction = optionalMonitorInteger(value.transaction, 0, Number.MAX_SAFE_INTEGER)
        const request = optionalMonitorInteger(value.request, 0, Number.MAX_SAFE_INTEGER)
        if (transaction !== undefined && request !== undefined) {
          this.progress = { transaction, request }
          return
        }
      } catch {
        // Retain the prior checkpoint if one event was damaged.
      }
    }
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
      run:
        this.triggerMsecs > 0 &&
        nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch >
          (this.progress.transaction > 0 || this.progress.request > 0 ? Monitor.oneSecond : this.triggerMsecs)
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
      const started = performance.now()
      const page = await selected.provider.reviewStatusPage?.({ agedLimit, admission }, this.progress.transaction)
      if (page != null) {
        const notices =
          Date.now() >= this.requestReviewAfter
            ? await selected.provider.reconcileCompletedProvenTxReqs(admission, {
                after: this.progress.request,
                limit: 8,
                deadline: performance.now() + 800
              })
            : undefined
        const progress = {
          transaction: page.complete ? 0 : page.after,
          request: notices == null ? this.progress.request : notices.complete ? 0 : (notices.after ?? 0)
        }
        await this.monitor.logEvent(
          TaskReviewStatus.progressEvent,
          JSON.stringify({
            ...progress,
            examined: page.examined,
            failed: page.failed,
            durationMsecs: Math.round(performance.now() - started)
          })
        )
        if (notices?.complete === true) this.requestReviewAfter = Date.now() + Monitor.oneMinute
        this.progress = progress
        return page.log + (notices?.log ?? '')
      }
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
