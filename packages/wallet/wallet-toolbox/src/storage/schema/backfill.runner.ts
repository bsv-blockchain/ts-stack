import { buildActionRow, buildTransactionNewRow, buildTransactionNewRowFromLegacyTx } from './backfill'
import {
  TableAction,
  TableProvenTx,
  TableProvenTxReq,
  TableTransaction,
  TableTransactionNew
} from './tables'

/**
 * Storage-agnostic driver used by the the backfill orchestrator.
 *
 * Implementations must be idempotent — calling each method twice with the same
 * input must not produce duplicate rows. The orchestrator is responsible for
 * iteration order and chunking; the driver only performs writes.
 */
export interface BackfillDriver {
  /** Stream legacy `proven_tx_reqs` rows joined with their `proven_txs` row when available. */
  streamLegacyReqs: () => AsyncIterable<{ req: TableProvenTxReq, proven?: TableProvenTx }>
  /** Stream legacy `transactions` rows ordered by transactionId ascending. */
  streamLegacyTransactions: () => AsyncIterable<TableTransaction>
  /**
   * Upsert a new `transactions` row by `txid`. Returns the resolved
   * `transactionId` (PK of `transactions_new`).
   */
  upsertTransactionNew: (row: Omit<TableTransactionNew, 'transactionId'>) => Promise<number>
  /**
   * Upsert a new `actions` row by `(userId, transactionId)`. Returns the
   * resolved `actionId`.
   */
  upsertAction: (row: Omit<TableAction, 'actionId'>) => Promise<number>
  /**
   * Re-point a single legacy `tx_labels_map` row whose `transactionId` refers
   * to the old `transactions` PK so that it points to the new `actions.actionId`.
   *
   * Implementations may choose to rewrite the entire mapping in bulk and treat
   * this method as a no-op; the orchestrator will still call it once per pair.
   */
  repointTxLabelMap: (legacyTransactionId: number, actionId: number) => Promise<void>
}

export interface BackfillStats {
  reqsBackfilled: number
  legacyTxOnlyBackfilled: number
  actionsBackfilled: number
  labelMapsRepointed: number
}

/**
 * Orchestrates §3 Steps 2-5 of the spec (PROD_REQ_V7_TS.md).
 *
 * Strategy:
 *  1. Walk every `proven_tx_reqs` row (joined with its proof) and upsert a row
 *     in `transactions_new`. Build a `txid -> transactionId` map.
 *  2. Walk every legacy `transactions` row.
 *     - If the row has a txid AND it is not in the map, upsert a tx-only new-schema
 *       row (locally-created actions that never reached the broadcast queue).
 *     - Compute the new-schema `transactionId` for this legacy row. Rows without a
 *       txid (unsigned, unprocessed) are skipped — they have no canonical new-schema
 *       representation yet and are surfaced as gaps in the stats.
 *  3. Upsert an `actions` row per legacy `transactions` row that has a new-schema
 *     transactionId.
 *  4. Re-point `tx_labels_map.transactionId` from legacy PK to new `actionId`.
 *
 * The driver is invoked one row at a time so that the entire pass can run as
 * a single Knex transaction or a single IDB readwrite transaction without
 * holding the full row set in memory.
 */
export async function runBackfill (driver: BackfillDriver, now: Date = new Date()): Promise<BackfillStats> {
  const stats: BackfillStats = {
    reqsBackfilled: 0,
    legacyTxOnlyBackfilled: 0,
    actionsBackfilled: 0,
    labelMapsRepointed: 0
  }

  const txidToNewId = new Map<string, number>()

  for await (const { req, proven } of driver.streamLegacyReqs()) {
    const newRow = buildTransactionNewRow(req, proven, now)
    const id = await driver.upsertTransactionNew(newRow)
    txidToNewId.set(newRow.txid, id)
    stats.reqsBackfilled += 1
  }

  for await (const legacy of driver.streamLegacyTransactions()) {
    let newId: number | undefined
    if (legacy.txid != null) {
      newId = txidToNewId.get(legacy.txid)
      if (newId === undefined) {
        const newRow = buildTransactionNewRowFromLegacyTx(legacy, now)
        if (newRow !== undefined) {
          newId = await driver.upsertTransactionNew(newRow)
          // Use newRow.txid (not legacy.txid) as the map key so that empty-string
          // legacy txids each get a unique placeholder key and don't collide.
          txidToNewId.set(newRow.txid, newId)
          stats.legacyTxOnlyBackfilled += 1
        }
      }
    }
    if (newId === undefined) continue

    const actionRow = buildActionRow(legacy, newId, now)
    const actionId = await driver.upsertAction(actionRow)
    stats.actionsBackfilled += 1

    await driver.repointTxLabelMap(legacy.transactionId, actionId)
    stats.labelMapsRepointed += 1
  }

  return stats
}
