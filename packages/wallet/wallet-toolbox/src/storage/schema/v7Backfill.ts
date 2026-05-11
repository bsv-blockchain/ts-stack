import * as sdk from '../../sdk'
import {
  TableAction,
  TableProvenTx,
  TableProvenTxReq,
  TableTransaction,
  TableTransactionV7
} from './tables'

/**
 * Pure transformation helpers for the V7 schema backfill.
 *
 * These functions are deliberately storage-agnostic — they accept the legacy
 * rows and return the new shapes. A storage driver (Knex or IDB) is responsible
 * for reading the source rows and inserting the returned objects.
 *
 * No row in this module ever talks to the database; this keeps the
 * transformation under unit-test control and lets us run dry-run migrations.
 */

/**
 * Merge a legacy `proven_tx_reqs` row together with an optional `proven_txs`
 * row into a single V7 `transactions` (transactions_v7) row.
 *
 * The proof fields come from `proven_txs` when present; otherwise they are
 * left undefined. Processing state is derived from the request's legacy status.
 */
export function buildTransactionV7Row (
  req: TableProvenTxReq,
  proven: TableProvenTx | undefined,
  now: Date = new Date()
): Omit<TableTransactionV7, 'transactionId'> {
  const processing = sdk.provenTxReqStatusToProcessing(req.status)
  return {
    created_at: req.created_at,
    updated_at: now,
    txid: req.txid,
    processing,
    processingChangedAt: req.updated_at ?? now,
    nextActionAt: undefined,
    attempts: req.attempts ?? 0,
    rebroadcastCycles: req.rebroadcastAttempts ?? 0,
    wasBroadcast: req.wasBroadcast === true,
    idempotencyKey: undefined,
    batch: req.batch,
    rawTx: req.rawTx,
    inputBeef: req.inputBEEF,
    height: proven?.height,
    merkleIndex: proven?.index,
    merklePath: proven?.merklePath,
    merkleRoot: proven?.merkleRoot,
    blockHash: proven?.blockHash,
    isCoinbase: false,
    lastProvider: undefined,
    lastProviderStatus: undefined,
    frozenReason: undefined,
    rowVersion: 0
  }
}

/**
 * Build a V7 `transactions` row from a legacy per-user `transactions` row when
 * no `proven_tx_reqs` entry exists (e.g. locally-created actions that never
 * reached the broadcast queue).
 *
 * Returns `undefined` when the legacy row has no txid — such rows belong to
 * incomplete actions and have no canonical V7 representation yet.
 */
export function buildTransactionV7RowFromLegacyTx (
  tx: TableTransaction,
  now: Date = new Date()
): Omit<TableTransactionV7, 'transactionId'> | undefined {
  if (tx.txid == null) return undefined
  return {
    created_at: tx.created_at,
    updated_at: now,
    txid: tx.txid,
    processing: sdk.transactionStatusToProcessing(tx.status),
    processingChangedAt: tx.updated_at ?? now,
    nextActionAt: undefined,
    attempts: 0,
    rebroadcastCycles: 0,
    wasBroadcast: false,
    idempotencyKey: undefined,
    batch: undefined,
    rawTx: tx.rawTx,
    inputBeef: tx.inputBEEF,
    height: undefined,
    merkleIndex: undefined,
    merklePath: undefined,
    merkleRoot: undefined,
    blockHash: undefined,
    isCoinbase: false,
    lastProvider: undefined,
    lastProviderStatus: undefined,
    frozenReason: undefined,
    rowVersion: 0
  }
}

/**
 * Build a V7 `actions` row from a legacy per-user `transactions` row.
 * The caller is responsible for resolving `transactionId` to the
 * newly-inserted `transactions_v7.transactionId`.
 */
export function buildActionRow (
  legacy: TableTransaction,
  v7TransactionId: number,
  now: Date = new Date()
): Omit<TableAction, 'actionId'> {
  return {
    created_at: legacy.created_at,
    updated_at: now,
    userId: legacy.userId,
    transactionId: v7TransactionId,
    reference: legacy.reference,
    description: legacy.description,
    isOutgoing: legacy.isOutgoing,
    satoshisDelta: legacy.satoshis ?? 0,
    userNosend: legacy.status === 'nosend',
    hidden: false,
    userAborted: legacy.status === 'failed',
    notifyJson: undefined,
    rowVersion: 0
  }
}
