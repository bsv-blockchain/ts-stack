// Strict DAG-CBOR (the IPLD profile), which BRC-162 requires payloads to be read as: definite
// lengths, minimal integer arguments, text keys in canonical order (shorter first, then
// bytewise) without duplicates, floats only as finite 64-bit values, no simple values beyond
// false/true/null, and tag 42 (a CID link) as the only tag. Hand-rolled on purpose: one
// decoder that the TS and Go overlays implement byte for byte, with identical messages, which
// the Mandala overlay copies into its reject reasons.
//
// The spec sets no size or nesting limit. STRICT_CBOR_MAX_DEPTH bounds container nesting only,
// so hostile input cannot exhaust the stack.
//
// Integers decode to bigint and floats to number. A float with an integral value (1.0) decodes
// to a number that re-encodes as an integer, as JS cannot keep the distinction; a canonical
// encoder never has to emit such a float, so this is a limitation of round-tripping, not of
// reading.

/** A tag 42 link: the CID bytes, which begin with the 0x00 identity multibase prefix. */
export class StrictCborLink {
  readonly cid: Uint8Array
  constructor(cid: Uint8Array) {
    this.cid = cid
  }
}

export type StrictCborValue =
  | bigint
  | number
  | Uint8Array
  | string
  | null
  | boolean
  | StrictCborValue[]
  | StrictCborMap
  | StrictCborLink
export interface StrictCborMap {
  readonly [key: string]: StrictCborValue
}
export type StrictCborInput = StrictCborValue | number

/** Anti-DoS bound on container nesting; the spec itself sets none. */
export const STRICT_CBOR_MAX_DEPTH = 1024
const MAX_UINT64 = (1n << 64n) - 1n
const CID_TAG = 42n

type Encodable =
  | bigint
  | number
  | string
  | null
  | boolean
  | Uint8Array
  | StrictCborLink
  | readonly Encodable[]
  | { readonly [key: string]: Encodable }

export class StrictCborError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrictCborError'
  }
}

const fail = (message: string): never => {
  throw new StrictCborError(message)
}

const tooDeep = (): never => fail(`nesting deeper than ${STRICT_CBOR_MAX_DEPTH}`)

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

const isMapObject = (value: unknown): value is { readonly [key: string]: Encodable } => {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const isCid = (bytes: Uint8Array): boolean => bytes.length > 0 && bytes[0] === 0

const encodeInteger = (value: bigint): number[] => {
  if (value >= 0n) {
    if (value > MAX_UINT64) fail('integer outside -2^64..2^64-1')
    return header(0, value)
  }
  const argument = -1n - value
  if (argument > MAX_UINT64) fail('integer outside -2^64..2^64-1')
  return header(1, argument)
}

const encodeNumber = (value: number): number[] => {
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) fail('number must be a safe integer or a finite float')
    return encodeInteger(BigInt(value))
  }
  if (!Number.isFinite(value)) fail('number must be a safe integer or a finite float')
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return [0xfb, ...new Uint8Array(view.buffer)]
}

const encodeLink = (link: StrictCborLink): number[] => {
  if (!isCid(link.cid)) fail('invalid CID')
  return [0xd8, Number(CID_TAG), ...header(2, BigInt(link.cid.length)), ...link.cid]
}

const encodeValue = (value: Encodable, depth: number): number[] => {
  if (typeof value === 'bigint') return encodeInteger(value)
  if (typeof value === 'number') return encodeNumber(value)
  if (typeof value === 'string') return encodeText(value)
  if (value === null) return [0xf6]
  if (value === true) return [0xf5]
  if (value === false) return [0xf4]
  if (value instanceof Uint8Array) return [...header(2, BigInt(value.length)), ...value]
  if (value instanceof StrictCborLink) return encodeLink(value)
  if (Array.isArray(value)) return encodeArray(value, depth + 1)
  if (isMapObject(value)) return encodeMap(value, depth + 1)
  return fail('unsupported value type')
}

const encodeArray = (items: readonly Encodable[], depth: number): number[] => {
  if (depth > STRICT_CBOR_MAX_DEPTH) tooDeep()
  const out = header(4, BigInt(items.length))
  for (const item of items) for (const b of encodeValue(item, depth)) out.push(b)
  return out
}

const encodeMap = (map: { readonly [key: string]: Encodable }, depth: number): number[] => {
  if (depth > STRICT_CBOR_MAX_DEPTH) tooDeep()
  const entries = Object.entries(map).map(([k, v]) => ({ key: encodeText(k), value: v }))
  entries.sort((a, b) => compareBytes(a.key, b.key))
  const out = header(5, BigInt(entries.length))
  for (const e of entries) {
    for (const b of e.key) out.push(b)
    for (const b of encodeValue(e.value, depth)) out.push(b)
  }
  return out
}

/** Encodes a map as strict DAG-CBOR. Integral numbers encode as integers, other numbers as float64. */
export function encodeStrictCbor(map: { readonly [key: string]: Encodable }): number[] {
  if (!isMapObject(map)) fail('top level must be a map')
  return encodeMap(map, 1)
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

  // Returns [major, additional info, argument]; rejects indefinite/reserved and non-minimal
  // headers. A float's argument is its IEEE 754 bits and is not subject to minimality.
  head(): [number, number, bigint] {
    const b = this.byte()
    const major = b >> 5
    const info = b & 0x1f
    if (info < 24) return [major, info, BigInt(info)]
    if (info > 27) fail(info === 31 ? 'indefinite length' : 'reserved additional info')
    let v = 0n
    for (const x of this.take(1 << (info - 24))) v = (v << 8n) | BigInt(x)
    if (major === 7) {
      // A one-byte simple value must be 32 or more; smaller ones have a one-byte form.
      if (info === 24 && v < 32n) fail('non-minimal header')
      return [major, info, v]
    }
    const min = [24n, 0x100n, 0x10000n, 0x100000000n][info - 24]
    if (v < min) fail('non-minimal header')
    return [major, info, v]
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

const decodeSimpleOrFloat = (info: number, v: bigint): StrictCborValue => {
  if (info === 27) {
    const view = new DataView(new ArrayBuffer(8))
    view.setBigUint64(0, v)
    const value = view.getFloat64(0)
    if (!Number.isFinite(value)) fail('non-finite float')
    return value
  }
  if (info === 25 || info === 26) return fail('float must be 64-bit')
  if (v === 20n) return false
  if (v === 21n) return true
  if (v === 22n) return null
  return fail('simple value not allowed')
}

const decodeLink = (r: Reader, tag: bigint, depth: number): StrictCborLink => {
  if (tag !== CID_TAG) fail('only tag 42 is allowed')
  const content = decodeValue(r, depth)
  if (!(content instanceof Uint8Array) || !isCid(content)) fail('invalid CID')
  return new StrictCborLink(content as Uint8Array)
}

const decodeValue = (r: Reader, depth: number): StrictCborValue => {
  const [major, info, v] = r.head()
  switch (major) {
    case 0:
      return v
    case 1:
      return -1n - v
    case 2:
      return Uint8Array.from(r.take(r.count(v)))
    case 3:
      return decodeText(r.take(r.count(v)))
    case 4:
      return decodeArrayBody(r, r.count(v), depth + 1)
    case 5:
      return decodeMapBody(r, r.count(v), depth + 1)
    case 6:
      return decodeLink(r, v, depth)
    default:
      return decodeSimpleOrFloat(info, v)
  }
}

const decodeArrayBody = (r: Reader, count: number, depth: number): StrictCborValue[] => {
  if (depth > STRICT_CBOR_MAX_DEPTH) tooDeep()
  const out: StrictCborValue[] = []
  for (let i = 0; i < count; i++) out.push(decodeValue(r, depth))
  return out
}

const decodeMapBody = (r: Reader, count: number, depth: number): StrictCborMap => {
  if (depth > STRICT_CBOR_MAX_DEPTH) tooDeep()
  // No prototype, and defineProperty rather than assignment: a key named
  // __proto__ must stay an ordinary own entry, never touch the prototype.
  const out: Record<string, StrictCborValue> = Object.create(null)
  let previous: Uint8Array | undefined
  for (let i = 0; i < count; i++) {
    const start = r.pos
    const [major, , len] = r.head()
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

const toBytes = (input: readonly number[] | Uint8Array): Uint8Array => {
  if (input instanceof Uint8Array) return input
  // Uint8Array.from would wrap an entry outside 0..255 (0x101 reads as 0x01); refuse instead.
  for (const b of input)
    if (!Number.isInteger(b) || b < 0 || b > 255) fail('input bytes outside 0..255')
  return Uint8Array.from(input)
}

/** Decodes strict DAG-CBOR whose top level is a map; any deviation is a `StrictCborError`. */
export function decodeStrictCbor(input: readonly number[] | Uint8Array): StrictCborMap {
  const bytes = toBytes(input)
  const r = new Reader(bytes)
  const [major, , count] = r.head()
  if (major !== 5) fail('top level must be a map')
  const map = decodeMapBody(r, r.count(count), 1)
  if (r.pos !== bytes.length) fail('trailing bytes')
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
