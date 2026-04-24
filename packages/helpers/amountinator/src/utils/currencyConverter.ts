import { WalletClient } from '@bsv/sdk'
import { formatAmountWithCurrency } from './amountFormatHelpers'
import {
  ExchangeRates,
  FiatCurrencyCode,
  FormatOptions,
  SUPPORTED_FIAT_CURRENCY_CODES,
  SupportedCurrencyCode
} from '../types'
import { Services } from '@bsv/wallet-toolbox-client'
import { WalletSettingsManager } from '@bsv/wallet-toolbox-client/out/src/WalletSettingsManager'
const DEFAULT_REFRESH_INTERVAL = 5 * 60 * 1000

/**
 * Converts currency amounts to user's preferred currency, and supports converting all supported currency types to satoshis.
 */
export class CurrencyConverter {
  public exchangeRates: ExchangeRates
  public preferredCurrency: SupportedCurrencyCode
  private services: Services
  private settingsManager: WalletSettingsManager

  private readonly refreshInterval: number
  private lastRateFetch = 0
  private lastCurrencyFetch = 0
  private ratePromise: Promise<ExchangeRates> | null = null
  private currencyPromise: Promise<SupportedCurrencyCode> | null = null

  private refreshTimer?: ReturnType<typeof setInterval>

  /** 
   * @param refreshInterval  How often to pull new rates (ms), if 0, it never auto-refreshes
   */
  constructor(refreshInterval: number = DEFAULT_REFRESH_INTERVAL, settingsManager: WalletSettingsManager | undefined = undefined) {
    this.refreshInterval = refreshInterval > 0 ? refreshInterval : 0
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
   * TODO: Test interval updates when used in a React UI
   */
  async initialize(): Promise<void> {
    await Promise.all([this.fetchExchangeRates(), this.refreshPreferredCurrency()])

    // only start timer when refreshInterval > 0
    if (this.refreshInterval > 0) {
      this.refreshTimer = setInterval( () => this.fetchExchangeRates(true), this.refreshInterval)
    }
  }

  dispose() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
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
    try {
      const now = Date.now()
      if (!force && now - this.lastRateFetch < this.refreshInterval) {
        return this.exchangeRates
      }
      if (this.ratePromise) return this.ratePromise

      this.ratePromise = (async () => {
        const usdPerBsv = await this.services.getBsvExchangeRate()

        const fiatTargets = SUPPORTED_FIAT_CURRENCY_CODES.filter(
          (c): c is FiatCurrencyCode => c !== 'USD'
        )
        const fiatRates = await this.services.getFiatExchangeRates(fiatTargets)

        const fiatPerUsd: Record<FiatCurrencyCode, number> = Object.fromEntries(
          SUPPORTED_FIAT_CURRENCY_CODES.map(c => {
            if (c === 'USD') return ['USD', 1]
            const v = fiatRates.rates?.[c]
            return [c, typeof v === 'number' ? v : 0]
          })
        ) as Record<FiatCurrencyCode, number>

        this.exchangeRates = { usdPerBsv, fiatPerUsd }
        this.lastRateFetch = Date.now()
        this.ratePromise = null
        return this.exchangeRates
      })()
      return this.ratePromise
    } catch (err) {
      console.error(err)
      throw new Error('Failed to fetch exchange rates.')
    }
  }

  private async refreshPreferredCurrency(): Promise<SupportedCurrencyCode> {
    const now = Date.now()
    if (now - this.lastCurrencyFetch < this.refreshInterval) {
      return this.preferredCurrency
    }
    if (this.currencyPromise) return this.currencyPromise
  
    this.currencyPromise = (async () => {
      const settingsManager = this.settingsManager

      const newCurrencyRaw = (await settingsManager.get()).currency ?? 'SATS'
      const newCurrency = this.normalizeSupportedCurrencyCode(newCurrencyRaw)
      if (newCurrency !== this.preferredCurrency) this.preferredCurrency = newCurrency
      this.lastCurrencyFetch = Date.now()
      this.currencyPromise = null
      return this.preferredCurrency
    })()
  
    return this.currencyPromise
  }  

  private normalizeSupportedCurrencyCode(currency: string): SupportedCurrencyCode {
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
    const amountAsString = amount.toString()
    let parsedAmount = parseFloat(amountAsString.replace(/[^0-9.-]+/g, ""))
    let inputCurrency = amountAsString.replace(/[\d.,\s]+/g, '').trim()
    inputCurrency ||= (amountAsString.includes('.') ? 'BSV' : 'SATS')

    // Use convertCurrency to directly convert from the input currency to the preferred currency
    let finalAmount = this.convertCurrency(parsedAmount, inputCurrency, this.preferredCurrency)
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
    if (satoshis === null) {
      console.error('Unsupported currency or conversion error:', this.preferredCurrency)
      return null
    }
    return Math.ceil(satoshis)
  }

  /**
   * Converts a given amount from one currency to another.
   * @param {number} amount - The amount to be converted.
   * @param {string} fromCurrency - The currency code of the amount being converted.
   * @param {string} toCurrency - The currency code to convert the amount to.
   * @returns {number | null} - The converted amount or null if the conversion cannot be performed.
   */
  convertCurrency(amount: number, fromCurrency: string, toCurrency: string): number | null {
    const from = fromCurrency.toUpperCase()
    const to = toCurrency.toUpperCase()
    if (from === to) return amount

    const usdPerBsv = this.exchangeRates.usdPerBsv
    if (typeof usdPerBsv !== 'number' || usdPerBsv <= 0) {
      throw new Error('Exchange rate not available: usdPerBsv')
    }

    const getFiatPerUsd = (code: string): number => {
      if (!(SUPPORTED_FIAT_CURRENCY_CODES as readonly string[]).includes(code)) {
        throw new Error('Currency not supported!')
      }
      const v = this.exchangeRates.fiatPerUsd[code as FiatCurrencyCode]
      if (typeof v !== 'number' || v <= 0) {
        throw new Error(`Exchange rate not available: ${code} per USD`)
      }
      return v
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
    switch (to) {
      case 'SATS':
        return (amountInUsd / usdPerBsv) * 100_000_000
      case 'BSV':
        return amountInUsd / usdPerBsv
      case 'USD':
        return amountInUsd
      default: {
        const fiatPerUsd = getFiatPerUsd(to)
        return amountInUsd * fiatPerUsd
      }
    }
  }
}
