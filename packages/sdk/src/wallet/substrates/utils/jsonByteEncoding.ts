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
 * `walletJsonReplacer` makes serialization safe. `walletJsonReviver` repairs
 * already-corrupted action results produced by the affected deployed wallets.
 */

/** JSON.stringify replacer that encodes Uint8Array values as plain number arrays. */
export function walletJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value]
  return value
}

/**
 * JSON.parse reviver that repairs the action-result `tx` regression introduced
 * by Uint8Array action serialization. Healthy arrays and all other fields are
 * returned untouched.
 */
export function walletJsonReviver(key: string, value: unknown): unknown {
  if (key !== 'tx' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  const bytes = Object.assign([] as unknown[], value)
  return bytes.length > 0 &&
    bytes.length === Object.keys(value).length &&
    bytes.every(byte => typeof byte === 'number')
    ? bytes
    : value
}
