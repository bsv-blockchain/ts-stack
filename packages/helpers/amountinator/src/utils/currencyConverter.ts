import { WalletClient } from '@bsv/sdk'
import { formatAmountWithCurrency } from './amountFormatHelpers'
import {
  ExchangeRates,
  FiatCurrencyCode,
  FormatOptions,
  SUPPORTED_FIAT_CURRENCY_CODES,
  SupportedCurrencyCode
} from '../types'
import { Services, WalletSettingsManager } from '@bsv/wallet-toolbox-client'
const DEFAULT_REFRESH_INTERVAL = 5 * 60 * 1000
const MAX_TIMER_INTERVAL = 2_147_483_647
const MAX_SATOSHIS = 21_000_000 * 100_000_000
const AMOUNT_PATTERN = /^([+-]?(?:(?:\d{1,3}(?:[,_]\d{3})+|\d+)(?:\.\d+)?|\.\d+))\s*([A-Za-z]+)?$/

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`)
  }
  return value
}

function requirePositiveRate(value: unknown, name: string): number {
  const rate = requireFiniteNumber(value, name)
  if (rate <= 0) throw new Error(`Exchange rate not available: ${name}`)
  return rate
}

function normalizeCurrencyArgument(value: unknown, name: string): SupportedCurrencyCode {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a supported currency code`)
  const code = value.trim().toUpperCase()
  if (code === 'BSV' || code === 'SATS') return code
  if ((SUPPORTED_FIAT_CURRENCY_CODES as readonly string[]).includes(code)) {
    return code as FiatCurrencyCode
  }
  throw new Error('Currency not supported!')
}

function parseAmountInput(amount: number | string): {
  amount: number
  currency: SupportedCurrencyCode
} {
  if (typeof amount === 'number') {
    const parsed = requireFiniteNumber(amount, 'amount')
    return { amount: parsed, currency: Number.isInteger(parsed) ? 'SATS' : 'BSV' }
  }
  if (typeof amount !== 'string')
    throw new TypeError('amount must be a finite number or amount string')

  const match = amount.trim().match(AMOUNT_PATTERN)
  if (match == null)
    throw new Error('Amount must use a valid number followed by an optional currency code')
  const parsed = requireFiniteNumber(Number(match[1].replace(/[,_]/g, '')), 'amount')
  const currency =
    match[2] == null
      ? match[1].includes('.')
        ? 'BSV'
        : 'SATS'
      : normalizeCurrencyArgument(match[2], 'currency')
  return { amount: parsed, currency }
}

/**
 * Converts currency amounts to user's preferred currency, and supports converting all supported currency types to satoshis.
 */
export class CurrencyConverter {
  public exchangeRates: ExchangeRates
  public preferredCurrency: SupportedCurrencyCode
  private readonly services: Services
  private readonly settingsManager: WalletSettingsManager

  private readonly refreshInterval: number
  private lastRateFetch = 0
  private lastCurrencyFetch = 0
  private ratePromise: Promise<ExchangeRates> | null = null
  private currencyPromise: Promise<SupportedCurrencyCode> | null = null

  private refreshTimer?: ReturnType<typeof setInterval>

  /**
   * @param refreshInterval  How often to pull new rates (ms), if 0, it never auto-refreshes
   */
  constructor(
    refreshInterval: number = DEFAULT_REFRESH_INTERVAL,
    settingsManager: WalletSettingsManager | undefined = undefined
  ) {
    if (
      !Number.isSafeInteger(refreshInterval) ||
      refreshInterval < 0 ||
      refreshInterval > MAX_TIMER_INTERVAL
    ) {
      throw new RangeError(
        `refreshInterval must be a safe integer from 0 through ${MAX_TIMER_INTERVAL}`
      )
    }
    this.refreshInterval = refreshInterval
    this.services = new Services('main')
    this.exchangeRates = {
      usdPerBsv: 0,
      fiatPerUsd: Object.fromEntries(
        SUPPORTED_FIAT_CURRENCY_CODES.map(c => [c, c === 'USD' ? 1 : 0])
      ) as Record<FiatCurrencyCode, number>
    }
    this.preferredCurrency = 'USD'
    this.settingsManager = settingsManager || new WalletSettingsManager(new WalletClient())
  }

  /**
   * Initializes the currency converter by fetching
   * - the currency exchange rates
   * - the user's preferred currency
   * - and set's an interval to keep the exchange rate updated.
   * NOTE: Interval updates need testing when used in a React UI
   */
  async initialize(): Promise<void> {
    await Promise.all([this.fetchExchangeRates(), this.refreshPreferredCurrency()])

    // only start timer when refreshInterval > 0
    this.stopRefreshTimer()
    if (this.refreshInterval > 0) {
      this.refreshTimer = setInterval(() => {
        void this.fetchExchangeRates(true).catch(() => undefined)
      }, this.refreshInterval)
    }
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
  }

  dispose(): void {
    this.stopRefreshTimer()
  }

  /**
   * @returns - the symbol associated with a user's preferred currency
   */
  getCurrencySymbol(): string {
    const symbolMap = {
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
      MXN: 'MX$',
      BSV: 'BSV',
      SATS: 'SATS'
    }
    return symbolMap[this.preferredCurrency] || this.preferredCurrency
  }

  /**
   * Fetch the exchange rates for usdPerBSV, gbpPerUsd, and eurPerUsd
   * @returns {Promise<ExchangeRates>}
   */
  async fetchExchangeRates(force = false): Promise<ExchangeRates> {
    const now = Date.now()
    if (!force && this.lastRateFetch > 0 && now - this.lastRateFetch < this.refreshInterval) {
      return this.exchangeRates
    }
    if (this.ratePromise !== null) return this.ratePromise

    const pending = (async (): Promise<ExchangeRates> => {
      const usdPerBsv = requirePositiveRate(await this.services.getBsvExchangeRate(), 'usdPerBsv')

      const fiatTargets = SUPPORTED_FIAT_CURRENCY_CODES.filter(
        (c): c is FiatCurrencyCode => c !== 'USD'
      )
      const fiatRates = await this.services.getFiatExchangeRates(fiatTargets)

      const fiatPerUsd = Object.fromEntries(
        SUPPORTED_FIAT_CURRENCY_CODES.map(code => [
          code,
          code === 'USD' ? 1 : requirePositiveRate(fiatRates.rates?.[code], `${code} per USD`)
        ])
      ) as Record<FiatCurrencyCode, number>

      const rates = { usdPerBsv, fiatPerUsd }
      this.exchangeRates = rates
      this.lastRateFetch = Date.now()
      return rates
    })()
    this.ratePromise = pending

    try {
      return await pending
    } catch {
      throw new Error('Failed to fetch exchange rates.')
    } finally {
      if (this.ratePromise === pending) this.ratePromise = null
    }
  }

  private refreshPreferredCurrency(): Promise<SupportedCurrencyCode> {
    const now = Date.now()
    if (this.lastCurrencyFetch > 0 && now - this.lastCurrencyFetch < this.refreshInterval) {
      return Promise.resolve(this.preferredCurrency)
    }
    if (this.currencyPromise !== null) return this.currencyPromise

    const pending = Promise.resolve(this.settingsManager.get()).then(settings => {
      const newCurrencyRaw = settings.currency ?? 'SATS'
      const newCurrency = this.normalizeSupportedCurrencyCode(newCurrencyRaw)
      if (newCurrency !== this.preferredCurrency) this.preferredCurrency = newCurrency
      this.lastCurrencyFetch = Date.now()
      return this.preferredCurrency
    })
    const tracked = pending.then(
      currency => {
        if (this.currencyPromise === tracked) this.currencyPromise = null
        return currency
      },
      error => {
        if (this.currencyPromise === tracked) this.currencyPromise = null
        throw error
      }
    )
    this.currencyPromise = tracked
    return tracked
  }

  private normalizeSupportedCurrencyCode(currency: unknown): SupportedCurrencyCode {
    if (typeof currency !== 'string') return 'SATS'
    const upper = currency.toUpperCase()
    if (upper === 'BSV' || upper === 'SATS') return upper
    if ((SUPPORTED_FIAT_CURRENCY_CODES as readonly string[]).includes(upper)) {
      return upper as FiatCurrencyCode
    }
    return 'SATS'
  }

  /**
   * Converts currency amount based on user's preferences
   * @param {number | string} amount - the currency to convert
   * @param {FormatOptions} formatOptions
   * @returns
   */
  async convertAmount(amount: number | string, formatOptions?: FormatOptions) {
    await this.refreshPreferredCurrency()
    const parsed = parseAmountInput(amount)

    // Use convertCurrency to directly convert from the input currency to the preferred currency
    const finalAmount = this.convertCurrency(parsed.amount, parsed.currency, this.preferredCurrency)
    if (finalAmount === null) {
      throw new Error('Unsupported currency or conversion error')
    }
    return formatAmountWithCurrency(finalAmount, this.preferredCurrency, formatOptions)
  }

  /**
   * Convert an amount given in any of the supported currencies to an amount in satoshis
   * @param amount
   * @returns
   */
  async convertToSatoshis(amount: number): Promise<number | null> {
    // Directly convert the amount from the preferred currency to SATS
    const satoshis = this.convertCurrency(amount, this.preferredCurrency, 'SATS')
    if (satoshis === null) return null
    if (satoshis < 0 || satoshis > MAX_SATOSHIS) {
      throw new RangeError(`Satoshi amount must be between 0 and ${MAX_SATOSHIS}`)
    }
    const rounded = Math.ceil(satoshis)
    if (!Number.isSafeInteger(rounded))
      throw new RangeError('Satoshi amount must be a safe integer')
    return rounded
  }

  /**
   * Converts a given amount from one currency to another.
   * @param {number} amount - The amount to be converted.
   * @param {string} fromCurrency - The currency code of the amount being converted.
   * @param {string} toCurrency - The currency code to convert the amount to.
   * @returns {number | null} - The converted amount or null if the conversion cannot be performed.
   */
  convertCurrency(amount: number, fromCurrency: string, toCurrency: string): number | null {
    requireFiniteNumber(amount, 'amount')
    const from = normalizeCurrencyArgument(fromCurrency, 'fromCurrency')
    const to = normalizeCurrencyArgument(toCurrency, 'toCurrency')
    if (from === to) return amount

    const usdPerBsv = requirePositiveRate(this.exchangeRates.usdPerBsv, 'usdPerBsv')

    const getFiatPerUsd = (code: string): number => {
      if (!(SUPPORTED_FIAT_CURRENCY_CODES as readonly string[]).includes(code)) {
        throw new Error('Currency not supported!')
      }
      return requirePositiveRate(
        this.exchangeRates.fiatPerUsd[code as FiatCurrencyCode],
        `${code} per USD`
      )
    }

    // Convert from the original currency to USD
    let amountInUsd: number
    switch (from) {
      case 'SATS':
        amountInUsd = (amount / 100_000_000) * usdPerBsv
        break
      case 'BSV':
        amountInUsd = amount * usdPerBsv
        break
      case 'USD':
        amountInUsd = amount
        break
      default: {
        const fiatPerUsd = getFiatPerUsd(from)
        amountInUsd = amount / fiatPerUsd
        break
      }
    }

    // Convert from USD to the target currency
    let converted: number
    switch (to) {
      case 'SATS':
        converted = (amountInUsd / usdPerBsv) * 100_000_000
        break
      case 'BSV':
        converted = amountInUsd / usdPerBsv
        break
      case 'USD':
        converted = amountInUsd
        break
      default: {
        const fiatPerUsd = getFiatPerUsd(to)
        converted = amountInUsd * fiatPerUsd
      }
    }
    return requireFiniteNumber(converted, 'converted amount')
  }
}
