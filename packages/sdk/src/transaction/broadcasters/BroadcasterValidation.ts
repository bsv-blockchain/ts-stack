import type { HttpClient } from '../http/HttpClient.js'
import { hasControlCharacter, utf8ByteLength } from '../../primitives/UTF8.js'

export const TRANSACTION_ID = /^[0-9a-f]{64}$/i

/** ARC-style txStatus values that mean the transaction was not accepted. */
export const ARC_ERROR_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'MINED_IN_STALE_BLOCK'
])
export const MAX_ARC_STATUS_BYTES = 128
export const MAX_ARC_INFO_BYTES = 8192
const MAX_ARC_RESPONSE_PROPERTIES = 32
const MAX_COMPETING_TXS = 256

export function boundedText(
  value: unknown,
  maximumBytes: number,
  allowEmpty = true
): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length !== 0) &&
    utf8ByteLength(value) <= maximumBytes &&
    !hasControlCharacter(value)
  )
}

/** Own data properties of a plain ARC-style response object, or undefined for anything else. */
export function ownArcData(value: unknown): Record<string, PropertyDescriptor> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const properties = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length > MAX_ARC_RESPONSE_PROPERTIES ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    return undefined
  }
  return properties
}

/**
 * A canonical copy of an ARC-style competingTxs array: own, plain, at most
 * MAX_COMPETING_TXS distinct transaction ids, lower-cased. Undefined when absent or malformed.
 */
export function snapshotCompetingTxs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_COMPETING_TXS) return undefined
  const properties = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index))
  ])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length !== expectedKeys.size ||
    Object.keys(properties).some(key => !expectedKeys.has(key)) ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    return undefined
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const candidate = properties[index]?.value
    if (typeof candidate !== 'string' || !TRANSACTION_ID.test(candidate)) return undefined
    const normalized = candidate.toLowerCase()
    if (seen.has(normalized)) return undefined
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/** Parses a JSON text body; any other value, or text that is not JSON, is returned as is. */
export function parseArcData(data: unknown): unknown {
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

/** Preserve a bounded provider diagnostic without permitting terminal/log control injection. */
export function providerDiagnostic(value: unknown): string {
  return typeof value === 'string' && utf8ByteLength(value) <= 8192 && !hasControlCharacter(value)
    ? value
    : 'Unknown error'
}

export function providerStatusCode(value: unknown): string {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 999
    ? (value as number).toString()
    : 'ERR_UNKNOWN'
}

export function normalizeBroadcasterUrl(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8ByteLength(value) > 2048 ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${label} must be nonempty bounded text without control characters.`)
  }
  return value
}

export function normalizeBroadcasterHttpClient(value: unknown, label: string): HttpClient {
  if (
    value == null ||
    typeof value !== 'object' ||
    typeof (value as HttpClient).request !== 'function'
  ) {
    throw new TypeError(`${label} must provide request().`)
  }
  return value as HttpClient
}

export function normalizeBsvNetwork(value: unknown): 'main' | 'test' | 'stn' {
  if (value !== 'main' && value !== 'test' && value !== 'stn') {
    throw new TypeError("Network must be 'main', 'test', or 'stn'.")
  }
  return value
}
