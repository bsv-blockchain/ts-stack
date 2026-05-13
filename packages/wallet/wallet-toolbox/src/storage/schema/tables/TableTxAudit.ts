import * as sdk from '../../../sdk'

/**
 * per-event audit log for transactions and actions.
 *
 * Each row records a single observable event scoped to either a transaction
 * (per-txid) or an action (per-user) or both. Append-only.
 */
export interface TableTxAudit extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** PK */
  auditId: number
  /** FK -> transactions.transactionId, optional for action-only events */
  transactionId?: number
  /** FK -> actions.actionId, optional for tx-only events */
  actionId?: number
  /** Stable event identifier, e.g. 'processing.changed', 'proof.acquired' */
  event: string
  /** Optional FSM source state for transitions */
  fromState?: string
  /** Optional FSM target state for transitions */
  toState?: string
  /** JSON-encoded event payload */
  detailsJson?: string
}
