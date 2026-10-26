import type Transaction from './Transaction.js'
import { utf8ByteLength } from '../primitives/UTF8.js'
import { isPlainRecord } from '../primitives/SafeRecord.js'

const TXID = /^[0-9a-f]{64}$/i
const MAX_BROADCAST_MESSAGE_BYTES = 8192
const MAX_BROADCAST_CODE_BYTES = 128
const MAX_COMPETING_TXS = 256

function ownDataProperty(
  value: Record<string, unknown>,
  key: string
): { present: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor == null) return { present: false }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return { present: true }
  return { present: true, value: descriptor.value }
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= maximumBytes
}

function invalidBroadcastResult(): BroadcastFailure {
  return {
    status: 'error',
    code: 'ERR_INVALID_RESPONSE',
    description: 'Broadcaster returned a malformed or transaction-mismatched response.'
  }
}

/**
 * Validates and owns the security-relevant fields returned by a broadcaster.
 * A success is accepted only when it acknowledges the exact submitted transaction.
 */
export function validateBroadcastResult(
  result: unknown,
  expectedTxid: string
): BroadcastResponse | BroadcastFailure {
  if (!TXID.test(expectedTxid) || !isPlainRecord(result)) return invalidBroadcastResult()
  const status = ownDataProperty(result, 'status').value
  if (status === 'success') {
    const txid = ownDataProperty(result, 'txid').value
    const message = ownDataProperty(result, 'message').value
    const competing = ownDataProperty(result, 'competingTxs')
    if (
      typeof txid !== 'string' ||
      !TXID.test(txid) ||
      txid.toLowerCase() !== expectedTxid.toLowerCase() ||
      !boundedString(message, MAX_BROADCAST_MESSAGE_BYTES)
    )
      return invalidBroadcastResult()
    const normalized: BroadcastResponse = {
      status: 'success',
      txid: expectedTxid.toLowerCase(),
      message
    }
    if (competing.present) {
      if (!Array.isArray(competing.value) || competing.value.length > MAX_COMPETING_TXS) {
        return invalidBroadcastResult()
      }
      const competingTxs: string[] = []
      const seen = new Set<string>()
      for (let i = 0; i < competing.value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(competing.value, i)
        const candidate = descriptor?.value
        if (
          descriptor == null ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          typeof candidate !== 'string' ||
          !TXID.test(candidate)
        )
          return invalidBroadcastResult()
        const canonical = candidate.toLowerCase()
        if (seen.has(canonical)) return invalidBroadcastResult()
        seen.add(canonical)
        competingTxs.push(canonical)
      }
      normalized.competingTxs = competingTxs
    }
    return normalized
  }
  if (status !== 'error') return invalidBroadcastResult()
  const code = ownDataProperty(result, 'code').value
  const description = ownDataProperty(result, 'description').value
  const txid = ownDataProperty(result, 'txid')
  if (
    !boundedString(code, MAX_BROADCAST_CODE_BYTES) ||
    !boundedString(description, MAX_BROADCAST_MESSAGE_BYTES) ||
    (txid.present &&
      (typeof txid.value !== 'string' ||
        !TXID.test(txid.value) ||
        txid.value.toLowerCase() !== expectedTxid.toLowerCase()))
  )
    return invalidBroadcastResult()
  const normalized: BroadcastFailure = { status: 'error', code, description }
  if (txid.present) normalized.txid = expectedTxid.toLowerCase()
  const more = ownDataProperty(result, 'more')
  if (more.present && more.value != null && typeof more.value === 'object') {
    normalized.more = more.value
  }
  return normalized
}

/**
 * Defines the structure of a successful broadcast response.
 *
 * @interface
 * @property {string} status - The status of the response, indicating success.
 * @property {string} txid - The transaction ID of the broadcasted transaction.
 * @property {string} message - A human-readable success message.
 */
export interface BroadcastResponse {
  status: 'success'
  txid: string
  message: string
  competingTxs?: string[]
}

/**
 * Defines the structure of a failed broadcast response.
 *
 * @interface
 * @property {string} status - The status of the response, indicating an error.
 * @property {string} code - A machine-readable error code representing the type of error encountered.
 * @property {string} txid - The transaction ID of the broadcasted transaction.
 * @property {string} description - A detailed description of the error.
 * @property {object} more - The unparsed response data from the underlying broadcast service.
 */
export interface BroadcastFailure {
  status: 'error'
  code: string
  txid?: string
  description: string
  more?: object
}

/**
 * Represents the interface for a transaction broadcaster.
 * This interface defines a standard method for broadcasting transactions.
 *
 * @interface
 * @property {function} broadcast - A function that takes a Transaction object and returns a promise.
 *                                  The promise resolves to either a BroadcastResponse or a BroadcastFailure.
 * @property {function} broadcastMany - A function that takes an array of Transaction objects and returns a promise.
 *                                  The promise resolves to an array of broadcast result response objects.
 */
export interface Broadcaster {
  broadcast: (transaction: Transaction) => Promise<BroadcastResponse | BroadcastFailure>
  broadcastMany?: (txs: Transaction[]) => Promise<object[]>
}

/**
 * Convenience type guard for response from `Broadcaster.broadcast`
 */
export function isBroadcastResponse(
  r: BroadcastResponse | BroadcastFailure
): r is BroadcastResponse {
  return isPlainRecord(r) && ownDataProperty(r, 'status').value === 'success'
}

/**
 * Convenience type guard for response from `Broadcaster.broadcast`
 */
export function isBroadcastFailure(r: BroadcastResponse | BroadcastFailure): r is BroadcastFailure {
  return isPlainRecord(r) && ownDataProperty(r, 'status').value === 'error'
}
