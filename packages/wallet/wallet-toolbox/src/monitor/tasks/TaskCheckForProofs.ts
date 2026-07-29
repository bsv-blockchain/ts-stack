import { GetMerklePathResult } from '../../sdk'
import { EntityProvenTx, EntityProvenTxReq } from '../../storage/schema/entities'
import { TableProvenTxReq } from '../../storage/schema/tables'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * `TaskCheckForProofs` is a WalletMonitor task that retreives merkle proofs for
 * transactions.
 *
 * It is normally triggered by the Chaintracks new block header event.
 *
 * When a new block is found, cwi-external-services are used to obtain proofs for
 * any transactions that are currently in the 'unmined' or 'unknown' state.
 *
 * If a proof is obtained and validated, a new ProvenTx record is created and
 * the original ProvenTxReq status is advanced to 'notifying'.
 */
export class TaskCheckForProofs extends WalletMonitorTask {
  static readonly taskName = 'CheckForProofs'

  /**
   * An external service such as the chaintracks new block header
   * listener can set this true to cause
   */
  private static checkNowRequested = false
  static get checkNow (): boolean { return this.checkNowRequested }
  static set checkNow (value: boolean) { this.checkNowRequested = value }

  constructor(
    monitor: Monitor,
    public triggerMsecs = 0
  ) {
    super(monitor, TaskCheckForProofs.taskName)
  }

  /**
   * Normally triggered by checkNow getting set by new block header found event from chaintracks
   */
  trigger(_nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: TaskCheckForProofs.checkNow
      // Check only when checkNow flag is set.
      // || (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
    }
  }

  async runTask(): Promise<string> {
    let log = ''
    const countsAsAttempt = TaskCheckForProofs.checkNow
    TaskCheckForProofs.checkNow = false

    const maxAcceptableHeight = this.monitor.lastNewHeader?.height
    if (maxAcceptableHeight === undefined) {
      return log
    }

    const limit = 100
    let offset = 0
    for (;;) {
      const reqs = await this.storage.findProvenTxReqs({
        partial: {},
        status: ['callback', 'unmined', 'sending', 'unknown', 'unconfirmed'],
        paged: { limit, offset }
      })
      if (reqs.length === 0) break
      log += `${reqs.length} reqs with status 'callback', 'unmined', 'sending', 'unknown', or 'unconfirmed'\n`
      const r = await getProofs(this, reqs, maxAcceptableHeight, 2, countsAsAttempt, false)
      log += `${r.log}\n`
      if (reqs.length < limit) break
      offset += limit
    }
    return log
  }
}

interface ProofRequestResult {
  log: string
  proven?: TableProvenTxReq
  invalid?: TableProvenTxReq
}

const PROVABLE_STATUSES = new Set([
  'callback',
  'unmined',
  'unknown',
  'unconfirmed',
  'nosend',
  'sending'
])

function requestIsReadyForProof (
  req: TableProvenTxReq,
  ignoreStatus: boolean
): boolean {
  return ignoreStatus || PROVABLE_STATUSES.has(req.status)
}

function rawTransactionMatchesTxid (req: EntityProvenTxReq): boolean {
  return req.rawTx != null && asString(doubleSha256BE(req.rawTx)) === req.txid
}

async function completeLinkedRequest (
  task: WalletMonitorTask,
  req: EntityProvenTxReq,
  reqApi: TableProvenTxReq,
  log: string
): Promise<ProofRequestResult> {
  log += `Already linked to provenTxId ${req.provenTxId}.\n`
  req.notified = false
  req.status = 'completed'
  await req.updateStorageDynamicProperties(task.storage)
  return { log, proven: reqApi }
}

async function invalidateMalformedRequest (
  task: WalletMonitorTask,
  req: EntityProvenTxReq,
  reqApi: TableProvenTxReq,
  log: string
): Promise<ProofRequestResult> {
  log += " rawTx doesn't hash to txid. status => invalid.\n"
  req.notified = false
  req.status = 'invalid'
  await req.updateStorageDynamicProperties(task.storage)
  return { log, invalid: reqApi }
}

async function applyProofTimeout (
  task: WalletMonitorTask,
  req: EntityProvenTxReq,
  reqApi: TableProvenTxReq,
  ignoreStatus: boolean,
  log: string
): Promise<ProofRequestResult | undefined> {
  const limit = task.monitor.chain === 'main'
    ? task.monitor.options.unprovenAttemptsLimitMain
    : task.monitor.options.unprovenAttemptsLimitTest
  if (ignoreStatus || req.attempts <= limit) return undefined

  const maxRebroadcast = task.monitor.options.maxRebroadcastAttempts ?? 0
  const wasBroadcast = req.wasBroadcast
  const timedOutAttempts = req.attempts
  const timeout = req.applyProofTimeout(maxRebroadcast)
  if (timeout.action === 'rebroadcast') {
    log += ` too many failed attempts ${timedOutAttempts}, resetting to unsent for rebroadcast (cycle ${timeout.rebroadcastAttempts})\n`
    await req.updateStorageDynamicProperties(task.storage)
    return { log }
  }

  log += wasBroadcast
    ? ` too many failed attempts ${timedOutAttempts} and rebroadcast limit ${maxRebroadcast} reached, marking invalid\n`
    : ` too many failed attempts ${timedOutAttempts} and tx was never broadcast, marking invalid\n`
  await req.updateStorageDynamicProperties(task.storage)
  return { log, invalid: reqApi }
}

async function applyProvenTransaction (
  task: WalletMonitorTask,
  req: EntityProvenTxReq,
  provenTx: EntityProvenTx
): Promise<void> {
  await req.updateStorageDynamicProperties(task.storage)
  await req.refreshFromStorage(task.storage)
  const { provenTxReqId, status, txid, attempts, history } = req.toApi()
  const { index, height, blockHash, merklePath, merkleRoot } = provenTx.toApi()
  const result = await task.storage.runAsStorageProvider(async provider => {
    return await provider.updateProvenTxReqWithNewProvenTx({
      provenTxReqId,
      status,
      txid,
      attempts,
      history,
      index,
      height,
      blockHash,
      merklePath,
      merkleRoot
    })
  })
  req.status = result.status
  req.apiHistory = result.history
  req.provenTxId = result.provenTxId
  if (result.notify != null) req.apiNotify = result.notify
  req.notified = result.notified ?? true

  task.monitor.callOnProvenTransaction({
    txid,
    txIndex: index,
    blockHeight: height,
    blockHash,
    merklePath,
    merkleRoot
  })
}

async function processProofRequest (
  task: WalletMonitorTask,
  reqApi: TableProvenTxReq,
  maxAcceptableHeight: number,
  indent: number,
  countsAsAttempt: boolean,
  ignoreStatus: boolean
): Promise<ProofRequestResult> {
  let log = `${' '.repeat(indent)}reqId ${reqApi.provenTxReqId} txid ${reqApi.txid}: `
  if (!requestIsReadyForProof(reqApi, ignoreStatus)) {
    return { log: `${log}status of '${reqApi.status}' is not ready to be proven.\n` }
  }

  const req = new EntityProvenTxReq(reqApi)
  if (req.provenTxId != null && Number.isInteger(req.provenTxId)) {
    return await completeLinkedRequest(task, req, reqApi, log)
  }

  log += '\n'
  if (!rawTransactionMatchesTxid(req)) {
    return await invalidateMalformedRequest(task, req, reqApi, log)
  }

  const timedOut = await applyProofTimeout(task, req, reqApi, ignoreStatus, log)
  if (timedOut != null) return timedOut

  const since = new Date()
  const merklePathResult: GetMerklePathResult =
    await task.monitor.services.getMerklePath(req.txid)
  if (
    merklePathResult.header != null &&
    merklePathResult.header.height > maxAcceptableHeight
  ) {
    log += ` ignoring possible proof from very new block at height ${merklePathResult.header.height} ${merklePathResult.header.hash}\n`
    return { log }
  }

  const provenTx = await EntityProvenTx.fromReq(
    req,
    merklePathResult,
    countsAsAttempt && req.status !== 'nosend',
    task.monitor.options.maxRebroadcastAttempts ?? 0
  )
  if (provenTx != null) {
    await applyProvenTransaction(task, req, provenTx)
  } else if (countsAsAttempt && ['callback', 'unmined', 'unknown', 'unconfirmed', 'sending'].includes(req.status)) {
    req.attempts++
  }
  await req.updateStorageDynamicProperties(task.storage)
  await req.refreshFromStorage(task.storage)
  log += req.historyPretty(since, indent + 2) + '\n'
  return {
    log,
    ...(req.status === 'completed' ? { proven: req.api } : {}),
    ...(req.status === 'invalid' ? { invalid: req.api } : {})
  }
}

/**
 * Process an array of table.ProvenTxReq (typically with status 'unmined' or 'unknown')
 *
 * If req is invalid, set status 'invalid'
 *
 * Verify the requests are valid, lookup proofs or updated transaction status using the array of getProofServices,
 *
 * When proofs are found, create new ProvenTxApi records and transition the requests' status to 'unconfirmed' or 'notifying',
 * depending on chaintracks succeeding on proof verification.
 *
 * Increments attempts if proofs where requested.
 *
 * @param reqs
 * @returns reqs partitioned by status
 */
export async function getProofs(
  task: WalletMonitorTask,
  reqs: TableProvenTxReq[],
  maxAcceptableHeight: number,
  indent = 0,
  countsAsAttempt = false,
  ignoreStatus = false
): Promise<{
  proven: TableProvenTxReq[]
  invalid: TableProvenTxReq[]
  log: string
}> {
  const proven: TableProvenTxReq[] = []
  const invalid: TableProvenTxReq[] = []

  let log = ''
  for (const reqApi of reqs) {
    const result = await processProofRequest(
      task,
      reqApi,
      maxAcceptableHeight,
      indent,
      countsAsAttempt,
      ignoreStatus
    )
    log += result.log
    if (result.proven != null) proven.push(result.proven)
    if (result.invalid != null) invalid.push(result.invalid)
  }

  return { proven, invalid, log }
}
