import { GetStatusForTxidsResult, StatusForTxidResult } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { WalletError } from '../sdk/WalletError'
import { normalizeTxid } from './validateMerklePathResult'

const MAX_PROVIDER_NAME_LENGTH = 128
const MAX_PROVIDER_STATUS_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 512
const MAX_COMPETING_TXIDS = 24
const MAX_DEPTH = 0x7fffffff
const MAX_STATUS_CODE = 999
const STATUS_PROPERTIES = new Set([
  'txid',
  'depth',
  'status',
  'terminal',
  'inputConflict',
  'providerStatus',
  'statusCode',
  'description',
  'competingTxs'
])

function invalid(name: string, requirement: string): never {
  throw new WERR_INVALID_PARAMETER(name, requirement)
}

function requirePlainDataRecord(value: unknown, name: string): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(name, 'an accessor-free plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(name, 'an accessor-free plain data object')
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(name, 'a data object without symbol properties')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
    invalid(name, 'accessor-free data properties')
  }
  return descriptors
}

function ownValue(descriptors: Record<string, PropertyDescriptor>, property: string): unknown {
  const descriptor = descriptors[property]
  return descriptor != null && 'value' in descriptor ? descriptor.value : undefined
}

function requireDenseArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(name, `a dense array of at most ${maximum} items`)
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(name, 'an array without symbol properties')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
    invalid(name, 'an accessor-free array')
  }
  const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.keys(descriptors).some(key => !expectedKeys.has(key)) ||
    Object.keys(descriptors).length !== expectedKeys.size
  ) {
    invalid(name, 'a dense array without extra properties')
  }
  return value
}

function requireBoundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /\p{Cc}/u.test(value)) {
    invalid(name, `at most ${maximum} characters without control characters`)
  }
  return value
}

function copyStatusResult(value: unknown, requested: Set<string>, seen: Set<string>): StatusForTxidResult {
  const descriptors = requirePlainDataRecord(value, 'transaction status result')
  const keys = Object.keys(descriptors)
  if (keys.some(key => !STATUS_PROPERTIES.has(key))) {
    invalid('transaction status result', 'only documented status data properties')
  }

  const txid = normalizeTxid(ownValue(descriptors, 'txid'), 'transaction status result.txid')
  if (!requested.has(txid)) invalid('transaction status result.txid', 'one of the requested transaction ids')
  if (seen.has(txid)) invalid('transaction status results', 'at most one result for each requested transaction id')
  seen.add(txid)

  const status = ownValue(descriptors, 'status')
  if (status !== 'mined' && status !== 'known' && status !== 'unknown') {
    invalid('transaction status result.status', "'mined', 'known', or 'unknown'")
  }
  const depth = ownValue(descriptors, 'depth')
  if (
    (status === 'mined' && (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > MAX_DEPTH)) ||
    (status === 'known' && depth !== 0) ||
    (status === 'unknown' && depth !== undefined)
  ) {
    invalid('transaction status result.depth', 'a value consistent with the transaction status')
  }

  const terminalValue = ownValue(descriptors, 'terminal')
  const inputConflictValue = ownValue(descriptors, 'inputConflict')
  if (terminalValue !== undefined && typeof terminalValue !== 'boolean') {
    invalid('transaction status result.terminal', 'a boolean or absent')
  }
  if (inputConflictValue !== undefined && typeof inputConflictValue !== 'boolean') {
    invalid('transaction status result.inputConflict', 'a boolean or absent')
  }
  if (terminalValue === true && status !== 'unknown') {
    invalid('transaction status result.terminal', "true only for an 'unknown' lifecycle result")
  }
  if (inputConflictValue === true && terminalValue !== true) {
    invalid('transaction status result.inputConflict', 'true only for an explicit terminal result')
  }

  const result: StatusForTxidResult = { txid, status, depth: depth as number | undefined }
  if (terminalValue === true) result.terminal = true
  if (inputConflictValue === true) result.inputConflict = true

  const providerStatusValue = ownValue(descriptors, 'providerStatus')
  if (providerStatusValue !== undefined) {
    const providerStatus = requireBoundedText(
      providerStatusValue,
      'transaction status result.providerStatus',
      MAX_PROVIDER_STATUS_LENGTH
    )
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(providerStatus)) {
      invalid('transaction status result.providerStatus', 'a bounded status token')
    }
    result.providerStatus = providerStatus
  }

  const statusCodeValue = ownValue(descriptors, 'statusCode')
  if (statusCodeValue !== undefined) {
    if (
      !Number.isSafeInteger(statusCodeValue) ||
      (statusCodeValue as number) < 0 ||
      (statusCodeValue as number) > MAX_STATUS_CODE
    ) {
      invalid('transaction status result.statusCode', `an integer from 0 through ${MAX_STATUS_CODE}`)
    }
    result.statusCode = statusCodeValue as number
  }

  const descriptionValue = ownValue(descriptors, 'description')
  if (descriptionValue !== undefined) {
    result.description = requireBoundedText(
      descriptionValue,
      'transaction status result.description',
      MAX_DESCRIPTION_LENGTH
    )
  }

  const competingTxidsValue = ownValue(descriptors, 'competingTxs')
  if (competingTxidsValue !== undefined) {
    const competing = requireDenseArray(
      competingTxidsValue,
      'transaction status result.competingTxs',
      MAX_COMPETING_TXIDS
    )
    const unique = new Set<string>()
    result.competingTxs = competing.map((candidate, index) => {
      const competingTxid = normalizeTxid(candidate, `transaction status result.competingTxs[${index}]`)
      if (competingTxid === txid || unique.has(competingTxid)) {
        invalid('transaction status result.competingTxs', 'unique transaction ids other than the requested transaction')
      }
      unique.add(competingTxid)
      return competingTxid
    })
  }

  return result
}

/**
 * Copy and validate an external transaction-status provider response before it
 * can influence wallet transaction state. Provider names may be replaced with
 * a locally configured name so remote data cannot forge durable attribution.
 */
export function validateStatusForTxidsResult(
  value: unknown,
  requestedTxids: readonly string[],
  providerName?: string
): GetStatusForTxidsResult {
  const normalizedRequested = requestedTxids.map((txid, index) => normalizeTxid(txid, `txids[${index}]`))
  const requested = new Set(normalizedRequested)
  const descriptors = requirePlainDataRecord(value, 'transaction status provider result')
  const allowedEnvelopeProperties = new Set(['name', 'status', 'error', 'results'])
  if (Object.keys(descriptors).some(key => !allowedEnvelopeProperties.has(key))) {
    invalid('transaction status provider result', 'only name, status, error, and results data properties')
  }

  const trustedName =
    providerName ??
    requireBoundedText(
      ownValue(descriptors, 'name'),
      'transaction status provider result.name',
      MAX_PROVIDER_NAME_LENGTH
    )
  const status = ownValue(descriptors, 'status')
  if (status !== 'success' && status !== 'error') {
    invalid('transaction status provider result.status', "'success' or 'error'")
  }
  if (status === 'error') {
    const sourceError = ownValue(descriptors, 'error')
    return {
      name: trustedName,
      status,
      error: sourceError instanceof WalletError ? sourceError : undefined,
      results: []
    }
  }

  const sourceResults = requireDenseArray(
    ownValue(descriptors, 'results'),
    'transaction status provider result.results',
    requested.size
  )
  const seen = new Set<string>()
  const results = sourceResults.map(result => copyStatusResult(result, requested, seen))
  return { name: trustedName, status, results }
}
