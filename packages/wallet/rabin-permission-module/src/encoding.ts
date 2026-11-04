/**
 * BRC-206 result encoding: a sequence of fields, each a 2-byte little-endian length followed by a
 * minimally encoded non-negative Bitcoin Script number.
 */

const MAX_FIELD_BYTES = 0xffff

/** Minimal non-negative Script number: LE magnitude, plus a 0x00 sign byte when the top bit is set. */
export function scriptNum(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError('RABIN: a Script number value must be a non-negative bigint')
  }
  if (value === 0n) return new Uint8Array(0)
  const bytes: number[] = []
  let rest = value
  while (rest > 0n) {
    bytes.push(Number(rest & 0xffn))
    rest >>= 8n
  }
  if ((bytes.at(-1)! & 0x80) !== 0) bytes.push(0x00)
  return Uint8Array.from(bytes)
}

/** Strict inverse of `scriptNum`: rejects negative and non-minimal encodings. */
export function scriptNumToBigInt(bytes: ArrayLike<number>): bigint {
  const length = bytes.length
  if (length === 0) return 0n
  const last = bytes[length - 1]
  if ((last & 0x80) !== 0) throw new RangeError('RABIN: negative Script number')
  if (last === 0x00 && (length === 1 || (bytes[length - 2] & 0x80) === 0)) {
    throw new RangeError('RABIN: non-minimal Script number')
  }
  let value = 0n
  for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  return value
}

/** Frames each value as `len_lo len_hi value…` and returns a plain byte array. */
export function encodeFields(fields: ArrayLike<number>[]): number[] {
  const out: number[] = []
  for (const field of fields) {
    if (field.length > MAX_FIELD_BYTES) throw new RangeError('RABIN: field exceeds 65535 bytes')
    out.push(field.length & 0xff, field.length >> 8)
    for (const byte of Array.from(field)) out.push(byte)
  }
  return out
}

/** Splits a field sequence; throws on a truncated length or value. */
export function decodeFields(bytes: ArrayLike<number>): Uint8Array[] {
  const out: Uint8Array[] = []
  let i = 0
  while (i < bytes.length) {
    if (i + 2 > bytes.length) throw new RangeError('RABIN: truncated field length')
    const length = bytes[i] | (bytes[i + 1] << 8)
    i += 2
    if (i + length > bytes.length) throw new RangeError('RABIN: truncated field value')
    out.push(Uint8Array.from(Array.prototype.slice.call(bytes, i, i + length) as number[]))
    i += length
  }
  return out
}

/** Encodes a `key` result: one field, `n`. */
export function encodeKeyResult(n: bigint): number[] {
  return encodeFields([scriptNum(n)])
}

/** Encodes a `sign` result: two fields, `sig` then `padding`. */
export function encodeSignResult(sig: bigint, padding: bigint): number[] {
  return encodeFields([scriptNum(sig), scriptNum(padding)])
}

/** Reads `n` from a `key` result's `ciphertext`. */
export function decodeKeyResult(ciphertext: ArrayLike<number>): bigint {
  const fields = decodeFields(ciphertext)
  if (fields.length !== 1) throw new RangeError('RABIN: a key result has exactly one field')
  return scriptNumToBigInt(fields[0])
}

/** Reads `(sig, padding)` from a `sign` result's `ciphertext`. */
export function decodeSignResult(ciphertext: ArrayLike<number>): { sig: bigint; padding: bigint } {
  const fields = decodeFields(ciphertext)
  if (fields.length !== 2) throw new RangeError('RABIN: a sign result has exactly two fields')
  return { sig: scriptNumToBigInt(fields[0]), padding: scriptNumToBigInt(fields[1]) }
}
