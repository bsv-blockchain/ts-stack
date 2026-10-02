import { BigNumber, LockingScript, OP } from '@bsv/sdk'
import type { ScriptChunk } from '@bsv/sdk'
import fc from 'fast-check'

import {
  BSV21_MAX_AMOUNT,
  Bsv21Binary,
  Bsv21BinaryError,
  decodeAmountChunk,
  encodeAmountChunk,
  isTokenShaped,
  tokenIdFromString,
  tokenIdToString
} from '../Bsv21Binary.js'
import type { Bsv21Role } from '../Bsv21Binary.js'
import {
  STRICT_CBOR_MAX_BYTES,
  STRICT_CBOR_MAX_DEPTH,
  StrictCborError,
  decodeStrictCbor,
  encodeStrictCbor,
  tryDecodeStrictCbor
} from '../strictCbor.js'
import type { StrictCborMap, StrictCborValue } from '../strictCbor.js'
import { createMinimallyEncodedScriptChunk, decodeScriptNumChunk } from '../mandala-encoding.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const MAX_UINT64 = (1n << 64n) - 1n
const hexOf = (bytes: ArrayLike<number>): string => Buffer.from(Array.from(bytes)).toString('hex')

const leafValue: fc.Arbitrary<StrictCborValue> = fc.oneof(
  fc.bigInt({ min: 0n, max: MAX_UINT64 }),
  fc.uint8Array({ maxLength: 16 }),
  fc.string({ unit: 'binary', maxLength: 8 }),
  fc.constant(null),
  fc.boolean()
)
const textKey = fc.string({ unit: 'binary', maxLength: 6 })

// The top-level map is depth 1; nested maps may reach STRICT_CBOR_MAX_DEPTH.
const mapAtDepth = (depth: number): fc.Arbitrary<StrictCborMap> => {
  const value =
    depth >= STRICT_CBOR_MAX_DEPTH
      ? leafValue
      : fc.oneof(
          { weight: 3, arbitrary: leafValue },
          { weight: 1, arbitrary: mapAtDepth(depth + 1) }
        )
  return fc.dictionary(textKey, value, { maxKeys: 3 })
}

// Generation is small, but the 4096-byte cap is a hard encoder limit: the encoder throws on an
// oversized map, so the predicate catches that and filters the map out instead of failing.
const encodesWithinCap = (map: StrictCborMap): boolean => {
  try {
    return encodeStrictCbor(map).length <= STRICT_CBOR_MAX_BYTES
  } catch {
    return false
  }
}
const strictMap = mapAtDepth(1).filter(encodesWithinCap)

// A deterministic, seed-driven shuffle of every map's own keys, at every depth.
const mixKey = (seed: number, key: string): number => {
  let h = seed | 0
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x45d9f3b) | 0
  return h
}
const permuteKeys = (value: StrictCborValue, seed: number): StrictCborValue => {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value
  const entries = Object.entries(value as StrictCborMap)
    .map(([k, v]) => [k, permuteKeys(v, seed)] as const)
    .sort((a, b) => mixKey(seed, a[0]) - mixKey(seed, b[0]))
  return Object.fromEntries(entries) as StrictCborMap
}

// Mutations of a valid encoding keep the accept path of the decoder well exercised.
const mutated = (map: StrictCborMap, index: number, byte: number, mode: number): number[] => {
  const bytes = encodeStrictCbor(map)
  const i = index % bytes.length
  if (mode === 0) return bytes
  if (mode === 1) return bytes.map((b, j) => (j === i ? byte : b))
  if (mode === 2) return bytes.slice(0, i)
  return [...bytes, byte]
}

const amountArb = fc.oneof(
  fc.bigInt({ min: 0n, max: BSV21_MAX_AMOUNT }),
  fc.bigInt({ min: 0n, max: 40n }),
  fc.integer({ min: 0, max: 64 }).chain(bits =>
    fc.constantFrom(-1n, 0n, 1n).map(delta => {
      const v = (1n << BigInt(bits)) + delta
      return v < 0n ? 0n : v > BSV21_MAX_AMOUNT ? BSV21_MAX_AMOUNT : v
    })
  )
)

// ---- strict CBOR reject messages (spec §3.5) ----------------------------------------------------
//
// The messages are a cross-engine contract (the overlay copies them into its reasons), so every
// class of reject below pins its exact message. Headers are built from RFC 8949 here, never with
// the encoder under test.

const NON_MINIMAL = 'non-minimal header'
const SIMPLE = 'simple value or float not allowed'
const LENGTH_EXCEEDS = 'length exceeds input'
const TRUNCATED = 'truncated input'
const NOT_A_MAP = 'top level must be a map'
const KEY_NOT_TEXT = 'map key must be text'

/** The StrictCborError message decoding `bytes` throws; fails the property when it accepts. */
const rejectMessage = (bytes: readonly number[]): string => {
  try {
    decodeStrictCbor(bytes)
  } catch (e) {
    expect(e).toBeInstanceOf(StrictCborError)
    return (e as Error).message
  }
  throw new Error(`expected ${hexOf(bytes)} to be refused`)
}

const bigEndian = (value: bigint, size: number): number[] =>
  Array.from({ length: size }, (_, i) => Number((value >> BigInt(8 * (size - 1 - i))) & 0xffn))

// Additional info 24..27 carry a 1, 2, 4 or 8 byte argument; each width has a smallest value
// that needs it.
const WIDTH_MINIMUM = [24n, 0x100n, 0x10000n, 0x100000000n]

const minimalHeader = (major: number, value: bigint): number[] => {
  const m = major << 5
  if (value < 24n) return [m | Number(value)]
  let width = WIDTH_MINIMUM.length - 1
  while (value < WIDTH_MINIMUM[width]) width--
  return [m | (24 + width), ...bigEndian(value, 1 << width)]
}

const argumentArb = fc.oneof(
  fc.bigInt({ min: 0n, max: 23n }),
  fc.bigInt({ min: 24n, max: 0xffffn }),
  fc.bigInt({ min: 0n, max: MAX_UINT64 })
)

// Where a header sits: the top level, the key of a one-entry map, or its value.
type Slot = 'top' | 'key' | 'value'
const slotArb = fc.constantFrom<Slot>('top', 'key', 'value')
const inSlot = (slot: Slot, header: readonly number[]): number[] => {
  if (slot === 'top') return [...header]
  if (slot === 'key') return [0xa1, ...header]
  return [0xa1, 0x61, 0x61, ...header]
}

/** The one-entry map `{a: <raw>}`. */
const underKeyA = (raw: readonly number[]): number[] => inSlot('value', raw)

/** A raw map of encoded `key value` entries, in the order given (at most 23 entries). */
const rawMap = (entries: readonly number[][]): number[] => [
  0xa0 + entries.length,
  ...entries.flat()
]
const entryOf = (key: string, value: StrictCborValue): number[] =>
  encodeStrictCbor({ [key]: value }).slice(1)

// The WHATWG fatal decoder accepts exactly RFC 3629 UTF-8: an independent oracle.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const isStrictUtf8 = (bytes: Uint8Array): boolean => {
  try {
    strictUtf8.decode(bytes)
    return true
  } catch {
    return false
  }
}

// ---- BRC-162 push rules (spec §3.1) ------------------------------------------------------------

const NOT_TOKEN = 'not a BRC-162 token output'
const TRUNCATED_PUSH = 'truncated push'
const BAD_ID = 'token id must be a direct 32-byte push'
const BAD_AMOUNT_PUSH = 'amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes'
const p2pkhTail = (pkh: readonly number[]): string => `76a914${hexOf(pkh)}88ac`

/** The decoder's message for a script, or undefined when it decodes. */
const decodeMessage = (script: LockingScript): string | undefined => {
  try {
    Bsv21Binary.decode(script)
    return undefined
  } catch (e) {
    expect(e).toBeInstanceOf(Bsv21BinaryError)
    return (e as Error).message
  }
}

// The layout marker, stated from the spec: two pushes then OP_2DROP. A push is any data push
// opcode, OP_1NEGATE or OP_1..OP_16.
const isPushOpcode = (op: number): boolean =>
  op <= OP.OP_PUSHDATA4 || op === OP.OP_1NEGATE || (op >= OP.OP_1 && op <= OP.OP_16)
const hasLayoutMarker = (chunks: readonly ScriptChunk[]): boolean =>
  chunks.length >= 3 &&
  isPushOpcode(chunks[0].op) &&
  isPushOpcode(chunks[1].op) &&
  chunks[2].op === OP.OP_2DROP

/**
 * What a direct push of `data` in the amount slot reads as, or its refusal, with the SDK's
 * script-number reader as the oracle: the sign bit first, then minimality, then the range.
 */
const directAmountOracle = (data: number[]): bigint | string => {
  if (((data.at(-1) ?? 0) & 0x80) !== 0) return 'amount must not be negative'
  let value: bigint
  try {
    value = BigInt(BigNumber.fromScriptNum(data, true).toString())
  } catch {
    return 'amount is not minimally encoded'
  }
  if (value <= 16n) return 'amounts 0..16 must use OP_0/OP_1..OP_16'
  if (value > BSV21_MAX_AMOUNT) return 'amount exceeds 2^64-1'
  return value
}

/** What the decoder must make of a chunk in the amount slot. */
const amountSlotOracle = (chunk: ScriptChunk): bigint | string => {
  if (chunk.op === OP.OP_0) return 0n
  if (chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16) return BigInt(chunk.op - OP.OP_1 + 1)
  const direct = chunk.op >= 1 && chunk.op <= 9 && chunk.data?.length === chunk.op
  return direct ? directAmountOracle(chunk.data ?? []) : BAD_AMOUNT_PUSH
}

// The minimal push for raw bytes (MINIMALDATA), stated from the consensus rule.
const minimalPushOp = (data: Uint8Array): number => {
  if (data.length === 0) return OP.OP_0
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return OP.OP_1 + data[0] - 1
  if (data.length === 1 && data[0] === 0x81) return OP.OP_1NEGATE
  if (data.length <= 75) return data.length
  return data.length <= 0xff ? OP.OP_PUSHDATA1 : OP.OP_PUSHDATA2
}

interface PushForm {
  op: number
  hex: string
}

const littleEndianHex = (value: number, size: number): string =>
  hexOf(bigEndian(BigInt(value), size).reverse())

// Every encoding a script can use to push `data` (up to 0xffff bytes).
const pushForms = (data: Uint8Array): PushForm[] => {
  const hex = hexOf(data)
  const forms: PushForm[] = [
    { op: OP.OP_PUSHDATA2, hex: `4d${littleEndianHex(data.length, 2)}${hex}` },
    { op: OP.OP_PUSHDATA4, hex: `4e${littleEndianHex(data.length, 4)}${hex}` }
  ]
  if (data.length <= 0xff)
    forms.push({ op: OP.OP_PUSHDATA1, hex: `4c${littleEndianHex(data.length, 1)}${hex}` })
  if (data.length >= 1 && data.length <= 75)
    forms.push({ op: data.length, hex: `${littleEndianHex(data.length, 1)}${hex}` })
  if (data.length === 0) forms.push({ op: OP.OP_0, hex: '00' })
  const op = minimalPushOp(data)
  if (op === OP.OP_1NEGATE || (op >= OP.OP_1 && op <= OP.OP_16)) {
    forms.push({ op, hex: op.toString(16) })
  }
  return forms
}

const pushFormArb = (data: Uint8Array): fc.Arbitrary<PushForm> =>
  fc.constantFrom(...pushForms(data))

/** The role spec §3.2 assigns: no id is a deploy, amount 0 an authority, anything else value. */
const specRole = (tokenId: string | null, amount: bigint): Bsv21Role => {
  if (tokenId === null) return 'deploy'
  return amount === 0n ? 'authority' : 'value'
}

const tokenIdArb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b => tokenIdToString([...b]))
const pkhArb = fc.uint8Array({ minLength: 20, maxLength: 20 }).map(b => [...b])
const payloadArb = fc.oneof(
  fc.uint8Array({ maxLength: 300 }),
  fc.constantFrom(0, 1, 16, 17, 0x80, 0x81, 0xff).map(b => Uint8Array.of(b))
)

// One chunk an attacker could put in a slot: a push of any form, or any other opcode.
const anyChunkHex = fc.oneof(
  fc
    .uint8Array({ maxLength: 40 })
    .chain(pushFormArb)
    .map(form => form.hex),
  fc.integer({ min: 0x4f, max: 0xff }).map(op => op.toString(16).padStart(2, '0'))
)
// Biased towards the shapes that reach the id and amount checks.
const idSlotHex = fc.oneof(
  anyChunkHex,
  fc.constant('00'),
  tokenIdArb.map(id => `20${hexOf(tokenIdFromString(id))}`)
)
const amountSlotHex = fc.oneof(
  anyChunkHex,
  fc.integer({ min: 0x51, max: 0x60 }).map(op => op.toString(16)),
  fc
    .uint8Array({ minLength: 1, maxLength: 10 })
    .map(d => `${littleEndianHex(d.length, 1)}${hexOf(d)}`)
)

describe('BRC-162 encoding properties', () => {
  test('strict CBOR round-trips arbitrary maps', () => {
    fc.assert(
      fc.property(strictMap, map => {
        expect(decodeStrictCbor(encodeStrictCbor(map))).toEqual(map)
      })
    )
  })

  test('strict CBOR output does not depend on key insertion order', () => {
    fc.assert(
      fc.property(strictMap, fc.integer(), (map, seed) => {
        const permuted = permuteKeys(map, seed) as StrictCborMap
        expect(encodeStrictCbor(permuted)).toEqual(encodeStrictCbor(map))
      })
    )
    expect(encodeStrictCbor({ b: 1n, a: 2n })).toEqual(encodeStrictCbor({ a: 2n, b: 1n }))
  })

  test('strict CBOR accepts only bytes that re-encode to exactly themselves', () => {
    const arbitraryBytes = fc.uint8Array({ maxLength: 64 })
    const nearValid = fc
      .tuple(strictMap, fc.nat(), fc.nat({ max: 255 }), fc.nat({ max: 3 }))
      .map(([map, index, byte, mode]) => Uint8Array.from(mutated(map, index, byte, mode)))
    fc.assert(
      fc.property(fc.oneof(arbitraryBytes, nearValid), bytes => {
        const decoded = tryDecodeStrictCbor(bytes)
        if (decoded !== undefined) expect(encodeStrictCbor(decoded)).toEqual(Array.from(bytes))
      })
    )
  })

  test('strict CBOR refuses a non-minimal header first, whatever its major type or slot', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 3 }),
        fc.bigInt({ min: 0n, max: 0xffffffffn }),
        slotArb,
        (major, width, seed, slot) => {
          const value = seed % WIDTH_MINIMUM[width]
          const header = [(major << 5) | (24 + width), ...bigEndian(value, 1 << width)]
          expect(rejectMessage(inSlot(slot, header))).toBe(NON_MINIMAL)
        }
      )
    )
  })

  test('strict CBOR refuses a value of major type 1, 4 or 6, a non-map top level and a non-text key', () => {
    fc.assert(
      fc.property(fc.constantFrom(1, 4, 6), argumentArb, slotArb, (major, value, slot) => {
        const expected = {
          top: NOT_A_MAP,
          key: KEY_NOT_TEXT,
          value: `major type ${major} not allowed`
        }
        expect(rejectMessage(inSlot(slot, minimalHeader(major, value)))).toBe(expected[slot])
      })
    )
    fc.assert(
      fc.property(fc.constantFrom(0, 2, 7), argumentArb, (major, value) => {
        expect(rejectMessage(inSlot('top', minimalHeader(major, value)))).toBe(NOT_A_MAP)
        expect(rejectMessage(inSlot('key', minimalHeader(major, value)))).toBe(KEY_NOT_TEXT)
      })
    )
  })

  test('strict CBOR reads only false, true and null from major type 7', () => {
    const known = new Map<bigint, StrictCborValue>([
      [20n, false],
      [21n, true],
      [22n, null]
    ])
    fc.assert(
      fc.property(fc.oneof(argumentArb, fc.constantFrom(20n, 21n, 22n)), value => {
        const bytes = underKeyA(minimalHeader(7, value))
        if (known.has(value)) expect(decodeStrictCbor(bytes)).toEqual({ a: known.get(value) })
        else expect(rejectMessage(bytes)).toBe(SIMPLE)
      })
    )
  })

  test('strict CBOR bounds every length and count by the whole input before reading it', () => {
    // the slots where a length or count is read: the top-level map, a key, and a value
    const counted = fc.constantFrom<[Slot, number]>(
      ['top', 5],
      ['key', 3],
      ['value', 2],
      ['value', 3],
      ['value', 5]
    )
    fc.assert(
      fc.property(counted, argumentArb, ([slot, major], value) => {
        fc.pre(value > 0n)
        const bytes = inSlot(slot, minimalHeader(major, value))
        // compared with the total input first; only then is anything read
        const expected = value > BigInt(bytes.length) ? LENGTH_EXCEEDS : TRUNCATED
        expect(rejectMessage(bytes)).toBe(expected)
      })
    )
  })

  test('strict CBOR refuses every strict prefix of a valid map as truncated', () => {
    fc.assert(
      fc.property(strictMap, fc.nat(), (map, cut) => {
        const bytes = encodeStrictCbor(map)
        expect([TRUNCATED, LENGTH_EXCEEDS]).toContain(
          rejectMessage(bytes.slice(0, cut % bytes.length))
        )
      })
    )
  })

  test('strict CBOR refuses any bytes after a complete map', () => {
    fc.assert(
      fc.property(strictMap, fc.uint8Array({ minLength: 1, maxLength: 8 }), (map, extra) => {
        const bytes = [...encodeStrictCbor(map), ...extra]
        fc.pre(bytes.length <= STRICT_CBOR_MAX_BYTES)
        expect(rejectMessage(bytes)).toBe('trailing bytes')
      })
    )
  })

  test('strict CBOR refuses unsorted and duplicate keys, at the top level and nested', () => {
    const entries = fc
      .uniqueArray(fc.tuple(textKey, leafValue), {
        minLength: 2,
        maxLength: 5,
        selector: e => e[0]
      })
      .map(pairs =>
        pairs
          .map(([key, value]) => entryOf(key, value))
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      )
    fc.assert(
      fc.property(entries, fc.boolean(), fc.boolean(), (sorted, duplicate, nested) => {
        const place = (map: number[]): number[] => (nested ? underKeyA(map) : map)
        const disordered = duplicate ? [sorted[0], ...sorted] : [...sorted].reverse()
        expect(rejectMessage(place(rawMap(disordered)))).toBe('map keys unsorted or duplicated')
        expect(tryDecodeStrictCbor(place(rawMap(sorted)))).toBeDefined()
      })
    )
  })

  test('strict CBOR refuses a map nested deeper than 4 before reading its keys', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: STRICT_CBOR_MAX_DEPTH + 1, max: 40 }),
        anyChunkHex,
        (depth, tail) => {
          const outer = Array.from({ length: depth - 1 }, () => [0xa1, 0x61, 0x61]).flat()
          const bytes = [...outer, 0xa1, ...Buffer.from(tail, 'hex')]
          expect(rejectMessage(bytes)).toBe('map nesting deeper than 4')
        }
      )
    )
  })

  test('strict CBOR text is accepted exactly when it is strict UTF-8, as a value and as a key', () => {
    const nearUtf8 = fc
      .tuple(fc.string({ unit: 'binary', maxLength: 6 }), fc.nat(), fc.nat({ max: 255 }))
      .map(([text, at, byte]) => {
        const bytes = new TextEncoder().encode(text)
        if (bytes.length > 0) bytes[at % bytes.length] = byte
        return bytes
      })
    fc.assert(
      fc.property(
        fc.oneof(fc.uint8Array({ maxLength: 8 }), nearUtf8),
        fc.boolean(),
        (raw, asKey) => {
          const text = [...minimalHeader(3, BigInt(raw.length)), ...raw]
          const bytes = asKey ? [0xa1, ...text, 0xf6] : underKeyA(text)
          if (isStrictUtf8(raw)) expect(tryDecodeStrictCbor(bytes)).toBeDefined()
          else expect(rejectMessage(bytes)).toBe('invalid UTF-8')
        }
      )
    )
  })

  test('BRC-162 amounts round-trip and use data pushes only above 16', () => {
    fc.assert(
      fc.property(amountArb, amount => {
        const chunk = encodeAmountChunk(amount)
        expect(decodeAmountChunk(chunk)).toBe(amount)
        expect(chunk.data === undefined).toBe(amount <= 16n)
      })
    )
  })

  test('BRC-162 amount pushes decode exactly as the SDK script-number reader says', () => {
    const data = fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 10 }),
      amountArb.map(amount => Uint8Array.from(encodeAmountChunk(amount).data ?? [0])),
      fc.uint8Array({ minLength: 1, maxLength: 8 }).map(d => Uint8Array.from([...d, 0x00]))
    )
    fc.assert(
      fc.property(data, fc.boolean(), (bytes, pushdata1) => {
        const chunk = { op: pushdata1 ? OP.OP_PUSHDATA1 : bytes.length, data: [...bytes] }
        const expected = amountSlotOracle(chunk)
        if (typeof expected === 'bigint') expect(decodeAmountChunk(chunk)).toBe(expected)
        else expect(() => decodeAmountChunk(chunk)).toThrow(new Bsv21BinaryError(expected))
      })
    )
  })

  test('BRC-162 amount encoding refuses anything but a bigint in 0..2^64-1', () => {
    const outside = fc.oneof(
      fc.bigInt({ min: -(1n << 70n), max: -1n }),
      fc.bigInt({ min: BSV21_MAX_AMOUNT + 1n, max: 1n << 80n })
    )
    fc.assert(
      fc.property(outside, amount => {
        expect(() => encodeAmountChunk(amount)).toThrow(
          new Bsv21BinaryError('amount outside 0..2^64-1')
        )
      })
    )
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string(), fc.constant(null)), notBigint => {
        expect(() => encodeAmountChunk(notBigint as never)).toThrow(
          new Bsv21BinaryError('amount must be a bigint')
        )
      })
    )
  })

  test('BRC-162 lock then decode returns every field, with the role the spec assigns', () => {
    fc.assert(
      fc.property(
        fc.option(tokenIdArb, { nil: null }),
        amountArb,
        pkhArb,
        fc.option(payloadArb, { nil: undefined }),
        (tokenId, amount, pkh, payload) => {
          const payloadBytes = payload === undefined ? undefined : [...payload]
          const hex = new Bsv21Binary().lock(tokenId, amount, pkh, payloadBytes).toHex()
          const script = LockingScript.fromHex(hex)
          const role = specRole(tokenId, amount)
          const idPush = tokenId === null ? '00' : `20${hexOf(tokenIdFromString(tokenId))}`
          expect(hex.startsWith(idPush)).toBe(true)
          expect(hex.endsWith(p2pkhTail(pkh))).toBe(true)
          expect(isTokenShaped(script)).toBe(true)
          const decoded = Bsv21Binary.decode(script)
          expect(decoded.role).toBe(role)
          expect(decoded.tokenId === undefined ? null : tokenIdToString(decoded.tokenId)).toBe(
            tokenId
          )
          expect(decoded.amount).toBe(amount)
          expect(decoded.payload).toEqual(payloadBytes)
          expect(decoded.payloadCanonical).toBe(true)
          expect(decoded.restPubKeyHash).toEqual(pkh)
          expect(decoded.restChunks).toHaveLength(5)
        }
      )
    )
  })

  test('BRC-162 payload pushes are canonical exactly when they use the minimal push', () => {
    const payloadPush = payloadArb.chain(data => fc.tuple(fc.constant(data), pushFormArb(data)))
    fc.assert(
      fc.property(payloadPush, pkhArb, ([data, form], pkh) => {
        const decoded = Bsv21Binary.decode(
          LockingScript.fromHex(`00006d${form.hex}75${p2pkhTail(pkh)}`)
        )
        expect(decoded.payload).toEqual([...data])
        expect(decoded.payloadCanonical).toBe(form.op === minimalPushOp(data))
        expect(decoded.restPubKeyHash).toEqual(pkh)
      })
    )
  })

  test('BRC-162 decode refuses exactly what the layout and push rules refuse, in their order', () => {
    const shaped = fc
      .tuple(
        idSlotHex,
        amountSlotHex,
        fc.constantFrom('6d', '75', '76'),
        fc.uint8Array({ maxLength: 30 })
      )
      .map(([id, amount, marker, rest]) => `${id}${amount}${marker}${hexOf(rest)}`)
    const scriptHex = fc.oneof(fc.uint8Array({ maxLength: 48 }).map(hexOf), shaped)
    fc.assert(
      fc.property(scriptHex, hex => {
        const script = LockingScript.fromHex(hex)
        const [id, amount] = script.chunks
        const message = decodeMessage(script)
        expect(isTokenShaped(script)).toBe(hasLayoutMarker(script.chunks))
        if (!hasLayoutMarker(script.chunks)) expect(message).toBe(NOT_TOKEN)
        else if (script.chunks.some(c => c.invalidLength === true))
          expect(message).toBe(TRUNCATED_PUSH)
        else if (id.op !== OP.OP_0 && (id.op !== 32 || id.data?.length !== 32))
          expect(message).toBe(BAD_ID)
        else {
          const read = amountSlotOracle(amount)
          expect(message).toBe(typeof read === 'string' ? read : undefined)
        }
      })
    )
  })

  test('token id strings round-trip and reverse the 32 wire bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), raw => {
        const id = tokenIdToString([...raw])
        expect(id).toMatch(/^[0-9a-f]{64}_0$/)
        expect(id.slice(0, 64)).toBe(hexOf([...raw].reverse()))
        expect(tokenIdFromString(id)).toEqual([...raw])
      })
    )
  })

  test('token ids of any other length or spelling are refused', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 40 }).filter(b => b.length !== 32),
        raw => {
          expect(() => tokenIdToString([...raw])).toThrow(
            new Bsv21BinaryError('token id must be 32 bytes')
          )
        }
      )
    )
    const misspelt = fc.oneof(
      fc.string(),
      tokenIdArb.map(id => id.toUpperCase()),
      tokenIdArb.map(id => `${id.slice(0, 64)}_1`),
      tokenIdArb.map(id => id.slice(1)),
      tokenIdArb.map(id => `${id}0`),
      tokenIdArb.map(id => `0${id}`)
    )
    fc.assert(
      fc.property(
        misspelt.filter(id => !/^[0-9a-f]{64}_0$/.test(id)),
        id => {
          expect(() => tokenIdFromString(id)).toThrow(
            new Bsv21BinaryError('token id must be <64 lowercase hex>_0')
          )
        }
      )
    )
  })

  test('lock refuses a public key hash of any length but 20 bytes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 40 }).filter(b => b.length !== 20),
        amountArb,
        (pkh, amount) => {
          expect(() => new Bsv21Binary().lock(null, amount, [...pkh])).toThrow(
            new Bsv21BinaryError('pubKeyHash must be 20 bytes')
          )
        }
      )
    )
  })

  test('script numbers round-trip through minimal chunks across the safe-integer range', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        value => {
          const bytes = new BigNumber(value).toScriptNum()
          expect(decodeScriptNumChunk(createMinimallyEncodedScriptChunk(bytes))).toBe(value)
        }
      )
    )
  })
})
