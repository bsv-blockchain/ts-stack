import { type ValidListOutputsArgs } from '@bsv/sdk/wallet/validationHelpers'
import { WalletOutput } from '@bsv/sdk'
import { specOpInvalidChange } from '../../sdk'
import { isAutoSpendableChangeOutput, managedChangeOutputFields } from '../../storage/methods/managedChange'
import { TableUser } from '../../storage/schema/tables'
import {
  MAX_UTXO_REVIEW_CANDIDATES,
  reviewUtxoOutputs,
  UtxoReviewDiagnostics
} from '../../storage/methods/reviewUtxoOutputs'
import { verifyOne } from '../../utility/utilityHelpers'
import { numericTotalOutputs } from '../../utility/numericTotalOutputs'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import {
  copyMonitorTags,
  MAX_MONITOR_INTERVAL_MSECS,
  MAX_MONITOR_OFFSET,
  MAX_MONITOR_PAGE_SIZE,
  normalizeMonitorIdentityKey,
  requireMonitorInteger
} from '../monitorValidation'

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
    if (typeof value !== 'boolean') throw new TypeError('checkNow must be boolean')
    this.checkNowRequested = value
  }

  public triggerMsecs: number
  public userLimit: number
  public userOffset: number
  public tags: string[]

  constructor(monitor: Monitor, triggerMsecs = 0, userLimit = 10, userOffset = 0, tags: string[] = ['all']) {
    super(monitor, TaskReviewUtxos.taskName)
    this.triggerMsecs = requireMonitorInteger(triggerMsecs, 'triggerMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
    this.userLimit = requireMonitorInteger(userLimit, 'userLimit', 1, MAX_MONITOR_PAGE_SIZE)
    this.userOffset = requireMonitorInteger(userOffset, 'userOffset', 0, MAX_MONITOR_OFFSET)
    this.tags = copyMonitorTags(tags)
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
    identityKey = normalizeMonitorIdentityKey(identityKey)
    if (mode !== 'all' && mode !== 'change') throw new TypeError("mode must be 'all' or 'change'")
    if (typeof release !== 'boolean') throw new TypeError('release must be boolean')
    const tags = [...(release ? ['release'] : []), ...(mode === 'all' ? ['all'] : [])]
    const vargs: ValidListOutputsArgs = {
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
      return this.toUserLog(user, result.outputs, numericTotalOutputs(result), total, tags)
    })
  }

  async reviewPageByIdentityKey(
    identityKey: string,
    mode: 'all' | 'change' = 'all',
    release = false,
    pageLimit = REVIEW_PAGE_DEFAULT_LIMIT,
    offset = 0
  ): Promise<TaskReviewUtxosPageResult> {
    identityKey = normalizeMonitorIdentityKey(identityKey)
    if (mode !== 'all' && mode !== 'change') throw new TypeError("mode must be 'all' or 'change'")
    if (typeof release !== 'boolean') throw new TypeError('release must be boolean')
    pageLimit = requireMonitorInteger(pageLimit, 'pageLimit', 1, REVIEW_PAGE_MAX_LIMIT)
    offset = requireMonitorInteger(offset, 'offset', 0, MAX_MONITOR_OFFSET - pageLimit)

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

  /**
   * Report managed-change liquidity without changing it. Monitor deliberately
   * has no signing authority; progressive migration occurs only during a
   * caller-authorized createAction.
   */
  async reviewManagedChangeByIdentityKey(identityKey: string): Promise<string> {
    identityKey = normalizeMonitorIdentityKey(identityKey)
    return await this.storage.runAsStorageProvider(async sp => {
      const user = (await sp.findUsers({ partial: { identityKey } }))[0]
      if (user == null) return `identityKey ${identityKey} was not found\n`
      const basket = verifyOne(await sp.findOutputBaskets({ partial: { userId: user.userId, name: 'default' } }))
      const outputQuery = {
        partial: { userId: user.userId, basketId: basket.basketId, spendable: true, ...managedChangeOutputFields },
        txStatus: ['completed', 'unproven', 'sending'],
        noScript: true
      } satisfies Parameters<typeof sp.findOutputs>[0]
      const candidateCount = await sp.countOutputs(outputQuery)
      if (!Number.isSafeInteger(candidateCount) || candidateCount < 0 || candidateCount > MAX_UTXO_REVIEW_CANDIDATES) {
        throw new Error(
          `Managed-change review is limited to ${MAX_UTXO_REVIEW_CANDIDATES} candidate outputs; use bounded storage diagnostics.`
        )
      }
      const outputs = (await sp.findOutputs(outputQuery)).filter(isAutoSpendableChangeOutput)
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
      let satoshis = 0
      for (const output of outputs) {
        if (!Number.isSafeInteger(output.satoshis) || output.satoshis < 0 || output.satoshis > 21e14) {
          throw new Error('Managed-change output has an invalid satoshi value.')
        }
        satoshis += output.satoshis
        if (!Number.isSafeInteger(satoshis) || satoshis > 21e14) {
          throw new Error('Managed-change output total exceeds the maximum monetary supply.')
        }
      }
      return (
        `userId ${user.userId}: managed change ${outputs.length}/${basket.numberOfDesiredUTXOs}, ` +
        `healthy ${healthy.length}, undersized ${undersized.length}, reserved ${reserved.size}, ` +
        `completed ${countStatus('completed')}, unproven ${countStatus('unproven')}, ` +
        `sending ${countStatus('sending')}, satoshis ${satoshis}, preferred minimum ${preferred}\n`
      )
    })
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
