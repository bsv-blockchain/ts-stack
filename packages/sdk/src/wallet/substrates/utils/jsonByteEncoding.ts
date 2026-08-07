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
 * repairs already-corrupted action results produced by affected deployed
 * wallets.
 */

/** JSON.stringify replacer that encodes Uint8Array values as plain number arrays. */
export function walletJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value]
  return value
}

/**
 * Repair the top-level action-result `tx` regression introduced by Uint8Array
 * action serialization. Healthy arrays and all other fields are returned
 * untouched.
 */
export function normalizeWalletJsonTx<T>(value: T): T {
  const tx = (value as { tx?: unknown } | null)?.tx
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    return value
  }
  const entries = Object.entries(tx)
  if (
    entries.length > 0 &&
    entries.every(([key, byte], index) => key === String(index) && typeof byte === 'number')
  ) {
    Object.assign(value as object, { tx: entries.map(([, byte]) => byte) })
  }
  return value
}
