// Strict DAG-CBOR subset used by Mandala (BRC-162 spec §3.5). Hand-rolled on
// purpose: one whitelist that the TS and Go overlays implement byte for byte.
// Map keys are text and sorted by encoded bytes, which for text keys equals
// DAG-CBOR's length-first order.

export type StrictCborValue = bigint | Uint8Array | string | null | boolean | StrictCborMap
export interface StrictCborMap {
  readonly [key: string]: StrictCborValue
}
export type StrictCborInput = StrictCborValue | number

export const STRICT_CBOR_MAX_BYTES = 4096
export const STRICT_CBOR_MAX_DEPTH = 4
const MAX_UINT64 = (1n << 64n) - 1n

type Encodable = StrictCborInput | { readonly [key: string]: Encodable }

export class StrictCborError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrictCborError'
  }
}

const fail = (message: string): never => {
  throw new StrictCborError(message)
}

const utf8Encoder = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF in the text; the decoder would otherwise
// strip it and the value would no longer round-trip. The default label is UTF-8.
const utf8Decoder = new TextDecoder(undefined, { ignoreBOM: true })

const bigEndian = (value: bigint, size: number): number[] => {
  const out = Array.from({ length: size }, () => 0)
  let rest = value
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

// Minimal definite-length header for a major type and an unsigned argument.
const header = (major: number, value: bigint): number[] => {
  const m = major << 5
  if (value < 24n) return [m | Number(value)]
  if (value < 0x100n) return [m | 24, Number(value)]
  if (value < 0x10000n) return [m | 25, ...bigEndian(value, 2)]
  if (value < 0x100000000n) return [m | 26, ...bigEndian(value, 4)]
  return [m | 27, ...bigEndian(value, 8)]
}

const compareBytes = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

// TextEncoder silently turns a lone surrogate into U+FFFD, which would change
// the value (and could make two distinct keys collide). Refuse instead. In a
// `u` regex a surrogate pair is one code point, so \p{Cs} matches only a lone
// surrogate.
const LONE_SURROGATE = /\p{Cs}/u
const hasLoneSurrogate = (s: string): boolean => LONE_SURROGATE.test(s)

const encodeText = (text: string): number[] => {
  if (hasLoneSurrogate(text)) fail('text contains a lone surrogate')
  const bytes = Array.from(utf8Encoder.encode(text))
  return [...header(3, BigInt(bytes.length)), ...bytes]
}

const isMapObject = (value: unknown): value is { readonly [key: string]: Encodable } =>
  Object.prototype.toString.call(value) === '[object Object]'

const encodeUint = (value: bigint | number): number[] => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0)
      fail('number must be a safe non-negative integer')
    return header(0, BigInt(value))
  }
  if (value < 0n || value > MAX_UINT64) fail('integer outside 0..2^64-1')
  return header(0, value)
}

const encodeValue = (value: Encodable, depth: number): number[] => {
  if (typeof value === 'bigint' || typeof value === 'number') return encodeUint(value)
  if (typeof value === 'string') return encodeText(value)
  if (value === null) return [0xf6]
  if (value === true) return [0xf5]
  if (value === false) return [0xf4]
  if (value instanceof Uint8Array) return [...header(2, BigInt(value.length)), ...value]
  if (isMapObject(value)) return encodeMap(value, depth + 1)
  return fail('unsupported value type')
}

const encodeMap = (map: { readonly [key: string]: Encodable }, depth: number): number[] => {
  if (depth > STRICT_CBOR_MAX_DEPTH) fail('map nesting deeper than 4')
  const entries = Object.entries(map).map(([k, v]) => ({ key: encodeText(k), value: v }))
  entries.sort((a, b) => compareBytes(a.key, b.key))
  const out = header(5, BigInt(entries.length))
  for (const e of entries) {
    for (const b of e.key) out.push(b)
    for (const b of encodeValue(e.value, depth)) out.push(b)
  }
  return out
}

export function encodeStrictCbor(map: {
  readonly [key: string]: StrictCborInput | { readonly [k: string]: StrictCborInput }
}): number[] {
  if (!isMapObject(map)) fail('top level must be a map')
  const out = encodeMap(map, 1)
  if (out.length > STRICT_CBOR_MAX_BYTES) fail('encoding exceeds 4096 bytes')
  return out
}

class Reader {
  pos = 0
  readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  byte(): number {
    if (this.pos >= this.bytes.length) fail('truncated input')
    return this.bytes[this.pos++]
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) fail('truncated input')
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  // Returns [major, value]; rejects indefinite/reserved and non-minimal headers.
  head(): [number, bigint] {
    const b = this.byte()
    const major = b >> 5
    const info = b & 0x1f
    if (info < 24) return [major, BigInt(info)]
    if (info > 27) fail(info === 31 ? 'indefinite length' : 'reserved additional info')
    let v = 0n
    for (const x of this.take(1 << (info - 24))) v = (v << 8n) | BigInt(x)
    const min = [24n, 0x100n, 0x10000n, 0x100000000n][info - 24]
    if (v < min) fail('non-minimal header')
    return [major, v]
  }

  // A byte or entry count can never exceed the input; this also keeps Number() exact.
  count(v: bigint): number {
    if (v > BigInt(this.bytes.length)) fail('length exceeds input')
    return Number(v)
  }
}

// Strict UTF-8 validation (RFC 3629): no overlongs, no surrogates, max
// U+10FFFF. Hand-rolled so the accept set is identical on every platform
// (Hermes/RN included) and mirrored exactly in Go.
// A lead byte maps to [continuation byte count, minimum code point, payload bits].
const utf8Lead = (c: number): [number, number, number] | undefined => {
  if (c >= 0xc2 && c <= 0xdf) return [1, 0x80, c & 0x1f]
  if (c >= 0xe0 && c <= 0xef) return [2, 0x800, c & 0x0f]
  if (c >= 0xf0 && c <= 0xf4) return [3, 0x10000, c & 0x07]
  return undefined
}

// Length in bytes of the valid sequence starting at b[i], or 0 when invalid.
const utf8SequenceLength = (b: Uint8Array, i: number): number => {
  const lead = utf8Lead(b[i])
  if (lead === undefined) return 0
  const [need, min] = lead
  let cp = lead[2]
  for (let k = 1; k <= need; k++) {
    const x = b[i + k]
    if (x === undefined || (x & 0xc0) !== 0x80) return 0
    cp = (cp << 6) | (x & 0x3f)
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0
  return need + 1
}

const validUtf8 = (b: Uint8Array): boolean => {
  let i = 0
  while (i < b.length) {
    if (b[i] < 0x80) {
      i += 1
      continue
    }
    const size = utf8SequenceLength(b, i)
    if (size === 0) return false
    i += size
  }
  return true
}

const decodeText = (bytes: Uint8Array): string => {
  if (!validUtf8(bytes)) fail('invalid UTF-8')
  return utf8Decoder.decode(bytes)
}

const decodeSimple = (v: bigint): StrictCborValue => {
  if (v === 20n) return false
  if (v === 21n) return true
  if (v === 22n) return null
  return fail('simple value or float not allowed')
}

const decodeValue = (r: Reader, depth: number): StrictCborValue => {
  const [major, v] = r.head()
  switch (major) {
    case 0:
      return v
    case 2:
      return Uint8Array.from(r.take(r.count(v)))
    case 3:
      return decodeText(r.take(r.count(v)))
    case 5:
      return decodeMapBody(r, r.count(v), depth + 1)
    case 7:
      return decodeSimple(v)
    default:
      return fail(`major type ${major} not allowed`)
  }
}

const decodeMapBody = (r: Reader, count: number, depth: number): StrictCborMap => {
  if (depth > STRICT_CBOR_MAX_DEPTH) fail('map nesting deeper than 4')
  // No prototype, and defineProperty rather than assignment: a key named
  // __proto__ must stay an ordinary own entry, never touch the prototype.
  const out: Record<string, StrictCborValue> = Object.create(null)
  let previous: Uint8Array | undefined
  for (let i = 0; i < count; i++) {
    const start = r.pos
    const [major, len] = r.head()
    if (major !== 3) fail('map key must be text')
    const key = decodeText(r.take(r.count(len)))
    const encodedKey = r.bytes.subarray(start, r.pos)
    if (previous !== undefined && compareBytes(previous, encodedKey) >= 0) {
      fail('map keys unsorted or duplicated')
    }
    previous = encodedKey
    const value = decodeValue(r, depth)
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}

export function decodeStrictCbor(input: readonly number[] | Uint8Array): StrictCborMap {
  if (input.length > STRICT_CBOR_MAX_BYTES) fail('input exceeds 4096 bytes')
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input)
  const r = new Reader(bytes)
  const [major, count] = r.head()
  if (major !== 5) fail('top level must be a map')
  const map = decodeMapBody(r, r.count(count), 1)
  if (r.pos !== bytes.length) fail('trailing bytes')
  // Belt and braces: whatever the decoder accepted must re-encode to the caller's
  // exact bytes. Compared with `input`, not `bytes`: Uint8Array.from wraps a
  // number[] entry outside 0..255 (0x101 reads as 0x01), and that must not pass.
  const again = encodeStrictCbor(map)
  if (compareBytes(again, input) !== 0) fail('non-canonical encoding')
  return map
}

export function tryDecodeStrictCbor(
  input: readonly number[] | Uint8Array
): StrictCborMap | undefined {
  try {
    return decodeStrictCbor(input)
  } catch (e) {
    if (e instanceof StrictCborError) return undefined
    throw e
  }
}
