import type { RegistryEntry } from './types'
import { snapshotPlainDataRecord } from './certificate-validation'

export const MAX_REGISTRY_TAG_LENGTH = 128
export const MAX_REGISTRY_QUERY_LENGTH = 128
export const MAX_REGISTRY_RESPONSE_ITEMS = 256
export const MAX_REGISTRY_ERROR_LENGTH = 512

const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-fA-F]{64}$/

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })
}

export function isPlainRegistryRecord(value: unknown): value is Record<string, unknown> {
  return snapshotPlainDataRecord(value) != null
}

export function normalizeRegistryTag(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Registry tag must be a string')
  const tag = value.trim()
  if (tag.length === 0 || tag.length > MAX_REGISTRY_TAG_LENGTH || hasControlCharacters(tag)) {
    throw new TypeError(
      `Registry tag must contain 1-${MAX_REGISTRY_TAG_LENGTH} control-free characters`
    )
  }
  return tag
}

export function normalizeRegistryQuery(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Registry query must be a string')
  const query = value.trim()
  if (
    query.length === 0 ||
    query.length > MAX_REGISTRY_QUERY_LENGTH ||
    hasControlCharacters(query)
  ) {
    throw new TypeError(
      `Registry query must contain 1-${MAX_REGISTRY_QUERY_LENGTH} control-free characters`
    )
  }
  return query
}

export function normalizeRegistryIdentityKey(value: unknown): string {
  if (typeof value !== 'string' || !COMPRESSED_PUBLIC_KEY.test(value)) {
    throw new TypeError('Registry identityKey must be a compressed public key')
  }
  return value.toLowerCase()
}

export function normalizeRegistryTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40) {
    throw new TypeError('Registry createdAt must be a canonical ISO timestamp')
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError('Registry createdAt must be a canonical ISO timestamp')
  }
  return value
}

export function validateRegistryEntries(value: unknown, maximum: number): RegistryEntry[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`Registry store must contain at most ${maximum} entries`)
  }
  const entries: RegistryEntry[] = []
  const tags = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const entry =
      descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null
        ? undefined
        : snapshotPlainDataRecord(descriptor.value)
    if (entry == null) {
      throw new TypeError('Registry store contains a malformed entry')
    }
    const tag = normalizeRegistryTag(entry.tag)
    const tagKey = tag.toLowerCase()
    if (tags.has(tagKey)) throw new TypeError('Registry store contains a duplicate tag')
    tags.add(tagKey)
    entries.push({
      tag,
      identityKey: normalizeRegistryIdentityKey(entry.identityKey),
      createdAt: normalizeRegistryTimestamp(entry.createdAt)
    })
  }
  return entries
}

export function remoteRegistryError(value: unknown, fallback: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REGISTRY_ERROR_LENGTH ||
    hasControlCharacters(value)
  ) {
    return fallback
  }
  return value
}

export function boundedPositiveSafeInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  name: string
): number {
  const selected = value ?? fallback
  if (
    typeof selected !== 'number' ||
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > maximum
  ) {
    throw new TypeError(`${name} must be a safe integer between 1 and ${maximum}`)
  }
  return selected
}
