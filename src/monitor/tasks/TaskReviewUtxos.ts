import { Validation, WalletOutput } from '@bsv/sdk'
import { specOpInvalidChange } from '../../sdk'
import { TableUser } from '../../storage/schema/tables'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Use the reviewByIdentityKey method to review the utxos of a specific user by their identityKey.
 * 
 * The task itself is disabled and will not run on a schedule; review must be triggered manually by calling reviewByIdentityKey.
 */
export class TaskReviewUtxos extends WalletMonitorTask {
  static taskName = 'ReviewUtxos'

  static checkNow = false

  constructor(
    monitor: Monitor,
    public triggerMsecs = 0,
    public userLimit = 10,
    public userOffset = 0,
    public tags: string[] = ['release', 'all']
  ) {
    super(monitor, TaskReviewUtxos.taskName)
  }

  trigger(_nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: false
    }
  }

  async runTask(): Promise<string> {
    TaskReviewUtxos.checkNow = false
    return 'TaskReviewUtxos is disabled; use reviewByIdentityKey instead.\n'
  }

  async reviewByIdentityKey(identityKey: string, mode: 'all' | 'change' = 'all'): Promise<string> {
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

  private toUserLog(user: TableUser, outputs: WalletOutput[], totalOutputs: number, total: number, tags: string[]): string {
    const action = tags.includes('release') ? 'updated to unspendable' : 'found'
    const target = tags.includes('all') ? 'spendable utxos' : 'spendable change utxos'
    let log = `userId ${user.userId}: ${totalOutputs} ${target} ${action}, total ${total}, ${user.identityKey}\n`
    for (const output of outputs) {
      log += `  ${output.outpoint} ${output.satoshis} now ${output.spendable ? 'spendable' : 'spent'}\n`
    }
    return log
  }
}
