export const SUPPORTED_FIAT_CURRENCY_CODES = [
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
] as const

export type FiatCurrencyCode = (typeof SUPPORTED_FIAT_CURRENCY_CODES)[number]

export type SupportedCurrencyCode = FiatCurrencyCode | 'BSV' | 'SATS'

export interface ExchangeRates {
  usdPerBsv: number
  fiatPerUsd: Record<FiatCurrencyCode, number>
}

export interface FormatOptions {
  decimalPlaces?: number
  useCommas?: boolean
  useUnderscores?: boolean
}