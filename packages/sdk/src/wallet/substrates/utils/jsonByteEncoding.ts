/**
 * JSON byte-encoding helpers for the HTTP wallet JSON substrate.
 *
 * BRC-100 byte fields (`AtomicBEEF`, `BEEF`, `Byte[]`) may be represented as
 * `Uint8Array` since the transaction-pipeline performance work. `JSON.stringify`
 * serializes a `Uint8Array` as a numeric-keyed OBJECT (`{"0":1,"1":2,...}`)
 * rather than a JSON array, which corrupts the wire format in both directions:
 * wallets responding with `JSON.stringify(result)` break every JSON-substrate
 * client (`ReaderUint8Array.makeReader: bin must be Uint8Array or number[]`),
 * and clients sending `Uint8Array` args (e.g. `inputBEEF`) corrupt requests.
 *
 * `walletJsonReplacer` makes serialization safe (use it in any
 * `JSON.stringify` of wallet args or results). `normalizeJsonMangledBytes`
 * repairs already-corrupted payloads produced by wallets that serialized
 * without the replacer, so clients remain compatible with deployed wallets.
 */

/** JSON.stringify replacer that encodes Uint8Array values as plain number arrays. */
export function walletJsonReplacer (_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value)
  return value
}

/**
 * Wallet result fields defined as bytes by BRC-100 / Wallet.interfaces.
 * Only values under these keys are ever repaired, so structured objects
 * elsewhere in a result can never be misinterpreted.
 */
const BYTE_FIELD_NAMES = new Set([
  'tx',
  'BEEF',
  'beef',
  'rawTx',
  'inputBEEF',
  'signature',
  'ciphertext',
  'plaintext',
  'hmac',
  'encryptedLinkage',
  'encryptedLinkageProof'
])

/** Convert a JSON-mangled Uint8Array ({"0":n,...}) to number[]; return undefined if not that shape. */
function asMangledBytes (value: unknown): number[] | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    return undefined
  }
  const obj = value as Record<number, unknown>
  const length = Object.keys(obj).length
  if (length === 0) return undefined
  const out: number[] = Array.from({ length })
  for (let i = 0; i < length; i++) {
    const byte = obj[i]
    // A missing index (non-contiguous keys) or non-numeric value means this is
    // an ordinary object, not a mangled byte array.
    if (typeof byte !== 'number') return undefined
    out[i] = byte
  }
  return out
}

/**
 * Recursively repair known byte fields that a wallet serialized as
 * numeric-keyed objects. Healthy values (arrays, Uint8Array, strings) and all
 * non-byte fields are returned untouched.
 */
export function normalizeJsonMangledBytes<T> (value: T): T {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const item of value) normalizeJsonMangledBytes(item)
    return value
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const child = obj[key]
    if (BYTE_FIELD_NAMES.has(key)) {
      const repaired = asMangledBytes(child)
      if (repaired !== undefined) {
        obj[key] = repaired
        continue
      }
    }
    normalizeJsonMangledBytes(child)
  }
  return value
}
