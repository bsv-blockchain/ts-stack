import { createPublicHTTPSFetch } from '@bsv/sdk'
import type { FiatExchangeRates, WalletServicesOptions } from '../../sdk/WalletServices.interfaces'
import { WERR_BAD_REQUEST, WERR_MISSING_PARAMETER } from '../../sdk/WERR_errors'
import {
  MAX_FIAT_FUTURE_SKEW_MS,
  MAX_FIAT_RESPONSE_RATES,
  normalizeFiatCurrencies,
  normalizeFiatExchangeRates,
  normalizeFiatRate,
  normalizeFiatTimestamp
} from '../fiatRateValidation'

const EXCHANGE_RATES_ORIGIN = 'https://api.exchangeratesapi.io'
const MAX_EXCHANGE_RATE_RESPONSE_BYTES = 256 * 1024
const EXCHANGE_RATE_TIMEOUT_MS = 15_000
const API_KEY_MAX_LENGTH = 4_096

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WERR_BAD_REQUEST(`${name} returned malformed data`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WERR_BAD_REQUEST(`${name} returned malformed data`)
  }
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || descriptor == null || !('value' in descriptor)) {
      throw new WERR_BAD_REQUEST(`${name} returned malformed data`)
    }
    result[key] = descriptor.value
  }
  return result
}

function configuredRateUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WERR_BAD_REQUEST('Fiat exchange-rate URL is invalid')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new WERR_BAD_REQUEST('Fiat exchange-rate URL must be credential-free HTTPS')
  }
  return url
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared != null && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_EXCHANGE_RATE_RESPONSE_BYTES)) {
    throw new WERR_BAD_REQUEST('Fiat exchange-rate response is too large')
  }

  const reader = response.body?.getReader()
  if (reader == null) throw new WERR_BAD_REQUEST('Fiat exchange-rate response has no body')
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_EXCHANGE_RATE_RESPONSE_BYTES) {
        await reader.cancel()
        throw new WERR_BAD_REQUEST('Fiat exchange-rate response is too large')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new WERR_BAD_REQUEST('Fiat exchange-rate response is malformed JSON')
  }
}

async function fetchRateJson(url: URL, fetchClient?: typeof fetch): Promise<unknown> {
  const client = fetchClient ?? createPublicHTTPSFetch(url.origin)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_RATE_TIMEOUT_MS)
  try {
    const response = await client(url, { redirect: 'error', signal: controller.signal })
    if (response.status !== 200) {
      throw new WERR_BAD_REQUEST(`Fiat exchange-rate provider returned status ${response.status}`)
    }
    return await readBoundedJson(response)
  } finally {
    clearTimeout(timeout)
  }
}

export async function updateChaintracksFiatExchangeRates(
  targetCurrencies: string[],
  options: WalletServicesOptions
): Promise<FiatExchangeRates> {
  const configuredUrl = options.chaintracksFiatExchangeRatesUrl
  if (configuredUrl == null || configuredUrl === '') {
    throw new WERR_MISSING_PARAMETER('options.chaintracksFiatExchangeRatesUrl')
  }
  const targets = normalizeFiatCurrencies(targetCurrencies)
  const data = plainRecord(
    await fetchRateJson(configuredRateUrl(configuredUrl), options.fiatExchangeRatesFetch),
    'Chaintracks fiat provider'
  )
  if (data.status !== 'success') {
    throw new WERR_BAD_REQUEST('Chaintracks fiat provider returned a failure status')
  }
  return normalizeFiatExchangeRates(data.value, targets)
}

export async function updateExchangeratesapi(
  targetCurrencies: string[],
  options: WalletServicesOptions
): Promise<FiatExchangeRates> {
  const key = options.exchangeratesapiKey
  if (key == null || key === '') throw new WERR_MISSING_PARAMETER('options.exchangeratesapiKey')

  const unique = normalizeFiatCurrencies(targetCurrencies, ['USD', 'EUR', 'GBP'])
  const iorates = await getExchangeRatesIo(key, unique, options.fiatExchangeRatesFetch)
  if (iorates.success !== true) {
    throw new WERR_BAD_REQUEST('getExchangeRatesIo returned a failure status')
  }

  const usdPerBase = iorates.base === 'USD' ? 1 : normalizeFiatRate(iorates.rates.USD, 'USD')
  const rates: Record<string, number> = { USD: 1 }
  for (const currency of unique) {
    if (currency === 'USD') continue
    const curPerBase = currency === iorates.base ? 1 : normalizeFiatRate(iorates.rates[currency], currency)
    rates[currency] = normalizeFiatRate(curPerBase / usdPerBase, currency)
  }

  return normalizeFiatExchangeRates(
    {
      timestamp: new Date(iorates.timestamp * 1000),
      base: 'USD',
      rates
    },
    unique
  )
}

export interface ExchangeRatesIoApi {
  success: true
  timestamp: number
  base: 'EUR' | 'USD'
  date: string
  rates: Record<string, number>
}

export async function getExchangeRatesIo(
  key: string,
  symbols?: string[],
  fetchClient?: typeof fetch
): Promise<ExchangeRatesIoApi> {
  if (typeof key !== 'string' || key.length === 0 || key.length > API_KEY_MAX_LENGTH || /\p{Cc}/u.test(key)) {
    throw new WERR_BAD_REQUEST('Exchange-rates API key is invalid')
  }
  const normalizedSymbols = normalizeFiatCurrencies(symbols ?? [])
  const url = new URL('/v1/latest', EXCHANGE_RATES_ORIGIN)
  url.searchParams.set('access_key', key)
  if (normalizedSymbols.length > 0) url.searchParams.set('symbols', normalizedSymbols.join(','))

  const data = plainRecord(await fetchRateJson(url, fetchClient), 'getExchangeRatesIo')
  if (data.success !== true || (data.base !== 'EUR' && data.base !== 'USD')) {
    throw new WERR_BAD_REQUEST('getExchangeRatesIo returned malformed data')
  }
  if (
    !Number.isSafeInteger(data.timestamp) ||
    (data.timestamp as number) * 1000 > Date.now() + MAX_FIAT_FUTURE_SKEW_MS
  ) {
    throw new WERR_BAD_REQUEST('getExchangeRatesIo returned an invalid timestamp')
  }
  if (
    typeof data.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
    new Date((data.timestamp as number) * 1000).toISOString().slice(0, 10) !== data.date
  ) {
    throw new WERR_BAD_REQUEST('getExchangeRatesIo returned an invalid date')
  }
  normalizeFiatTimestamp((data.timestamp as number) * 1000)

  const rawRates = plainRecord(data.rates, 'getExchangeRatesIo rates')
  if (Object.keys(rawRates).length > MAX_FIAT_RESPONSE_RATES) {
    throw new WERR_BAD_REQUEST('getExchangeRatesIo returned too many rates')
  }
  const rates: Record<string, number> = {}
  for (const symbol of normalizedSymbols) {
    if (symbol !== data.base) rates[symbol] = normalizeFiatRate(rawRates[symbol], symbol)
  }
  if (data.base === 'EUR') rates.USD = normalizeFiatRate(rawRates.USD, 'USD')

  return {
    success: true,
    timestamp: data.timestamp as number,
    base: data.base,
    date: data.date,
    rates
  }
}
