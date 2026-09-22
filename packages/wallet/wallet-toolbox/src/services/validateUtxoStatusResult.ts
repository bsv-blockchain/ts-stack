import { GetUtxoStatusDetails, GetUtxoStatusResult } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { WalletError } from '../sdk/WalletError'
import { normalizeTxid } from './validateMerklePathResult'

export const MAX_UTXO_STATUS_DETAILS = 4096
const MAX_BLOCK_HEIGHT = 0x7fffffff
const MAX_VOUT = 0xffffffff

function invalid(name: string, requirement: string): never {
  throw new WERR_INVALID_PARAMETER(name, requirement)
}

function plainDescriptors(value: unknown, name: string): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(name, 'an accessor-free plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(name, 'an accessor-free plain data object')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    invalid(name, 'accessor-free data properties without symbols')
  }
  return descriptors
}

function read(descriptors: Record<string, PropertyDescriptor>, property: string): unknown {
  return descriptors[property]?.value
}

function denseArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_UTXO_STATUS_DETAILS) {
    invalid(name, `a dense array of at most ${MAX_UTXO_STATUS_DETAILS} items`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    invalid(name, 'an accessor-free dense array')
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

function integer(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    invalid(name, `an integer from 0 through ${maximum}`)
  }
  return value as number
}

function optionalInteger(value: unknown, name: string, maximum: number): number | undefined {
  return value === undefined ? undefined : integer(value, name, maximum)
}

function providerName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /\p{Cc}/u.test(value)) {
    invalid('getUtxoStatus result.name', '1 through 128 characters without control characters')
  }
  return value
}

export function normalizeWalletOutpoint(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid('outpoint', "'<txid>.<vout>' or absent")
  const match = /^([0-9a-fA-F]{64})\.([0-9]+)$/.exec(value)
  if (match == null) invalid('outpoint', "'<txid>.<vout>' or absent")
  const txid = normalizeTxid(match[1], 'outpoint txid')
  const index = Number(match[2])
  return `${txid}.${integer(index, 'outpoint vout', MAX_VOUT)}`
}

function copyDetail(value: unknown, index: number): GetUtxoStatusDetails {
  const name = `getUtxoStatus result.details[${index}]`
  const descriptors = plainDescriptors(value, name)
  const allowed = new Set(['height', 'txid', 'index', 'satoshis'])
  if (Object.keys(descriptors).some(key => !allowed.has(key))) invalid(name, 'only height, txid, index, and satoshis')
  return {
    // Unconfirmed UTXOs have no block height yet. Preserve that valid state
    // without relaxing the numeric boundary when a provider does claim one.
    height: optionalInteger(read(descriptors, 'height'), `${name}.height`, MAX_BLOCK_HEIGHT),
    txid: normalizeTxid(read(descriptors, 'txid'), `${name}.txid`),
    index: integer(read(descriptors, 'index'), `${name}.index`, MAX_VOUT),
    satoshis: integer(read(descriptors, 'satoshis'), `${name}.satoshis`, Number.MAX_SAFE_INTEGER)
  }
}

/** Validate, bind, and own a UTXO-oracle result before wallet state uses it. */
export function validateUtxoStatusResult(
  value: unknown,
  expectedOutpoint?: string,
  configuredProviderName?: string
): GetUtxoStatusResult {
  const outpoint = normalizeWalletOutpoint(expectedOutpoint)
  const descriptors = plainDescriptors(value, 'getUtxoStatus result')
  const allowed = new Set(['name', 'status', 'error', 'isUtxo', 'details'])
  if (Object.keys(descriptors).some(key => !allowed.has(key))) {
    invalid('getUtxoStatus result', 'only name, status, error, isUtxo, and details data properties')
  }
  const name = providerName(configuredProviderName ?? read(descriptors, 'name'))
  const status = read(descriptors, 'status')
  if (status !== 'success' && status !== 'error') invalid('getUtxoStatus result.status', "'success' or 'error'")
  if (status === 'error') {
    const errorValue = read(descriptors, 'error')
    return {
      name,
      status,
      error: errorValue instanceof Error ? WalletError.fromUnknown(errorValue) : undefined,
      details: []
    }
  }

  const isUtxo = read(descriptors, 'isUtxo')
  if (typeof isUtxo !== 'boolean') invalid('getUtxoStatus result.isUtxo', 'a boolean for a successful result')
  const details = denseArray(read(descriptors, 'details'), 'getUtxoStatus result.details').map((detail, index) =>
    copyDetail(detail, index)
  )
  const outpoints = details.map(detail => `${detail.txid!}.${detail.index!}`)
  if (new Set(outpoints).size !== outpoints.length) invalid('getUtxoStatus result.details', 'unique outpoints')
  const expectedVerdict = outpoint === undefined ? details.length > 0 : outpoints.includes(outpoint)
  // `details` is historically optional evidence even for a conclusive custom
  // provider verdict. When it is supplied, however, it must agree exactly.
  if (details.length > 0 && isUtxo !== expectedVerdict) {
    invalid('getUtxoStatus result.isUtxo', 'a verdict consistent with the requested outpoint and returned details')
  }
  return { name, status, isUtxo, details }
}
