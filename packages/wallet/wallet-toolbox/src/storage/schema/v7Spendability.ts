import * as sdk from '../../sdk'
import { TableChainTip, TableOutput, TableTransactionV7 } from './tables'
import { isProcessingSpendable } from './v7Fsm'

/**
 * Per-output inputs for the V7 spendability check.
 *
 * Only the fields needed by §4 of PROD_REQ_V7_TS.md are required; callers are
 * free to pass full rows. `spentBy` is the legacy `outputs.spentBy` column;
 * coinbase fields use the names introduced in §2.3.
 */
export interface SpendabilityOutputInput {
  spentBy?: number | null
  lockingScript?: number[] | null
  isCoinbase?: boolean
  maturesAtHeight?: number | null
}

export interface SpendabilityTxInput {
  processing: sdk.ProcessingStatus
}

export interface SpendabilityTipInput {
  height: number
}

/**
 * Pure implementation of the §4 spendability rule:
 *
 * ```
 * spendable = (transactions.processing IN ('sent','seen','seen_multi','unconfirmed','proven'))
 *           AND outputs.spent_by IS NULL
 *           AND outputs.locking_script IS NOT NULL
 *           AND (NOT outputs.is_coinbase OR outputs.matures_at_height <= chain_tip.height)
 * ```
 *
 * The function never reads from storage — call sites are responsible for
 * loading the matching transaction row and chain tip. This keeps the rule
 * testable in isolation and lets the refresh helpers batch loads efficiently.
 */
export function isOutputSpendable (
  out: SpendabilityOutputInput,
  tx: SpendabilityTxInput,
  tip: SpendabilityTipInput | undefined
): boolean {
  if (!isProcessingSpendable(tx.processing)) return false
  if (out.spentBy != null) return false
  if (out.lockingScript == null) return false
  if (out.isCoinbase === true) {
    if (tip == null) return false
    if (out.maturesAtHeight == null) return false
    if (out.maturesAtHeight > tip.height) return false
  }
  return true
}

/**
 * Convenience wrapper that takes whole table rows and forwards to the pure
 * predicate. Returns `false` when the matching transaction row is missing.
 */
export function isTableOutputSpendable (
  out: TableOutput & { isCoinbase?: boolean, maturesAtHeight?: number | null },
  tx: TableTransactionV7 | undefined,
  tip: TableChainTip | undefined
): boolean {
  if (tx === undefined) return false
  return isOutputSpendable(
    {
      spentBy: out.spentBy ?? null,
      lockingScript: out.lockingScript ?? null,
      isCoinbase: out.isCoinbase === true,
      maturesAtHeight: out.maturesAtHeight ?? null
    },
    { processing: tx.processing },
    tip != null ? { height: tip.height } : undefined
  )
}
