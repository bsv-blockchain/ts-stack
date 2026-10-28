import { promiseFromSync, awaitFromSync } from '../../utility/promiseFromSync'
import { WalletError } from '../../sdk/WalletError'
import { StorageReqWrite } from '../../storage/StorageReqWrite'
import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import { Monitor } from '../Monitor'
import { WalletMonitorTask, captureMonitorReqWrite } from './WalletMonitorTask'
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
  private readonly writeCaptures = new WeakMap<EntityProvenTxReq, StorageReqWrite>()
  static get checkNow(): boolean {
    return this.checkNowRequested
  }
  static set checkNow(value: boolean) {
    this.checkNowRequested = value
  }

  constructor(
    monitor: Monitor,
    public triggerMsecs = Monitor.oneMinute * 10
  ) {
    super(monitor, TaskUnFail.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run:
        TaskUnFail.checkNow ||
        (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async runTask(): Promise<string> {
    let log = ''
    TaskUnFail.checkNow = false

    const limit = 100
    let offset = 0
    for (;;) {
      const reqs = await this.storage.findProvenTxReqs({
        partial: {},
        status: ['unfail'],
        // Every successfully processed row leaves the 'unfail' set, so keep
        // retaining only inactive-profile rows in the offset. Successful rows
        // leave the set; they must not advance the remaining-row cursor.
        paged: { limit, offset }
      })
      if (reqs.length === 0) break
      log += `${reqs.length} reqs with status 'unfail'\n`
      const r = await this.unfail(reqs, 2)
      log += `${r.log}\n`
      offset += r.deferred ?? 0
      if (reqs.length < limit) break
    }

    return log
  }

  async unfail(reqs: TableProvenTxReq[], indent = 0): Promise<{ log: string; deferred?: number }> {
    let log = ''
    let deferred = 0
    for (const reqApi of reqs) {
      try {
        log += (await this.unfailOne(reqApi, indent)).log
      } catch (error) {
        if (WalletError.fromUnknown(error).code !== 'WERR_NOT_ACTIVE') throw error
        deferred++
        log += `reqId ${reqApi.provenTxReqId} deferred to its current primary\n`
      }
    }
    return { log, ...(deferred ? { deferred } : {}) }
  }

  private async unfailOne(reqApi: TableProvenTxReq, indent: number): Promise<{ log: string }> {
    let log = ''
    const req = new EntityProvenTxReq(reqApi)
    log += ' '.repeat(indent)
    log += `reqId ${reqApi.provenTxReqId} txid ${reqApi.txid}: `
    const writes = await captureMonitorReqWrite(this, [req.txid])
    await writes?.assertCurrent()
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
      log += "proof unavailable or rejected; returned to status 'invalid'\n"
      if (writes == null) await req.updateStorageDynamicProperties(this.storage)
      else if (
        !(await writes.request(req, current => {
          return promiseFromSync(() => {
            if (current.status !== 'unfail') return
            current.status = 'invalid'
            current.addHistoryNote({ what: 'unfailProofRejected' }, true)
          })
        }))
      )
        throw new WERR_NOT_ACTIVE('Unfail observation lost its captured primary profiles')
      return { log }
    }
    this.authenticatedRequests.add(req)
    if (writes != null) this.writeCaptures.set(req, writes)
    log += "authenticated and unfailed. status is now 'unmined'\n"
    log += await this.unfailReq(req, indent + 2)
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
  async unfailReq(req: EntityProvenTxReq, indent: number): Promise<string> {
    if (!this.authenticatedRequests.delete(req)) {
      throw new WERR_INVALID_OPERATION('Unfail requires a proof authenticated for this exact request.')
    }
    const writes = this.writeCaptures.get(req)
    this.writeCaptures.delete(req)
    if (writes?.preparesOutsideManager === true)
      return await writes.prepare(sp =>
        awaitFromSync(() => sp.unfailTransactionsForProof(req, indent, { status: 'unmined', attempts: 0 }, writes))
      )
    return await this.storage.runAsStorageProvider(async sp =>
      writes == null
        ? await sp.unfailTransactionsForProof(req, indent, { status: 'unmined', attempts: 0 })
        : await sp.unfailTransactionsForProof(req, indent, { status: 'unmined', attempts: 0 }, writes)
    )
  }
}
