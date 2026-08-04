import {
  profileValue,
  readResourceLimit,
  readResourceProfile
} from './security/edgePolicy'

export interface HeaderRange {
  height: number
  count: number
}

export function parseHeaderRange(query: Record<string, unknown>): HeaderRange {
  const height = Number(query.height)
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
    throw new Error('CHAINTRACKS_HEADERS_DEFAULT_LIMIT must not exceed CHAINTRACKS_HEADERS_MAX_LIMIT')
  }
  const count = query.count == null
    ? configuredDefault === -1 ? Number.MAX_SAFE_INTEGER : configuredDefault
    : Number(query.count)
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new RangeError('Invalid or missing height parameter')
  }
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
  return { height, count }
}
