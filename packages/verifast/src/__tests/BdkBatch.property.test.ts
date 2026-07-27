import fc from 'fast-check'

import { decodeResults, flagsForInputCount, packArrays } from '../BdkBatch.js'
import { BdkVerificationError } from '../BdkVerifierTypes.js'

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

describe('VeriFast batch framing properties', () => {
  test('packs arbitrary byte-array batches with exact monotonic offsets and content', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 2048 }), { maxLength: 50 }), arrays => {
        const packed = packArrays(arrays, length => new Uint8Array(length))
        const expectedOffsets = [0]
        for (const array of arrays) {
          expectedOffsets.push(expectedOffsets.at(-1)! + array.length)
        }

        expect(Array.from(packed.offsets)).toEqual(expectedOffsets)
        expect(Array.from(packed.values)).toEqual(arrays.flatMap(array => Array.from(array)))
        for (let index = 0; index < arrays.length; index++) {
          expect(packed.values.slice(packed.offsets[index], packed.offsets[index + 1])).toEqual(
            arrays[index]
          )
        }
      })
    )
  })

  test('round-trips arbitrary signed BDK result pairs and rejects every wrong flat length', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            domain: fc.integer({ min: -0x80000000, max: 0x7fffffff }),
            code: fc.integer({ min: -0x80000000, max: 0x7fffffff })
          }),
          { maxLength: 100 }
        ),
        results => {
          const flat = Int32Array.from(results.flatMap(result => [result.domain, result.code]))
          expect(decodeResults(flat, results.length)).toEqual(results)

          const malformed = new Int32Array(flat.length + 1)
          malformed.set(flat)
          expect(() => decodeResults(malformed, results.length)).toThrow(BdkVerificationError)
        }
      )
    )
  })

  test('duplicates arbitrary custom flags exactly and rejects mismatched counts', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(0xffffffff), { maxLength: 100 }), flags => {
        expect(flagsForInputCount(flags.length, undefined, flags)).toEqual(Uint32Array.from(flags))
        if (flags.length > 0) {
          expect(() => flagsForInputCount(flags.length + 1, undefined, flags)).toThrow(
            'match the input count'
          )
        }
      })
    )
  })
})
