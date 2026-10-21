import { validateBase64String } from '@bsv/sdk/wallet/validationHelpers'
import { LookupQuestion } from '@bsv/overlay'
import { PublicKey, WalletProtocol } from '@bsv/sdk'
export type LookupQueryRecord = Record<string, unknown>

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
  if (question.service !== expectedService) throw new Error('Lookup service not supported!')

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
  options: { minBytes?: number; maxBytes?: number } = {}
): string | undefined {
  const value = query[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  const length = utf8Length(value)
  const minimum = options.minBytes ?? 1
  const maximum = options.maxBytes ?? 1000
  if (length < minimum || length > maximum) {
    invalid(`${field} must contain ${minimum}-${maximum} UTF-8 bytes`)
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

export function readBoolean(
  query: LookupQueryRecord,
  field: string,
  defaultValue = false
): boolean {
  const value = query[field]
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`)
  return value
}

export function readSortOrder(query: LookupQueryRecord, field = 'sortOrder'): 'asc' | 'desc' {
  const value = query[field] ?? 'desc'
  if (value !== 'asc' && value !== 'desc') invalid(`${field} must be asc or desc`)
  return value
}

export function readDate(query: LookupQueryRecord, field: string): Date | undefined {
  const value = query[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' && !(value instanceof Date)) {
    invalid(`${field} must be an ISO date string`)
  }
  if (typeof value === 'string' && (value.length === 0 || value.length > 64)) {
    invalid(`${field} must be a bounded ISO date string`)
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(parsed.getTime())) invalid(`${field} must be a valid date`)
  return parsed
}

export function readStringArray(
  query: LookupQueryRecord,
  field: string,
  options: { maxItems?: number; maxItemBytes?: number } = {}
): string[] | undefined {
  const value = query[field]
  if (value === undefined) return undefined
  const maxItems = options.maxItems ?? 32
  const maxItemBytes = options.maxItemBytes ?? 1000
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    invalid(`${field} must be an array of 1-${maxItems} strings`)
  }
  const result: string[] = []
  const unique = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid(`${field} must be dense`)
    const item = value[index]
    if (typeof item !== 'string' || utf8Length(item) < 1 || utf8Length(item) > maxItemBytes) {
      invalid(`${field}[${index}] must be a non-empty bounded string`)
    }
    if (unique.has(item)) invalid(`${field} must not contain duplicates`)
    unique.add(item)
    result.push(item)
  }
  return result
}

export function readPublicKeyArray(
  query: LookupQueryRecord,
  field: string,
  options: { maxItems?: number } = {}
): string[] | undefined {
  const values = readStringArray(query, field, {
    maxItems: options.maxItems,
    maxItemBytes: 66
  })
  if (values === undefined) return undefined
  return values.map((value, index) => requirePublicKey(value, `${field}[${index}]`)!)
}

export function readWalletProtocol(
  query: LookupQueryRecord,
  field: string
): WalletProtocol | undefined {
  const value = query[field]
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 0) ||
    !Object.prototype.hasOwnProperty.call(value, 1)
  ) {
    invalid(`${field} must be a [securityLevel, protocolName] tuple`)
  }
  const [securityLevel, protocolName] = value
  if (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) {
    invalid(`${field} security level must be 0, 1, or 2`)
  }
  if (typeof protocolName !== 'string') invalid(`${field} protocol name must be a string`)
  const length = utf8Length(protocolName)
  if (length < 5 || length > 400) invalid(`${field} protocol name must contain 5-400 UTF-8 bytes`)
  return [securityLevel, protocolName] as WalletProtocol
}

export function requirePublicKey(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  if (!/^(?:02|03)[0-9a-fA-F]{64}$/.test(value)) invalid(`${field} must be a compressed public key`)
  try {
    PublicKey.fromString(value)
  } catch {
    invalid(`${field} must be a valid compressed public key`)
  }
  return value
}

export function requireBase64_32(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  try {
    return validateBase64String(value, field, 32, 32)
  } catch {
    invalid(`${field} must be a 32-byte base64 value`)
  }
}

export function requireBase64(
  value: string | undefined,
  field: string,
  minimumBytes = 1,
  maximumBytes = 256
): string | undefined {
  if (value === undefined) return undefined
  try {
    return validateBase64String(value, field, minimumBytes, maximumBytes)
  } catch {
    invalid(
      `${field} must be a canonical base64 value containing ${minimumBytes}-${maximumBytes} bytes`
    )
  }
}

export function requireOutpoint(
  value: string | undefined,
  field = 'outpoint'
): { txid: string; outputIndex: number } | undefined {
  if (value === undefined) return undefined
  const match = /^([0-9a-fA-F]{64})\.(0|[1-9]\d{0,9})$/.exec(value)
  if (match == null) invalid(`${field} must be a canonical outpoint`)
  const outputIndex = Number(match[2])
  if (outputIndex > 0xffffffff) invalid(`${field} output index is out of range`)
  return { txid: match[1].toLowerCase(), outputIndex }
}

export function requireTxid(value: string | undefined, field = 'txid'): string | undefined {
  if (value === undefined) return undefined
  if (!/^[0-9a-fA-F]{64}$/.test(value)) invalid(`${field} must be a transaction ID`)
  return value.toLowerCase()
}

/** A Mandala token id is `<txid>_0` in display byte order, lowercase only (BRC-162 string form). */
export function requireTokenId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}_0$/.test(value)) {
    invalid(`${field} must be a token id (<64 lowercase hex>_0)`)
  }
  return value
}

export function requireHex(
  value: string | undefined,
  field: string,
  exactBytes?: number
): string | undefined {
  if (value === undefined) return undefined
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) invalid(`${field} must be hexadecimal`)
  if (exactBytes !== undefined && value.length !== exactBytes * 2) {
    invalid(`${field} must contain exactly ${exactBytes} bytes`)
  }
  return value.toLowerCase()
}

export function requireMongoFieldName(value: string): string {
  if (
    utf8Length(value) < 1 ||
    utf8Length(value) > 50 ||
    value.includes('.') ||
    value.includes('$') ||
    value.includes('\0') ||
    unsafeKeys.has(value)
  ) {
    invalid('attribute names must be safe MongoDB field segments of at most 50 UTF-8 bytes')
  }
  return value
}
