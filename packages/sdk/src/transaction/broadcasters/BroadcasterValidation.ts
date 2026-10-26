import type { HttpClient } from '../http/HttpClient.js'
import { hasControlCharacter, utf8ByteLength } from '../../primitives/UTF8.js'

export const TRANSACTION_ID = /^[0-9a-f]{64}$/i

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
