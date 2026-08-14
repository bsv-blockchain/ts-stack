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
 * repairs already-corrupted wallet payloads produced by affected deployed
 * wallets. Both compatibility names delegate to the shared BRC-100 byte
 * encoding contract used by every JSON transport.
 */

import { brc100JsonReplacer, normalizeBRC100WalletByteFields } from '../../BRC100ByteEncoding.js'

/** JSON.stringify replacer that encodes Uint8Array values as plain number arrays. */
export function walletJsonReplacer(
  this: Record<string, unknown>,
  key: string,
  value: unknown
): unknown {
  return brc100JsonReplacer.call(this, key, value)
}

/**
 * Repair wallet byte fields affected by Uint8Array JSON serialization,
 * including direct and signable action transactions, list-output BEEF,
 * cryptographic byte results, and review-action error BEEF.
 */
export function normalizeWalletJsonTx<T>(value: T): T {
  return normalizeBRC100WalletByteFields(value)
}
