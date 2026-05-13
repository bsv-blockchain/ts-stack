import { Knex } from 'knex'

/**
 * §4 spendability backfill — populate `outputs.matures_at_height` for
 * legacy coinbase outputs that were inserted before the new-schema column existed
 * (migration `2026-05-13-001`).
 *
 * The §4 rule treats coinbase outputs whose `matures_at_height` is NULL as
 * not-yet-mature, so any coinbase output inserted prior to the migration is
 * permanently un-spendable until backfilled. This helper computes the BSV
 * coinbase maturity height as `transactions.height + 100` and writes it via
 * batched UPDATEs.
 *
 * Only rows where:
 *   - `transactions.is_coinbase = true`
 *   - `outputs.matures_at_height IS NULL`
 *   - `transactions.height IS NOT NULL`
 * are touched. Non-coinbase outputs and outputs whose owning transaction has
 * no recorded block height are left alone.
 *
 * Idempotent: re-running after a successful backfill examines the same set
 * of rows from a fresh scan and finds none with a NULL maturity, so the
 * second invocation reports `updated: 0`.
 *
 * Note on column naming: the database column is snake_case
 * (`outputs.matures_at_height`) but is exposed in API surfaces as
 * `maturesAtHeight`. This module references the DB column name directly
 * because Knex passes column literals straight through to SQL.
 */

const DEFAULT_BATCH_SIZE = 500
const BSV_COINBASE_MATURITY = 100

export interface BackfillCoinbaseMaturityArgs {
  /** Maximum number of rows examined per batch. Default 500. */
  batchSize?: number
  /** Override clock for `updated_at` writes. Default `new Date()`. */
  now?: Date
}

export interface BackfillCoinbaseMaturityStats {
  /** Rows visited by the scan, including any that could not be updated. */
  examined: number
  /** Rows whose `matures_at_height` was written by this run. */
  updated: number
}

/**
 * Stream every output joined with `transactions` where the owning transaction
 * is a coinbase, `outputs.matures_at_height` is NULL, and the transaction has
 * a non-null block height. For each candidate compute
 * `maturesAtHeight = height + 100` and write it back in a batched UPDATE.
 *
 * Returns `{ examined, updated }` for telemetry. The two counts diverge only
 * when concurrent writers update the same rows mid-scan; in steady state on
 * a quiescent DB they are equal.
 */
export async function backfillCoinbaseMaturity (
  knex: Knex,
  args: BackfillCoinbaseMaturityArgs = {}
): Promise<BackfillCoinbaseMaturityStats> {
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE
  const now = args.now ?? new Date()
  const stats: BackfillCoinbaseMaturityStats = { examined: 0, updated: 0 }

  let lastOutputId = 0
  /* eslint-disable-next-line no-constant-condition */
  while (true) {
    const rows: Array<{ outputId: number, height: number }> = await knex('outputs as o')
      .join('transactions as t', 't.transactionId', 'o.transactionId')
      .where('t.is_coinbase', true)
      .whereNull('o.matures_at_height')
      .whereNotNull('t.height')
      .andWhere('o.outputId', '>', lastOutputId)
      .orderBy('o.outputId')
      .limit(batchSize)
      .select(
        knex.ref('o.outputId').as('outputId'),
        knex.ref('t.height').as('height')
      )

    if (rows.length === 0) return stats

    for (const row of rows) {
      lastOutputId = row.outputId
      stats.examined += 1
      const maturesAtHeight = row.height + BSV_COINBASE_MATURITY
      const written = await knex('outputs')
        .where({ outputId: row.outputId })
        .whereNull('matures_at_height')
        .update({ matures_at_height: maturesAtHeight, updated_at: now })
      if (written > 0) stats.updated += 1
    }
  }
}
