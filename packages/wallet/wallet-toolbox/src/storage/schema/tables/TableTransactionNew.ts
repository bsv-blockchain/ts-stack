import * as sdk from '../../../sdk'

/**
 * new canonical per-txid table.
 *
 * Single source of truth for everything about a transaction on the network.
 * Merges the legacy `proven_tx_reqs` (broadcast queue + processing state) and
 * `proven_txs` (final Merkle proof) tables into one row per txid.
 *
 * Per-user metadata (description, labels, hidden, etc.) lives in `actions`.
 */
export interface TableTransactionNew extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** PK */
  transactionId: number
  /** UNIQUE — Bitcoin txid, hex */
  txid: string
  /** Granular FSM state (see ProcessingStatus) */
  processing: sdk.ProcessingStatus
  /** Wall-clock of the most recent processing transition */
  processingChangedAt: Date
  /** Wall-clock at which the next monitor pass should consider this row */
  nextActionAt?: Date
  /** Cumulative network-service attempt count */
  attempts: number
  /** Count of times this row has been reset for rebroadcast (circuit-breaker) */
  rebroadcastCycles: number
  /** true once the row has reached a state implying successful broadcast */
  wasBroadcast: boolean
  /** Application-supplied idempotency key (unique when present) */
  idempotencyKey?: string
  /** Optional batch tag for grouped broadcast */
  batch?: string
  rawTx?: number[]
  inputBeef?: number[]
  /** Merkle proof fields — populated on transition to `proven` */
  height?: number
  merkleIndex?: number
  merklePath?: number[]
  merkleRoot?: string
  blockHash?: string
  isCoinbase: boolean
  lastProvider?: string
  lastProviderStatus?: string
  /** Reason a row is in `frozen` state, free text */
  frozenReason?: string
  /** Optimistic concurrency token */
  rowVersion: number
}
