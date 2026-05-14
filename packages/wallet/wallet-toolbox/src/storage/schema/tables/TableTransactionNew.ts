import * as sdk from '../../../sdk'

/**
 * v3 canonical per-txid record. **`txid` is the PK** — there is no integer
 * `transactionId` column.
 *
 * Single source of truth for everything about a transaction on the network.
 * Per-user metadata (description, labels, hidden, etc.) lives in `actions`.
 */
export interface TableTransactionNew extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** PK — Bitcoin txid, hex (64 chars). */
  txid: string
  processing: sdk.ProcessingStatus
  processingChangedAt: Date
  nextActionAt?: Date
  attempts: number
  rebroadcastCycles: number
  wasBroadcast: boolean
  idempotencyKey?: string
  batch?: string
  rawTx?: number[]
  inputBeef?: number[]
  height?: number
  merkleIndex?: number
  merklePath?: number[]
  merkleRoot?: string
  blockHash?: string
  isCoinbase: boolean
  lastProvider?: string
  lastProviderStatus?: string
  frozenReason?: string
  rowVersion: number
}
