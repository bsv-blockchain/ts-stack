import { Validation, WalletOutput } from '@bsv/sdk'
import { specOpInvalidChange } from '../../sdk'
import { TableUser } from '../../storage/schema/tables'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Review users incrementally for invalid change / invalid spendable outputs using
 * the existing specOpInvalidChange listOutputs behavior.
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

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskReviewUtxos.checkNow ||
        (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async runTask(): Promise<string> {
    TaskReviewUtxos.checkNow = false

    const users = await this.storage.runAsStorageProvider(async sp => {
      return await sp.findUsers({ partial: {}, paged: { limit: this.userLimit, offset: this.userOffset } })
    })

    if (users.length === 0) {
      await this.monitor.logEvent(
        TaskReviewUtxos.taskName,
        JSON.stringify({
          reviewedUsers: 0,
          affectedUsers: 0,
          userLimit: this.userLimit,
          userOffset: this.userOffset,
          tags: this.tags
        })
      )
      return '0 users reviewed\n'
    }

    let log = ''
    const findings: Array<{ userId: number; identityKey: string; outputs: number; total: number }> = []
    const vargs: Validation.ValidListOutputsArgs = {
      basket: specOpInvalidChange,
      tags: [...this.tags],
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

    await this.storage.runAsStorageProvider(async sp => {
      for (const user of users) {
        const auth = { userId: user.userId, identityKey: user.identityKey }
        const result = await sp.listOutputs(auth, vargs)
        if (result.totalOutputs > 0) {
          const total = result.outputs.reduce((sum, output) => sum + output.satoshis, 0)
          findings.push({ userId: user.userId, identityKey: user.identityKey, outputs: result.totalOutputs, total })
          log += this.toUserLog(user, result.outputs, result.totalOutputs, total)
        }
      }
    })

    await this.monitor.logEvent(
      TaskReviewUtxos.taskName,
      JSON.stringify({
        reviewedUsers: users.length,
        affectedUsers: findings.length,
        userLimit: this.userLimit,
        userOffset: this.userOffset,
        tags: this.tags,
        findings
      })
    )

    if (!log) {
      return `${users.length} users reviewed, no invalid utxos found\n`
    }

    return `${users.length} users reviewed\n${log}`
  }

  private toUserLog(user: TableUser, outputs: WalletOutput[], totalOutputs: number, total: number): string {
    const action = this.tags.includes('release') ? 'updated to unspendable' : 'found'
    const target = this.tags.includes('all') ? 'spendable utxos' : 'spendable change utxos'
    let log = `userId ${user.userId}: ${totalOutputs} ${target} ${action}, total ${total}, ${user.identityKey}\n`
    for (const output of outputs) {
      log += `  ${output.outpoint} ${output.satoshis} now ${output.spendable ? 'spendable' : 'spent'}\n`
    }
    return log
  }
}
