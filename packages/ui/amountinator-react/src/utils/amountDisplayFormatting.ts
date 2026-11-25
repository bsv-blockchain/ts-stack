import { CurrencyConverter } from '@bsv/amountinator'

export interface FormatOptions {
  decimalPlaces?: number
  useCommas?: boolean
  useUnderscores?: boolean
}

export interface DisplayAmount {
  formattedAmount: string
  hoverText?: string
}

const ZERO_DECIMAL_CURRENCIES = new Set(['SATS', 'JPY'])

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  GBP: '£',
  EUR: '€',
  JPY: '¥',
  CNY: '¥',
  INR: '₹',
  AUD: 'A$',
  CAD: 'C$',
  CHF: 'CHF ',
  HKD: 'HK$',
  SGD: 'S$',
  NZD: 'NZ$',
  SEK: 'SEK ',
  NOK: 'NOK ',
  MXN: 'MX$'
}

const parseInputAmount = (amount: number | string): { parsedAmount: number; inputCurrency: string } | null => {
  const amountAsString = amount.toString()
  const parsedAmount = Number.parseFloat(amountAsString.replace(/[^0-9.-]+/g, ''))

  if (!Number.isFinite(parsedAmount)) {
    return null
  }

  let inputCurrency = amountAsString.replace(/[\d.,\s]+/g, '').trim().toUpperCase()
  if (!inputCurrency) {
    inputCurrency = amountAsString.includes('.') ? 'BSV' : 'SATS'
  }

  return {
    parsedAmount,
    inputCurrency
  }
}

const getDefaultDecimalPlaces = (amount: number, currency: string): number => {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return 0
  }

  const absoluteAmount = Math.abs(amount)

  if (absoluteAmount < 1 && absoluteAmount !== 0) {
    return Math.min(Math.max(2, -Math.floor(Math.log10(absoluteAmount)) + 1), 4)
  }

  return currency === 'BSV' ? 8 : 2
}

const formatNumericPortion = (
  amount: number,
  decimals: number,
  useCommas: boolean,
  useUnderscores: boolean,
  trimTrailingZeros: boolean
): string => {
  let fixedAmount = amount.toFixed(decimals)

  if (trimTrailingZeros && decimals > 0) {
    fixedAmount = fixedAmount.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
  }

  let [integerPart, decimalPart] = fixedAmount.split('.')

  if (useUnderscores) {
    integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '_')
  } else if (useCommas) {
    integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  return decimalPart ? `${integerPart}.${decimalPart}` : integerPart
}

const formatCurrencyAmount = (
  amount: number,
  currency: string,
  formatOptions?: FormatOptions,
  forcedDecimalPlaces?: number
): string => {
  const normalizedCurrency = currency.toUpperCase()
  const useCommas = formatOptions?.useCommas ?? true
  const useUnderscores = formatOptions?.useUnderscores ?? false
  const hasNoDecimals = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)

  const decimalPlaces = hasNoDecimals
    ? 0
    : forcedDecimalPlaces ?? formatOptions?.decimalPlaces ?? getDefaultDecimalPlaces(amount, normalizedCurrency)

  const numericPortion = formatNumericPortion(
    amount,
    decimalPlaces,
    useCommas,
    useUnderscores,
    formatOptions?.decimalPlaces === undefined && forcedDecimalPlaces === undefined && !hasNoDecimals
  )

  if (normalizedCurrency === 'SATS') {
    return `${numericPortion} satoshis`
  }

  if (normalizedCurrency === 'BSV') {
    return `${numericPortion} BSV`
  }

  return `${CURRENCY_SYMBOLS[normalizedCurrency] || `${normalizedCurrency} `}${numericPortion}`
}

const getHoverPrecision = (amount: number): number => {
  const absoluteAmount = Math.abs(amount)
  if (absoluteAmount === 0) {
    return 2
  }

  const magnitude = Math.floor(Math.log10(absoluteAmount))
  return Math.max(4, Math.min(12, magnitude < 0 ? -magnitude + 2 : 2))
}

export const normalizeDisplayAmount = async (
  currencyConverter: CurrencyConverter,
  paymentAmount: number | string,
  formatOptions?: FormatOptions
): Promise<DisplayAmount> => {
  const convertedAmount = await currencyConverter.convertAmount(paymentAmount, formatOptions)

  const parsedInput = parseInputAmount(paymentAmount)
  if (!parsedInput) {
    return convertedAmount
  }

  const preferredCurrency = currencyConverter.preferredCurrency.toUpperCase()
  const convertedNumericAmount = currencyConverter.convertCurrency(
    parsedInput.parsedAmount,
    parsedInput.inputCurrency,
    preferredCurrency
  )

  if (convertedNumericAmount === null || !Number.isFinite(convertedNumericAmount)) {
    return convertedAmount
  }

  if (ZERO_DECIMAL_CURRENCIES.has(preferredCurrency)) {
    return {
      formattedAmount: formatCurrencyAmount(convertedNumericAmount, preferredCurrency, formatOptions, 0)
    }
  }

  if (Math.abs(convertedNumericAmount) > 0 && Math.abs(convertedNumericAmount) < 0.01) {
    return {
      formattedAmount: convertedAmount.formattedAmount,
      hoverText: formatCurrencyAmount(convertedNumericAmount, preferredCurrency, formatOptions, getHoverPrecision(convertedNumericAmount))
    }
  }

  return convertedAmount
}
