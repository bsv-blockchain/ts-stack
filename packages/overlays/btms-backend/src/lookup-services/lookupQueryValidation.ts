import type { LookupQuestion } from '@bsv/overlay'
import { PublicKey } from '@bsv/sdk'

type LookupQueryRecord = Record<string, unknown>

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

function invalid(message: string): never {
  throw new Error(`Invalid lookup query: ${message}`)
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

export function requireLookupQuery(
  question: LookupQuestion,
  expectedService: string,
  allowedKeys: readonly string[]
): LookupQueryRecord {
  if (question == null || typeof question !== 'object' || Array.isArray(question)) {
    invalid('a question object is required')
  }
  if (question.service !== expectedService) throw new Error('Lookup service not supported')

  const query = question.query
  if (query == null || typeof query !== 'object' || Array.isArray(query)) {
    invalid('query must be an object')
  }
  const prototype = Object.getPrototypeOf(query)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('query must be a plain object')
  }

  const allowed = new Set(allowedKeys)
  for (const key of Reflect.ownKeys(query)) {
    if (typeof key !== 'string' || unsafeKeys.has(key) || !allowed.has(key)) {
      invalid(`unexpected field ${String(key)}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(query, key)
    if (descriptor == null || !('value' in descriptor)) invalid(`field ${key} must be data`)
  }
  return query as LookupQueryRecord
}

export function readString(
  query: LookupQueryRecord,
  field: string,
  maximumBytes: number
): string | undefined {
  const value = query[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  const length = utf8Length(value)
  if (length < 1 || length > maximumBytes) {
    invalid(`${field} must contain 1-${maximumBytes} UTF-8 bytes`)
  }
  return value
}

export function readInteger(
  query: LookupQueryRecord,
  field: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  const value = query[field] ?? defaultValue
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${field} must be an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}

export function readBoolean(query: LookupQueryRecord, field: string): boolean {
  const value = query[field]
  if (value === undefined) return false
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`)
  return value
}

export function readSortOrder(query: LookupQueryRecord): 'asc' | 'desc' {
  const value = query.sortOrder ?? 'desc'
  if (value !== 'asc' && value !== 'desc') invalid('sortOrder must be asc or desc')
  return value
}

export function requirePublicKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^(?:02|03)[0-9a-fA-F]{64}$/.test(value)) {
    invalid('ownerKey must be a compressed public key')
  }
  try {
    PublicKey.fromString(value)
  } catch {
    invalid('ownerKey must be a valid compressed public key')
  }
  return value
}
