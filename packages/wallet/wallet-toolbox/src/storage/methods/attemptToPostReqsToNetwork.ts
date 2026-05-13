import { Beef, Transaction, WalletLoggerInterface } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities'
import * as sdk from '../../sdk'
import { ReqHistoryNote } from '../../sdk'
import { wait } from '../../utility/utilityHelpers'
import { TransactionService } from '../schema/transactionService'

// ---------------------------------------------------------------------------
// new-schema wiring helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the new-schema `transactionId` for a given txid.
 *
 * Returns `undefined` when:
 *  - `service` is undefined (pre-cutover / IDB path)
 *  - The txid is not yet in the new `transactions` table (bridge period)
 *  - Any unexpected error (we swallow and return undefined to avoid
 *    disrupting the legacy broadcast path)
 */
async function resolveTransactionId (
  service: TransactionService | undefined,
  txid: string
): Promise<number | undefined> {
  if (service == null) return undefined
  try {
    const row = await service.findByTxid(txid)
    return row?.transactionId
  } catch {
    return undefined
  }
}

/**
 * Map the aggregate broadcast outcome to the new-schema `ProcessingStatus` to record.
 *
 * Mapping:
 *  success   → 'sent'       (broadcast accepted; waiting for on-chain proof)
 *  doubleSpend → 'doubleSpend' (terminal)
 *  invalidTx → 'invalid'    (terminal)
 *  serviceError → 'sending' (retry; attempts counter also incremented)
 */
function aggregateStatusToProcessing (
  status: AggregateStatus
): sdk.ProcessingStatus {
  switch (status) {
    case 'success': return 'sent'
    case 'doubleSpend': return 'doubleSpend'
    case 'invalidTx': return 'invalid'
    case 'serviceError': return 'sending'
  }
}

/**
 * Attempt to post one or more `ProvenTxReq` with status 'unsent'
 * to the bitcoin network.
 *
 * @param reqs
 */
export async function attemptToPostReqsToNetwork (
  storage: StorageProvider,
  reqs: EntityProvenTxReq[],
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface
): Promise<PostReqsToNetworkResult> {
  // initialize results, validate reqs ready to post, txids are of the transactions in the beef that we care about.

  const { r, vreqs, txids } = await validateReqsAndMergeBeefs(storage, reqs, trx)
  logger?.log('validated request and merged beefs')

  const services = storage.getServices()

  const pbrs = await services.postBeef(r.beef, txids, logger)

  // post beef results (pbrs) is an array by service provider
  // for each service provider, there's an aggregate result and individual results by txid.

  await transferNotesToReqHistories(txids, vreqs, pbrs, storage, trx)

  const apbrs = aggregatePostBeefResultsByTxid(txids, vreqs, pbrs)

  await updateReqsFromAggregateResults(txids, r, apbrs, storage, services, trx, logger)

  return r
}

async function validateReqsAndMergeBeefs (
  storage: StorageProvider,
  reqs: EntityProvenTxReq[],
  trx?: sdk.TrxToken
): Promise<{ r: PostReqsToNetworkResult, vreqs: PostReqsToNetworkDetails[], txids: string[] }> {
  const r: PostReqsToNetworkResult = {
    status: 'success',
    beef: new Beef(),
    details: [],
    log: ''
  }

  const vreqs: PostReqsToNetworkDetails[] = []

  // the transaction service — undefined on pre-cutover / IDB paths; all transaction-service calls are gated.
  const txSvc = storage.getTransactionService()

  for (const req of reqs) {
    // Resolve the new transactionId for this req (by txid). Cached per req so
    // subsequent transaction-service calls within the same loop body reuse it.
    const newTxId = await resolveTransactionId(txSvc, req.txid)

    try {
      const noRawTx = !req.rawTx
      const noTxIds = (req.notify.transactionIds == null) || req.notify.transactionIds.length < 1
      const noInputBEEF = req.inputBEEF == null
      if (noRawTx || noTxIds || noInputBEEF) {
        // This should have happened earlier...
        const note = { when: new Date().toISOString(), what: 'validateReqFailed', noRawTx, noTxIds, noInputBEEF }
        req.addHistoryNote(note)
        req.status = 'invalid'
        await req.updateStorageDynamicProperties(storage, trx)
        r.details.push({ txid: req.txid, req, status: 'invalid' })

        // new-schema additive: record history note + transition to invalid
        if (newTxId != null) {
          await txSvc!.recordHistoryNote(newTxId, note)
          await txSvc!.recordBroadcastResult({
            transactionId: newTxId,
            txid: req.txid,
            status: 'invalid',
            provider: 'validateReqsAndMergeBeefs',
            details: { reason: 'validateReqFailed' }
          })
        }
      } else {
        const vreq: PostReqsToNetworkDetails = { txid: req.txid, req, status: 'unknown' }
        await storage.mergeReqToBeefToShareExternally(req.api, r.beef, [], trx)

        // new-schema additive: also merge raw tx / proof bytes from new transactions table into the
        // shared beef so post-cutover callers get the same merged payload.
        if (newTxId != null) {
          await txSvc!.mergeBeefForTxids(r.beef, [req.txid])
        }

        vreqs.push(vreq)
        r.details.push(vreq)
      }
    } catch (error_: unknown) {
      const { code, message } = sdk.WalletError.fromUnknown(error_)
      const errNote = { when: new Date().toISOString(), what: 'validateReqError', txid: req.txid, code, message }
      req.addHistoryNote(errNote)
      req.attempts++
      if (req.attempts > 6 || message.startsWith('The txid parameter must be known to storage')) {
        req.status = 'invalid'
        r.details.push({ txid: req.txid, req, status: 'invalid' })
      }
      await req.updateStorageDynamicProperties(storage, trx)

      // new-schema additive: record history note + increment attempts
      if (newTxId != null) {
        await txSvc!.recordHistoryNote(newTxId, errNote)
        await txSvc!.incrementAttempts(newTxId)
      }
    }
  }
  return { r, vreqs, txids: vreqs.map(r => r.txid) }
}

async function transferNotesToReqHistories (
  txids: string[],
  vreqs: PostReqsToNetworkDetails[],
  pbrs: sdk.PostBeefResult[],
  storage: StorageProvider,
  trx?: sdk.TrxToken
): Promise<void> {
  // the transaction service — gated; undefined means legacy-only path.
  const txSvc = storage.getTransactionService()

  for (const txid of txids) {
    const vreq = vreqs.find(r => r.txid === txid)
    if (vreq == null) throw new sdk.WERR_INTERNAL()

    // Resolve new transactionId once per txid (cheap SELECT by txid).
    const newTxId = await resolveTransactionId(txSvc, txid)

    const notes: sdk.ReqHistoryNote[] = []
    for (const pbr of pbrs) {
      notes.push(...(pbr.notes || []))
      const r = pbr.txidResults.find(tr => tr.txid === txid)
      if (r != null) notes.push(...(r.notes || []))
    }
    for (const n of notes) {
      vreq.req.addHistoryNote(n)

      // new-schema additive: mirror each provider note into tx_audit.
      if (newTxId != null) {
        await txSvc!.recordHistoryNote(newTxId, n as { what: string, [k: string]: unknown })
      }
    }
    await vreq.req.updateStorageDynamicProperties(storage, trx)
  }
}

function tallyTxidResults (
  ar: AggregatePostBeefTxResult,
  pbrs: sdk.PostBeefResult[]
): void {
  for (const pbr of pbrs) {
    const tr = pbr.txidResults.find(tr => tr.txid === ar.txid)
    if (tr == null) continue
    ar.txidResults.push(tr)
    if (tr.status === 'success') {
      ar.successCount++
    } else if (tr.doubleSpend) {
      ar.doubleSpendCount++
      if (tr.competingTxs != null) ar.competingTxs = [...tr.competingTxs]
    } else if (tr.serviceError) {
      ar.serviceErrorCount++
    } else {
      ar.statusErrorCount++
    }
  }
  if (ar.competingTxs.length > 1) ar.competingTxs = [...new Set(ar.competingTxs)]
}

/**
 * For each txid, decide on the aggregate success or failure of attempting to broadcast it to the bitcoin processing network.
 *
 * Possible results:
 * 1. Success: At least one success, no double spends.
 * 2. DoubleSpend: One or more double spends.
 * 3. InvalidTransaction: No success, no double spend, one or more non-exception errors.
 * 4. Service Failure: No results or all results are exception errors.
 *
 * @param txids
 * @param reqs
 * @param pbrs
 * @param storage
 * @returns
 */
function aggregatePostBeefResultsByTxid (
  txids: string[],
  vreqs: PostReqsToNetworkDetails[],
  pbrs: sdk.PostBeefResult[]
): Record<string, AggregatePostBeefTxResult> {
  const r: Record<string, AggregatePostBeefTxResult> = {}

  for (const txid of txids) {
    const vreq = vreqs.find(r => r.txid === txid)!
    const ar: AggregatePostBeefTxResult = {
      txid,
      vreq,
      txidResults: [],
      status: 'success',
      successCount: 0,
      doubleSpendCount: 0,
      statusErrorCount: 0,
      serviceErrorCount: 0,
      competingTxs: []
    }
    r[txid] = ar
    tallyTxidResults(ar, pbrs)

    if (ar.successCount > 0 && ar.doubleSpendCount === 0) ar.status = 'success'
    else if (ar.doubleSpendCount > 0) ar.status = 'doubleSpend'
    else if (ar.statusErrorCount > 0) ar.status = 'invalidTx'
    else ar.status = 'serviceError'
  }

  return r
}

/**
 * For each txid in submitted `txids`:
 *
 *   Based on its aggregate status, and whether broadcast happening in background (isDelayed) or immediately (!isDelayed),
 *   and iff current req.status is not 'unproven' or 'completed':
 *
 *     'success':
 *       req.status => 'unmined', tx.status => 'unproven'
 *     'doubleSpend':
 *       req.status => 'doubleSpend', tx.status => 'failed'
 *     'invalidTx':
 *       req.status => 'invalid', tx.status => 'failed'
 *     'serviceError':
 *       increment req.attempts
 *
 * @param txids
 * @param apbrs
 * @param storage
 * @param services if valid, doubleSpend results will be verified (but only if not within a trx. e.g. trx must be undefined)
 * @param trx
 */
export async function updateReqsFromAggregateResults (
  txids: string[],
  r: PostReqsToNetworkResult,
  apbrs: Record<string, AggregatePostBeefTxResult>,
  storage: StorageProvider,
  services?: sdk.WalletServices,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface
): Promise<void> {
  logger?.group('update storage from aggregate results')

  // the transaction service — undefined on pre-cutover / IDB paths; all transaction-service calls are gated.
  const txSvc = storage.getTransactionService()

  for (const txid of txids) {
    const ar = apbrs[txid]
    const req = ar.vreq.req
    await req.refreshFromStorage(storage, trx)

    // Resolve new transactionId once per txid for this iteration.
    const newTxId = await resolveTransactionId(txSvc, txid)

    const { successCount, doubleSpendCount, statusErrorCount, serviceErrorCount } = ar
    const note: ReqHistoryNote = {
      when: new Date().toISOString(),
      what: 'aggregateResults',
      reqStatus: req.status,
      aggStatus: ar.status,
      attempts: req.attempts,
      successCount,
      doubleSpendCount,
      statusErrorCount,
      serviceErrorCount
    }

    if (['completed', 'unmined'].includes(req.status))
    // However it happened, don't degrade status if it is somehow already beyond broadcast stage
    { continue }

    if (ar.status === 'doubleSpend' && (services != null) && (trx == null)) await confirmDoubleSpend(ar, r.beef, storage, services, logger)

    let newReqStatus: sdk.ProvenTxReqStatus | undefined
    let newTxStatus: sdk.TransactionStatus | undefined
    switch (ar.status) {
      case 'success':
        newReqStatus = 'unmined'
        newTxStatus = 'unproven'
        // Mark as broadcast so proof-timeout resets to rebroadcast rather than invalid
        req.wasBroadcast = true
        break
      case 'doubleSpend':
        newReqStatus = 'doubleSpend'
        newTxStatus = 'failed'
        break
      case 'invalidTx':
        newReqStatus = 'invalid'
        newTxStatus = 'failed'
        break
      case 'serviceError':
        newReqStatus = 'sending'
        newTxStatus = 'sending'
        req.attempts++
        break
      default:
        throw new sdk.WERR_INTERNAL(`unimplemented AggregateStatus ${ar.status}`)
    }

    note.newReqStatus = newReqStatus
    note.newTxStatus = newTxStatus
    note.newAttempts = req.attempts

    if (newReqStatus) req.status = newReqStatus

    req.addHistoryNote(note)
    await req.updateStorageDynamicProperties(storage, trx)

    // new-schema additive: record aggregateResults history note, then record the
    // broadcast outcome (transitions processing state + sets wasBroadcast).
    if (newTxId != null) {
      await txSvc!.recordHistoryNote(newTxId, note as { what: string, [k: string]: unknown })

      const processingStatus = aggregateStatusToProcessing(ar.status)
      if (ar.status === 'serviceError') {
        // serviceError: increment attempts in new-schema and leave processing in 'sending'.
        await txSvc!.incrementAttempts(newTxId)
      } else {
        // success / doubleSpend / invalidTx: record broadcast result with final status.
        await txSvc!.recordBroadcastResult({
          transactionId: newTxId,
          txid,
          status: processingStatus,
          provider: 'aggregatePostBeef',
          wasBroadcast: ar.status === 'success',
          details: {
            aggStatus: ar.status,
            successCount,
            doubleSpendCount,
            statusErrorCount,
            serviceErrorCount
          }
        })
      }
    }

    if (newTxStatus) {
      const ids = req.notify.transactionIds
      if (ids != null) {
        // Also set generated outputs to spendable false and consumed input outputs to spendable true (and clears their spentBy).
        await storage.updateTransactionsStatus(ids, newTxStatus, trx)
      }
    }

    // For ANY failed-broadcast result (doubleSpend, invalidTx,
    // serviceError-resolved-to-failure), override the optimistic
    // "restore inputs spendable" behavior of updateTransactionStatus
    // for inputs that on-chain state confirms are actually spent.
    // Without this, the wallet picks the same stale UTXO on the next
    // createAction — an infinite missing-inputs loop. Apps cannot
    // self-heal because the default basket is admin-only on
    // app-isolated wallets (e.g. metanet-desktop).
    //
    // Why broaden beyond doubleSpend (Codex review 51331f6e035a7ed0):
    // different broadcasters classify the same on-chain reality
    // differently. ARC reports SEEN_IN_ORPHAN_MEMPOOL → doubleSpend.
    // WoC + Bitails report 'Missing inputs' / 'missing-inputs' →
    // invalidTx. Both mean the same root cause (referenced UTXO is
    // gone). The helper is conservatively opt-in on positive
    // isUtxo===false evidence: malformed/fee/script failures whose
    // inputs are still UTXOs are LEFT spendable=true, preserving
    // the existing transient-retry semantics. So broadening is safe.
    //
    // Gate: services available + not in a nested transaction (chain
    // queries are async I/O — same gate as confirmDoubleSpend).
    if (
      newTxStatus === 'failed' &&
      services != null &&
      trx == null
    ) {
      const stale = await markStaleInputsAsSpent(ar, storage, services, trx, logger)
      if (stale.checked > 0) {
        const staleNote = {
          when: new Date().toISOString(),
          what: 'markStaleInputsAsSpent',
          aggStatus: ar.status,
          checked: stale.checked,
          confirmed: stale.staleConfirmed,
          ...(stale.staleOutpoints.length > 0
            ? { outpoints: stale.staleOutpoints.join(',') }
            : {})
        }
        req.addHistoryNote(staleNote)
        await req.updateStorageDynamicProperties(storage, trx)

        // new-schema additive: mirror stale-inputs note into tx_audit.
        if (newTxId != null) {
          await txSvc!.recordHistoryNote(newTxId, staleNote)
        }
      }
    }

    // Transfer critical results to details going back to the user
    const details = r.details.find(d => d.txid === txid)!
    details.status = ar.status
    details.competingTxs = ar.competingTxs
    logger?.log(`updated ${txid}`)
  }
  logger?.group('update storage from aggregate results')
}

async function gatherCompetingTxids (
  ar: AggregatePostBeefTxResult,
  beef: Beef,
  services: sdk.WalletServices,
  note: ReqHistoryNote,
  logger?: WalletLoggerInterface
): Promise<void> {
  const req = ar.vreq.req
  const tx = Transaction.fromBinary(req.rawTx)
  const competingTxids = new Set(ar.competingTxs)
  for (const input of tx.inputs) {
    const sourceTx = beef.findTxid(input.sourceTXID!)?.tx
    if (sourceTx == null) {
      let s = note.missingSourceTx || ''
      s += input.sourceTXID! + ' '
      note.missingSourceTx = s
      continue
    }
    const lockingScript = sourceTx.outputs[input.sourceOutputIndex].lockingScript.toHex()
    const hash = services.hashOutputScript(lockingScript)
    const shhrs = await services.getScriptHashHistory(hash, undefined, logger)
    if (shhrs.status === 'success') {
      for (const h of shhrs.history) {
        // Neither the source of the input nor the current transaction are competition.
        if (h.txid !== input.sourceTXID && h.txid !== ar.txid) competingTxids.add(h.txid)
      }
    }
  }
  ar.competingTxs = [...competingTxids].slice(-24) // keep at most 24, if they were sorted by time, keep newest
  note.competingTxs = ar.competingTxs.join(',')
}

/**
 * Requires ar.status === 'doubleSpend'
 *
 * Parse the rawTx and review each input as a possible double spend.
 *
 * If all inputs appear to be unspent, update aggregate status to 'success' if successCount > 0, otherwise 'serviceError'.
 *
 * @param ar
 * @param storage
 * @param services
 */
async function confirmDoubleSpend (
  ar: AggregatePostBeefTxResult,
  beef: Beef,
  storage: StorageProvider,
  services: sdk.WalletServices,
  logger?: WalletLoggerInterface
): Promise<void> {
  const req = ar.vreq.req
  const note: ReqHistoryNote = { when: new Date().toISOString(), what: 'confirmDoubleSpend' }

  let known = false

  for (let retry = 0; retry < 3; retry++) {
    const gsr = await services.getStatusForTxids([req.txid])
    const errCode = gsr.error != null ? gsr.error.code : ''
    note[`getStatus${retry}`] = `${gsr.status}${errCode},${gsr.results[0]?.status}`
    if (gsr.status !== 'success' || gsr.results[0].status === 'unknown') {
      await wait(1000)
    } else {
      known = true
      break
    }
  }

  if (known) {
    // doubleSpend -> success
    ar.status = 'success'
    note.newStatus = ar.status
  } else {
    // Confirmed double spend, get txids of possible competing transactions.
    await gatherCompetingTxids(ar, beef, services, note, logger)
  }
  req.addHistoryNote(note)
}

/**
 * After any failed broadcast (doubleSpend, invalidTx, etc.), query each
 * consumed-input outpoint of the failed transaction against on-chain
 * UTXO state. For inputs the chain authoritatively confirms are spent
 * (i.e. NOT a UTXO), update the corresponding wallet basket entry to
 * spendable=false.
 *
 * Background: `updateTransactionStatus(failed)` optimistically restores
 * all consumed-input outputs to spendable=true so the user can retry
 * with the same inputs. For some failures (genuine doubleSpend, or any
 * 'missing-inputs' outcome where the input has been spent on chain by
 * a different transaction), restoration is incorrect — the input is
 * gone and restoring it produces an infinite missing-inputs loop on
 * the next createAction → broadcast cycle. Apps cannot evict from the
 * default basket on app-isolated wallets (admin-only policy), so this
 * self-heal must run inside the wallet.
 *
 * Different broadcasters classify the same on-chain reality differently
 * (ARC → doubleSpend, WhatsOnChain/Bitails → invalidTx via
 * 'missing-inputs'); this helper is broadcaster-agnostic because its
 * decision is based on services.isUtxo, not the aggregate failure
 * classification.
 *
 * Pre-broadcast races where concurrent createActions reach the same
 * UTXO across separate app processes are out of scope; see PR
 * description.
 *
 * Conservatively scoped:
 *   - Only inputs found in the failing user's basket are touched.
 *   - Inputs whose on-chain UTXO status cannot be determined (service
 *     error / inconclusive) are left spendable=true. Eviction is opt-in
 *     based on positive evidence of stale state.
 *   - Inputs the chain confirms are still UTXOs (e.g. a competing tx
 *     itself failed, or a malformed/fee failure where inputs are intact)
 *     are left spendable=true — preserving the existing transient-retry
 *     semantics callers depend on.
 *
 * Returns counts for instrumentation and the set of stale outpoints
 * that were actually evicted (added to history note for diagnostics).
 */
export async function markStaleInputsAsSpent (
  ar: AggregatePostBeefTxResult,
  storage: StorageProvider,
  services: sdk.WalletServices,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface
): Promise<{ checked: number; staleConfirmed: number; staleOutpoints: string[] }> {
  const result = { checked: 0, staleConfirmed: 0, staleOutpoints: [] as string[] }
  const req = ar.vreq.req

  // Resolve the user owning the failing tx so we only touch THIS user's
  // basket entries. Multiple txids share a userId; first is sufficient.
  const txIds = req.notify.transactionIds
  if (txIds == null || txIds.length === 0) return result
  const txRecord = (await storage.findTransactions({
    partial: { transactionId: txIds[0] },
    noRawTx: true,
    trx
  }))[0]
  if (txRecord == null) return result
  const userId = txRecord.userId

  // Walk the failed tx's inputs to find which user-owned UTXOs were
  // consumed and need on-chain verification.
  const tx = Transaction.fromBinary(req.rawTx)
  const outpoints = tx.inputs
    .map(i => ({ txid: i.sourceTXID ?? '', vout: i.sourceOutputIndex ?? 0 }))
    .filter(o => o.txid !== '')
  if (outpoints.length === 0) return result

  const byOutpoint = await storage.findOutputsByOutpoints(userId, outpoints, trx)

  // Two-phase processing:
  //   Phase 1 (parallel, read-only): validateOutputScript + services.isUtxo
  //     run concurrently across all outpoints. Both are network-bound on
  //     the slow path; serializing them produces O(N) wall-time for no
  //     correctness benefit. validateOutputScript only lazily fills the
  //     in-memory lockingScript from a known-valid tx (no shared state
  //     to race). services.isUtxo is provider HTTP — independent calls.
  //     Per-provider rate limiters that 429 some calls fall into the
  //     existing service-error branch and preserve retry semantics for
  //     those inputs; the surviving inputs still get correct treatment.
  //   Phase 2 (serial, in-trx writes): drain the per-input classification
  //     into result.checked / staleConfirmed accumulators and the
  //     storage.updateOutput writes, in iteration order. Storage writes
  //     stay serialized inside the trx — no change in transactional
  //     semantics from the pre-parallel version.
  type CheckResult =
    | { kind: 'skipped' }
    | { kind: 'service-error'; localOutput: typeof byOutpoint[keyof typeof byOutpoint] }
    | { kind: 'still-utxo'; localOutput: typeof byOutpoint[keyof typeof byOutpoint] }
    | {
        kind: 'stale'
        localOutput: typeof byOutpoint[keyof typeof byOutpoint]
        outpoint: { txid: string; vout: number }
      }

  const checks: CheckResult[] = await Promise.all(
    outpoints.map(async (outpoint): Promise<CheckResult> => {
      const localOutput = byOutpoint[`${outpoint.txid}.${outpoint.vout}`]
      if (localOutput == null) return { kind: 'skipped' }

      // services.isUtxo requires the lockingScript; load it lazily.
      if (localOutput.lockingScript == null) {
        try {
          await storage.validateOutputScript(localOutput, trx)
        } catch {
          return { kind: 'skipped' }
        }
      }

      let isStillUtxo: boolean
      try {
        isStillUtxo = await services.isUtxo(localOutput)
      } catch {
        // Service error — preserve current behavior (keep spendable=true).
        // Eviction requires positive evidence of stale state.
        return { kind: 'service-error', localOutput }
      }

      return isStillUtxo
        ? { kind: 'still-utxo', localOutput }
        : { kind: 'stale', localOutput, outpoint }
    })
  )

  for (const c of checks) {
    if (c.kind === 'skipped') continue
    result.checked++
    if (c.kind === 'stale') {
      // Authoritative on-chain evidence the input is spent. Override
      // the optimistic restore from updateTransactionStatus(failed).
      await storage.updateOutput(
        c.localOutput.outputId!,
        { spendable: false },
        trx
      )
      result.staleConfirmed++
      result.staleOutpoints.push(`${c.outpoint.txid}.${c.outpoint.vout}`)
    }
  }

  if (result.staleConfirmed > 0) {
    logger?.log(
      `markStaleInputsAsSpent: ${result.staleConfirmed} of ${result.checked} input(s) confirmed-spent on chain for txid=${req.txid}`
    )
  }
  return result
}

type AggregateStatus = 'success' | 'doubleSpend' | 'invalidTx' | 'serviceError'

export interface AggregatePostBeefTxResult {
  txid: string
  txidResults: sdk.PostTxResultForTxid[]
  status: AggregateStatus
  vreq: PostReqsToNetworkDetails
  successCount: number
  doubleSpendCount: number
  statusErrorCount: number
  serviceErrorCount: number
  /**
   * Any competing double spend txids reported for this txid
   */
  competingTxs: string[]
}

/**
 * Indicates status of a new Action following a `createAction` or `signAction` in immediate mode:
 * When `acceptDelayedBroadcast` is falses.
 *
 * 'success': The action has been broadcast and accepted by the bitcoin processing network.
 * 'doubleSpend': The action has been confirmed to double spend one or more inputs, and by the "first-seen-rule" is the losing transaction.
 * 'invalidTx': The action was rejected by the processing network as an invalid bitcoin transaction.
 * 'serviceError': The broadcast services are currently unable to reach the bitcoin network. The action is now queued for delayed retries.
 *
 * 'invalid': The action was in an invalid state for processing, this status should never be seen by user code.
 * 'unknown': An internal processing error has occured, this status should never be seen by user code.
 *
 */
export type PostReqsToNetworkDetailsStatus =
  | 'success'
  | 'doubleSpend'
  | 'unknown'
  | 'invalid'
  | 'serviceError'
  | 'invalidTx'

export interface PostReqsToNetworkDetails {
  txid: string
  req: EntityProvenTxReq
  status: PostReqsToNetworkDetailsStatus
  /**
   * Any competing double spend txids reported for this txid
   */
  competingTxs?: string[]
}

export interface PostReqsToNetworkResult {
  status: 'success' | 'error'
  beef: Beef
  details: PostReqsToNetworkDetails[]
  log: string
}
