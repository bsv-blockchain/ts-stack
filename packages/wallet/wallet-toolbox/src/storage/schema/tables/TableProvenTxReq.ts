import { sdk } from '../../../index.client'

export interface TableProvenTxReq extends TableProvenTxReqDynamics {
  created_at: Date
  updated_at: Date
  provenTxReqId: number
  provenTxId?: number
  status: sdk.ProvenTxReqStatus
  /**
   * Count of how many times a service has been asked about this txid
   */
  attempts: number
  /**
   * Set to true when a terminal status has been set and notification has occurred.
   */
  notified: boolean
  txid: string
  /**
   * If valid, a unique string identifying a batch of transactions to be sent together for processing.
   */
  batch?: string
  /**
   * JSON string of processing history.
   * Parses to `ProvenTxReqHistoryApi`.
   */
  history: string
  /**
   * JSON string of data to drive notifications when this request completes.
   * Parses to `ProvenTxReqNotifyApi`.
   */
  notify: string
  rawTx: number[]
  inputBEEF?: number[]
  /**
   * Set to true the first time this req transitions to 'unmined' or 'callback' status,
   * indicating the transaction was successfully broadcast to the network.
   * Used to distinguish rebroadcast candidates from transactions that were never sent.
   * Defaults to false (added by migration 2026-04-30-001).
   */
  wasBroadcast?: boolean
  /**
   * Count of how many times this req has been reset to 'unsent' for rebroadcast
   * after proof check timeout. Used by the circuit-breaker (maxRebroadcastAttempts).
   * Defaults to 0 (added by migration 2026-04-30-001).
   */
  rebroadcastAttempts?: number
}

/**
 * Table properties that may change after initial record insertion.
 */
export interface TableProvenTxReqDynamics extends sdk.EntityTimeStamp {
  updated_at: Date
  provenTxId?: number
  status: sdk.ProvenTxReqStatus
  /**
   * Count of how many times a service has been asked about this txid
   */
  attempts: number
  /**
   * Set to true when a terminal status has been set and notification has occurred.
   */
  notified: boolean
  /**
   * If valid, a unique string identifying a batch of transactions to be sent together for processing.
   */
  batch?: string
  /**
   * JSON string of processing history.
   * Parses to `ProvenTxReqHistoryApi`.
   */
  history: string
  /**
   * JSON string of data to drive notifications when this request completes.
   * Parses to `ProvenTxReqNotifyApi`.
   */
  notify: string
  /**
   * Set to true the first time this req transitions to 'unmined' or 'callback' status.
   * Defaults to false (added by migration 2026-04-30-001).
   */
  wasBroadcast?: boolean
  /**
   * Count of rebroadcast cycles for this req. Used by the circuit-breaker.
   * Defaults to 0 (added by migration 2026-04-30-001).
   */
  rebroadcastAttempts?: number
}
