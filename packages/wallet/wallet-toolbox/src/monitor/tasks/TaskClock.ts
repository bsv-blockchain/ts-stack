import { promiseFromSync } from '../../utility/promiseFromSync'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

export class TaskClock extends WalletMonitorTask {
  static readonly taskName = 'Clock'
  nextMinute: number

  constructor(
    monitor: Monitor,
    public triggerMsecs = 1 * Monitor.oneSecond
  ) {
    super(monitor, TaskClock.taskName)
    this.nextMinute = this.getNextMinute()
  }

  trigger(_nowMsecsSinceEpoch: number): { run: boolean } {
    const run = Date.now() > this.nextMinute
    return { run }
  }

  runTask(): Promise<string> {
    return promiseFromSync(() => {
      const log = `${new Date(this.nextMinute).toISOString()}`
      this.nextMinute = this.getNextMinute()
      return log
    })
  }

  getNextMinute(): number {
    return Math.ceil(Date.now() / Monitor.oneMinute) * Monitor.oneMinute
  }
}
