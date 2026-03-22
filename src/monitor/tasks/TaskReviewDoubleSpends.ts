import { TableProvenTxReq } from '../../storage/schema/tables'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

interface ReviewDoubleSpendsCheckpoint {
  reviewLimit: number
  minAgeMinutes: number
  reviewed: number
  unfails: number
  provenTxReqIds?: number[]
  reviewLog?: string
  resumeOffset?: number
  expectedProvenTxReqId?: number
}

/**
 * Review recent reqs in terminal 'doubleSpend' state and move any false positives
 * back to 'unfail' so existing recovery handling can re-process them.
 */
export class TaskReviewDoubleSpends extends WalletMonitorTask {
  static taskName = 'ReviewDoubleSpends'

  static checkNow = false

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute * 12,
    public reviewLimit = 100,
    public minAgeMinutes = 60
  ) {
    super(monitor, TaskReviewDoubleSpends.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskReviewDoubleSpends.checkNow ||
        (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async getLastReviewedCheckpoint(): Promise<{ resumeOffset: number; expectedProvenTxReqId?: number } | undefined> {
    let events: Array<{ details?: string }> = []
    await this.storage.runAsStorageProvider(async sp => {
      events = await sp.findMonitorEvents({
        partial: { event: TaskReviewDoubleSpends.taskName },
        orderDescending: true,
        paged: { limit: 5 }
      })
    })

    for (const event of events) {
      if (!event.details) continue
      try {
        const parsed = JSON.parse(event.details) as Partial<ReviewDoubleSpendsCheckpoint>
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
    TaskReviewDoubleSpends.checkNow = false

    const checkpoint = await this.getLastReviewedCheckpoint()
    const updatedBefore = new Date(Date.now() - this.minAgeMinutes * 60 * 1000)
    const reqs = await this.findReqsToReview(checkpoint, updatedBefore)
    if (reqs.length === 0) return ''

    const reviewed: TableProvenTxReq[] = []
    const unfails: number[] = []
    let log = ``
    let lastRetainedDoubleSpendIndex = -1

    for (const req of reqs) {
      const gsr = await this.monitor.services.getStatusForTxids([req.txid])
      const status = gsr.results[0]?.status
      reviewed.push(req)
      if (status !== 'unknown') {
        unfails.push(req.provenTxReqId)
        log += `unfail ${req.provenTxReqId} ${req.txid} status:${status}\n`
      } else {
        lastRetainedDoubleSpendIndex = reviewed.length - 1
      }
    }

    if (unfails.length > 0) {
      await this.storage.runAsStorageProvider(async sp => {
        await sp.updateProvenTxReq(unfails, { status: 'unfail' })
      })
    }

    return JSON.stringify({
      minAgeMinutes: this.minAgeMinutes,
      reviewed: reviewed.length,
      unfails: unfails.length,
      reviewLimit: this.reviewLimit,
      provenTxReqIds: unfails,
      resumeOffset:
        lastRetainedDoubleSpendIndex >= 0 ? reqs.sourceOffset! + lastRetainedDoubleSpendIndex : undefined,
      expectedProvenTxReqId: lastRetainedDoubleSpendIndex >= 0 ? reviewed[lastRetainedDoubleSpendIndex].provenTxReqId : undefined,
      reviewLog: `${reviewed.length} reqs with status 'doubleSpend'\n${log}`
    } satisfies ReviewDoubleSpendsCheckpoint)
  }

  private async findReqsToReview(
    checkpoint: { resumeOffset: number; expectedProvenTxReqId?: number } | undefined,
    updatedBefore: Date
  ): Promise<TableProvenTxReq[] & { sourceOffset?: number }> {
    let offset = checkpoint?.resumeOffset || 0

    if (checkpoint && checkpoint.expectedProvenTxReqId !== undefined) {
      const verify = await this.storage.findProvenTxReqs({
        partial: { status: 'doubleSpend' },
        paged: { limit: 1, offset: checkpoint.resumeOffset }
      })
      if (verify[0]?.provenTxReqId !== checkpoint.expectedProvenTxReqId) {
        offset = 0
      } else {
        offset += 1
      }
    }

    const batch = await this.storage.findProvenTxReqs({
      partial: { status: 'doubleSpend' },
      paged: { limit: this.reviewLimit, offset }
    })
    const reqs = batch.filter(req => req.updated_at <= updatedBefore) as TableProvenTxReq[] & { sourceOffset?: number }
    reqs.sourceOffset = offset
    return reqs
  }
}
