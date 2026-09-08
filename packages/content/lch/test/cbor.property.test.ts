import { describe, expect, it } from '@jest/globals'
import fc from 'fast-check'
import { decodeDeterministicCbor, encodeDeterministicCbor } from '../src/index.js'

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

describe('deterministic CBOR properties', () => {
  it('round trips supported values canonically', () => {
    const leaf = fc.oneof(
      fc.boolean(),
      fc.constant(null),
      fc.nat(),
      fc.string().map(value => value.normalize('NFC')),
      fc.uint8Array()
    )
    const values = fc.oneof(
      leaf,
      fc.array(leaf, { maxLength: 20 }),
      fc.dictionary(
        fc.string({ minLength: 1 }).map(value => value.normalize('NFC')),
        leaf
      )
    )
    fc.assert(
      fc.property(values, value => {
        const first = encodeDeterministicCbor(value)
        const second = encodeDeterministicCbor(decodeDeterministicCbor(first))
        expect(second).toEqual(first)
      })
    )
  })
})
