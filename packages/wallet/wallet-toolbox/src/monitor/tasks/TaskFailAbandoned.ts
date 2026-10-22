import { awaitFromSync } from '../../utility/promiseFromSync'
import type { StorageActiveWrite } from '../../storage/StorageActiveWrite'
import { WalletError } from '../../sdk/WalletError'
import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import { verifyOne } from '../../utility/utilityHelpers'
import { Monitor } from '../Monitor'
import { MAX_MONITOR_INTERVAL_MSECS, requireMonitorInteger } from '../monitorValidation'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Handles transactions which do not have terminal status and have not been
 * updated for an extended time period.
 *
 * Calls `updateTransactionStatus` to set `status` to `failed`.
 * This returns inputs to spendable status and verifies that any
 * outputs are not spendable.
 */

export class TaskFailAbandoned extends WalletMonitorTask {
  static readonly taskName = 'FailAbandoned'

  constructor(
    monitor: Monitor,
    public triggerMsecs = 1000 * 60 * 5
  ) {
    super(monitor, TaskFailAbandoned.taskName)
    requireMonitorInteger(triggerMsecs, 'triggerMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: nowMsecsSinceEpoch > this.lastRunMsecsSinceEpoch + this.triggerMsecs
    }
  }

  async runTask(): Promise<string> {
    let log = ''
    const provider = await this.storage.runAsStorageProvider(
      async sp =>
        typeof sp.supportsPrimaryWriteFences === 'function' && (await sp.supportsPrimaryWriteFences()) ? sp : undefined,
      true
    )
    const captures = new Map<number, StorageActiveWrite | undefined>()
    const limit = 100
    let offset = 0
    for (;;) {
      const now = new Date()
      const abandoned = new Date(now.getTime() - this.monitor.options.abandonedMsecs)
      const page =
        provider == null
          ? await this.storage.runAsStorageProvider(async sp => {
              const txsAll = await sp.findTransactions({
                partial: {},
                status: ['unprocessed', 'unsigned'],
                paged: { limit, offset }
              })
              const txs = txsAll.filter(t => t.updated_at && t.updated_at < abandoned)
              for (const tx of txs) {
                await sp.updateTransactionStatus('failed', tx.transactionId)
                log += `updated tx ${tx.transactionId} status to 'failed'\n`
              }
              return {
                done: txsAll.length < limit,
                retained: txsAll.length - txs.length
              }
            })
          : await (async () => {
              const rows = await provider.findTransactions({
                partial: {},
                status: ['unprocessed', 'unsigned'],
                paged: { limit, offset },
                noRawTx: true
              })
              let changed = 0
              for (const tx of rows) {
                if (tx.updated_at == null || tx.updated_at >= abandoned) continue
                try {
                  if (!captures.has(tx.userId)) {
                    const user = verifyOne(await provider.findUsers({ partial: { userId: tx.userId } }))
                    // Record the original actual role before joining the writer queue.
                    // An inactive or obsolete profile is never freshly captured later.
                    captures.set(tx.userId, undefined)
                    captures.set(tx.userId, await provider.activeWriteTransaction(user))
                  }
                  const write = captures.get(tx.userId)
                  if (write == null) continue
                  const applied = await this.storage.runAsStorageProvider(
                    current =>
                      awaitFromSync(() => {
                        if (current !== provider) throw new WERR_NOT_ACTIVE('Abandoned review provider was replaced')
                        return write.transaction(async trx => {
                          const currentTx = (
                            await provider.findTransactions({
                              partial: { transactionId: tx.transactionId, userId: tx.userId },
                              noRawTx: true,
                              trx
                            })
                          )[0]
                          if (
                            currentTx == null ||
                            !['unprocessed', 'unsigned'].includes(currentTx.status) ||
                            currentTx.updated_at == null ||
                            currentTx.updated_at >= abandoned
                          )
                            return false
                          await provider.updateTransactionStatus('failed', tx.transactionId, tx.userId, undefined, trx)
                          return true
                        })
                      }),
                    true
                  )
                  if (applied) {
                    changed++
                    log += `updated tx ${tx.transactionId} status to 'failed'\n`
                  }
                } catch (error) {
                  if (WalletError.fromUnknown(error).code !== 'WERR_NOT_ACTIVE') throw error
                  log += `tx ${tx.transactionId} abandoned review deferred to its current primary\n`
                }
              }
              return { done: rows.length < limit, retained: rows.length - changed }
            })()
      if (page.done) break
      offset += page.retained
    }
    return log
  }
}
