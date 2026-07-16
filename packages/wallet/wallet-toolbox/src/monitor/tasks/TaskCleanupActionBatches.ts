import { Monitor } from '../Monitor'
import { cleanupExpiredActionBatches } from '../../storage/methods/actionBatch'
import { WalletMonitorTask } from './WalletMonitorTask'

/** Releases expired action-batch reservations and incomplete staged blobs. */
export class TaskCleanupActionBatches extends WalletMonitorTask {
  static readonly taskName = 'CleanupActionBatches'

  constructor (monitor: Monitor, public triggerMsecs = Monitor.oneMinute) {
    super(monitor, TaskCleanupActionBatches.taskName)
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch >= this.triggerMsecs }
  }

  async runTask (): Promise<string> {
    const count = await this.storage.runAsStorageProvider(cleanupExpiredActionBatches)
    return count > 0 ? `released ${count} expired action batches` : ''
  }
}
