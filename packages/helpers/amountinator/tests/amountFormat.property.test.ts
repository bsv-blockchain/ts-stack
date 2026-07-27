import fc from 'fast-check'

import { formatAmountWithCurrency } from '../src/utils/amountFormatHelpers'
import { CurrencyConverter } from '../src/utils/currencyConverter'
import {
  FiatCurrencyCode,
  SUPPORTED_FIAT_CURRENCY_CODES,
  SupportedCurrencyCode
} from '../src/types'

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

const rates = Object.fromEntries(
  SUPPORTED_FIAT_CURRENCY_CODES.map((code, index) => [code, code === 'USD' ? 1 : index + 1])
) as Record<FiatCurrencyCode, number>
const currencies: SupportedCurrencyCode[] = [...SUPPORTED_FIAT_CURRENCY_CODES, 'BSV', 'SATS']
const converter = new CurrencyConverter(0, {
  get: async () => ({ currency: 'USD' })
} as never)
converter.exchangeRates = { usdPerBsv: 50, fiatPerUsd: rates }

describe('currency boundary properties', () => {
  test('groups arbitrary safe integer amounts without changing their digits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), amount => {
        const digits = String(amount)
        const commaGrouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        const underscoreGrouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '_')

        expect(formatAmountWithCurrency(amount, 'BSV', { decimalPlaces: 0 }).formattedAmount).toBe(
          `${commaGrouped} BSV`
        )
        expect(
          formatAmountWithCurrency(amount, 'BSV', {
            decimalPlaces: 0,
            useUnderscores: true
          }).formattedAmount
        ).toBe(`${underscoreGrouped} BSV`)
      })
    )
  })

  test('round-trips arbitrary finite amounts across every supported currency pair', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom(...currencies),
        fc.constantFrom(...currencies),
        (amount, from, to) => {
          const converted = converter.convertCurrency(amount, from, to)
          expect(converted).not.toBeNull()
          const roundTrip = converter.convertCurrency(converted as number, to, from)
          expect(roundTrip).toBeCloseTo(amount, 8)
        }
      )
    )
  })

  test('formats arbitrary bounded finite values and decimal policies without throwing', () => {
    fc.assert(
      fc.property(
        fc.double({
          min: -1_000_000_000,
          max: 1_000_000_000,
          noNaN: true,
          noDefaultInfinity: true
        }),
        fc.constantFrom(...currencies),
        fc.integer({ min: 0, max: 12 }),
        (amount, currency, decimalPlaces) => {
          const result = formatAmountWithCurrency(amount, currency, { decimalPlaces })
          expect(result.formattedAmount).toEqual(expect.any(String))
          expect(result.formattedAmount).not.toContain('NaN')
        }
      )
    )
  })

  test('trims implicit decimals and fails closed for unavailable conversion rates', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom(...currencies),
        (amount, currency) => {
          const result = formatAmountWithCurrency(amount, currency)
          expect(result.formattedAmount).toEqual(expect.any(String))
          expect(result.formattedAmount).not.toContain('NaN')
        }
      )
    )

    const unavailable = new CurrencyConverter(0, {
      get: async () => ({ currency: 'USD' })
    } as never)
    expect(() => unavailable.convertCurrency(1, 'USD', 'BSV')).toThrow('usdPerBsv')
    unavailable.exchangeRates = { usdPerBsv: 50, fiatPerUsd: { ...rates, EUR: 0 } }
    expect(() => unavailable.convertCurrency(1, 'EUR', 'USD')).toThrow('EUR per USD')
    expect(() => unavailable.convertCurrency(1, 'USD', 'EUR')).toThrow('EUR per USD')
    expect(() => unavailable.convertCurrency(1, 'UNKNOWN', 'USD')).toThrow('Currency not supported')
  })
})
