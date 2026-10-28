import { awaitFromSync } from '../../utility/promiseFromSync'
import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import type { StorageWriterAdmission } from '../../storage/StorageActiveWrite'
import { Monitor } from '../Monitor'
import { cleanupExpiredActionBatches } from '../../storage/methods/actionBatch'
import { WalletMonitorTask } from './WalletMonitorTask'

/** Releases expired action-batch reservations and incomplete staged blobs. */
export class TaskCleanupActionBatches extends WalletMonitorTask {
  static readonly taskName = 'CleanupActionBatches'

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute
  ) {
    super(monitor, TaskCleanupActionBatches.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch >= this.triggerMsecs }
  }

  async runTask(): Promise<string> {
    const provider = await this.storage.runAsStorageProvider(
      async sp =>
        typeof sp.supportsPrimaryWriteFences === 'function' && (await sp.supportsPrimaryWriteFences()) ? sp : undefined,
      true
    )
    const admission: StorageWriterAdmission = async operation =>
      await this.storage.runAsStorageProvider(
        current =>
          awaitFromSync(() => {
            if (current !== provider) throw new WERR_NOT_ACTIVE('Batch cleanup belongs to a replaced provider')
            return operation()
          }),
        true
      )
    const count =
      provider == null
        ? await this.storage.runAsStorageProvider(cleanupExpiredActionBatches)
        : await cleanupExpiredActionBatches(provider, admission)
    return count > 0 ? `released ${count} expired action batches` : ''
  }
}
