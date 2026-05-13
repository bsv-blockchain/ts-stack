import { SendWithResult } from '@bsv/sdk'

import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { attemptToPostReqsToNetwork } from '../../storage/methods/attemptToPostReqsToNetwork'
import { aggregateActionResults } from '../../utility/aggregateResults'
import { ProvenTxReqStatus } from '../../sdk/types'
import { verifyTruthy } from '../../utility/utilityHelpers'
import { TableProvenTxReq } from '../../storage/schema/tables/TableProvenTxReq'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'

export class TaskSendWaiting extends WalletMonitorTask {
  static readonly taskName = 'SendWaiting'

  lastSendingRunMsecsSinceEpoch: number | undefined
  includeSending = true
  triggerNextMsecs: number

  /**
   * @param monitor Wallet monitor owning this task.
   * @param triggerMsecs Normal interval between SendWaiting runs when no backlog remains.
   * @param agedMsecs Minimum age a request must reach before this task will attempt to send it.
   * @param sendingMsecs Minimum interval before stale `sending` requests are included again.
   * @param triggerQuickMsecs Follow-up interval used when a full chunk was consumed and more work may remain.
   * @param chunkLimit Maximum number of waiting requests to fetch and inspect in a single run.
   */
  constructor (
    monitor: Monitor,
    public triggerMsecs = Monitor.oneSecond * 8,
    public agedMsecs = Monitor.oneSecond * 7,
    public sendingMsecs = Monitor.oneMinute * 5,
    public triggerQuickMsecs = Monitor.oneSecond * 1,
    public chunkLimit = 100
  ) {
    super(monitor, TaskSendWaiting.taskName)
    this.triggerNextMsecs = this.triggerQuickMsecs
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    this.includeSending =
      !this.lastSendingRunMsecsSinceEpoch || nowMsecsSinceEpoch > this.lastSendingRunMsecsSinceEpoch + this.sendingMsecs
    if (this.includeSending) this.lastSendingRunMsecsSinceEpoch = nowMsecsSinceEpoch
    return {
      run: nowMsecsSinceEpoch > this.lastRunMsecsSinceEpoch + this.triggerNextMsecs
    }
  }

  async runTask (): Promise<string> {
    let log = ''
    const nowMsecsSinceEpoch = Date.now()
    const agedLimit = new Date(nowMsecsSinceEpoch - this.agedMsecs)
    const status: ProvenTxReqStatus[] = this.includeSending ? ['unsent', 'sending'] : ['unsent']
    const reqs = await this.storage.findProvenTxReqs({
      partial: {},
      status,
      paged: { limit: this.chunkLimit, offset: 0 }
    })

    const count = reqs.length
    if (count > 0) {
      log += `${count} reqs with status ${status.join(' or ')}\n`
      const filteredReqs = await this.expandBatches(reqs, status)
      const agedReqs = this.filterAgedReqs(filteredReqs, agedLimit)
      log += `  Of those reqs, ${agedReqs.length} where last updated before ${agedLimit.toISOString()}.\n`
      log += await this.processUnsent(agedReqs, 2)

      if (count >= this.chunkLimit) {
        this.triggerNextMsecs = this.triggerQuickMsecs
      } else if (agedReqs.length < filteredReqs.length) {
        const ageAllMsecs = Math.max(
          ...filteredReqs.map(req => verifyTruthy(req.updated_at).getTime() + this.agedMsecs - nowMsecsSinceEpoch),
          0
        )
        this.triggerNextMsecs = ageAllMsecs
      } else {
        this.triggerNextMsecs = this.triggerMsecs
      }
    } else {
      this.triggerNextMsecs = this.triggerMsecs
    }

    return log
  }

  private async expandBatches (reqs: TableProvenTxReq[], status: ProvenTxReqStatus[]): Promise<TableProvenTxReq[]> {
    const expanded: TableProvenTxReq[] = []
    const seenReqIds = new Set<number>()
    const seenBatches = new Set<string>()

    for (const req of reqs) {
      if (seenReqIds.has(req.provenTxReqId)) continue

      if (!req.batch || seenBatches.has(req.batch)) {
        seenReqIds.add(req.provenTxReqId)
        expanded.push(req)
        continue
      }

      seenBatches.add(req.batch)
      const batchReqs = await this.storage.findProvenTxReqs({
        partial: { batch: req.batch },
        status
      })

      for (const batchReq of batchReqs) {
        if (seenReqIds.has(batchReq.provenTxReqId)) continue
        seenReqIds.add(batchReq.provenTxReqId)
        expanded.push(batchReq)
      }
    }

    return expanded
  }

  private filterAgedReqs (reqs: TableProvenTxReq[], agedLimit: Date): TableProvenTxReq[] {
    const agedReqs: TableProvenTxReq[] = []
    const seenBatches = new Set<string>()

    for (const req of reqs) {
      if (!req.batch) {
        if (verifyTruthy(req.updated_at) < agedLimit) agedReqs.push(req)
        continue
      }

      if (seenBatches.has(req.batch)) continue
      seenBatches.add(req.batch)

      const batchReqs = reqs.filter(candidate => candidate.batch === req.batch)
      const youngestUpdatedAt = Math.max(...batchReqs.map(batchReq => verifyTruthy(batchReq.updated_at).getTime()))
      if (youngestUpdatedAt < agedLimit.getTime()) {
        agedReqs.push(...batchReqs)
      }
    }

    return agedReqs
  }

  /**
   * Process an array of 'unsent' status table.ProvenTxReq
   *
   * Send rawTx to transaction processor(s), requesting proof callbacks when possible.
   *
   * Set status 'invalid' if req is invalid.
   *
   * Set status to 'callback' on successful network submission with callback service.
   *
   * Set status to 'unmined' on successful network submission without callback service.
   *
   * Add mapi responses to database table if received.
   *
   * Increments attempts if sending was attempted.
   *
   * @param reqApis
   */
  async processUnsent (reqApis: TableProvenTxReq[], indent = 0): Promise<string> {
    const txids = reqApis.map(r => r.txid)
    const logs: Record<string, string> = {}
    const reqApiIds = new Set(reqApis.map(r => r.provenTxReqId))
    const groupedReqIds = new Set<number>()
    for (let i = 0; i < reqApis.length; i++) {
      const reqApi = reqApis[i]
      logs[reqApi.txid] = `${i} reqId=${reqApi.provenTxReqId} attempts=${reqApi.attempts} txid=${reqApi.txid}:`
    }
    for (const reqApi of reqApis) {
      if (groupedReqIds.has(reqApi.provenTxReqId)) {
        logs[reqApi.txid] += ' processed with batch'
        continue
      }
      if (reqApi.status !== 'unsent' && reqApi.status !== 'sending') {
        logs[reqApi.txid] += ` status now ${reqApi.status}`
        continue
      }
      const req = new EntityProvenTxReq(reqApi)
      const reqs: EntityProvenTxReq[] = []
      if (req.batch) {
        logs[reqApi.txid] += ` batch ${req.batch}`
        // Make sure wew process entire batch together for efficient beef generation
        const batchReqApis = await this.storage.findProvenTxReqs({
          partial: { batch: req.batch },
          status: this.includeSending ? ['unsent', 'sending'] : ['unsent']
        })
        for (const bra of batchReqApis) {
          if (reqApiIds.has(bra.provenTxReqId)) groupedReqIds.add(bra.provenTxReqId)
          reqs.push(new EntityProvenTxReq(bra))
        }
      } else {
        // Just a single non-batched req...
        reqs.push(req)
      }

      const r = await this.storage.runAsStorageProvider(async sp => {
        return await attemptToPostReqsToNetwork(sp, reqs)
      })

      for (const rd of r.details) {
        logs[rd.txid] += ` req.status ${rd.req.status} post.status ${rd.status}`
      }

      if (this.monitor.onTransactionBroadcasted != null) {
        const rar = await this.storage.runAsStorageProvider(async sp => {
          const ars: SendWithResult[] = [{ txid: req.txid, status: 'sending' }]
          const { rar } = await aggregateActionResults(sp, ars, r)
          return rar
        })
        this.monitor.callOnBroadcastedTransaction(rar[0])
      }
    }

    let log = ''
    for (const txid of txids) {
      log += `${' '.repeat(indent)}${logs[txid]}\n`
    }
    return log
  }
}
