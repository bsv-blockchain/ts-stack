import Transaction from '../transaction/Transaction.js'
import { isBroadcastFailure, validateBroadcastResult } from '../transaction/Broadcaster.js'
import { WERR_REVIEW_ACTIONS } from '../wallet/WERR_REVIEW_ACTIONS.js'
import type { BEEF } from '../wallet/Wallet.interfaces.js'
import TopicBroadcaster from './SHIPBroadcaster.js'
import { isPlainRecord } from '../primitives/SafeRecord.js'

const MAX_DOUBLE_SPEND_RETRIES = 5
const MAX_CONFIGURED_RETRIES = 100
const MAX_REVIEW_RESULTS = 256
const MAX_COMPETING_TRANSACTIONS = 256
const MAX_COMPETING_BEEF_BYTES = 64 * 1024 * 1024
const TXID = /^[0-9a-f]{64}$/i

interface DoubleSpendEvidence {
  beef: BEEF
  txids: string[]
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor == null || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return undefined
  }
  return descriptor.value
}

function denseTXIDs(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMPETING_TRANSACTIONS) {
    return undefined
  }
  const txids: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const candidate = ownDataValue(value as unknown as Record<string, unknown>, String(index))
    if (typeof candidate !== 'string' || !TXID.test(candidate)) return undefined
    const canonical = candidate.toLowerCase()
    if (seen.has(canonical)) return undefined
    seen.add(canonical)
    txids.push(canonical)
  }
  return txids
}

function ownedBEEF(value: unknown): BEEF | undefined {
  if (value instanceof Uint8Array) {
    if (value.length === 0 || value.length > MAX_COMPETING_BEEF_BYTES) return undefined
    return value.slice()
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMPETING_BEEF_BYTES) {
    return undefined
  }
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    const candidate = ownDataValue(value as unknown as Record<string, unknown>, String(index))
    if (!Number.isInteger(candidate) || (candidate as number) < 0 || (candidate as number) > 255) {
      return undefined
    }
    bytes.push(candidate as number)
  }
  return bytes
}

function extractDoubleSpendEvidence(error: unknown): DoubleSpendEvidence[] | undefined {
  if (
    !(error instanceof WERR_REVIEW_ACTIONS) ||
    ownDataValue(error as unknown as Record<string, unknown>, 'name') !== 'WERR_REVIEW_ACTIONS'
  ) {
    return undefined
  }
  const reviewActionResults = ownDataValue(
    error as unknown as Record<string, unknown>,
    'reviewActionResults'
  )
  if (!Array.isArray(reviewActionResults) || reviewActionResults.length > MAX_REVIEW_RESULTS) {
    return undefined
  }

  const evidence: DoubleSpendEvidence[] = []
  let aggregateBytes = 0
  const aggregateTxids = new Set<string>()
  for (let index = 0; index < reviewActionResults.length; index++) {
    const result = ownDataValue(
      reviewActionResults as unknown as Record<string, unknown>,
      String(index)
    )
    if (!isPlainRecord(result)) return undefined
    if (ownDataValue(result, 'status') !== 'doubleSpend') continue
    const beef = ownedBEEF(ownDataValue(result, 'competingBeef'))
    const txids = denseTXIDs(ownDataValue(result, 'competingTxs'))
    if (beef === undefined || txids === undefined) return undefined
    aggregateBytes += beef.length
    if (aggregateBytes > MAX_COMPETING_BEEF_BYTES) return undefined
    for (const txid of txids) aggregateTxids.add(txid)
    if (aggregateTxids.size > MAX_COMPETING_TRANSACTIONS) return undefined
    evidence.push({ beef, txids })
  }
  return evidence.length === 0 ? undefined : evidence
}

async function synchronizeCompetingTransactions(
  evidence: DoubleSpendEvidence[],
  broadcaster: TopicBroadcaster
): Promise<void> {
  const synchronized = new Set<string>()
  for (const item of evidence) {
    for (const txid of item.txids) {
      if (synchronized.has(txid)) continue
      let competingTransaction: Transaction
      try {
        competingTransaction = Transaction.fromBEEF(item.beef, txid)
      } catch (cause) {
        throw new Error('Wallet returned malformed competing transaction evidence.', { cause })
      }
      if (competingTransaction.id('hex').toLowerCase() !== txid) {
        throw new Error('Wallet competing transaction evidence does not match its transaction ID.')
      }
      const rawResult = await broadcaster.broadcast(competingTransaction)
      const result = validateBroadcastResult(rawResult, txid)
      if (isBroadcastFailure(result)) {
        throw new Error(
          `Failed to synchronize competing transaction: ${result.code}: ${result.description}`
        )
      }
      synchronized.add(txid)
    }
  }
}

/**
 * Executes an operation with bounded retry logic for authenticated wallet
 * double-spend errors. Before retrying, every reported competing transaction is
 * parsed from bounded owned BEEF, bound to its txid, and successfully
 * acknowledged by the supplied overlay broadcaster.
 *
 * `operation` must be safe to invoke again after throwing a review error. The
 * helper never retries malformed/name-spoofed errors and never retries when
 * conflict synchronization fails.
 */
export async function withDoubleSpendRetry<T>(
  operation: () => Promise<T>,
  broadcaster: TopicBroadcaster,
  maxRetries: number = MAX_DOUBLE_SPEND_RETRIES
): Promise<T> {
  if (typeof operation !== 'function') throw new TypeError('Retry operation is required.')
  if (broadcaster == null || typeof broadcaster.broadcast !== 'function') {
    throw new TypeError('Retry broadcaster is required.')
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > MAX_CONFIGURED_RETRIES) {
    throw new RangeError(`maxRetries must be an integer from 1 to ${MAX_CONFIGURED_RETRIES}.`)
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (attempt === maxRetries) throw error
      const evidence = extractDoubleSpendEvidence(error)
      if (evidence === undefined) throw error
      await synchronizeCompetingTransactions(evidence, broadcaster)
    }
  }

  throw new Error('Unexpected end of retry loop')
}
