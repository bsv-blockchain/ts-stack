import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

export class TaskClock extends WalletMonitorTask {
  static taskName = 'Clock'
  nextMinute: number

  constructor(
    monitor: Monitor,
    public triggerMsecs = 1 * Monitor.oneSecond
  ) {
    super(monitor, TaskClock.taskName)
    this.nextMinute = this.getNextMinute()
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    const s = this.storage

    const run = Date.now() > this.nextMinute

    return { run }
  }

  async runTask(): Promise<string> {
    const log = `${new Date(this.nextMinute).toISOString()}`
    this.nextMinute = this.getNextMinute()
    return log
  }

  getNextMinute(): number {
    return Math.ceil(Date.now() / Monitor.oneMinute) * Monitor.oneMinute
  }
}
