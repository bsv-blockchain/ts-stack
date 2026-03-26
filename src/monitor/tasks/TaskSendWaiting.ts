import { ReviewActionResult, SendWithResult } from '@bsv/sdk'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { attemptToPostReqsToNetwork } from '../../storage/methods/attemptToPostReqsToNetwork'
import { aggregateActionResults } from '../../utility/aggregateResults'
import { ProvenTxReqStatus } from '../../sdk/types'
import { verifyTruthy } from '../../utility/utilityHelpers'
import { TableProvenTxReq } from '../../storage/schema/tables/TableProvenTxReq'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'

export class TaskSendWaiting extends WalletMonitorTask {
  static taskName = 'SendWaiting'

  lastSendingRunMsecsSinceEpoch: number | undefined
  includeSending: boolean = true

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneSecond * 8,
    public agedMsecs = Monitor.oneSecond * 7,
    public sendingMsecs = Monitor.oneMinute * 5
  ) {
    super(monitor, TaskSendWaiting.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    this.includeSending =
      !this.lastSendingRunMsecsSinceEpoch || nowMsecsSinceEpoch > this.lastSendingRunMsecsSinceEpoch + this.sendingMsecs
    if (this.includeSending) this.lastSendingRunMsecsSinceEpoch = nowMsecsSinceEpoch
    return {
      run: nowMsecsSinceEpoch > this.lastRunMsecsSinceEpoch + this.triggerMsecs
    }
  }

  async runTask(): Promise<string> {
    let log = ''
    const limit = 100
    let offset = 0
    const agedLimit = new Date(Date.now() - this.agedMsecs)
    const status: ProvenTxReqStatus[] = this.includeSending ? ['unsent', 'sending'] : ['unsent']
    for (;;) {
      let reqs = await this.storage.findProvenTxReqs({
        partial: {},
        status,
        paged: { limit, offset }
      })
      const count = reqs.length
      if (reqs.length === 0) break
      log += `${reqs.length} reqs with status ${status.join(' or ')}\n`
      const agedReqs = reqs.filter(req => verifyTruthy(req.updated_at) < agedLimit)
      log += `  Of those reqs, ${agedReqs.length} where last updated before ${agedLimit.toISOString()}.\n`
      log += await this.processUnsent(agedReqs, 2)
      if (count < limit) break
      offset += limit
    }
    return log
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
  async processUnsent(reqApis: TableProvenTxReq[], indent = 0): Promise<string> {
    const txids = reqApis.map(r => r.txid)
    const logs: Record<string, string> = {}
    const reqApiIds = new Set(reqApis.map(r => r.provenTxReqId))
    const groupedReqIds = new Set<number>()
    for (let i = 0; i < reqApis.length; i++) {
      const reqApi = reqApis[i]
      logs[reqApi.txid] = `${i} reqId=${reqApi.provenTxReqId} attempts=${reqApi.attempts} txid=${reqApi.txid}:`
    }
    for (let i = 0; i < reqApis.length; i++) {
      const reqApi = reqApis[i]
      if (groupedReqIds.has(reqApi.provenTxReqId)) {
        logs[reqApi.txid] += ` processed with batch`
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
          partial: { batch: req.batch, status: 'unsent' }
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
        return attemptToPostReqsToNetwork(sp, reqs)
      })

      for (const rd of r.details) {
        logs[rd.txid] += ` req.status ${rd.req.status} post.status ${rd.status}`
      }

      if (this.monitor.onTransactionBroadcasted) {
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
