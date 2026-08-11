import { Validation, WalletOutput } from '@bsv/sdk'
import { specOpInvalidChange } from '../../sdk'
import { TableUser } from '../../storage/schema/tables'
import { reviewUtxoOutputs, UtxoReviewDiagnostics } from '../../storage/methods/reviewUtxoOutputs'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

const REVIEW_PAGE_DEFAULT_LIMIT = 20
const REVIEW_PAGE_MAX_LIMIT = 250

export interface TaskReviewUtxosPageResult extends UtxoReviewDiagnostics {
  found: boolean
  userId?: number
  identityKey: string
  mode: 'all' | 'change'
  release: boolean
  offset: number
  pageLimit: number
  sourceScanned: number
  complete: boolean
  nextOffset?: number
  log: string
}

/**
 * Use the reviewByIdentityKey method to scan the UTXOs of a specific user by
 * identity key. The scan is read-only unless the caller explicitly requests
 * release, and release remains blocked if any provider result is inconclusive.
 * Operator UIs should use reviewPageByIdentityKey: it bounds each provider
 * round-trip and may explicitly release only the conclusive spent subset while
 * reporting unknowns.
 *
 * The task itself is disabled and will not run on a schedule; review must be triggered manually by calling reviewByIdentityKey.
 */
export class TaskReviewUtxos extends WalletMonitorTask {
  static readonly taskName = 'ReviewUtxos'

  private static checkNowRequested = false
  static get checkNow(): boolean {
    return this.checkNowRequested
  }
  static set checkNow(value: boolean) {
    this.checkNowRequested = value
  }

  constructor(
    monitor: Monitor,
    public triggerMsecs = 0,
    public userLimit = 10,
    public userOffset = 0,
    public tags: string[] = ['all']
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

  async reviewByIdentityKey(identityKey: string, mode: 'all' | 'change' = 'all', release = false): Promise<string> {
    const tags = [...(release ? ['release'] : []), ...(mode === 'all' ? ['all'] : [])]
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

  async reviewPageByIdentityKey(
    identityKey: string,
    mode: 'all' | 'change' = 'all',
    release = false,
    pageLimit = REVIEW_PAGE_DEFAULT_LIMIT,
    offset = 0
  ): Promise<TaskReviewUtxosPageResult> {
    pageLimit = Math.min(Math.max(Math.trunc(pageLimit), 1), REVIEW_PAGE_MAX_LIMIT)
    offset = Math.max(Math.trunc(offset), 0)

    return await this.storage.runAsStorageProvider(async sp => {
      const user = (await sp.findUsers({ partial: { identityKey } }))[0]
      if (!user) {
        return {
          found: false,
          identityKey,
          mode,
          release,
          offset,
          pageLimit,
          sourceScanned: 0,
          complete: true,
          checked: 0,
          confirmedUnspent: 0,
          confirmedSpent: 0,
          unknown: 0,
          confirmedSpentSatoshis: 0,
          released: 0,
          releasedSatoshis: 0,
          providers: [],
          providerCount: 0,
          providersTruncated: false,
          log: `identityKey ${identityKey} was not found\n`
        }
      }

      let basketId: number | undefined
      if (mode === 'change') {
        basketId = (
          await sp.findOutputBaskets({
            partial: { userId: user.userId, name: 'default' }
          })
        )[0]?.basketId
        if (basketId == null) {
          return this.emptyPage(user, mode, release, pageLimit, offset)
        }
      }

      const sourceOutputs = await sp.findOutputs({
        partial: {
          userId: user.userId,
          spendable: true,
          ...(basketId != null ? { basketId } : {})
        },
        txStatus: ['completed', 'unproven', 'nosend', 'sending'],
        noScript: true,
        paged: { limit: pageLimit, offset }
      })
      const candidates = sourceOutputs.filter(output => output.basketId != null)
      const auth = { userId: user.userId, identityKey: user.identityKey }
      const review = await reviewUtxoOutputs(sp, auth, candidates, release ? 'conclusive' : 'none')
      const complete = sourceOutputs.length < pageLimit
      const nextOffset = complete ? undefined : offset + sourceOutputs.length - review.diagnostics.released
      const target = mode === 'all' ? 'spendable utxos' : 'spendable change utxos'
      const action = release ? 'released' : 'found'
      let log =
        `userId ${user.userId}: page checked ${review.diagnostics.checked} ${target}; ` +
        `${review.diagnostics.confirmedSpent} confirmed spent, ${review.diagnostics.confirmedUnspent} confirmed unspent, ` +
        `${review.diagnostics.unknown} unknown; ${action} ${review.diagnostics.released}, ${user.identityKey}\n`
      for (const output of review.confirmedSpentOutputs) {
        log += `  ${output.txid}.${output.vout} ${output.satoshis} now ${output.spendable ? 'spendable' : 'spent'}\n`
      }
      if (review.unknownOutputs.length > 0) {
        log += `  ${review.unknownOutputs.length} output(s) quarantined from release pending a conclusive provider result\n`
      }
      if (nextOffset != null) log += `  continue at offset ${nextOffset}\n`

      return {
        found: true,
        userId: user.userId,
        identityKey: user.identityKey,
        mode,
        release,
        offset,
        pageLimit,
        sourceScanned: sourceOutputs.length,
        complete,
        ...(nextOffset != null ? { nextOffset } : {}),
        ...review.diagnostics,
        log
      }
    })
  }

  private emptyPage(
    user: TableUser,
    mode: 'all' | 'change',
    release: boolean,
    pageLimit: number,
    offset: number
  ): TaskReviewUtxosPageResult {
    return {
      found: true,
      userId: user.userId,
      identityKey: user.identityKey,
      mode,
      release,
      offset,
      pageLimit,
      sourceScanned: 0,
      complete: true,
      checked: 0,
      confirmedUnspent: 0,
      confirmedSpent: 0,
      unknown: 0,
      confirmedSpentSatoshis: 0,
      released: 0,
      releasedSatoshis: 0,
      providers: [],
      providerCount: 0,
      providersTruncated: false,
      log: `userId ${user.userId}: no invalid utxos found, ${user.identityKey}\n`
    }
  }

  private toUserLog(
    user: TableUser,
    outputs: WalletOutput[],
    totalOutputs: number,
    total: number,
    tags: string[]
  ): string {
    const action = tags.includes('release') ? 'confirmed spent and updated to unspendable' : 'confirmed spent'
    const target = tags.includes('all') ? 'spendable utxos' : 'spendable change utxos'
    let log = `userId ${user.userId}: ${totalOutputs} ${target} ${action}, total ${total}, ${user.identityKey}\n`
    for (const output of outputs) {
      log += `  ${output.outpoint} ${output.satoshis} now ${output.spendable ? 'spendable' : 'spent'}\n`
    }
    return log
  }
}
