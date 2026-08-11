import { Transaction } from '@bsv/sdk'
import { StatusForTxidResult } from '../../sdk/WalletServices.interfaces'
import { EntityProvenTxReq } from '../../storage/schema/entities'
import { TableProvenTxReq } from '../../storage/schema/tables'
import {
  quarantineReqInputs,
  quarantineReqInputsFromFailedParents
} from '../../storage/methods/reconcileFailedTransactionInputs'
import { StorageProvider } from '../../storage/StorageProvider'
import { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

const REVIEW_STATUSES = ['callback', 'unmined', 'sending', 'unknown', 'unconfirmed'] as const

interface ReconcilePendingCheckpoint {
  reviewed: number
  reconciled: number
  inputConflicts: number
  retained: number
  reviewLimit: number
  minAgeMinutes: number
  cycleComplete?: boolean
  resumeOffset?: number
  expectedProvenTxReqId?: number
  reviewLog?: string
}

interface AppliedTerminalVerdict {
  result: StatusForTxidResult
}

/**
 * Poll durable transaction lifecycle state for aged, non-terminal requests.
 * This closes the gap where an Arcade rejection event was missed before the
 * monitor subscribed or while it was offline. Unknown/provider-error results
 * never mutate storage; only a provider's explicit terminal verdict does.
 */
export class TaskReconcilePendingTransactions extends WalletMonitorTask {
  static readonly taskName = 'ReconcilePendingTransactions'

  triggerNextMsecs: number

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute * 12,
    public reviewLimit = 100,
    public minAgeMinutes = 60,
    public triggerQuickMsecs = Monitor.oneMinute
  ) {
    super(monitor, TaskReconcilePendingTransactions.taskName)
    this.triggerNextMsecs = this.triggerQuickMsecs
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: this.triggerNextMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerNextMsecs
    }
  }

  private async getCheckpoint(): Promise<
    | {
        resumeOffset: number
        expectedProvenTxReqId?: number
      }
    | undefined
  > {
    let events: Array<{ details?: string }> = []
    await this.storage.runAsStorageProvider(async sp => {
      events = await sp.findMonitorEvents({
        partial: { event: TaskReconcilePendingTransactions.taskName },
        orderDescending: true,
        paged: { limit: 5 }
      })
    })
    for (const event of events) {
      if (!event.details) continue
      try {
        const parsed = JSON.parse(event.details) as Partial<ReconcilePendingCheckpoint>
        if (parsed.cycleComplete === true) return undefined
        if (typeof parsed.resumeOffset === 'number') {
          return {
            resumeOffset: parsed.resumeOffset,
            expectedProvenTxReqId: parsed.expectedProvenTxReqId
          }
        }
      } catch {
        continue
      }
    }
    return undefined
  }

  async runTask(): Promise<string> {
    const checkpoint = await this.getCheckpoint()
    // Proof checks and lifecycle events legitimately refresh updated_at while a
    // request remains pending. Use the immutable creation time so that routine
    // monitoring cannot postpone reconciliation forever.
    const createdBefore = new Date(Date.now() - this.minAgeMinutes * 60 * 1000)
    const reqs = await this.findReqsToReview(checkpoint)
    const eligible = reqs.filter(req => req.created_at <= createdBefore)
    const provider =
      eligible.length === 0 ? undefined : await this.monitor.services.getStatusForTxids(eligible.map(req => req.txid))
    const results = new Map(provider?.results.map(result => [result.txid, result]) ?? [])

    let reconciled = 0
    let inputConflicts = 0
    let reviewLog = ''
    const retained: TableProvenTxReq[] = []
    for (const req of reqs) {
      const result = results.get(req.txid)
      if (req.created_at > createdBefore) {
        retained.push(req)
        continue
      }
      const applied = await this.applyTerminalVerdict(
        req,
        provider?.status === 'success' ? result : undefined,
        provider?.status === 'success' ? provider.name : undefined,
        createdBefore
      )
      if (!applied) {
        retained.push(req)
        continue
      }
      reconciled++
      if (applied.result.inputConflict === true) inputConflicts++
      reviewLog +=
        `reconciled ${req.provenTxReqId} ${req.txid} ${applied.result.providerStatus ?? 'terminal'} ` +
        `=> ${applied.result.inputConflict === true ? 'doubleSpend' : 'invalid'}\n`
    }

    const fullPage = reqs.length >= this.reviewLimit
    this.triggerNextMsecs = fullPage ? this.triggerQuickMsecs : this.triggerMsecs
    let resumeOffset: number | undefined
    let expectedProvenTxReqId: number | undefined
    if (fullPage) {
      if (retained.length === 0) {
        resumeOffset = reqs.sourceOffset ?? 0
      } else {
        resumeOffset = (reqs.sourceOffset ?? 0) + retained.length - 1
        expectedProvenTxReqId = retained.at(-1)?.provenTxReqId
      }
    }

    return JSON.stringify({
      reviewed: eligible.length,
      reconciled,
      inputConflicts,
      retained: retained.length,
      reviewLimit: this.reviewLimit,
      minAgeMinutes: this.minAgeMinutes,
      cycleComplete: !fullPage,
      ...(resumeOffset != null ? { resumeOffset } : {}),
      ...(expectedProvenTxReqId != null ? { expectedProvenTxReqId } : {}),
      reviewLog
    } satisfies ReconcilePendingCheckpoint)
  }

  private async findReqsToReview(
    checkpoint: { resumeOffset: number; expectedProvenTxReqId?: number } | undefined
  ): Promise<TableProvenTxReq[] & { sourceOffset?: number }> {
    let offset = checkpoint?.resumeOffset ?? 0
    if (checkpoint?.expectedProvenTxReqId != null) {
      const verify = await this.storage.findProvenTxReqs({
        partial: {},
        status: [...REVIEW_STATUSES],
        paged: { limit: 1, offset }
      })
      offset = verify[0]?.provenTxReqId === checkpoint.expectedProvenTxReqId ? offset + 1 : 0
    }
    const reqs = (await this.storage.findProvenTxReqs({
      partial: {},
      status: [...REVIEW_STATUSES],
      paged: { limit: this.reviewLimit, offset }
    })) as TableProvenTxReq[] & { sourceOffset?: number }
    reqs.sourceOffset = offset
    return reqs
  }

  private async applyTerminalVerdict(
    reqApi: TableProvenTxReq,
    providerResult: StatusForTxidResult | undefined,
    providerName: string | undefined,
    createdBefore: Date
  ): Promise<AppliedTerminalVerdict | undefined> {
    let applied: AppliedTerminalVerdict | undefined
    await this.storage.runAsStorageProvider(async sp => {
      await sp.transaction(async trx => {
        const req = new EntityProvenTxReq(reqApi)
        await req.refreshFromStorage(sp, trx)
        if (!REVIEW_STATUSES.includes(req.status as (typeof REVIEW_STATUSES)[number])) return
        if (req.created_at > createdBefore) return

        const failedParentTxids = await this.findFailedLocalParentTxids(req, sp, trx)
        const result =
          providerResult?.terminal === true
            ? providerResult
            : providerResult?.status === 'known' || providerResult?.status === 'mined'
              ? undefined
              : this.failedParentVerdict(req.txid, failedParentTxids)
        if (result == null) return
        const provider =
          providerResult?.terminal === true ? (providerName ?? 'transaction-status-provider') : 'local-storage'

        req.status = result.inputConflict === true ? 'doubleSpend' : 'invalid'
        req.addHistoryNote({
          when: new Date().toISOString(),
          what: 'proactiveTerminalReconciliation',
          provider,
          providerStatus: result.providerStatus,
          statusCode: result.statusCode,
          description: result.description,
          inputConflict: result.inputConflict === true,
          competingTxs: result.competingTxs?.join(',')
        })
        await req.updateStorageDynamicProperties(sp, trx)
        if (req.notify.transactionIds != null) {
          await sp.updateTransactionsStatus(req.notify.transactionIds, 'failed', trx)
        }
        if (result.inputConflict === true) {
          const quarantined = await quarantineReqInputs(req, sp, trx)
          req.addHistoryNote({
            when: new Date().toISOString(),
            what: 'proactiveInputQuarantine',
            checked: quarantined.checked,
            confirmed: quarantined.staleConfirmed,
            ...(quarantined.staleOutpoints.length > 0 ? { outpoints: quarantined.staleOutpoints.join(',') } : {})
          })
          await req.updateStorageDynamicProperties(sp, trx)
        } else if (failedParentTxids.length > 0) {
          const quarantined = await quarantineReqInputsFromFailedParents(req, failedParentTxids, sp, trx)
          req.addHistoryNote({
            when: new Date().toISOString(),
            what: 'proactiveFailedParentQuarantine',
            checked: quarantined.checked,
            confirmed: quarantined.staleConfirmed,
            parentTxids: failedParentTxids.join(','),
            ...(quarantined.staleOutpoints.length > 0 ? { outpoints: quarantined.staleOutpoints.join(',') } : {})
          })
          await req.updateStorageDynamicProperties(sp, trx)
        }
        applied = { result }
      })
    })
    if (applied) {
      this.monitor.callOnTransactionStatusChanged(reqApi.txid, applied.result.providerStatus ?? 'REJECTED')
    }
    return applied
  }

  private async findFailedLocalParentTxids(
    req: EntityProvenTxReq,
    storage: StorageProvider,
    trx: TrxToken
  ): Promise<string[]> {
    const parentTxids = [
      ...new Set(
        Transaction.fromBinary(req.rawTx)
          .inputs.map(input => input.sourceTXID)
          .filter((txid): txid is string => txid != null && txid !== '')
      )
    ]
    const failed: string[] = []
    for (const txid of parentTxids) {
      const parentReqs = await storage.findProvenTxReqs({ partial: { txid }, trx })
      if (parentReqs.some(parent => parent.status === 'invalid' || parent.status === 'doubleSpend')) {
        failed.push(txid)
      }
    }
    return failed
  }

  private failedParentVerdict(txid: string, failedParentTxids: string[]): StatusForTxidResult | undefined {
    if (failedParentTxids.length === 0) return undefined
    return {
      txid,
      status: 'unknown',
      depth: undefined,
      terminal: true,
      inputConflict: false,
      providerStatus: 'LOCAL_PARENT_FAILED',
      description: `Local parent request is terminal: ${failedParentTxids.join(',')}`.slice(0, 512)
    }
  }
}
