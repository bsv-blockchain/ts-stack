import { profileValue, readResourceLimit, readResourceProfile } from './security/edgePolicy'
import type { BaseBlockHeader } from '@bsv/wallet-toolbox'

export interface HeaderRange {
  height: number
  count: number
}

const SUBMITTED_HEADER_KEYS = [
  'version',
  'previousHash',
  'merkleRoot',
  'time',
  'bits',
  'nonce'
] as const
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/

function parseUint32(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new RangeError(`${field} must be an unsigned 32-bit integer`)
  }
  return value as number
}

/** Validate and copy the public header-submission body before any storage lookup or queue. */
export function parseSubmittedHeader(value: unknown): BaseBlockHeader {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('header must be a plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError('header must be a plain data object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (
    keys.length !== SUBMITTED_HEADER_KEYS.length ||
    !keys.every(key =>
      SUBMITTED_HEADER_KEYS.includes(key as (typeof SUBMITTED_HEADER_KEYS)[number])
    ) ||
    keys.some(key => descriptors[key]?.get != null || descriptors[key]?.set != null)
  ) {
    throw new RangeError('header must contain exactly the required data properties')
  }
  const header = value as Record<string, unknown>
  if (typeof header.previousHash !== 'string' || !HEX_32_BYTES.test(header.previousHash)) {
    throw new RangeError('previousHash must be exactly 32 hexadecimal bytes')
  }
  if (typeof header.merkleRoot !== 'string' || !HEX_32_BYTES.test(header.merkleRoot)) {
    throw new RangeError('merkleRoot must be exactly 32 hexadecimal bytes')
  }
  return {
    version: parseUint32(header.version, 'version'),
    previousHash: header.previousHash,
    merkleRoot: header.merkleRoot,
    time: parseUint32(header.time, 'time'),
    bits: parseUint32(header.bits, 'bits'),
    nonce: parseUint32(header.nonce, 'nonce')
  }
}

export function parseHeaderHeight(value: unknown): number {
  if (Array.isArray(value)) {
    throw new RangeError('Invalid or missing height parameter')
  }
  const raw = value
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) {
    throw new RangeError('Invalid or missing height parameter')
  }
  const height = Number(raw)
  if (!Number.isSafeInteger(height)) {
    throw new RangeError('Invalid or missing height parameter')
  }
  return height
}

function parseHeaderCount(value: unknown, fallback: number): number {
  if (value == null) return fallback
  if (Array.isArray(value)) return Number.NaN
  const raw = value
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return Number.NaN
  return Number(raw)
}

export function parseHeaderRange(query: Record<string, unknown>): HeaderRange {
  const height = parseHeaderHeight(query.height)
  const profile = readResourceProfile('CHAINTRACKS')
  const configuredDefault = readResourceLimit(
    'CHAINTRACKS',
    'HEADERS_DEFAULT_LIMIT',
    profileValue(profile, { small: 250, standard: 1_000, highThroughput: 5_000 })
  )
  const configuredMaximum = readResourceLimit(
    'CHAINTRACKS',
    'HEADERS_MAX_LIMIT',
    profileValue(profile, { small: 500, standard: 1_000, highThroughput: 5_000 })
  )
  if (
    configuredDefault !== -1 &&
    configuredMaximum !== -1 &&
    configuredDefault > configuredMaximum
  ) {
    throw new Error(
      'CHAINTRACKS_HEADERS_DEFAULT_LIMIT must not exceed CHAINTRACKS_HEADERS_MAX_LIMIT'
    )
  }
  const count = parseHeaderCount(
    query.count,
    configuredDefault === -1 ? Number.MAX_SAFE_INTEGER : configuredDefault
  )
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    (configuredMaximum !== -1 && count > configuredMaximum)
  ) {
    throw new RangeError(
      configuredMaximum === -1
        ? 'count must be a positive safe integer'
        : `count must be an integer between 1 and ${configuredMaximum}`
    )
  }
  if (!Number.isSafeInteger(height + count - 1)) {
    throw new RangeError('height plus count exceeds the safe integer range')
  }
  return { height, count }
}
