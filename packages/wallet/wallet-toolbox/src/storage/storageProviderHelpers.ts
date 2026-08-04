import { Beef, Transaction } from '@bsv/sdk'
import { TableProvenTxReq } from './schema/tables/TableProvenTxReq'
import { TrxToken } from '../sdk/WalletStorage.interfaces'
import { WERR_INTERNAL } from '../sdk/WERR_errors'
import { WalletError } from '../sdk/WalletError'
import { GetReqsAndBeefDetail } from './methods/processAction'
import { ReqHistoryNote } from '../sdk/types'

// ---------------------------------------------------------------------------
// getReqsAndBeefToShareWithWorld helpers
// ---------------------------------------------------------------------------

const alreadySentStatuses = new Set(['unmined', 'callback', 'unconfirmed', 'completed'])
const readyToSendStatuses = new Set(['sending', 'unsent', 'nosend', 'unprocessed'])
const errorStatuses = new Set(['unknown', 'nonfinal', 'invalid', 'doubleSpend'])

/**
 * Classify a ProvenTxReq status into beef-sharing lifecycle status.
 * Mutates `d` in place.
 */
export function classifyReqStatus (d: GetReqsAndBeefDetail, req: TableProvenTxReq): void {
  if (errorStatuses.has(req.status)) {
    d.status = 'error'
    d.error = `ERR_INVALID_PARAMETER: ${d.txid} is not ready to send.`
  } else if (alreadySentStatuses.has(req.status)) {
    d.status = 'alreadySent'
  } else if (readyToSendStatuses.has(req.status)) {
    if ((req.rawTx == null) || req.inputBEEF == null) {
      d.status = 'error'
      d.error = `ERR_INTERNAL: ${d.txid} req is missing rawTx or beef.`
    } else {
      d.status = 'readyToSend'
    }
  } else {
    d.status = 'error'
    d.error = `ERR_INTERNAL: ${d.txid} has unexpected req status ${req.status}`
  }
}

// ---------------------------------------------------------------------------
// Beef input-merge helpers (used by mergeReqToBeefToShareExternally and getValidBeefForTxid)
// ---------------------------------------------------------------------------

/**
 * For each input of `rawTx`, ensure the source txid is represented in `beef`.
 *
 * When `requiredLevels` is undefined/0 and `knownTxids` contains the source txid,
 * a txid-only stub is merged rather than recursing into storage.
 */
export async function mergeInputBeefs (
  rawTx: number[],
  beef: Beef,
  trustSelf: 'known' | undefined,
  knownTxids: string[] | undefined,
  trx: TrxToken | undefined,
  requiredLevels: number | undefined,
  getValidBeef: (
    txid: string,
    beef: Beef,
    trustSelf: 'known' | undefined,
    knownTxids: string[] | undefined,
    trx: TrxToken | undefined,
    requiredLevels: number | undefined
  ) => Promise<unknown>
): Promise<void> {
  const tx = Transaction.fromBinary(rawTx)
  for (const input of tx.inputs) {
    const sourceTXID = input.sourceTXID ?? ''
    if (sourceTXID === '') throw new WERR_INTERNAL('req all transaction inputs must have valid sourceTXID')
    const existing = beef.findTxid(sourceTXID)
    const callerKnows = (requiredLevels == null || requiredLevels === 0) &&
      (knownTxids?.includes(sourceTXID) === true)
    // Stored input BEEFs can contain txid-only placeholders supplied by a
    // different client. They are not proof for the current caller unless that
    // caller also declared the txid known (or explicitly trusts this storage).
    if (existing != null && (!existing.isTxidOnly || callerKnows || trustSelf === 'known')) continue
    if (callerKnows) {
      beef.mergeTxidOnly(sourceTXID)
    } else {
      await getValidBeef(sourceTXID, beef, trustSelf, knownTxids, trx, requiredLevels)
    }
  }
}

/**
 * Convenience wrapper for the external-sharing path where `trustSelf` and
 * `requiredLevels` are always absent.
 */
export async function mergeInputsIntoBeef (
  rawTx: number[],
  beef: Beef,
  knownTxids: string[],
  trx: TrxToken | undefined,
  getValidBeef: (txid: string, beef: Beef, trustSelf: undefined, knownTxids: string[], trx: TrxToken | undefined) => Promise<unknown>
): Promise<void> {
  await mergeInputBeefs(
    rawTx,
    beef,
    undefined,
    knownTxids,
    trx,
    undefined,
    async (txid, beef, _trustSelf, knownTxids, trx) =>
      await getValidBeef(txid, beef, undefined, knownTxids as string[], trx)
  )
}

// ---------------------------------------------------------------------------
// updateProvenTxReqWithNewProvenTx helpers
// ---------------------------------------------------------------------------

/**
 * Notify each transaction that a proof has been found.
 * Mutates `req` history notes in place.
 *
 * The `addNote` callback avoids coupling this helper to a specific entity type.
 * Returns false if any transaction update failed so callers can retain the
 * request for later status repair.
 */
export async function notifyTransactionsOfProof (
  ids: number[],
  provenTxId: number,
  addNote: (note: ReqHistoryNote) => void,
  updateTransaction: (id: number, update: { provenTxId: number, status: 'completed' }) => Promise<unknown>
): Promise<boolean> {
  let allUpdatesSucceeded = true
  for (const id of ids) {
    try {
      await updateTransaction(id, { provenTxId, status: 'completed' })
      addNote({ what: 'notifyTxOfProof', transactionId: id })
    } catch (error_: unknown) {
      allUpdatesSucceeded = false
      const { code, description } = WalletError.fromUnknown(error_)
      addNote({ what: 'notifyTxOfProofError', id, provenTxId, code, description })
    }
  }
  return allUpdatesSucceeded
}
