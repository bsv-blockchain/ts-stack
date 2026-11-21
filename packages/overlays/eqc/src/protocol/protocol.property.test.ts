import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { propertyTestBatches } from '../../test/utils/property-test-batches.cjs'

import { canonicalJson } from './canonicalJson.js'
import { computePayouts, requiredShare, squareRootWeights } from './weights.js'
import { decodeOutpointList, encodeMessageList, encodeOutpointList } from './payloads.js'

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

const jsonValue = fc.letrec<{ value: unknown }>(tie => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger(),
    fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie('value'), { maxKeys: 4 })
  )
})).value

function shuffleKeys(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map(item => shuffleKeys(item, seed))
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value).map(
    ([key, item]) => [key, shuffleKeys(item, seed)] as const
  )
  const rotation = entries.length === 0 ? 0 : seed % entries.length
  return Object.fromEntries([...entries.slice(rotation), ...entries.slice(0, rotation)].reverse())
}

const batches = propertyTestBatches(fc.readConfigureGlobal())

describe('BRC-178 protocol invariants', () => {
  test.each(batches)(
    'payouts conserve the fee, never increase with rank, and favour rank 1 (property $path, $numRuns cases)',
    propertyBatch => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 64 }),
          fc.integer({ min: 1, max: 2_100_000_000_000_000 }),
          (k, total) => {
            const payouts = computePayouts(total, k)
            expect(payouts).toHaveLength(k)
            expect(payouts.reduce((sum, value) => sum + value, 0)).toBe(total)
            for (let rank = 1; rank < k; rank++) {
              expect(payouts[rank]).toBeLessThanOrEqual(payouts[rank - 1])
              expect(payouts[rank]).toBeGreaterThanOrEqual(0)
            }
            const weights = squareRootWeights(k)
            const sum = weights.reduce((accumulator, weight) => accumulator + weight, 0)
            for (let rank = 1; rank < k; rank++) {
              expect(payouts[rank]).toBe(Math.floor((total * weights[rank]) / sum))
            }
          }
        ),
        propertyBatch
      )
    }
  )

  test.each(batches)(
    'every payout at a fee R covers the required share at any floor F <= R (property $path, $numRuns cases)',
    propertyBatch => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 64 }),
          fc.integer({ min: 1, max: 2_100_000_000_000_000 }),
          fc.integer({ min: 0, max: 2_100_000_000_000_000 }),
          (k, floor, extra) => {
            const paid = Math.min(2_100_000_000_000_000, floor + extra)
            const payouts = computePayouts(paid, k)
            for (let rank = 1; rank <= k; rank++) {
              expect(payouts[rank - 1]).toBeGreaterThanOrEqual(requiredShare(floor, k, rank))
            }
          }
        ),
        propertyBatch
      )
    }
  )

  test.each(batches)(
    'a fee only a few satoshis above the floor still covers every required share (property $path, $numRuns cases)',
    propertyBatch => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 64 }),
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 0, max: 12 }),
          (k, floor, gap) => {
            const payouts = computePayouts(floor + gap, k)
            for (let rank = 1; rank <= k; rank++) {
              expect(payouts[rank - 1]).toBeGreaterThanOrEqual(requiredShare(floor, k, rank))
            }
          }
        ),
        propertyBatch
      )
    }
  )

  test.each(batches)(
    'canonical JSON is independent of object key order and round-trips (property $path, $numRuns cases)',
    propertyBatch => {
      fc.assert(
        fc.property(jsonValue, fc.nat(), (value, seed) => {
          const canonical = canonicalJson(value)
          expect(canonicalJson(shuffleKeys(value, seed))).toBe(canonical)
          expect(canonicalJson(JSON.parse(canonical))).toBe(canonical)
        }),
        propertyBatch
      )
    }
  )

  test.each(batches)(
    'message-list bytes do not depend on input order (property $path, $numRuns cases)',
    propertyBatch => {
      const message = fc.record({ messageId: fc.string(), sender: fc.string(), body: fc.string() })
      fc.assert(
        fc.property(fc.array(message, { maxLength: 8 }), messages => {
          expect(encodeMessageList([...messages].reverse())).toEqual(encodeMessageList(messages))
        }),
        propertyBatch
      )
    }
  )

  test.each(batches)(
    'outpoint bytes do not depend on input order and decode to a sorted unique list (property $path, $numRuns cases)',
    propertyBatch => {
      const outpoint = fc.record({
        txid: fc.stringMatching(/^[0-9a-f]{64}$/),
        outputIndex: fc.nat({ max: 1000 }),
        context: fc.array(fc.nat({ max: 255 }), { maxLength: 4 })
      })
      fc.assert(
        fc.property(fc.array(outpoint, { maxLength: 8 }), entries => {
          const payload = encodeOutpointList(entries)
          expect(encodeOutpointList([...entries].reverse())).toEqual(payload)
          expect(encodeOutpointList(decodeOutpointList(payload))).toEqual(payload)
        }),
        propertyBatch
      )
    }
  )
})
