import type { AtomicBEEF } from './Wallet.interfaces.js'

const hasOwn = Object.prototype.hasOwnProperty

const walletByteFieldNames = new Set([
  'BEEF',
  'atomicBEEF',
  'beef',
  'ciphertext',
  'competingBeef',
  'data',
  'encryptedLinkage',
  'encryptedLinkageProof',
  'hashToDirectlySign',
  'hashToDirectlyVerify',
  'hmac',
  'inputBEEF',
  'payload',
  'plaintext',
  'signature',
  'transaction',
  'tx'
])

function isUint8Array(value: unknown): value is Uint8Array {
  if (value == null || typeof value !== 'object' || typeof ArrayBuffer === 'undefined') return false
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  )
}

function isByte(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255
}

function isUnsupportedBinaryView(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof ArrayBuffer !== 'undefined' &&
    (ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === '[object ArrayBuffer]')
  )
}

/**
 * Normalizes the runtime representations used for BRC-100 byte arrays.
 *
 * Healthy `number[]` and `Uint8Array` values are returned by identity so the
 * common path does not allocate. The fallback recovers the contiguous
 * numeric-key object produced by `JSON.stringify(new Uint8Array(...))` in
 * historical JSON transports. Invalid, sparse, or non-byte input is rejected.
 */
export function normalizeBRC100ByteArray(value: unknown): AtomicBEEF | undefined {
  if (isUint8Array(value)) return value
  if (isUnsupportedBinaryView(value)) return undefined

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!hasOwn.call(value, i) || !isByte(value[i])) return undefined
    }
    return value as number[]
  }

  if (value == null || typeof value !== 'object') return undefined

  try {
    const keys = Object.keys(value)
    // JSON.stringify(new Uint8Array()) and a legitimate empty JSON object are
    // indistinguishable. Require at least one byte for historical recovery;
    // callers can represent an intentional empty byte sequence as [] instead.
    if (keys.length === 0) return undefined
    const bytes: number[] = []
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== String(i)) return undefined
      const byte = (value as Record<string, unknown>)[keys[i]]
      if (!isByte(byte)) return undefined
      bytes.push(byte)
    }
    return bytes
  } catch {
    return undefined
  }
}

/** Convert a valid BRC-100 byte array to the portable JSON `number[]` form. */
export function toBRC100PortableByteArray(value: unknown): number[] | undefined {
  const bytes = normalizeBRC100ByteArray(value)
  if (bytes == null) return undefined
  return Array.isArray(bytes) ? bytes : Array.from(bytes)
}

/** JSON replacer that preserves `Uint8Array` values as portable JSON arrays. */
export function brc100JsonReplacer(
  this: Record<string, unknown>,
  key: string,
  value: unknown
): unknown {
  // Buffer.toJSON runs before a replacer. Inspect the holder so Node Buffers
  // retain the same portable array contract as browser Uint8Array values.
  const original = this == null ? undefined : this[key]
  // Serialization may safely identify real typed arrays, but it must never
  // reinterpret a plain numeric-key object. Such objects are valid arbitrary
  // application JSON and are indistinguishable from historical Uint8Array
  // damage once they have been parsed. Recovery belongs at typed boundaries.
  if (isUint8Array(original)) return Array.from(original)
  return isUint8Array(value) ? Array.from(value) : value
}

/** Serialize a BRC-100 payload without allowing typed byte arrays to become objects. */
export function stringifyBRC100(value: unknown, space?: string | number): string {
  const serialized = JSON.stringify(value, brc100JsonReplacer, space)
  if (serialized === undefined) {
    throw new TypeError('BRC-100 JSON payload is not serializable')
  }
  return serialized
}

/**
 * Repairs byte arrays only in explicitly selected own fields of one protocol
 * object. This non-recursive helper is for envelopes that also contain opaque
 * application data, where field-name-based traversal would be destructive.
 */
export function normalizeBRC100ByteFields<T>(value: T, fieldNames: readonly string[]): T {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  for (const fieldName of fieldNames) {
    if (!hasOwn.call(record, fieldName)) continue
    const fieldValue = record[fieldName]
    // At a schema-owned byte field, an empty JSON object can only be the
    // historical encoding of an empty Uint8Array. Generic and recursive
    // normalization deliberately leave the same ambiguous shape untouched.
    const bytes =
      fieldValue != null &&
      typeof fieldValue === 'object' &&
      !Array.isArray(fieldValue) &&
      !isUint8Array(fieldValue) &&
      Object.keys(fieldValue).length === 0
        ? []
        : normalizeBRC100ByteArray(fieldValue)
    if (bytes != null) record[fieldName] = bytes
  }
  return value
}

function visitBRC100WalletByteField(
  candidate: Record<string, unknown>,
  key: string,
  fieldValue: unknown,
  visit: (value: unknown) => void
): void {
  const bytes = normalizeBRC100ByteArray(fieldValue)
  if (bytes != null) candidate[key] = bytes
  else visit(fieldValue)
}

/**
 * Repairs known byte fields in a wallet request, result, or serialized wallet
 * error. This is intentionally field-aware: unrelated numeric-key objects are
 * left untouched. Parsed JSON objects are normalized in place.
 */
export function normalizeBRC100WalletByteFields<T>(value: T): T {
  const seen = new WeakSet<object>()

  const visit = (candidate: unknown): void => {
    if (candidate == null || typeof candidate !== 'object' || isUint8Array(candidate)) return
    if (seen.has(candidate)) return
    seen.add(candidate)

    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }

    for (const [key, fieldValue] of Object.entries(candidate)) {
      if (walletByteFieldNames.has(key)) {
        visitBRC100WalletByteField(candidate as Record<string, unknown>, key, fieldValue, visit)
      } else {
        visit(fieldValue)
      }
    }
  }

  visit(value)
  return value
}
