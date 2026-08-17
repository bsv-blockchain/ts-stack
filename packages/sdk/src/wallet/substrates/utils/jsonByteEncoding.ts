/**
 * JSON byte-encoding helpers for the HTTP wallet JSON substrate.
 *
 * BRC-100 byte fields (`AtomicBEEF`, `BEEF`, `Byte[]`) may be represented as
 * `Uint8Array` since the transaction-pipeline performance work. `JSON.stringify`
 * serializes a `Uint8Array` as a numeric-keyed OBJECT (`{"0":1,"1":2,...}`)
 * rather than a JSON array, which corrupts the wire format in both directions:
 * wallets responding with an action `tx` serialized that way break every
 * JSON-substrate client (`ReaderUint8Array.makeReader: bin must be Uint8Array
 * or number[]`), and clients sending `Uint8Array` args (e.g. `inputBEEF`)
 * corrupt requests.
 *
 * `walletJsonReplacer` makes serialization safe. `normalizeWalletJsonTx`
 * repairs the historical top-level action-result `tx` shape produced by
 * affected deployed wallets. Broader recovery is performed internally by the
 * HTTP substrate without changing this exported helper's narrow contract.
 */

import { brc100JsonReplacer, normalizeBRC100ByteArray } from '../../BRC100ByteEncoding.js'

/** JSON.stringify replacer that encodes Uint8Array values as plain number arrays. */
export function walletJsonReplacer(
  this: Record<string, unknown>,
  key: string,
  value: unknown
): unknown {
  return brc100JsonReplacer.call(this, key, value)
}

/**
 * Repair the historical top-level action-result `tx` regression. This narrow
 * compatibility export intentionally leaves every other field untouched.
 */
export function normalizeWalletJsonTx<T>(value: T): T {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const tx = normalizeBRC100ByteArray(record.tx)
  if (tx != null) record.tx = tx
  return value
}
