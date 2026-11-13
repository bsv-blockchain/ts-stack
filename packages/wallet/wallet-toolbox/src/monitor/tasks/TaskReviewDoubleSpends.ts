import { promiseFromSync, awaitVoidFromSync } from '../../utility/promiseFromSync'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'
import { WalletError } from '../../sdk/WalletError'
import { TableProvenTxReq } from '../../storage/schema/tables'
import { Monitor } from '../Monitor'
import {
  MAX_MONITOR_INTERVAL_MSECS,
  MAX_MONITOR_OFFSET,
  MAX_MONITOR_PAGE_SIZE,
  optionalMonitorInteger,
  requireMonitorInteger
} from '../monitorValidation'
import { WalletMonitorTask, captureMonitorReqWrite } from './WalletMonitorTask'

function hasDurableInputConflict(req: TableProvenTxReq): boolean {
  try {
    const history = JSON.parse(req.history) as { notes?: Array<Record<string, unknown>> }
    return history.notes?.some(note => note.inputConflict === true || note.what === 'arcSSEInputQuarantine') === true
  } catch {
    // Malformed legacy history must never weaken a terminal decision.
    return true
  }
}

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
  static readonly taskName = 'ReviewDoubleSpends'

  private static checkNowRequested = false
  static get checkNow(): boolean {
    return this.checkNowRequested
  }
  static set checkNow(value: boolean) {
    this.checkNowRequested = value
  }

  triggerNextMsecs: number

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute * 12,
    public reviewLimit = 100,
    public minAgeMinutes = 60,
    public triggerQuickMsecs = Monitor.oneMinute * 1
  ) {
    super(monitor, TaskReviewDoubleSpends.taskName)
    requireMonitorInteger(triggerMsecs, 'triggerMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
    requireMonitorInteger(reviewLimit, 'reviewLimit', 1, MAX_MONITOR_PAGE_SIZE)
    requireMonitorInteger(minAgeMinutes, 'minAgeMinutes', 0, MAX_MONITOR_INTERVAL_MSECS / Monitor.oneMinute)
    requireMonitorInteger(triggerQuickMsecs, 'triggerQuickMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
    this.triggerNextMsecs = this.triggerQuickMsecs
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskReviewDoubleSpends.checkNow ||
        (this.triggerNextMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerNextMsecs)
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
        const resumeOffset = optionalMonitorInteger(parsed.resumeOffset, 0, MAX_MONITOR_OFFSET)
        if (resumeOffset !== undefined) {
          return {
            resumeOffset,
            expectedProvenTxReqId: optionalMonitorInteger(parsed.expectedProvenTxReqId, 1, MAX_MONITOR_OFFSET)
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
    if (reqs.length === 0) {
      this.triggerNextMsecs = this.triggerMsecs
      return ''
    }

    this.triggerNextMsecs = reqs.length >= this.reviewLimit ? this.triggerQuickMsecs : this.triggerMsecs

    const reviewed: TableProvenTxReq[] = []
    const unfails: number[] = []
    const legacyUnfails: number[] = []
    let log = ''
    let lastRetainedDoubleSpendIndex = -1
    let retainedDoubleSpendCount = 0

    for (const req of reqs) {
      reviewed.push(req)
      let retained = true
      try {
        const writes = await captureMonitorReqWrite(this, [req.txid])
        if (writes != null) await writes.assertCurrent()
        const gsr = await this.monitor.services.getStatusForTxids([req.txid])
        const status =
          gsr.status === 'success' ? gsr.results.find(result => result.txid === req.txid)?.status : undefined
        let durableInputConflict = hasDurableInputConflict(req)
        let canUnfail = status === 'mined' || (status === 'known' && !durableInputConflict)
        if (writes == null) {
          if (canUnfail) legacyUnfails.push(req.provenTxReqId)
          retained = !canUnfail
        } else {
          const entity = new EntityProvenTxReq(req)
          let changed = false
          const committed = await writes.request(entity, current => {
            return promiseFromSync(() => {
              changed = false
              // A late proof, terminal input conflict or newer review cannot be
              // overwritten by the pre-observation snapshot. This callback only
              // updates cache metadata; validated proof recovery owns finances.
              durableInputConflict = hasDurableInputConflict(current.api)
              canUnfail = status === 'mined' || (status === 'known' && !durableInputConflict)
              if (current.status !== 'doubleSpend' || current.updated_at > updatedBefore || !canUnfail) return false
              current.status = 'unfail'
              changed = true
            })
          })
          canUnfail = committed && changed
          retained = !committed || entity.status === 'doubleSpend'
        }
        if (canUnfail) {
          unfails.push(req.provenTxReqId)
          log += `unfail ${req.provenTxReqId} ${req.txid} status:${status} durableInputConflict:${String(durableInputConflict)}\n`
        }
      } catch (error) {
        if (WalletError.fromUnknown(error).code !== 'WERR_NOT_ACTIVE') throw error
        log += `review ${req.provenTxReqId} deferred to its current primary\n`
      }
      if (retained) {
        lastRetainedDoubleSpendIndex = reviewed.length - 1
        retainedDoubleSpendCount++
      }
    }

    if (legacyUnfails.length > 0) {
      await this.storage.runAsStorageProvider(sp =>
        awaitVoidFromSync(() => sp.updateProvenTxReq(legacyUnfails, { status: 'unfail' }))
      )
    }

    return JSON.stringify({
      minAgeMinutes: this.minAgeMinutes,
      reviewed: reviewed.length,
      unfails: unfails.length,
      reviewLimit: this.reviewLimit,
      provenTxReqIds: unfails,
      resumeOffset: lastRetainedDoubleSpendIndex >= 0 ? reqs.sourceOffset! + retainedDoubleSpendCount - 1 : undefined,
      expectedProvenTxReqId:
        lastRetainedDoubleSpendIndex >= 0 ? reviewed[lastRetainedDoubleSpendIndex].provenTxReqId : undefined,
      reviewLog: `${reviewed.length} reqs with status 'doubleSpend'\n${log}`
    } satisfies ReviewDoubleSpendsCheckpoint)
  }

  private async findReqsToReview(
    checkpoint: { resumeOffset: number; expectedProvenTxReqId?: number } | undefined,
    updatedBefore: Date
  ): Promise<TableProvenTxReq[] & { sourceOffset?: number }> {
    let offset = checkpoint?.resumeOffset ?? 0

    if (checkpoint?.expectedProvenTxReqId !== undefined) {
      const verify = await this.storage.findProvenTxReqs({
        partial: { status: 'doubleSpend' },
        paged: { limit: 1, offset: checkpoint.resumeOffset }
      })
      if (verify[0]?.provenTxReqId === checkpoint.expectedProvenTxReqId) {
        offset += 1
      } else {
        offset = 0
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
