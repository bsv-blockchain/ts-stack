import { profileValue, readResourceLimit, readResourceProfile } from './security/edgePolicy'

export interface HeaderRange {
  height: number
  count: number
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
