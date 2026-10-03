import { WalletError } from './WalletError'
import type { AtomicBEEF, OutpointString, SendWithResult, TXIDHexString } from '@bsv/sdk'
import type { ReviewActionResult } from './WalletStorage.interfaces'
import {
  WERR_BAD_REQUEST,
  WERR_ACTION_BATCH_STATE,
  WERR_BROADCAST_UNAVAILABLE,
  WERR_INSUFFICIENT_FUNDS,
  WERR_INTERNAL,
  WERR_INVALID_OPERATION,
  WERR_INVALID_MERKLE_ROOT,
  WERR_INVALID_PARAMETER,
  WERR_INVALID_PUBLIC_KEY,
  WERR_MISSING_PARAMETER,
  WERR_NETWORK_CHAIN,
  WERR_NOT_ACTIVE,
  WERR_NOT_IMPLEMENTED,
  WERR_REVIEW_ACTIONS,
  WERR_UTXO_REVIEW_INCONCLUSIVE,
  WERR_UNAUTHORIZED
} from './WERR_errors'

const MAX_ERROR_RESULTS = 1001
const MAX_ERROR_BEEF_BYTES = 32 * 1024 * 1024

function dataRecord(value: unknown, field: string, maxKeys = 32): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
  }
  const prototype = Object.getPrototypeOf(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length > maxKeys ||
    Object.values(descriptors).some(descriptor => !('value' in descriptor))
  ) {
    throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

function boundedString(value: unknown, field: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 9 || (code > 10 && code < 13) || (code > 13 && code < 32) || code === 127) {
      throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
    }
  }
  return value
}

function identifier(value: unknown, field: string): string {
  const text = boundedString(value, field, 128)
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
  return text
}

function byteArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length > MAX_ERROR_BEEF_BYTES) {
    throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
  }
  const copy = Array.from({ length: value.length }, () => 0)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
    }
    copy[index] = descriptor.value
  }
  return copy
}

function stringArray(value: unknown, field: string, maximum = MAX_ERROR_RESULTS): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new WERR_INTERNAL(`Invalid remote wallet error ${field}`)
  }
  return value.map((entry, index) => boundedString(entry, `${field}[${index}]`, 256))
}

function reviewActionsEnvelope(obj: Record<string, unknown>): {
  reviewActionResults: ReviewActionResult[]
  sendWithResults: SendWithResult[]
  txid?: TXIDHexString
  tx?: AtomicBEEF
  noSendChange?: OutpointString[]
} {
  if (!Array.isArray(obj.reviewActionResults) || obj.reviewActionResults.length > MAX_ERROR_RESULTS) {
    throw new WERR_INTERNAL('Invalid remote wallet error reviewActionResults')
  }
  const reviewStatuses = new Set(['success', 'doubleSpend', 'serviceError', 'invalidTx'])
  const reviewActionResults = obj.reviewActionResults.map((value, index) => {
    const item = dataRecord(value, `reviewActionResults[${index}]`, 8)
    const txid = identifier(item.txid, `reviewActionResults[${index}].txid`)
    const status = boundedString(item.status, `reviewActionResults[${index}].status`, 32)
    if (!reviewStatuses.has(status)) throw new WERR_INTERNAL('Invalid remote wallet error review status')
    const competingTxs =
      item.competingTxs === undefined
        ? undefined
        : stringArray(item.competingTxs, `reviewActionResults[${index}].competingTxs`, 1000)
    const competingBeef =
      item.competingBeef === undefined
        ? undefined
        : byteArray(item.competingBeef, `reviewActionResults[${index}].competingBeef`)
    if (status !== 'doubleSpend' && (competingTxs !== undefined || competingBeef !== undefined)) {
      throw new WERR_INTERNAL('Invalid remote wallet error competing transaction evidence')
    }
    return {
      txid,
      status,
      ...(competingTxs === undefined ? {} : { competingTxs }),
      ...(competingBeef === undefined ? {} : { competingBeef })
    } as ReviewActionResult
  })
  if (!Array.isArray(obj.sendWithResults) || obj.sendWithResults.length > MAX_ERROR_RESULTS) {
    throw new WERR_INTERNAL('Invalid remote wallet error sendWithResults')
  }
  const sendStatuses = new Set(['unproven', 'sending', 'failed'])
  const sendWithResults = obj.sendWithResults.map((value, index) => {
    const item = dataRecord(value, `sendWithResults[${index}]`, 4)
    const txid = identifier(item.txid, `sendWithResults[${index}].txid`)
    const status = boundedString(item.status, `sendWithResults[${index}].status`, 32)
    if (!sendStatuses.has(status)) throw new WERR_INTERNAL('Invalid remote wallet error send status')
    return { txid, status } as SendWithResult
  })
  return {
    reviewActionResults,
    sendWithResults,
    ...(obj.txid === undefined ? {} : { txid: identifier(obj.txid, 'txid') as TXIDHexString }),
    ...(obj.tx === undefined ? {} : { tx: byteArray(obj.tx, 'tx') as AtomicBEEF }),
    ...(obj.noSendChange === undefined
      ? {}
      : { noSendChange: stringArray(obj.noSendChange, 'noSendChange') as OutpointString[] })
  }
}

/**
 * Reconstruct the correct derived WalletError from a JSON object created by `WalletError.unknownToJson`.
 *
 * This function is implemented as a separate function instead of a WalletError class static
 * to avoid circular dependencies.
 *
 * @param json
 * @returns a WalletError derived error object, typically for re-throw.
 */
export function WalletErrorFromJson(json: object): WalletError {
  let e: WalletError
  const obj = dataRecord(json, 'envelope', 64) as any
  switch (obj.name) {
    case 'WERR_ACTION_BATCH_STATE':
      e = new WERR_ACTION_BATCH_STATE(obj.state, obj.batchId)
      e.message = obj.message
      break
    case 'WERR_NOT_IMPLEMENTED':
      e = new WERR_NOT_IMPLEMENTED(obj.message)
      break
    case 'WERR_INTERNAL':
      e = new WERR_INTERNAL(obj.message)
      break
    case 'WERR_INVALID_OPERATION':
      e = new WERR_INVALID_OPERATION(obj.message)
      break
    case 'WERR_UTXO_REVIEW_INCONCLUSIVE':
      e = new WERR_UTXO_REVIEW_INCONCLUSIVE(obj.checked, obj.confirmedSpent, obj.unknown)
      e.message = obj.message
      break
    case 'WERR_BROADCAST_UNAVAILABLE':
      e = new WERR_BROADCAST_UNAVAILABLE(obj.message)
      break
    case 'WERR_INVALID_PARAMETER':
      e = new WERR_INVALID_PARAMETER(obj.parameter)
      e.message = obj.message
      break
    case 'WERR_MISSING_PARAMETER':
      e = new WERR_MISSING_PARAMETER(obj.parameter)
      e.message = obj.message
      break
    case 'WERR_BAD_REQUEST':
      e = new WERR_BAD_REQUEST(obj.message)
      break
    case 'WERR_NETWORK_CHAIN':
      e = new WERR_NETWORK_CHAIN(obj.message)
      break
    case 'WERR_INVALID_MERKLE_ROOT':
      if (!Number.isSafeInteger(obj.blockHeight) || obj.blockHeight < 0) {
        throw new WERR_INTERNAL('Invalid remote wallet error blockHeight')
      }
      e = new WERR_INVALID_MERKLE_ROOT(
        boundedString(obj.blockHash, 'blockHash', 64),
        obj.blockHeight,
        boundedString(obj.merkleRoot, 'merkleRoot', 64),
        obj.txid === undefined ? undefined : boundedString(obj.txid, 'txid', 64)
      )
      if (obj.message !== undefined) e.message = boundedString(obj.message, 'message')
      break
    case 'WERR_UNAUTHORIZED':
      e = new WERR_UNAUTHORIZED(obj.message)
      break
    case 'WERR_NOT_ACTIVE':
      e = new WERR_NOT_ACTIVE(obj.message)
      break
    case 'WERR_INSUFFICIENT_FUNDS':
      e = new WERR_INSUFFICIENT_FUNDS(obj.totalSatoshisNeeded, obj.moreSatoshisNeeded)
      break
    case 'WERR_INVALID_PUBLIC_KEY':
      e = new WERR_INVALID_PUBLIC_KEY(obj.key, 'mainnet')
      e.message = obj.message
      break
    case 'WERR_REVIEW_ACTIONS':
      {
        const review = reviewActionsEnvelope(obj)
        e = new WERR_REVIEW_ACTIONS(
          review.reviewActionResults,
          review.sendWithResults,
          review.txid,
          review.tx,
          review.noSendChange
        )
      }
      break
    default:
      e = new WalletError(
        typeof obj.name === 'string' && obj.name !== '' ? obj.name : 'WERR_UNKNOWN',
        typeof obj.message === 'string' ? obj.message : ''
      )
      break
  }
  return e
}
