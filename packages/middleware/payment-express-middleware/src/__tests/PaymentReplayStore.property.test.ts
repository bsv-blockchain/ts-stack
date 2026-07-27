import fc from 'fast-check'

import { InMemoryPaymentReplayStore } from '../index.js'

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

describe('payment replay-store properties', () => {
  test('accepts each arbitrary transaction ID exactly once up to its capacity', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 128 }), {
          minLength: 1,
          maxLength: 100
        }),
        transactionIds => {
          const store = new InMemoryPaymentReplayStore(transactionIds.length)
          for (const transactionId of transactionIds) {
            expect(store.claim(transactionId)).toBe(true)
            expect(store.claim(transactionId)).toBe(false)
          }
          let overflowId = 'overflow'
          while (transactionIds.includes(overflowId)) overflowId += '-next'
          expect(() => store.claim(overflowId)).toThrow('capacity')
        }
      )
    )
  })

  test('rejects every non-positive, fractional, or unsafe capacity', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
          fc
            .double({
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              noNaN: true,
              noDefaultInfinity: true
            })
            .filter(value => !Number.isSafeInteger(value)),
          fc.constant(Number.MAX_SAFE_INTEGER + 1)
        ),
        capacity => {
          expect(() => new InMemoryPaymentReplayStore(capacity)).toThrow(RangeError)
        }
      )
    )
  })
})
