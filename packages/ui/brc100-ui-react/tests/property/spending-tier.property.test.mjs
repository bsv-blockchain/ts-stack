import assert from 'node:assert/strict'
import { test } from 'vitest'
import fc from 'fast-check'
import { propertyReplayOptions } from '../../../../../config/testing/property-replay.mjs'
import { determineUpgradeAmount } from '../../src/utils/determineUpgradeAmount.ts'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal(
  propertyReplayOptions(MIN_PROPERTY_RUNS, {
    runs: process.env.FAST_CHECK_NUM_RUNS,
    seed: process.env.FAST_CHECK_SEED,
    path: process.env.FAST_CHECK_PATH
  })
)

test('selects the first applicable spending tier and expresses it in exact satoshis', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 12 }),
      fc.integer({ min: 0, max: 100 }),
      (satsPerDollarPower, previousDollars) => {
        const satsPerDollar = 2 ** satsPerDollarPower
        const rate = 100_000_000 / satsPerDollar
        const previousSats = previousDollars * satsPerDollar
        const expectedDollars = [5, 10, 20].find(limit => previousDollars < limit) ?? 50

        assert.equal(determineUpgradeAmount(previousSats, rate, 'usd'), expectedDollars)
        assert.equal(determineUpgradeAmount(previousSats, rate), expectedDollars * satsPerDollar)
      }
    )
  )
})

test('changes tier exactly at the established spending thresholds', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 12 }),
      fc.constantFrom([5, 10], [10, 20], [20, 50]),
      (satsPerDollarPower, [cutoff, nextTier]) => {
        const satsPerDollar = 2 ** satsPerDollarPower
        const rate = 100_000_000 / satsPerDollar
        assert.equal(determineUpgradeAmount(cutoff * satsPerDollar - 1, rate, 'usd'), cutoff)
        assert.equal(determineUpgradeAmount(cutoff * satsPerDollar, rate, 'usd'), nextTier)
      }
    )
  )
})
