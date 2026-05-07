import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

export class TaskSyncWhenIdle extends WalletMonitorTask {
  static readonly taskName = 'SyncWhenIdle'

  constructor (
    monitor: Monitor,
    public triggerMsecs = 1000 * 60 * 1
  ) {
    super(monitor, TaskSyncWhenIdle.taskName)
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: false }
  }

  async runTask (): Promise<string> {
    return ''
  }
}
