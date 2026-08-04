import { profileValue, readResourceLimit, readResourceProfile } from './security/edgePolicy'

export function normalizeUhrpPagination(
  limitValue: unknown,
  offsetValue: unknown
): { limit: number, offset: number } {
  const profile = readResourceProfile('UHRP')
  const defaultLimit = readResourceLimit(
    'UHRP',
    'LIST_DEFAULT_LIMIT',
    profileValue(profile, { small: 100, standard: 200, highThroughput: 1_000 })
  )
  const maxLimit = readResourceLimit(
    'UHRP',
    'LIST_MAX_LIMIT',
    profileValue(profile, { small: 500, standard: 1_000, highThroughput: 5_000 })
  )
  const maxOffset = readResourceLimit(
    'UHRP',
    'LIST_MAX_OFFSET',
    profileValue(profile, { small: 25_000, standard: 100_000, highThroughput: 1_000_000 })
  )
  if (defaultLimit !== -1 && maxLimit !== -1 && defaultLimit > maxLimit) {
    throw new Error('UHRP_LIST_DEFAULT_LIMIT must not exceed UHRP_LIST_MAX_LIMIT')
  }
  const limit = limitValue == null
    ? defaultLimit === -1 ? Number.MAX_SAFE_INTEGER : defaultLimit
    : Number(limitValue)
  const offset = offsetValue == null ? 0 : Number(offsetValue)
  if (!Number.isSafeInteger(limit) || limit < 1 || (maxLimit !== -1 && limit > maxLimit)) {
    throw new RangeError(`limit must be a positive integer${maxLimit === -1 ? '' : ` no greater than ${maxLimit}`}`)
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || (maxOffset !== -1 && offset > maxOffset)) {
    throw new RangeError(`offset must be a non-negative integer${maxOffset === -1 ? '' : ` no greater than ${maxOffset}`}`)
  }
  return { limit, offset }
}
