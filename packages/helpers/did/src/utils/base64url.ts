import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import type { JsonValue } from '../types.js'
import {
  assertBoundedString,
  MAX_JSON_STRING_BYTES,
  parseStrictJson,
  snapshotBytes,
  snapshotJsonValue
} from '../validation.js'

const MAX_BINARY_BYTES = 1_048_576

export function base64UrlEncode(bytes: Uint8Array | number[] | string): string {
  const data =
    typeof bytes === 'string' ? encodeText(bytes) : snapshotBytes(bytes, 'bytes', MAX_BINARY_BYTES)
  return toBase64(data).replaceAll('+', '-').replaceAll('/', '_').split('=', 1)[0]
}

export function base64UrlDecode(value: string, maximumBytes = MAX_BINARY_BYTES): number[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_BINARY_BYTES) {
    throw new TypeError('maximumBytes must be 0..1048576')
  }
  assertBoundedString(value, 'base64url value', encodedLimit(maximumBytes), true)
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TypeError('Invalid base64url encoding')
  }
  const remainder = value.length % 4
  const lastSextet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(
    value.at(-1) ?? 'A'
  )
  if (
    (remainder === 2 && (lastSextet & 0x0f) !== 0) ||
    (remainder === 3 && (lastSextet & 0x03) !== 0)
  ) {
    throw new TypeError('Invalid base64url encoding')
  }
  const base64 = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const decoded = toArray(base64, 'base64')
  if (decoded.length > maximumBytes) throw new TypeError('base64url value exceeds the byte limit')
  return decoded
}

export function base64UrlEncodeJson(value: unknown): string {
  const json = JSON.stringify(snapshotJsonValue(value, 'JSON value'))
  assertBoundedString(json, 'JSON serialization', MAX_JSON_STRING_BYTES, true)
  return base64UrlEncode(json)
}

export function base64UrlDecodeJson<T>(value: string): T {
  const decoded = base64UrlDecode(value, MAX_JSON_STRING_BYTES)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(decoded))
  } catch {
    throw new TypeError('JSON value is not valid UTF-8')
  }
  return parseStrictJson<JsonValue>(text, 'JSON value') as T
}

function encodeText(value: string): number[] {
  assertBoundedString(value, 'text value', MAX_BINARY_BYTES, true)
  return Array.from(new TextEncoder().encode(value))
}

function encodedLimit(maximumBytes: number): number {
  return Math.ceil(maximumBytes / 3) * 4
}
