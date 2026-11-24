/**
 * Internal validators for values that arrive from peers or app storage. Not part of
 * the public API: `wire.ts`, `accept.ts` and `requests.ts` build on them.
 */
import { Transaction } from '@bsv/sdk'
import { DEFAULTS } from '../types.js'
import { fromBase64, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'

/** Largest amount a payment may carry: 21 million BSV in satoshis. */
export const MAX_SATOSHIS = 2.1e15
/** Longest BRC-29 derivation prefix or suffix, in characters. */
const MAX_DERIVATION_CHARS = 400
const MAX_UINT32 = 0xffffffff
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// C0 controls, DEL and C1 controls (U+0000-U+001F, U+007F-U+009F: Unicode category Cc).
const CONTROL_RE = /\p{Cc}/u

/**
 * A null-prototype copy of `v`'s own properties when `v` is a plain data object
 * (prototype `Object.prototype` or `null`, string keys only, no accessors), else
 * `undefined`. Reading the copy never runs peer-controlled code, and a `__proto__`
 * key from `JSON.parse` is just an ordinary entry in it.
 */
export function plainRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const proto: unknown = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return undefined
  const out = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key)
    if (typeof key !== 'string' || d === undefined || !('value' in d)) return undefined
    out[key] = d.value
  }
  return out
}

/** Optional fields treat `null` (as some JSON encoders write) the same as absent. */
export function optional(v: unknown): unknown {
  return v === null ? undefined : v
}

/** A wire message `id`: 1–64 characters of `[A-Za-z0-9_-]`. */
export function isMessageId(v: unknown): v is string {
  return typeof v === 'string' && MESSAGE_ID_RE.test(v)
}

/** An integer `n` with `min <= n <= max` (both safe integers). */
export function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
}

/** A non-empty string of at most `maxBytes` UTF-8 bytes with no C0/C1 control characters. */
export function isBoundedText(v: unknown, maxBytes: number): v is string {
  // UTF-8 never takes fewer bytes than UTF-16 code units, so the length test is a cheap
  // early exit before encoding.
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= maxBytes &&
    utf8Encode(v).length <= maxBytes &&
    !CONTROL_RE.test(v)
  )
}

/** A string of at most `maxChars` UTF-16 code units. */
export function isShortString(v: unknown, maxChars: number): v is string {
  return typeof v === 'string' && v.length <= maxChars
}

export function invalidPayment(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('invalid_payment', message, cause === undefined ? undefined : { cause })
}

function isDerivationString(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_DERIVATION_CHARS) return false
  try {
    fromBase64(v)
    return true
  } catch {
    return false
  }
}

/** The checked fields of a payment token, with the transaction still in its carried form. */
export interface TokenFields {
  derivationPrefix: string
  derivationSuffix: string
  amount: number
  outputIndex: number
  /** Unchecked: base64 on the wire, bytes (`number[]` or `Uint8Array`) in a token. */
  transaction: unknown
}

/**
 * Checks a payment token's derivation strings (strict base64, 1–400 chars), amount
 * (integer 1…2.1e15) and output index (uint32; `fallbackOutputIndex` when absent, else
 * 0). Throws `invalid_payment`.
 */
export function tokenFields(v: unknown, fallbackOutputIndex?: unknown): TokenFields {
  const token = plainRecord(v)
  const instructions = plainRecord(token?.customInstructions)
  if (token === undefined || instructions === undefined) {
    throw invalidPayment('Payment token is malformed')
  }
  const { derivationPrefix, derivationSuffix } = instructions
  if (!isDerivationString(derivationPrefix) || !isDerivationString(derivationSuffix)) {
    throw invalidPayment('Payment derivation prefix or suffix is invalid')
  }
  const { amount } = token
  if (!isIntInRange(amount, 1, MAX_SATOSHIS)) throw invalidPayment('Payment amount is invalid')
  const outputIndex = optional(token.outputIndex) ?? optional(fallbackOutputIndex) ?? 0
  if (!isIntInRange(outputIndex, 0, MAX_UINT32)) {
    throw invalidPayment('Payment output index is invalid')
  }
  return { derivationPrefix, derivationSuffix, amount, outputIndex, transaction: token.transaction }
}

/** A `Uint8Array`, or an array whose every element is an integer from 0 to 255. */
export function isByteArray(v: unknown): v is Uint8Array | number[] {
  if (v instanceof Uint8Array) return true
  if (!Array.isArray(v)) return false
  for (const b of v as unknown[]) {
    if (typeof b !== 'number' || (b & 255) !== b) return false
  }
  return true
}

/** Parses 1…`DEFAULTS.maxMessageBytes` bytes of Atomic BEEF. Throws `invalid_payment`. */
export function parsePaymentTransaction(bytes: Uint8Array | number[]): Transaction {
  if (bytes.length === 0 || bytes.length > DEFAULTS.maxMessageBytes) {
    throw invalidPayment('Payment transaction size is out of range')
  }
  try {
    return Transaction.fromAtomicBEEF(bytes)
  } catch (cause) {
    throw invalidPayment('Payment transaction is not valid Atomic BEEF', cause)
  }
}
