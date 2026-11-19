import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import type { StorageWriterAdmission } from '../../storage/StorageActiveWrite'
import { Monitor } from '../Monitor'
import { optionalMonitorInteger } from '../monitorValidation'
import { WalletMonitorTask } from './WalletMonitorTask'

/** Bounded reconciliation for SQL stores with proofs learned outside the spend's wallet. */
export class TaskReviewConfirmedSpends extends WalletMonitorTask {
  private cursor = 0
  private recoveryCursor = 0
  private lastRecovery = 0
  private supported = true

  constructor(monitor: Monitor) {
    super(monitor, 'ReviewConfirmedSpends')
  }

  override async asyncSetup(): Promise<void> {
    const events = await this.storage.runAsStorageProvider(sp =>
      sp.findMonitorEvents({ partial: { event: this.name }, orderDescending: true, paged: { limit: 5 } })
    )
    for (const event of events) {
      try {
        const progress = JSON.parse(event.details ?? '')
        const cursor = optionalMonitorInteger(progress.after, 0, Number.MAX_SAFE_INTEGER)
        if (cursor != null) {
          this.cursor = cursor
          this.recoveryCursor = optionalMonitorInteger(progress.recoveryAfter, 0, Number.MAX_SAFE_INTEGER) ?? 0
          return
        }
      } catch {
        // One malformed diagnostic must not hide previous progress.
      }
    }
  }

  trigger(now: number): { run: boolean } {
    return {
      run:
        this.supported &&
        this.monitor.lastNewHeader != null &&
        now - this.lastRunMsecsSinceEpoch >=
          (this.cursor > 0 || this.recoveryCursor > 0 ? Monitor.oneSecond : 15 * Monitor.oneMinute)
    }
  }

  async runTask(): Promise<string> {
    const tip = this.monitor.lastNewHeader
    if (tip == null) return ''
    const provider = await this.storage.runAsStorageProvider(async sp => sp)
    const admission: StorageWriterAdmission = async operation =>
      await this.storage.runAsStorageProvider(async current => {
        if (current !== provider) throw new WERR_NOT_ACTIVE('Spend review belongs to a replaced provider')
        return await operation()
      }, true)
    const started = performance.now()
    const result = await provider.reviewConfirmedSpendPage?.(this.cursor, tip.height, admission)
    if (result == null) {
      this.supported = false
      return ''
    }
    const now = Date.now()
    const recoveryDue = this.recoveryCursor > 0 || now - this.lastRecovery >= Monitor.oneHour
    const recovery = recoveryDue
      ? await provider.reviewConfirmedSpendRecoveries?.(this.recoveryCursor, admission)
      : undefined
    const recoveryAfter = recovery?.after ?? this.recoveryCursor
    await this.monitor.logEvent(
      this.name,
      JSON.stringify({ ...result, recoveryAfter, recovery, durationMsecs: Math.round(performance.now() - started) })
    )
    if (recovery != null) this.lastRecovery = now
    this.recoveryCursor = recoveryAfter
    this.cursor = result.after
    return ''
  }
}
