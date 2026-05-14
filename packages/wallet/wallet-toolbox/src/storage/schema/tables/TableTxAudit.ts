import * as sdk from '../../../sdk'

/**
 * Per-event audit log for transactions and actions.
 *
 * Each row records a single observable event scoped to either a transaction
 * (`txid`), an action (`actionId`), or both. Append-only.
 */
export interface TableTxAudit extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** PK */
  auditId: number
  /** FK → transactions.txid (canonical chain record). */
  txid?: string
  /** FK → actions.actionId (per-user view). */
  actionId?: number
  /** Stable event identifier, e.g. 'processing.changed', 'proof.acquired'. */
  event: string
  fromState?: string
  toState?: string
  /** JSON-encoded event payload. */
  detailsJson?: string
}
