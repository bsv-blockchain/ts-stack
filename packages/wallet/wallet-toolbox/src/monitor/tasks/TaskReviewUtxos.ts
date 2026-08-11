import { Validation, WalletOutput } from '@bsv/sdk'
import { specOpInvalidChange } from '../../sdk'
import { isAutoSpendableChangeOutput, managedChangeOutputFields } from '../../storage/methods/managedChange'
import { TableUser } from '../../storage/schema/tables'
import { verifyOne } from '../../utility/utilityHelpers'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Use the reviewByIdentityKey method to review the utxos of a specific user by their identityKey.
 *
 * The task itself is disabled and will not run on a schedule; review must be triggered manually by calling reviewByIdentityKey.
 */
export class TaskReviewUtxos extends WalletMonitorTask {
  static readonly taskName = 'ReviewUtxos'

  private static checkNowRequested = false
  static get checkNow (): boolean { return this.checkNowRequested }
  static set checkNow (value: boolean) { this.checkNowRequested = value }

  constructor (
    monitor: Monitor,
    public triggerMsecs = 0,
    public userLimit = 10,
    public userOffset = 0,
    public tags: string[] = ['release', 'all']
  ) {
    super(monitor, TaskReviewUtxos.taskName)
  }

  trigger (_nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: false
    }
  }

  async runTask (): Promise<string> {
    TaskReviewUtxos.checkNow = false
    return 'TaskReviewUtxos is disabled; use reviewByIdentityKey instead.\n'
  }

  async reviewByIdentityKey (identityKey: string, mode: 'all' | 'change' = 'all'): Promise<string> {
    const tags = ['release', ...(mode === 'all' ? ['all'] : [])]
    const vargs: Validation.ValidListOutputsArgs = {
      basket: specOpInvalidChange,
      tags,
      tagQueryMode: 'all',
      includeLockingScripts: false,
      includeTransactions: false,
      includeCustomInstructions: false,
      includeTags: false,
      includeLabels: false,
      limit: 0,
      offset: 0,
      seekPermission: false,
      knownTxids: []
    }

    return await this.storage.runAsStorageProvider(async sp => {
      const user = (await sp.findUsers({ partial: { identityKey } }))[0]
      if (!user) {
        return `identityKey ${identityKey} was not found\n`
      }

      const auth = { userId: user.userId, identityKey: user.identityKey }
      const result = await sp.listOutputs(auth, vargs)
      if (result.totalOutputs === 0) {
        return `userId ${user.userId}: no invalid utxos found, ${user.identityKey}\n`
      }

      const total = result.outputs.reduce((sum, output) => sum + output.satoshis, 0)
      return this.toUserLog(user, result.outputs, result.totalOutputs, total, tags)
    })
  }

  /**
   * Report managed-change liquidity without changing it. Monitor deliberately
   * has no signing authority; progressive migration occurs only during a
   * caller-authorized createAction.
   */
  async reviewManagedChangeByIdentityKey (identityKey: string): Promise<string> {
    return await this.storage.runAsStorageProvider(async sp => {
      const user = (await sp.findUsers({ partial: { identityKey } }))[0]
      if (user == null) return `identityKey ${identityKey} was not found\n`
      const basket = verifyOne(await sp.findOutputBaskets({ partial: { userId: user.userId, name: 'default' } }))
      const outputs = (await sp.findOutputs({
        partial: { userId: user.userId, basketId: basket.basketId, spendable: true, ...managedChangeOutputFields },
        txStatus: ['completed', 'unproven', 'sending'],
        noScript: true
      })).filter(isAutoSpendableChangeOutput)
      const reserved = new Set(await sp.findReservedActionBatchOutputIds(outputs.map(output => output.outputId)))
      const statuses = await sp.findTransactionStatusesByIds(
        user.userId,
        outputs.map(output => output.transactionId)
      )
      const preferred = Math.max(1, basket.minimumDesiredUTXOValue)
      const healthy = outputs.filter(output => output.satoshis >= preferred)
      const undersized = outputs.filter(output => output.satoshis < preferred)
      const countStatus = (status: 'completed' | 'unproven' | 'sending'): number =>
        outputs.filter(output => statuses.get(output.transactionId) === status).length
      const satoshis = outputs.reduce((sum, output) => sum + output.satoshis, 0)
      return (
        `userId ${user.userId}: managed change ${outputs.length}/${basket.numberOfDesiredUTXOs}, ` +
        `healthy ${healthy.length}, undersized ${undersized.length}, reserved ${reserved.size}, ` +
        `completed ${countStatus('completed')}, unproven ${countStatus('unproven')}, ` +
        `sending ${countStatus('sending')}, satoshis ${satoshis}, preferred minimum ${preferred}\n`
      )
    })
  }

  private toUserLog (
    user: TableUser,
    outputs: WalletOutput[],
    totalOutputs: number,
    total: number,
    tags: string[]
  ): string {
    const action = tags.includes('release') ? 'updated to unspendable' : 'found'
    const target = tags.includes('all') ? 'spendable utxos' : 'spendable change utxos'
    let log = `userId ${user.userId}: ${totalOutputs} ${target} ${action}, total ${total}, ${user.identityKey}\n`
    for (const output of outputs) {
      log += `  ${output.outpoint} ${output.satoshis} now ${output.spendable ? 'spendable' : 'spent'}\n`
    }
    return log
  }
}
