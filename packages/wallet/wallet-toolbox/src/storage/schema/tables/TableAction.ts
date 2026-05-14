import * as sdk from '../../../sdk'

/**
 * Per-user view of a (potential) transaction.
 *
 *   - `actionId` is the PK.
 *   - `txid` is NULLABLE — set to NULL while the action is an unsigned draft
 *     (createAction inserts the action with `txid = NULL`; processAction sets
 *     `txid` to the real on-chain txid once signing completes).
 *   - `(userId, reference)` and `(userId, txid)` are UNIQUE.
 */
export interface TableAction extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** PK */
  actionId: number
  userId: number
  /** Canonical txid FK to `transactions.txid`; NULL until signing completes. */
  txid?: string
  /** Application reference, base64/hex, max 64 chars. UNIQUE per user. */
  reference: string
  description: string
  /** True if originated in this wallet (change returns to it). */
  isOutgoing: boolean
  /** Signed net satoshi change to this user's balance. */
  satoshisDelta: number
  /** Transaction version (chosen at create-time). */
  version?: number
  lockTime?: number
  /** Per-user nosend override. */
  userNosend: boolean
  /** Soft-delete flag — hide from default queries. */
  hidden: boolean
  /** Per-user abort flag. */
  userAborted: boolean
  /** Unsigned rawTx draft; bytes move to `transactions.raw_tx` on commit. */
  rawTxDraft?: number[]
  /** Pre-signing inputBEEF draft; bytes move to `transactions.input_beef` on commit. */
  inputBeefDraft?: number[]
  /** JSON string of per-user notification subscribers. */
  notifyJson?: string
  /** Optimistic concurrency token. */
  rowVersion: number
}
