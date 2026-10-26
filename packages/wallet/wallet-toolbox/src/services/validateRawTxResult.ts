import { GetRawTxResult } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { WalletError } from '../sdk/WalletError'
import { normalizeTxid } from './validateMerklePathResult'

export const MAX_RAW_TRANSACTION_BYTES = 32 * 1024 * 1024

function invalid(name: string, requirement: string): never {
  throw new WERR_INVALID_PARAMETER(name, requirement)
}

function boundedProviderName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 128 || /\p{Cc}/u.test(value)) {
    invalid('getRawTx result.name', 'at most 128 characters without control characters')
  }
  return value
}

export function copyRawTransactionBytes(value: unknown, name = 'rawTx'): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RAW_TRANSACTION_BYTES) {
    invalid(name, `a nonempty dense byte array of at most ${MAX_RAW_TRANSACTION_BYTES} bytes`)
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(name, 'an accessor-free dense byte array')
  const copy = Array.from({ length: value.length }, () => 0)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || !('value' in descriptor) || descriptor.get != null || descriptor.set != null) {
      invalid(name, 'an accessor-free dense byte array')
    }
    const byte = descriptor.value
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) invalid(`${name}[${index}]`, 'an integer byte')
    copy[index] = byte
  }
  return copy
}

/** Snapshot and bind a raw-transaction provider result to its requested txid. */
export function validateRawTxResult(value: unknown, expectedTxid: string, providerName?: string): GetRawTxResult {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('getRawTx result', 'an accessor-free plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('getRawTx result', 'an accessor-free plain data object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    invalid('getRawTx result', 'accessor-free data properties without symbols')
  }
  const allowed = new Set(['txid', 'name', 'rawTx', 'error'])
  if (Object.keys(descriptors).some(key => !allowed.has(key))) {
    invalid('getRawTx result', 'only txid, name, rawTx, and error data properties')
  }
  const read = (property: string): unknown => descriptors[property]?.value
  const txid = normalizeTxid(read('txid'), 'getRawTx result.txid')
  if (txid !== normalizeTxid(expectedTxid)) invalid('getRawTx result.txid', 'the requested transaction id')
  const name = boundedProviderName(providerName ?? read('name'))
  const rawTxValue = read('rawTx')
  const rawTx = rawTxValue === undefined ? undefined : copyRawTransactionBytes(rawTxValue, 'getRawTx result.rawTx')
  const errorValue = read('error')
  if (errorValue !== undefined && !(errorValue instanceof Error)) {
    invalid('getRawTx result.error', 'an Error or absent')
  }
  const error = errorValue === undefined ? undefined : WalletError.fromUnknown(errorValue)
  return {
    txid,
    ...(name !== undefined ? { name } : {}),
    ...(rawTx !== undefined ? { rawTx } : {}),
    ...(error !== undefined ? { error } : {})
  }
}
