import { Knex } from 'knex'
import * as sdk from '../../sdk'
import { isOutputSpendable } from './v7Spendability'

const REFRESH_BATCH = 500

const SPENDABLE_STATES: sdk.ProcessingStatus[] = sdk.ProcessingSpendableStatus.slice()

/**
 * Recompute and persist `outputs.spendable` for every output whose current
 * cached value disagrees with the §4 rule.
 *
 * The §4 rule depends on three inputs:
 *   - The owning transaction's V7 `processing` state.
 *   - Whether the output has been spent.
 *   - For coinbase outputs, whether maturity height has been reached on the
 *     current chain tip.
 *
 * Strategy: stream outputs joined with their owning transaction's processing
 * state in batches, evaluate the rule per row in JS, and update only rows
 * whose persisted `spendable` flag differs from the freshly-computed value.
 *
 * Returns counts so callers can detect drift and emit metrics.
 */
export interface RefreshSpendabilityStats {
  examined: number
  flipped: number
}

export interface RefreshSpendabilityArgs {
  /** Limit to outputs owned by this user. Default: refresh all users. */
  userId?: number
  /** Reuse a chain tip already fetched by the caller. */
  chainTip?: { height: number }
}

export async function refreshOutputsSpendable (
  knex: Knex,
  args: RefreshSpendabilityArgs = {}
): Promise<RefreshSpendabilityStats> {
  const stats: RefreshSpendabilityStats = { examined: 0, flipped: 0 }
  const tip = args.chainTip ?? (await knex('chain_tip').where({ id: 1 }).first('height'))
  const tipHeight: number | undefined = tip?.height

  let lastId = 0
  /* eslint-disable-next-line no-constant-condition */
  while (true) {
    const baseQuery = knex('outputs as o')
      .leftJoin('transactions as t', 't.transactionId', 'o.transactionId')
      .where('o.outputId', '>', lastId)
      .orderBy('o.outputId')
      .limit(REFRESH_BATCH)
      .select(
        knex.ref('o.outputId').as('outputId'),
        knex.ref('o.spendable').as('spendable'),
        knex.ref('o.spentBy').as('spentBy'),
        knex.ref('o.lockingScript').as('lockingScript'),
        knex.raw('o.scriptLength as scriptLength'),
        knex.raw('o.matures_at_height as maturesAtHeight'),
        knex.ref('t.processing').as('processing'),
        knex.ref('t.is_coinbase').as('isCoinbase')
      )

    const rows: any[] = args.userId != null
      ? await baseQuery.andWhere('o.userId', args.userId)
      : await baseQuery
    if (rows.length === 0) return stats

    for (const row of rows) {
      lastId = row.outputId
      stats.examined += 1
      const desired = isOutputSpendable(
        {
          spentBy: row.spentBy ?? null,
          // Treat presence of scriptLength as equivalent to presence of
          // locking script — the §4 rule only requires that some locking
          // script exists, not that it has been fetched into memory.
          lockingScript: (row.lockingScript ?? null) ?? (row.scriptLength != null ? [0] : null),
          isCoinbase: row.isCoinbase === 1 || row.isCoinbase === true,
          // Read the persisted maturity height from the V7 outputs column.
          // A null value for a coinbase row means maturity has not been
          // computed yet; the §4 rule treats that as not-yet-mature and
          // refuses spendability until backfill populates the column.
          maturesAtHeight: row.maturesAtHeight ?? null
        },
        { processing: row.processing as sdk.ProcessingStatus },
        tipHeight != null ? { height: tipHeight } : undefined
      )
      const current = row.spendable === 1 || row.spendable === true
      if (current !== desired) {
        await knex('outputs')
          .where({ outputId: row.outputId })
          .update({ spendable: desired })
        stats.flipped += 1
      }
    }
  }
}

/**
 * Fast-path counter used by the V7 hot query in §2.3:
 *
 *   SELECT * FROM outputs
 *   WHERE user_id = ? AND spendable = true AND basketId = default
 *   ORDER BY satoshis DESC LIMIT 100
 *
 * Returns the count of spendable outputs visible to the user in a basket
 * without joining transactions. Used by tests to assert that the cached
 * `outputs.spendable` column stays in sync with V7 state.
 */
export async function countCachedSpendable (
  knex: Knex,
  args: { userId: number, basketId?: number }
): Promise<number> {
  const q = knex('outputs').where({ userId: args.userId, spendable: true })
  if (args.basketId != null) q.andWhere({ basketId: args.basketId })
  const row = await q.count<{ c: number }>({ c: '*' }).first()
  return row?.c ?? 0
}

/** Snapshot of every spendable processing state. Mostly informational. */
export function spendableProcessingStates (): readonly sdk.ProcessingStatus[] {
  return SPENDABLE_STATES
}
