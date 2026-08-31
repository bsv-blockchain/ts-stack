import { processNoSendExpiryLifecycle } from '../../storage/methods/noSendExpiryLifecycle'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Enforces BRC-177 noSend expiries from the active authoritative storage.
 * Reclaim transactions are signed before release, so this task never needs
 * access to wallet keys and is safe to run in a remote storage monitor.
 */
export class TaskNoSendExpiry extends WalletMonitorTask {
  static readonly taskName = 'NoSendExpiry'
  static checkNow = false

  constructor(
    monitor: Monitor,
    public triggerMsecs = 5 * Monitor.oneSecond
  ) {
    super(monitor, TaskNoSendExpiry.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskNoSendExpiry.checkNow ||
        (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async runTask(): Promise<string> {
    TaskNoSendExpiry.checkNow = false
    // A client whose active store is remote does not own lifecycle execution;
    // the remote provider's keyless multi-user monitor does.
    if (!this.storage.isActiveStorageProvider()) return ''
    const result = await this.storage.runAsStorageProvider(async storage => {
      return await processNoSendExpiryLifecycle(storage)
    })
    if (result.inspected === 0) return ''
    return (
      `BRC-177 inspected=${result.inspected} cancelled=${result.cancelled} observed=${result.observed} ` +
      `activated=${result.reclaimActivated} reclaimed=${result.reclaimed} targetWon=${result.targetWon} ` +
      `deferred=${result.deferred} errors=${result.errors}\n`
    )
  }
}
