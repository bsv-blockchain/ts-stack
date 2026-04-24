import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

export class TaskSyncWhenIdle extends WalletMonitorTask {
  static taskName = 'SyncWhenIdle'

  constructor(
    monitor: Monitor,
    public triggerMsecs = 1000 * 60 * 1
  ) {
    super(monitor, TaskSyncWhenIdle.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    const s = this.storage

    const run = false

    return { run }
  }

  async runTask(): Promise<string> {
    // TODO...
    return ''
  }
}
