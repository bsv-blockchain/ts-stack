// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
  Beef,
  Transaction as BsvTransaction,
  SendWithResult,
  SendWithResultStatus,
  WalletLoggerInterface
} from '@bsv/sdk'
import { aggregateActionResults } from '../../utility/aggregateResults'
import { StorageProvider } from '../StorageProvider'
import {
  AuthId,
  ReviewActionResult,
  StorageProcessActionArgs,
  StorageProcessActionResults
} from '../../sdk/WalletStorage.interfaces'
import { stampLog } from '../../utility/stampLog'
import {
  randomBytesBase64,
  verifyId,
  verifyInteger,
  verifyOne,
  verifyOneOrNone,
  verifyTruthy
} from '../../utility/utilityHelpers'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { WERR_INTERNAL, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { TableProvenTxReq } from '../schema/tables/TableProvenTxReq'
import { TableProvenTx } from '../schema/tables/TableProvenTx'
import { ProvenTxReqStatus, TransactionStatus } from '../../sdk/types'
import { parseTxScriptOffsets, TxScriptOffsets } from '../../utility/parseTxScriptOffsets'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableCommission } from '../schema/tables/TableCommission'
import { asArray, asString } from '../../utility/utilityHelpers.noBuffer'

export async function processAction (
  storage: StorageProvider,
  auth: AuthId,
  args: StorageProcessActionArgs
): Promise<StorageProcessActionResults> {
  const logger = args.logger
  logger?.group('storage processAction')

  const userId = verifyId(auth.userId)
  const r: StorageProcessActionResults = {
    sendWithResults: undefined
  }

  let req: EntityProvenTxReq | undefined
  const txidsOfReqsToShareWithWorld: string[] = [...args.sendWith]

  if (args.isNewTx) {
    const vargs = await validateCommitNewTxToStorageArgs(storage, userId, args)
    logger?.log('validated new tx updates to storage')
    ;({ req } = await commitNewTxToStorage(storage, userId, vargs))
    logger?.log('committed new tx updates to storage ')
    if (!req) throw new WERR_INTERNAL()

    // new-schema additive wiring — Option B (defer to processAction).
    // Now that the real txid is known, create the new transactions row + actions
    // row and repoint any tx_labels_map rows from the legacy transactionId to
    // the new new actionId. Wrapped in try/catch so pre-cutover test databases
    // (which lack the new transactions tables) continue to pass without modification.
    // See docs/CREATEACTION_BLOCKERS.md §3 Option B.
    const txSvc = storage.getTransactionService()
    if (txSvc != null) {
      try {
        const processing = vargs.isNoSend ? 'nosend' as const : 'queued' as const
        const { action, transaction } = await txSvc.findOrCreateActionForTxid({
          userId,
          txid: vargs.txid,
          isOutgoing: vargs.transaction.isOutgoing,
          description: vargs.transaction.description ?? '',
          satoshisDelta: vargs.transaction.satoshis ?? 0,
          reference: vargs.reference,
          rawTx: vargs.rawTx,
          inputBeef: asArray(vargs.beef.toBinary()),
          processing
        })
        // v3: outputs are FK'd to actions.actionId directly at insert time;
        // no repoint needed. The action row exists (createAction inserted it
        // with txid=NULL); findOrCreateActionForTxid above UPSERTs the
        // canonical transactions row and ensures the per-user action row
        // points at the real txid.
        logger?.log(`v3 action wired: actionId=${action.actionId} txid=${transaction.txid}`)
      } catch (txErr: unknown) {
        // Tolerate pre-cutover databases where the new transactions tables may not yet exist.
        const msg = txErr instanceof Error ? txErr.message : String(txErr)
        if (
          msg.includes('no such table') ||
          msg.includes("Table") ||
          msg.includes('SQLITE_ERROR')
        ) {
          logger?.log(`new-schema wiring skipped (pre-cutover DB): ${msg}`)
        } else {
          throw txErr
        }
      }
    }

    // Add the new txid to sendWith unless there are no others to send and the noSend option is set.
    if (args.isNoSend && !args.isSendWith) {
      logger?.log(`noSend txid ${req.txid}`)
    } else {
      txidsOfReqsToShareWithWorld.push(req.txid)
      logger?.log(`sending txid ${req.txid}`)
    }
  }

  const { swr, ndr } = await shareReqsWithWorld(
    storage,
    userId,
    txidsOfReqsToShareWithWorld,
    args.isDelayed,
    undefined,
    logger
  )

  r.sendWithResults = swr
  r.notDelayedResults = ndr

  logger?.groupEnd()

  return r
}

export interface GetReqsAndBeefDetail {
  txid: string
  req?: TableProvenTxReq
  proven?: TableProvenTx
  status: 'readyToSend' | 'alreadySent' | 'error' | 'unknown'
  error?: string
}

export interface GetReqsAndBeefResult {
  beef: Beef
  details: GetReqsAndBeefDetail[]
}

export interface PostBeefResultForTxidApi {
  txid: string

  /**
   * 'success' - The transaction was accepted for processing
   */
  status: 'success' | 'error'

  /**
   * if true, the transaction was already known to this service. Usually treat as a success.
   *
   * Potentially stop posting to additional transaction processors.
   */
  alreadyKnown?: boolean

  blockHash?: string
  blockHeight?: number
  merklePath?: string
}

/**
 * Verifies that all the txids are known reqs with ready-to-share status.
 * Assigns a batch identifier and updates all the provenTxReqs.
 * If not isDelayed, triggers an initial attempt to broadcast the batch and returns the results.
 *
 * @param storage
 * @param userId
 * @param txids
 * @param isDelayed
 * @param r Optional. Ignores txids and allows ProvenTxReqs and merged beef to be passed in.
 */
function classifyReqDetails (
  details: GetReqsAndBeefDetail[],
  swr: SendWithResult[],
  readyToSendReqs: EntityProvenTxReq[]
): void {
  for (const getReq of details) {
    let status: SendWithResultStatus = 'failed'
    if (getReq.status === 'alreadySent') {
      status = 'unproven'
    } else if (getReq.status === 'readyToSend') {
      status = 'sending'
      readyToSendReqs.push(new EntityProvenTxReq(getReq.req))
    }
    swr.push({ txid: getReq.txid, status })
  }
}

async function verifyMergedBeef (
  storage: StorageProvider,
  r: GetReqsAndBeefResult,
  readyToSendReqs: EntityProvenTxReq[],
  logger?: WalletLoggerInterface
): Promise<void> {
  if (readyToSendReqs.length === 0) return
  const beefIsValid = await r.beef.verify(await storage.getServices().getChainTracker())
  if (!beefIsValid) {
    logger?.error(`VERIFY FALSE BEEF: ${r.beef.toLogString()}`)
    throw new WERR_INTERNAL('merged Beef failed validation.')
  }
  logger?.log('beef is valid')
}

export async function shareReqsWithWorld (
  storage: StorageProvider,
  userId: number,
  txids: string[],
  isDelayed: boolean,
  r?: GetReqsAndBeefResult,
  logger?: WalletLoggerInterface
): Promise<{ swr: SendWithResult[], ndr: ReviewActionResult[] | undefined }> {
  const swr: SendWithResult[] = []
  const ndr: ReviewActionResult[] | undefined = undefined

  if ((r == null) && txids.length < 1) return { swr, ndr }

  r ||= await storage.getReqsAndBeefToShareWithWorld(txids, [])

  const readyToSendReqs: EntityProvenTxReq[] = []
  classifyReqDetails(r.details, swr, readyToSendReqs)

  const readyToSendReqIds = readyToSendReqs.map(r => r.id)
  const transactionIds = readyToSendReqs.map(r => r.notify.transactionIds || []).flat()

  // If isDelayed, this (or a different beef) will have to be rebuilt at the time of sending.
  await verifyMergedBeef(storage, r, readyToSendReqs, logger)

  const batch = txids.length > 1 ? randomBytesBase64(16) : undefined
  if (isDelayed) {
    if (readyToSendReqIds.length > 0) {
      await storage.transaction(async trx => {
        await storage.updateProvenTxReq(readyToSendReqIds, { status: 'unsent', batch }, trx)
        // Post-cutover: notify.transactionIds are legacy IDs that live in
        // transactions_legacy. Use updateLegacyTransaction to target correct table.
        // Mapping §2: legacy `unprocessed` → `sending` transition.
        await storage.updateLegacyTransaction(transactionIds, { status: 'sending' }, trx)
      })
    }
    return { swr, ndr }
  }

  if (readyToSendReqIds.length < 1) return { swr, ndr }

  if (batch) {
    for (const req of readyToSendReqs) req.batch = batch
    await storage.updateProvenTxReq(readyToSendReqIds, { batch })
  }

  const prtn = await storage.attemptToPostReqsToNetwork(readyToSendReqs, undefined, logger)
  const { swr: swrRes, rar } = await aggregateActionResults(storage, swr, prtn)
  return { swr: swrRes, ndr: rar }
}

interface ReqTxStatus {
  req: ProvenTxReqStatus
  tx: TransactionStatus
}

function determineReqTxStatus (
  params: Pick<StorageProcessActionArgs, 'isNoSend' | 'isSendWith' | 'isDelayed'>
): { status: ReqTxStatus, postStatus: ReqTxStatus | undefined } {
  if (params.isNoSend && !params.isSendWith) return { status: { req: 'nosend', tx: 'nosend' }, postStatus: undefined }
  if (!params.isNoSend && params.isDelayed) return { status: { req: 'unsent', tx: 'unprocessed' }, postStatus: undefined }
  if (!params.isNoSend && !params.isDelayed) {
    return {
      status: { req: 'unprocessed', tx: 'unprocessed' },
      postStatus: { req: 'unmined', tx: 'unproven' }
    }
  }
  throw new WERR_INTERNAL('logic error')
}

function buildOutputUpdates (
  storage: StorageProvider,
  tx: BsvTransaction,
  vargs: ValidCommitNewTxToStorageArgs
): void {
  for (const o of vargs.outputOutputs) {
    const vout = verifyInteger(o.vout)
    const offset = vargs.txScriptOffsets.outputs[vout]
    const rawTxScript = asString(vargs.rawTx.slice(offset.offset, offset.offset + offset.length))
    if ((o.lockingScript != null) && rawTxScript !== asString(o.lockingScript)) {
      throw new WERR_INVALID_OPERATION(
        `rawTx output locking script for vout ${vout} not equal to expected output script.`
      )
    }
    if (tx.outputs[vout].lockingScript.toHex() !== rawTxScript) {
      throw new WERR_INVALID_OPERATION(
        `parsed transaction output locking script for vout ${vout} not equal to expected output script.`
      )
    }
    const update: Partial<TableOutput> = {
      txid: vargs.txid,
      spendable: true, // spendability is gated by transaction status. Remains true until the output is spent.
      scriptLength: offset.length,
      scriptOffset: offset.offset
    }
    if (offset.length > storage.getSettings().maxOutputScript)
    // Remove long lockingScript data from outputs table, will be read from rawTx in proven_tx or proven_tx_reqs tables.
    { update.lockingScript = undefined }
    vargs.outputUpdates.push({ id: o.outputId, update })
  }
}

interface ValidCommitNewTxToStorageArgs {
  // validated input args

  reference: string
  txid: string
  rawTx: number[]
  isNoSend: boolean
  isDelayed: boolean
  isSendWith: boolean
  log?: string

  // validated dependent args

  tx: BsvTransaction
  txScriptOffsets: TxScriptOffsets
  transactionId: number
  transaction: TableTransaction
  inputOutputs: TableOutput[]
  outputOutputs: TableOutput[]
  commission: TableCommission | undefined
  beef: Beef

  req: EntityProvenTxReq
  outputUpdates: Array<{ id: number, update: Partial<TableOutput> }>
  transactionUpdate: Partial<TableTransaction>
  postStatus?: ReqTxStatus
}

async function validateCommitNewTxToStorageArgs (
  storage: StorageProvider,
  userId: number,
  params: StorageProcessActionArgs
): Promise<ValidCommitNewTxToStorageArgs> {
  if (!params.reference || !params.txid || (params.rawTx == null)) { throw new WERR_INVALID_OPERATION('One or more expected params are undefined.') }
  let tx: BsvTransaction
  try {
    tx = BsvTransaction.fromBinary(params.rawTx)
  } catch (_parseError: unknown) {
    throw new WERR_INVALID_OPERATION('Parsing serialized transaction failed.')
  }
  if (params.txid !== tx.id('hex')) { throw new WERR_INVALID_OPERATION('Hash of serialized transaction doesn\'t match expected txid') }
  const services = storage.getServices()
  if (!(await services.nLockTimeIsFinal(tx))) {
    throw new WERR_INVALID_OPERATION(`This transaction is not final.
         Ensure that the transaction meets the rules for being a finalized
         which can be found at https://wiki.bitcoinsv.io/index.php/NLocktime_and_nSequence`)
  }
  const txScriptOffsets = parseTxScriptOffsets(params.rawTx)
  // Post-cutover: unsigned/unprocessed rows live in `transactions_legacy`, not
  // in new `transactions` (which has `processing` not `status` and requires a real
  // txid at insert time). Use findLegacyTransactions to target the correct table.
  // Pre-cutover: findLegacyTransactions falls back to findTransactions transparently.
  // Mapping §2: legacy `unsigned` → no equivalent in new schema; must query transactions_legacy.
  const transaction = verifyOne(
    await storage.findLegacyTransactions({
      partial: { userId, reference: params.reference }
    })
  )
  if (!transaction.isOutgoing) throw new WERR_INVALID_OPERATION('isOutgoing is not true')
  if (transaction.inputBEEF == null) throw new WERR_INVALID_OPERATION()
  const beef = Beef.fromBinary(asArray(transaction.inputBEEF))
  // Could check beef validates transaction inputs...
  // Transaction must have unsigned or unprocessed status
  if (transaction.status !== 'unsigned' && transaction.status !== 'unprocessed') { throw new WERR_INVALID_OPERATION(`invalid transaction status ${transaction.status}`) }
  const transactionId = verifyId(transaction.transactionId)
  const outputOutputs = await storage.findOutputs({
    partial: { userId, transactionId }
  })
  const inputOutputs = await storage.findOutputs({
    partial: { userId, spentBy: transactionId }
  })

  const commission = verifyOneOrNone(await storage.findCommissions({ partial: { transactionId, userId } }))
  if (storage.commissionSatoshis > 0) {
    // A commission is required...
    if (commission == null) throw new WERR_INTERNAL()
    const commissionValid = tx.outputs.some(
      x => x.satoshis === commission.satoshis && x.lockingScript.toHex() === asString(commission.lockingScript)
    )
    if (!commissionValid) { throw new WERR_INVALID_OPERATION('Transaction did not include an output to cover service fee.') }
  }

  const req = EntityProvenTxReq.fromTxid(params.txid, params.rawTx, transaction.inputBEEF)
  req.addNotifyTransactionId(transactionId)

  // "Processing" a transaction is the final step of creating a new one.
  // If it is to be sent to the network directly (prior to return from processAction),
  // then there is status pre-send and post-send.
  // Otherwise there is no post-send status.
  // Note that isSendWith trumps isNoSend, e.g. isNoSend && !isSendWith
  //
  // Determine what status the req and transaction should have pre- at the end of processing.
  //                           Pre-Status (to newReq/newTx)     Post-Status (to all sent reqs/txs)
  //                           req         tx                   req                 tx
  // isNoSend                  noSend      noSend
  // !isNoSend && isDelayed    unsent      unprocessed
  // !isNoSend && !isDelayed   unprocessed unprocessed          sending/unmined     sending/unproven      This is the only case that sends immediately.
  const { status, postStatus } = determineReqTxStatus(params)

  req.status = status.req
  const vargs: ValidCommitNewTxToStorageArgs = {
    reference: params.reference,
    txid: params.txid,
    rawTx: params.rawTx,
    isSendWith: !!params.sendWith && params.sendWith.length > 0,
    isDelayed: params.isDelayed,
    isNoSend: params.isNoSend,
    // Properties with values added during validation.
    tx,
    txScriptOffsets,
    transactionId,
    transaction,
    inputOutputs,
    outputOutputs,
    commission,
    beef,
    req,
    outputUpdates: [],
    // update txid, status in transactions table and drop rawTransaction value
    transactionUpdate: {
      txid: params.txid,
      rawTx: undefined,
      inputBEEF: undefined,
      status: status.tx
    },
    postStatus
  }

  // update outputs with txid, script offsets and lengths, drop long output scripts from outputs table
  // outputs spendable will be updated for change to true and all others to !!o.tracked when tx has been broadcast
  // MAX_OUTPUTSCRIPT_LENGTH is limit for scripts left in outputs table
  buildOutputUpdates(storage, tx, vargs)

  return vargs
}

export interface CommitNewTxResults {
  req: EntityProvenTxReq
  log?: string
}

async function commitNewTxToStorage (
  storage: StorageProvider,
  userId: number,
  vargs: ValidCommitNewTxToStorageArgs
): Promise<CommitNewTxResults> {
  let log = vargs.log

  log = stampLog(log, 'start storage commitNewTxToStorage')

  let req: EntityProvenTxReq | undefined

  // Post-cutover SQLite: `proven_tx_reqs_legacy` has a FK to `proven_txs`
  // (renamed to `proven_txs_legacy` after cutover). PRAGMA changes inside SQLite
  // transactions are no-ops, so we must disable FK before opening the transaction.
  // Pre-cutover or non-SQLite: disableForeignKeys() is a no-op.
  await storage.disableForeignKeys()
  try {
  await storage.transaction(async trx => {
    log = stampLog(log, '... storage commitNewTxToStorage storage transaction start')

    // Create initial 'nosend' proven_tx_req record to store signed, valid rawTx and input beef
    req = await vargs.req.insertOrMerge(storage, trx)

    log = stampLog(log, '... storage commitNewTxToStorage req inserted')

    // Batch the N output updates into a single CASE-WHEN UPDATE when the
    // underlying storage exposes bulkUpdateOutputs (StorageKnex). Fall back to
    // per-row updates otherwise.
    type MaybeBulk = { bulkUpdateOutputs?: (us: Array<{ id: number, update: Partial<TableOutput> }>, trx?: unknown) => Promise<number> }
    const bulk = (storage as unknown as MaybeBulk).bulkUpdateOutputs
    if (typeof bulk === 'function') {
      await bulk.call(storage, vargs.outputUpdates, trx)
    } else {
      for (const ou of vargs.outputUpdates) {
        await storage.updateOutput(ou.id, ou.update, trx)
      }
    }

    log = stampLog(log, '... storage commitNewTxToStorage outputs updated')

    // Post-cutover: the unsigned transaction row lives in `transactions_legacy`.
    // Use updateLegacyTransaction so the txid + status write-back goes to the
    // correct table. Pre-cutover: falls back to updateTransaction transparently.
    // Mapping §2: legacy `unsigned` → `unprocessed`/`nosend` write-back must
    // target `transactions_legacy` post-cutover, not new `transactions`.
    await storage.updateLegacyTransaction(vargs.transactionId, vargs.transactionUpdate, trx)

    log = stampLog(log, '... storage commitNewTxToStorage storage transaction end')
  })
  } finally {
    await storage.enableForeignKeys()
  }

  log = stampLog(log, '... storage commitNewTxToStorage storage transaction await done')

  const r: CommitNewTxResults = {
    req: verifyTruthy(req),
    log
  }

  log = stampLog(log, 'end storage commitNewTxToStorage')

  return r
}
