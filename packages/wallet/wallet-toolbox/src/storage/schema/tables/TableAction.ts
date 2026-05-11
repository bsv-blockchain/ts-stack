import * as sdk from '../../../sdk'

/**
 * V7 per-user view of a transaction.
 *
 * Migrated from the legacy `transactions` table. Holds everything that is truly
 * per-user (description, labels via tx_labels_map -> actionId, soft-delete flags,
 * notification subscribers). All on-chain status lives in the V7 `transactions`
 * table addressed by `transactionId`.
 *
 * UNIQUE(userId, transactionId).
 */
export interface TableAction extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** PK */
  actionId: number
  userId: number
  /** FK -> V7 transactions.transactionId (per-txid record) */
  transactionId: number
  /** Application reference, hex/Base64, max 64 chars */
  reference: string
  description: string
  /** true if originated in this wallet (change returns to it) */
  isOutgoing: boolean
  /** Signed net change to this user's balance from this action */
  satoshisDelta: number
  /** Per-user nosend override */
  userNosend: boolean
  /** Soft-delete flag — hide from default queries */
  hidden: boolean
  /** Per-user abort flag */
  userAborted: boolean
  /** JSON string of per-user notification subscribers (mirrors legacy notify) */
  notifyJson?: string
  /** Optimistic concurrency token */
  rowVersion: number
}
