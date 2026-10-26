import type { FiatCurrencyCode, FiatExchangeRates } from '../sdk/WalletServices.interfaces'

export const MAX_FIAT_RATE = 1_000_000_000_000_000
export const MAX_FIAT_RESPONSE_RATES = 256
export const MAX_FIAT_FUTURE_SKEW_MS = 5 * 60 * 1000
const EARLIEST_FIAT_TIMESTAMP_MS = Date.UTC(2000, 0, 1)

const SUPPORTED_FIAT_CURRENCIES = new Set<FiatCurrencyCode>([
  'USD',
  'EUR',
  'GBP',
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
])

function invalidRates(message: string): never {
  throw new TypeError(`Invalid fiat exchange-rate data: ${message}`)
}

function plainProperties(value: unknown, name: string): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidRates(`${name} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  const properties = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    return invalidRates(`${name} must be an accessor-free plain object`)
  }
  return properties
}

export function normalizeFiatCurrency(value: unknown, name = 'currency'): FiatCurrencyCode {
  if (typeof value !== 'string' || !SUPPORTED_FIAT_CURRENCIES.has(value as FiatCurrencyCode)) {
    return invalidRates(`${name} is unsupported`)
  }
  return value as FiatCurrencyCode
}

export function normalizeFiatCurrencies(value: unknown, extras: readonly FiatCurrencyCode[] = []): FiatCurrencyCode[] {
  if (!Array.isArray(value) || value.length > SUPPORTED_FIAT_CURRENCIES.size) {
    return invalidRates('currency list is malformed')
  }
  const currencies: FiatCurrencyCode[] = []
  const seen = new Set<FiatCurrencyCode>()
  const append = (candidate: unknown, index: number | string): void => {
    const currency = normalizeFiatCurrency(candidate, `currency ${String(index)}`)
    if (!seen.has(currency)) {
      seen.add(currency)
      currencies.push(currency)
    }
  }
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) return invalidRates('currency list must be dense')
    append(value[index], index)
  }
  for (const extra of extras) append(extra, 'extra')
  return currencies
}

export function normalizeFiatRate(value: unknown, currency: string): number {
  if (!isValidFiatRate(value)) {
    return invalidRates(`${currency} rate must be finite, positive, and bounded`)
  }
  return value
}

export function isValidFiatRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_FIAT_RATE
}

export function normalizeFiatTimestamp(value: unknown, now = Date.now()): Date {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    return invalidRates('timestamp is malformed')
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  const timestamp = date.getTime()
  if (
    !Number.isFinite(timestamp) ||
    timestamp < EARLIEST_FIAT_TIMESTAMP_MS ||
    timestamp > now + MAX_FIAT_FUTURE_SKEW_MS
  ) {
    return invalidRates('timestamp is invalid or too far in the future')
  }
  return date
}

export function normalizeFiatExchangeRates(
  value: unknown,
  required: readonly FiatCurrencyCode[],
  now = Date.now()
): FiatExchangeRates {
  const properties = plainProperties(value, 'rate result')
  if (properties.base?.value !== 'USD') return invalidRates('base must be USD')
  const timestamp = normalizeFiatTimestamp(properties.timestamp?.value, now)
  const rateProperties = plainProperties(properties.rates?.value, 'rates')
  if (Object.keys(rateProperties).length > MAX_FIAT_RESPONSE_RATES) {
    return invalidRates('rate collection is too large')
  }

  const rates: Record<string, number> = { USD: 1 }
  for (const [currency, property] of Object.entries(rateProperties)) {
    if (!/^[A-Z]{3}$/.test(currency)) return invalidRates('rate key is malformed')
    const rate = normalizeFiatRate(property.value, currency)
    rates[currency] = rate
  }
  if (rates.USD !== 1) return invalidRates('USD base rate must equal 1')
  for (const currency of required) {
    if (currency !== 'USD' && rates[currency] == null) {
      return invalidRates(`${currency} rate is missing`)
    }
  }

  return { timestamp, base: 'USD', rates }
}

export function normalizeFiatRateTimestamps(value: unknown, now = Date.now()): Record<string, Date> | undefined {
  if (value == null) return undefined
  const properties = plainProperties(value, 'rate timestamps')
  if (Object.keys(properties).length > MAX_FIAT_RESPONSE_RATES) {
    return invalidRates('rate timestamp collection is too large')
  }
  const timestamps: Record<string, Date> = {}
  for (const [currency, property] of Object.entries(properties)) {
    if (!/^[A-Z]{3}$/.test(currency)) return invalidRates('rate timestamp key is malformed')
    timestamps[currency] = normalizeFiatTimestamp(property.value, now)
  }
  return timestamps
}
