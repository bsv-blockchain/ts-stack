import { MonitorStorage, Monitor } from '../Monitor'

/**
 * A monitor task performs some periodic or state triggered maintenance function
 * on the data managed by a wallet (Bitcoin UTXO manager, aka wallet)
 *
 * The monitor maintains a collection of tasks.
 *
 * It runs each task's non-asynchronous trigger to determine if the runTask method needs to run.
 *
 * Tasks that need to be run are run consecutively by awaiting their async runTask override method.
 *
 * The monitor then waits a fixed interval before repeating...
 *
 * Tasks may use the monitor_events table to persist their execution history.
 * This is done by accessing the wathman.storage object.
 */

export abstract class WalletMonitorTask {
  /**
   * Set by monitor each time runTask completes
   */
  lastRunMsecsSinceEpoch = 0

  storage: MonitorStorage

  constructor(
    public monitor: Monitor,
    public name: string
  ) {
    this.storage = monitor.storage
  }

  /**
   * Override to handle async task setup configuration.
   *
   * Called before first call to `trigger`
   */
  async asyncSetup(): Promise<void> {}

  /**
   * Return true if `runTask` needs to be called now.
   */
  abstract trigger(nowMsecsSinceEpoch: number): { run: boolean }

  abstract runTask(): Promise<string>
}
