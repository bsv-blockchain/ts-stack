import { pendingDescendantTxids } from '../../storage/methods/reconcileFailedTransactionInputs'
import { promiseFromSync, awaitFromSync } from '../../utility/promiseFromSync'
import { StorageReqWrite } from '../../storage/StorageReqWrite'
import { WERR_NOT_ACTIVE, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
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
  asyncSetup(): Promise<void> {
    return promiseFromSync(() => {
      // Default no-op; override in subclasses that require async setup
    })
  }

  /**
   * Return true if `runTask` needs to be called now.
   */
  abstract trigger(nowMsecsSinceEpoch: number): { run: boolean }

  abstract runTask(): Promise<string>
}

/** Capture before observation. Only SQL callbacks reenter the manager; network
 * preparation keeps its actual provider reference and original epoch fences. */
export async function captureMonitorReqWrite(
  task: Pick<WalletMonitorTask, 'storage'>,
  txids: string[],
  includeDescendants = false
): Promise<StorageReqWrite | undefined> {
  if (typeof task.storage.runAsStorageProvider !== 'function') return undefined
  const provider = await task.storage.runAsStorageProvider(
    async current =>
      typeof current.supportsPrimaryWriteFences === 'function' && (await current.supportsPrimaryWriteFences())
        ? current
        : undefined,
    true
  )
  if (provider == null) return undefined
  const declared = includeDescendants ? [...txids, ...(await pendingDescendantTxids(txids, provider))] : txids
  const captured = await StorageReqWrite.capture(
    provider,
    declared,
    undefined,
    async operation =>
      await task.storage.runAsStorageProvider(
        current =>
          awaitFromSync(() => {
            if (current !== provider) throw new WERR_NOT_ACTIVE('Monitor preparation belongs to a replaced provider')
            return operation()
          }),
        true
      )
  )
  if (!captured.hasParticipatingProfiles) return undefined
  if (captured.requiresSerializedPreparation)
    throw new WERR_INVALID_OPERATION('Primary fence capability changed during monitor capture')
  return captured
}
