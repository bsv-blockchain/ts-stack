import { BigNumber } from '@bsv/sdk'
import fc from 'fast-check'

import { encodeAmountChunk, decodeAmountChunk, BSV21_MAX_AMOUNT } from '../Bsv21Binary.js'
import {
  STRICT_CBOR_MAX_BYTES,
  STRICT_CBOR_MAX_DEPTH,
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

// Generation is small, but the 4096-byte cap is a hard decoder limit, so keep
// the occasional oversized deep map out of the round-trip domain.
const strictMap = mapAtDepth(1).filter(m => encodeStrictCbor(m).length <= STRICT_CBOR_MAX_BYTES)

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

  test('BRC-162 amounts round-trip and use data pushes only above 16', () => {
    fc.assert(
      fc.property(amountArb, amount => {
        const chunk = encodeAmountChunk(amount)
        expect(decodeAmountChunk(chunk)).toBe(amount)
        expect(chunk.data === undefined).toBe(amount <= 16n)
      })
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
