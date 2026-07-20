import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { TableProvenTxReq } from '../../storage/schema/tables'
import { EntityProvenTxReq } from '../../storage/schema/entities'
/**
 * Setting provenTxReq status to 'unfail' when 'invalid' will attempt to find a merklePath, and if successful:
 *
 * 1. set the req status to 'unmined'
 * 2. set the referenced txs to 'unproven'
 * 3. determine if any inputs match user's existing outputs and if so update spentBy and spendable of those outputs.
 * 4. set the txs outputs to spendable
 *
 * If it fails (to find a merklePath), returns the req status to 'invalid'.
 */
export class TaskUnFail extends WalletMonitorTask {
  static readonly taskName = 'UnFail'

  /**
   * Set to true to trigger running this task
   */
  static checkNow = false

  constructor (
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute * 10
  ) {
    super(monitor, TaskUnFail.taskName)
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskUnFail.checkNow ||
        (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async runTask (): Promise<string> {
    let log = ''
    TaskUnFail.checkNow = false

    const limit = 100
    let offset = 0
    for (;;) {
      const reqs = await this.storage.findProvenTxReqs({
        partial: {},
        status: ['unfail'],
        paged: { limit, offset }
      })
      if (reqs.length === 0) break
      log += `${reqs.length} reqs with status 'unfail'\n`
      const r = await this.unfail(reqs, 2)
      log += `${r.log}\n`
      if (reqs.length < limit) break
      offset += limit
    }

    return log
  }

  async unfail (reqs: TableProvenTxReq[], indent = 0): Promise<{ log: string }> {
    let log = ''
    for (const reqApi of reqs) {
      const req = new EntityProvenTxReq(reqApi)
      log += ' '.repeat(indent)
      log += `reqId ${reqApi.provenTxReqId} txid ${reqApi.txid}: `
      const r = await this.monitor.services.getMerklePath(req.txid)
      if (r.merklePath != null) {
        log += 'unfailed. status is now \'unmined\'\n'
        log += await this.unfailReq(req, indent + 2)
      } else {
        req.status = 'invalid'
        log += 'returned to status \'invalid\'\n'
        await req.updateStorageDynamicProperties(this.storage)
      }
    }
    return { log }
  }

  /**
   * 2. set the referenced txs to 'unproven'
   * 3. determine if any inputs match user's existing outputs and if so update spentBy and spendable of those outputs.
   * 4. set the txs outputs to spendable
   *
   * @param req
   * @param indent
   * @returns
   */
  async unfailReq (req: EntityProvenTxReq, indent: number): Promise<string> {
    return await this.storage.runAsStorageProvider(async sp =>
      await sp.unfailTransactionsForProof(req, indent, { status: 'unmined', attempts: 0 })
    )
  }
}
