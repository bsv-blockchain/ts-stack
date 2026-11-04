// BRC-162 1Color attribute reader: the reserved `req` and `ext` payload keys and
// processing-profile identifiers (BRC-162 "Processing profiles", pinned 0162:171-191),
// read under the BRC-207 wallet rules (pinned 0207:82-93): absent and malformed are
// distinct, and nothing is recovered from a payload that is not a strictly valid
// DAG-CBOR map. Every function here is pure and total; none throws on any input.
import type { ScriptChunk } from '@bsv/sdk/script'
import { splitPayload } from './Bsv21Binary.js'
import { StrictCborLink, tryDecodeStrictCbor } from './strictCbor.js'
import type { StrictCborMap, StrictCborValue } from './strictCbor.js'

/** A required-profile descriptor: exactly `{params, version}` (0162:181-183). */
export interface OneColorProfileDescriptor {
  /** positive uint32: 1..4294967295 */
  version: number
  /** any DAG-CBOR value, including null (0162:182-183) */
  params: StrictCborValue
}

/** Absent and malformed are distinct (0207:88-93). */
export type OneColorField<T> =
  { status: 'absent' } | { status: 'valid'; value: T } | { status: 'malformed'; reason: string }

export interface OneColorAttributes {
  /** 'absent' = no payload push; 'empty' = zero-byte payload (OP_0 OP_DROP);
   *  'opaque' = nonzero bytes that are not a strictly valid DAG-CBOR map (no partial recovery, 0207:82-87);
   *  'map' = strictly valid DAG-CBOR map. Every field below is { status: 'absent' } unless payload === 'map'. */
  payload: 'absent' | 'empty' | 'opaque' | 'map'
  /** uint 0..18 (0162:246-252); anything else is malformed */
  dec: OneColorField<number>
  /** text */
  sym: OneColorField<string>
  /** exactly [text, bytes]; display MUST treat malformed as absent (0162:240) */
  icon: OneColorField<{ mediaType: string; bytes: Uint8Array }>
  /** map; keys satisfy isProfileId; values exactly {params, version} */
  req: OneColorField<ReadonlyMap<string, OneColorProfileDescriptor>>
  /** map; keys satisfy isProfileId */
  ext: OneColorField<ReadonlyMap<string, StrictCborValue>>
  /** Exact wire span of the `req` VALUE inside the payload (not the whole payload); canonical because only
   *  strictly decoded payloads reach 'map'. Set iff req.status === 'valid'. */
  reqBytes?: Uint8Array
  /** The decoded map, iff payload === 'map'. */
  map?: StrictCborMap
}

const PROFILE_ID_MAX_BYTES = 200
// The pattern admits only ASCII, so string length equals the byte count.
const PROFILE_ID_RE = /^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/

/** 0162:178-183: case-sensitive ASCII URI, 1..200 bytes, ^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$ */
export function isProfileId(id: string): boolean {
  return typeof id === 'string' && id.length <= PROFILE_ID_MAX_BYTES && PROFILE_ID_RE.test(id)
}

type Field<T> = OneColorField<T>

// Fresh objects per call, so no caller can mutate a shared result.
const absent = (): { status: 'absent' } => ({ status: 'absent' })
const malformed = (reason: string): { status: 'malformed'; reason: string } => ({
  status: 'malformed',
  reason
})

const DEC_MAX = 18n

const withoutFields = (payload: 'absent' | 'empty' | 'opaque'): OneColorAttributes => ({
  payload,
  dec: absent(),
  sym: absent(),
  icon: absent(),
  req: absent(),
  ext: absent()
})

const has = (map: StrictCborMap, key: string): boolean => Object.hasOwn(map, key)

// dec: a CBOR unsigned integer 0..18 (0162:246-252). A float (even 2.0) decodes as a
// number, not a bigint, so it is malformed rather than coerced.
const readDec = (map: StrictCborMap): Field<number> => {
  if (!has(map, 'dec')) return absent()
  const v = map.dec
  if (typeof v === 'bigint' && v >= 0n && v <= DEC_MAX) return { status: 'valid', value: Number(v) }
  return malformed('dec must be an unsigned integer 0..18')
}

const readSym = (map: StrictCborMap): Field<string> => {
  if (!has(map, 'sym')) return absent()
  const v = map.sym
  if (typeof v === 'string') return { status: 'valid', value: v }
  return malformed('sym must be text')
}

// icon: exactly [text, bytes] (0162:236-240); any other shape is malformed.
const readIcon = (map: StrictCborMap): Field<{ mediaType: string; bytes: Uint8Array }> => {
  if (!has(map, 'icon')) return absent()
  const v = map.icon
  if (Array.isArray(v) && v.length === 2) {
    const [mediaType, bytes] = v
    if (typeof mediaType === 'string' && bytes instanceof Uint8Array) {
      return { status: 'valid', value: { mediaType, bytes } }
    }
  }
  return malformed('icon must be exactly [text, bytes]')
}

// A CBOR map as the strict decoder returns it: a (null-prototype) object that is not an
// array, byte string or tag-42 link.
const isCborMap = (v: StrictCborValue | undefined): v is StrictCborMap =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Uint8Array) &&
  !(v instanceof StrictCborLink)

const VERSION_MAX = 4294967295n

// A descriptor is exactly {params, version}, version a CBOR uint 1..2^32-1 (0162:181-183).
// A float version (even 1.0) decodes as a number, not a bigint, so it is malformed.
const readDescriptor = (v: StrictCborValue): OneColorProfileDescriptor | undefined => {
  if (!isCborMap(v)) return undefined
  if (Object.keys(v).length !== 2 || !has(v, 'params') || !has(v, 'version')) return undefined
  const version = v.version
  if (typeof version !== 'bigint' || version < 1n || version > VERSION_MAX) return undefined
  return { version: Number(version), params: v.params }
}

// req: a map from profile ids to descriptors (0162:178-191). Profile ids always contain ':',
// so none is an integer-like key and Object.keys keeps the decoded (canonical) order.
const readReq = (map: StrictCborMap): Field<ReadonlyMap<string, OneColorProfileDescriptor>> => {
  if (!has(map, 'req')) return absent()
  const v = map.req
  if (!isCborMap(v)) return malformed('req must be a map')
  const out = new Map<string, OneColorProfileDescriptor>()
  for (const id of Object.keys(v)) {
    if (!isProfileId(id)) return malformed('req keys must be processing-profile identifiers')
    const descriptor = readDescriptor(v[id])
    if (descriptor === undefined) {
      return malformed('req values must be exactly {params, version} with version 1..4294967295')
    }
    out.set(id, descriptor)
  }
  return { status: 'valid', value: out }
}

// ext: a map from profile ids to any value (0162:184-187).
const readExt = (map: StrictCborMap): Field<ReadonlyMap<string, StrictCborValue>> => {
  if (!has(map, 'ext')) return absent()
  const v = map.ext
  if (!isCborMap(v)) return malformed('ext must be a map')
  const out = new Map<string, StrictCborValue>()
  for (const id of Object.keys(v)) {
    if (!isProfileId(id)) return malformed('ext keys must be processing-profile identifiers')
    out.set(id, v[id])
  }
  return { status: 'valid', value: out }
}

// ---- exact byte span of a top-level value -------------------------------------------------
// These helpers only ever run over bytes that decodeStrictCbor has already accepted (definite
// lengths, minimal heads, every count within the input), so they validate nothing.

// Reads a CBOR head at p: [major, argument, position after the head].
const headAt = (b: Uint8Array, p: number): [number, bigint, number] => {
  const major = b[p] >> 5
  const info = b[p] & 0x1f
  if (info < 24) return [major, BigInt(info), p + 1]
  const width = 1 << (info - 24)
  let arg = 0n
  for (let i = 1; i <= width; i++) arg = (arg << 8n) | BigInt(b[p + i])
  return [major, arg, p + 1 + width]
}

// The end of the data item starting at p. Iterative, so nesting depth costs no stack.
const valueEnd = (b: Uint8Array, p: number): number => {
  let pending = 1
  while (pending > 0) {
    const [major, arg, next] = headAt(b, p)
    pending--
    p = next
    // Majors 2..5 carry counts the decoder bounded by the input length, so Number() is exact.
    if (major === 2 || major === 3) p += Number(arg)
    else if (major === 4) pending += Number(arg)
    else if (major === 5) pending += 2 * Number(arg)
    else if (major === 6) pending += 1
    // majors 0, 1 and 7 (ints, simple values, floats) are the head alone
  }
  return p
}

const sameBytes = (
  b: Uint8Array,
  start: number,
  end: number,
  expected: readonly number[]
): boolean => {
  if (end - start !== expected.length) return false
  for (let i = 0; i < expected.length; i++) if (b[start + i] !== expected[i]) return false
  return true
}

// The encoded text key 'req' (0x63 'r' 'e' 'q'); keys are compared as whole encodings.
const REQ_KEY = [0x63, 0x72, 0x65, 0x71] as const

// [start, end) of the value stored under `key` in the top-level map, or undefined.
const topLevelSpan = (b: Uint8Array, key: readonly number[]): [number, number] | undefined => {
  const [, count, first] = headAt(b, 0)
  let p = first
  for (let i = 0n; i < count; i++) {
    const keyEnd = valueEnd(b, p)
    const valueStart = keyEnd
    const end = valueEnd(b, valueStart)
    if (sameBytes(b, p, keyEnd, key)) return [valueStart, end]
    p = end
  }
  return undefined
}

const isByteContainer = (v: unknown): v is readonly number[] | Uint8Array =>
  Array.isArray(v) || v instanceof Uint8Array

// Reads the caller's bytes exactly once into a private copy, so the decoder and the span finder
// see the same validated bytes even if the caller's array changes between reads (a getter or
// Proxy). An entry outside the integers 0..255 gives undefined (=> 'opaque'), as in the decoder.
// Throws (=> 'opaque') on a non-iterable runtime value.
const snapshot = (payload: readonly number[] | Uint8Array): Uint8Array | undefined => {
  if (payload instanceof Uint8Array) return Uint8Array.from(payload)
  const out: number[] = []
  for (const b of payload) {
    if (!Number.isInteger(b) || b < 0 || b > 255) return undefined
    out.push(b)
  }
  return Uint8Array.from(out)
}

/**
 * Reads the BRC-162 1Color payload attributes. Pure and total: never throws.
 * `undefined` => 'absent'; a zero-length array or Uint8Array => 'empty'; anything else that is
 * not a strictly valid DAG-CBOR map (non-arrays, entries outside 0..255, any decoder error)
 * => 'opaque', with every field absent and nothing recovered (0207:82-87). In a valid map a
 * reserved key that is present but ill-shaped is 'malformed', never 'absent' (0207:88-93).
 * `reqBytes` is set iff `req` is valid.
 */
export function readOneColorAttributes(
  payload: readonly number[] | Uint8Array | undefined
): OneColorAttributes {
  if (payload === undefined) return withoutFields('absent')
  let bytes: Uint8Array | undefined
  let map: StrictCborMap | undefined
  try {
    if (isByteContainer(payload) && payload.length === 0) return withoutFields('empty')
    bytes = snapshot(payload)
    // tryDecodeStrictCbor rethrows anything that is not a StrictCborError; every error here
    // (including a TypeError on a non-iterable runtime value) also means 'opaque'.
    map = bytes === undefined ? undefined : tryDecodeStrictCbor(bytes)
  } catch {
    map = undefined
  }
  if (map === undefined || bytes === undefined) return withoutFields('opaque')
  const req = readReq(map)
  const attributes: OneColorAttributes = {
    payload: 'map',
    dec: readDec(map),
    sym: readSym(map),
    icon: readIcon(map),
    req,
    ext: readExt(map),
    map
  }
  if (req.status !== 'valid') return attributes
  // reqBytes is the exact wire span of the req value, not a re-encoding of map.req: the strict
  // decoder accepted these very bytes, so the span is already canonical, and a re-encode would
  // fold an integral float (1.0) into an integer that a Go reader keeps distinct.
  const span = topLevelSpan(bytes, REQ_KEY)
  // Unreachable for a decoded map that has 'req'; fail closed rather than report a valid req
  // without its bytes.
  if (span === undefined) return { ...attributes, req: malformed('req span not found') }
  return { ...attributes, reqBytes: bytes.slice(span[0], span[1]) }
}

// The canonical DAG-CBOR encoding of the empty map: an absent deploy req counts as `a0`
// (0162:188-191).
const EMPTY_MAP = Uint8Array.of(0xa0)

// Length first, then every byte; no early exit on content mismatch.
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Whether a later output's `req` is consistent with the deploy's (0162:188-191). Pure and total.
 * Fixed fail-closed evaluation order (contract §1):
 * 1. deploy req malformed => false, for every later output, including one that omits req;
 * 2. later req absent (also a later payload that is absent, empty or opaque, 0207:85-87) => true;
 * 3. later req malformed => false;
 * 4. otherwise later.reqBytes must equal the deploy's req bytes byte for byte, where an absent
 *    deploy req (any deploy payload kind) is the empty map `a0`. Comparing exact wire bytes keeps
 *    an integral float (1.0) distinct from an integer (1).
 * A `valid` req without its `reqBytes` (never produced by readOneColorAttributes) fails closed.
 */
export function reqMatchesDeploy(deploy: OneColorAttributes, later: OneColorAttributes): boolean {
  if (deploy.req.status === 'malformed') return false
  if (later.req.status === 'absent') return true
  if (later.req.status === 'malformed') return false
  const deployBytes = deploy.req.status === 'valid' ? deploy.reqBytes : EMPTY_MAP
  const laterBytes = later.reqBytes
  if (!(deployBytes instanceof Uint8Array) || !(laterBytes instanceof Uint8Array)) return false
  return equalBytes(deployBytes, laterBytes)
}

/**
 * 0162:101/105: true iff the remainder starts with a single push (`OP_0`, `OP_1NEGATE`,
 * `OP_1`..`OP_16` or any data push, minimal or not) followed by `OP_DROP`. A token output
 * whose remainder starts that way, written with no payload, would be decoded as carrying
 * that push as its payload, so the encoder must write `OP_0 OP_DROP` first. Uses the
 * decoder's own payload detector, so there is one definition of "push".
 */
export function needsEmptyPayloadMarker(remainder: readonly ScriptChunk[]): boolean {
  return splitPayload([...remainder]).payload !== undefined
}
