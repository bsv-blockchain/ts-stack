import { PublicKey } from '@bsv/sdk'

export const MAX_DISCOVERY_LOOKUP_RESULTS = 1000
export const MAX_DISCOVERY_LOOKUP_SKIP = 1_000_000
const MAX_QUERY_STRING_BYTES = 2048
const MAX_QUERY_NAMES = 100
/** Upper bound for a topic or service name in a query; matches isValidTopicOrServiceName. */
export const MAX_QUERY_NAME_BYTES = 256
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

export interface PaginationQuery {
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
}

export interface ValidatedPagination {
  limit: number
  skip: number
  sortOrder: 'asc' | 'desc'
}

type LookupQueryRecord = Record<string, unknown>

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

function plainDataRecord(value: unknown, label: string): LookupQueryRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || descriptor == null || !('value' in descriptor)) {
      throw new Error(`${label} must contain only string-keyed data properties`)
    }
  }
  return value as LookupQueryRecord
}

/**
 * Reads a lookup question without invoking accessors and returns either the
 * legacy `findAll` query or an allowlisted plain-data query record.
 */
export function requireLookupQuery(
  question: unknown,
  expectedService: string,
  allowedKeys: readonly string[]
): 'findAll' | LookupQueryRecord {
  const record = plainDataRecord(question, 'Lookup question')
  const query = record.query
  if (query === undefined || query === null) {
    throw new Error('A valid query must be provided!')
  }
  if (record.service !== expectedService) throw new Error('Lookup service not supported!')
  if (query === 'findAll') return query
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    // Keep the historical concrete Error class: consumers may branch on it.
    throw new Error( // NOSONAR -- compatibility requires Error rather than TypeError
      'Invalid query format. Query must be "findAll" string or an object with valid parameters.'
    )
  }

  const queryRecord = plainDataRecord(query, 'Lookup query')
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(queryRecord)) {
    if (unsafeKeys.has(key) || !allowed.has(key)) {
      throw new Error(`query contains unexpected field ${key}`)
    }
  }
  return queryRecord
}

export function validatePaginationQuery(query: PaginationQuery): ValidatedPagination {
  const { limit = MAX_DISCOVERY_LOOKUP_RESULTS, skip = 0, sortOrder = 'desc' } = query
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > MAX_DISCOVERY_LOOKUP_RESULTS
  ) {
    throw new Error(`query.limit must be an integer from 0 to ${MAX_DISCOVERY_LOOKUP_RESULTS}`)
  }
  if (
    !Number.isSafeInteger(skip) ||
    skip < 0 ||
    skip > MAX_DISCOVERY_LOOKUP_SKIP
  ) {
    throw new Error(`query.skip must be an integer from 0 to ${MAX_DISCOVERY_LOOKUP_SKIP}`)
  }
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new Error('query.sortOrder must be "asc" or "desc" if provided')
  }
  return { limit, skip, sortOrder }
}

export function validateOptionalBoolean(value: unknown, path: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean if provided`)
  return value
}

export function validateOptionalString(
  value: unknown,
  path: string,
  maximumBytes = MAX_QUERY_STRING_BYTES
): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    utf8Length(value) < 1 ||
    utf8Length(value) > maximumBytes
  ) {
    throw new Error(`${path} must be a non-empty string of at most ${maximumBytes} UTF-8 bytes if provided`)
  }
  return value
}

export function validateOptionalPublicKey(value: unknown, path: string): string | undefined {
  const key = validateOptionalString(value, path, 66)
  if (key === undefined) return undefined
  if (!/^(?:02|03)[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${path} must be a compressed public key if provided`)
  }
  try {
    PublicKey.fromString(key)
  } catch {
    throw new Error(`${path} must be a valid compressed public key if provided`)
  }
  return key
}

export function validateOptionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUERY_NAMES) {
    throw new Error(`${path} must be an array of 1-${MAX_QUERY_NAMES} strings if provided`)
  }
  const result: string[] = []
  const unique = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      utf8Length(descriptor.value) < 1 ||
      utf8Length(descriptor.value) > MAX_QUERY_NAME_BYTES
    ) {
      throw new Error(`${path} must contain only dense, bounded strings`)
    }
    if (unique.has(descriptor.value)) throw new Error(`${path} must not contain duplicates`)
    unique.add(descriptor.value)
    result.push(descriptor.value)
  }
  return result
}

export function definedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}
