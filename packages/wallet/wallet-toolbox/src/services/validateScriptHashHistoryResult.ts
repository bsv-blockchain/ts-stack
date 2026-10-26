import { GetScriptHashHistory, GetScriptHashHistoryResult } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { WalletError } from '../sdk/WalletError'
import { normalizeTxid } from './validateMerklePathResult'

export const MAX_SCRIPT_HASH_HISTORY_ITEMS = 4096
const MAX_BLOCK_HEIGHT = 0x7fffffff

function invalid(name: string, requirement: string): never {
  throw new WERR_INVALID_PARAMETER(name, requirement)
}

function descriptors(value: unknown, name: string): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(name, 'an accessor-free plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(name, 'an accessor-free plain data object')
  const result = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(result).some(property => property.get != null || property.set != null)
  ) {
    invalid(name, 'accessor-free data properties without symbols')
  }
  return result
}

function read(source: Record<string, PropertyDescriptor>, property: string): unknown {
  return source[property]?.value
}

function providerName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /\p{Cc}/u.test(value)) {
    invalid('getScriptHashHistory result.name', '1 through 128 characters without control characters')
  }
  return value
}

function copyHistory(value: unknown): GetScriptHashHistory[] {
  if (!Array.isArray(value) || value.length > MAX_SCRIPT_HASH_HISTORY_ITEMS) {
    invalid('getScriptHashHistory result.history', `a dense array of at most ${MAX_SCRIPT_HASH_HISTORY_ITEMS} items`)
  }
  const properties = Object.getOwnPropertyDescriptors(value)
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length !== expected.size ||
    Object.keys(properties).some(key => !expected.has(key)) ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    invalid('getScriptHashHistory result.history', 'an accessor-free dense array without extra properties')
  }

  const byTxid = new Map<string, GetScriptHashHistory>()
  for (let index = 0; index < value.length; index++) {
    const name = `getScriptHashHistory result.history[${index}]`
    const entry = descriptors(properties[String(index)].value, name)
    if (Object.keys(entry).some(key => key !== 'txid' && key !== 'height')) {
      invalid(name, 'only txid and height data properties')
    }
    const txid = normalizeTxid(read(entry, 'txid'), `${name}.txid`)
    const rawHeight = read(entry, 'height')
    let height: number | undefined
    if (rawHeight !== undefined) {
      if (!Number.isSafeInteger(rawHeight) || (rawHeight as number) < 0 || (rawHeight as number) > MAX_BLOCK_HEIGHT) {
        invalid(`${name}.height`, `an integer from 0 through ${MAX_BLOCK_HEIGHT}, or absent`)
      }
      height = rawHeight as number
    }
    const previous = byTxid.get(txid)
    if (previous == null) {
      byTxid.set(txid, height === undefined ? { txid } : { txid, height })
    } else if (previous.height !== undefined && height !== undefined && previous.height !== height) {
      invalid('getScriptHashHistory result.history', 'no conflicting heights for one transaction')
    } else if (previous.height === undefined && height !== undefined) {
      previous.height = height
    }
  }
  return [...byTxid.values()]
}

/** Validate and own a script-history result before it contributes competing transaction IDs. */
export function validateScriptHashHistoryResult(
  value: unknown,
  configuredProviderName?: string
): GetScriptHashHistoryResult {
  const source = descriptors(value, 'getScriptHashHistory result')
  if (Object.keys(source).some(key => !['name', 'status', 'error', 'history'].includes(key))) {
    invalid('getScriptHashHistory result', 'only name, status, error, and history data properties')
  }
  const name = providerName(configuredProviderName ?? read(source, 'name'))
  const status = read(source, 'status')
  if (status !== 'success' && status !== 'error') {
    invalid('getScriptHashHistory result.status', "'success' or 'error'")
  }
  if (status === 'error') {
    const error = read(source, 'error')
    return {
      name,
      status,
      error: error instanceof Error ? WalletError.fromUnknown(error) : undefined,
      history: []
    }
  }
  return { name, status, history: copyHistory(read(source, 'history')) }
}
