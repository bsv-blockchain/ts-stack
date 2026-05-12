import { buildActionRow, buildTransactionV7Row, buildTransactionV7RowFromLegacyTx } from './v7Backfill'
import {
  TableAction,
  TableProvenTx,
  TableProvenTxReq,
  TableTransaction,
  TableTransactionV7
} from './tables'

/**
 * Storage-agnostic driver used by the V7 backfill orchestrator.
 *
 * Implementations must be idempotent — calling each method twice with the same
 * input must not produce duplicate rows. The orchestrator is responsible for
 * iteration order and chunking; the driver only performs writes.
 */
export interface V7BackfillDriver {
  /** Stream legacy `proven_tx_reqs` rows joined with their `proven_txs` row when available. */
  streamLegacyReqs: () => AsyncIterable<{ req: TableProvenTxReq, proven?: TableProvenTx }>
  /** Stream legacy `transactions` rows ordered by transactionId ascending. */
  streamLegacyTransactions: () => AsyncIterable<TableTransaction>
  /**
   * Upsert a V7 `transactions` row by `txid`. Returns the resolved
   * `transactionId` (PK of `transactions_v7`).
   */
  upsertTransactionV7: (row: Omit<TableTransactionV7, 'transactionId'>) => Promise<number>
  /**
   * Upsert a V7 `actions` row by `(userId, transactionId)`. Returns the
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

export interface V7BackfillStats {
  reqsBackfilled: number
  legacyTxOnlyBackfilled: number
  actionsBackfilled: number
  labelMapsRepointed: number
}

/**
 * Orchestrates §3 Steps 2-5 of PROD_REQ_V7_TS.md.
 *
 * Strategy:
 *  1. Walk every `proven_tx_reqs` row (joined with its proof) and upsert a row
 *     in `transactions_v7`. Build a `txid -> transactionId` map.
 *  2. Walk every legacy `transactions` row.
 *     - If the row has a txid AND it is not in the map, upsert a tx-only V7
 *       row (locally-created actions that never reached the broadcast queue).
 *     - Compute the V7 `transactionId` for this legacy row. Rows without a
 *       txid (unsigned, unprocessed) are skipped — they have no canonical V7
 *       representation yet and are surfaced as gaps in the stats.
 *  3. Upsert an `actions` row per legacy `transactions` row that has a V7
 *     transactionId.
 *  4. Re-point `tx_labels_map.transactionId` from legacy PK to new `actionId`.
 *
 * The driver is invoked one row at a time so that the entire pass can run as
 * a single Knex transaction or a single IDB readwrite transaction without
 * holding the full row set in memory.
 */
export async function runV7Backfill (driver: V7BackfillDriver, now: Date = new Date()): Promise<V7BackfillStats> {
  const stats: V7BackfillStats = {
    reqsBackfilled: 0,
    legacyTxOnlyBackfilled: 0,
    actionsBackfilled: 0,
    labelMapsRepointed: 0
  }

  const txidToV7Id = new Map<string, number>()

  for await (const { req, proven } of driver.streamLegacyReqs()) {
    const v7Row = buildTransactionV7Row(req, proven, now)
    const id = await driver.upsertTransactionV7(v7Row)
    txidToV7Id.set(v7Row.txid, id)
    stats.reqsBackfilled += 1
  }

  for await (const legacy of driver.streamLegacyTransactions()) {
    let v7Id: number | undefined
    if (legacy.txid != null) {
      v7Id = txidToV7Id.get(legacy.txid)
      if (v7Id === undefined) {
        const v7Row = buildTransactionV7RowFromLegacyTx(legacy, now)
        if (v7Row !== undefined) {
          v7Id = await driver.upsertTransactionV7(v7Row)
          // Use v7Row.txid (not legacy.txid) as the map key so that empty-string
          // legacy txids each get a unique placeholder key and don't collide.
          txidToV7Id.set(v7Row.txid, v7Id)
          stats.legacyTxOnlyBackfilled += 1
        }
      }
    }
    if (v7Id === undefined) continue

    const actionRow = buildActionRow(legacy, v7Id, now)
    const actionId = await driver.upsertAction(actionRow)
    stats.actionsBackfilled += 1

    await driver.repointTxLabelMap(legacy.transactionId, actionId)
    stats.labelMapsRepointed += 1
  }

  return stats
}
