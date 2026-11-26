import assert from 'node:assert/strict'
import { test } from 'vitest'
import fc from 'fast-check'
import { propertyReplayOptions } from '../../../../../config/testing/property-replay.mjs'
import { CurrencyConverter } from '@bsv/amountinator'
import { normalizeDisplayAmount } from '../../src/utils/amountDisplayFormatting.ts'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal(
  propertyReplayOptions(MIN_PROPERTY_RUNS, {
    runs: process.env.FAST_CHECK_NUM_RUNS,
    seed: process.env.FAST_CHECK_SEED,
    path: process.env.FAST_CHECK_PATH
  })
)

const converter = new CurrencyConverter(0, { get: async () => ({ currency: 'SATS' }) })
const integerFormatter = new Intl.NumberFormat('en-US')

test('keeps signed grouped amounts in the selected currency', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: -2_100_000_000_000_000, max: 2_100_000_000_000_000 }),
      fc.constantFrom(',', '_'),
      fc.boolean(),
      fc.constantFrom(',', '_', ''),
      async (amount, separator, explicitPlus, outputSeparator) => {
        const formatted = integerFormatter.format(amount)
        const prefix = amount >= 0 && explicitPlus ? '+' : ''
        const input = prefix + formatted.replaceAll(',', separator) + ' satS'

        const options = {
          useCommas: outputSeparator === ',',
          useUnderscores: outputSeparator === '_'
        }
        assert.deepEqual(await normalizeDisplayAmount(converter, input, options), {
          formattedAmount: formatted.replaceAll(',', outputSeparator) + ' satoshis'
        })
      }
    )
  )
})

test('interprets fractional numeric values in exponent notation as BSV', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 9 }), fc.boolean(), async (sats, negative) => {
      const signedSats = negative ? -sats : sats
      assert.deepEqual(
        await normalizeDisplayAmount(converter, Number(String(signedSats) + 'e-8')),
        {
          formattedAmount: String(signedSats) + ' satoshis'
        }
      )
    })
  )
})
