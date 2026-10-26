import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { TableProvenTxReq } from '../../storage/schema/tables'
import { EntityProvenTxReq } from '../../storage/schema/entities'
import { authenticateMerklePathResult } from '../../services/validateMerklePathResult'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
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
  private static checkNowRequested = false
  private readonly authenticatedRequests = new WeakSet<EntityProvenTxReq>()
  static get checkNow (): boolean { return this.checkNowRequested }
  static set checkNow (value: boolean) { this.checkNowRequested = value }

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
    for (;;) {
      const reqs = await this.storage.findProvenTxReqs({
        partial: {},
        status: ['unfail'],
        // Every successfully processed row leaves the 'unfail' set, so keep
        // reading its first page. Advancing an offset here skips rows after
        // the preceding page is updated.
        paged: { limit, offset: 0 }
      })
      if (reqs.length === 0) break
      log += `${reqs.length} reqs with status 'unfail'\n`
      const r = await this.unfail(reqs, 2)
      log += `${r.log}\n`
      if (reqs.length < limit) break
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
      try {
        if (r.merklePath == null || r.header == null) throw new Error('No proof was returned.')
        if (req.rawTx == null || asString(doubleSha256BE(req.rawTx)) !== req.txid.toLowerCase()) {
          throw new Error('The request transaction bytes do not match its txid.')
        }
        await authenticateMerklePathResult(req.txid, r, this.monitor.chaintracks, false, false)
      } catch {
        req.status = 'invalid'
        req.addHistoryNote({ what: 'unfailProofRejected' }, true)
        log += 'proof unavailable or rejected; returned to status \'invalid\'\n'
        await req.updateStorageDynamicProperties(this.storage)
        continue
      }
      this.authenticatedRequests.add(req)
      log += 'authenticated and unfailed. status is now \'unmined\'\n'
      log += await this.unfailReq(req, indent + 2)
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
    if (!this.authenticatedRequests.delete(req)) {
      throw new WERR_INVALID_OPERATION('Unfail requires a proof authenticated for this exact request.')
    }
    return await this.storage.runAsStorageProvider(async sp =>
      await sp.unfailTransactionsForProof(req, indent, { status: 'unmined', attempts: 0 })
    )
  }
}
