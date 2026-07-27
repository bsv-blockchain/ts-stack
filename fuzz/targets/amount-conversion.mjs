import {
  CurrencyConverter,
  formatAmountWithCurrency
} from '../../packages/helpers/amountinator/dist/index.mjs'
import { attempt, invariant, utf8 } from '../lib.mjs'

const FIAT = [
  'USD',
  'GBP',
  'EUR',
  'JPY',
  'CNY',
  'INR',
  'AUD',
  'CAD',
  'CHF',
  'HKD',
  'SGD',
  'NZD',
  'SEK',
  'NOK',
  'MXN'
]
const CURRENCIES = [...FIAT, 'BSV', 'SATS']
const converter = new CurrencyConverter(0, {
  get: async () => ({ currency: 'USD' })
})
converter.exchangeRates = {
  usdPerBsv: 50,
  fiatPerUsd: Object.fromEntries(FIAT.map((currency, index) => [currency, index + 1]))
}

export function fuzz(data) {
  const numbers = Buffer.alloc(8)
  data.copy(numbers, 0, 0, Math.min(data.length, numbers.length))
  const amount = numbers.readUIntBE(0, 6)
  const from = CURRENCIES[(data[6] ?? 0) % CURRENCIES.length]
  const to = CURRENCIES[(data[7] ?? 0) % CURRENCIES.length]
  const converted = converter.convertCurrency(amount, from, to)
  invariant(Number.isFinite(converted), 'Currency conversion returned a non-finite value')
  const roundTrip = converter.convertCurrency(converted, to, from)
  const tolerance = Math.max(1, amount) * 1e-10
  invariant(
    Math.abs(roundTrip - amount) <= tolerance,
    'Currency conversion did not round-trip within floating-point tolerance'
  )

  const decimalPlaces = (data[8] ?? 0) % 13
  const formatted = formatAmountWithCurrency(amount, from, { decimalPlaces })
  invariant(
    typeof formatted.formattedAmount === 'string' && !formatted.formattedAmount.includes('NaN'),
    'Currency formatter returned invalid text'
  )

  const rawAmount = Number(utf8(data, 128))
  if (Number.isFinite(rawAmount)) {
    const raw = attempt(() =>
      formatAmountWithCurrency(rawAmount, from, {
        decimalPlaces
      })
    )
    invariant(!raw.ok || !raw.value.formattedAmount.includes('NaN'), 'Raw amount formatted as NaN')
  }
}
