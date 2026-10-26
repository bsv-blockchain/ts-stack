import axios from 'axios'
import { log } from '../logger'

interface PriceCalculationParams {
  retentionPeriod: number
  fileSize: number
}

const FALLBACK_EXCHANGE_RATE = 30
const MIN_EXCHANGE_RATE = 0.01
const MAX_EXCHANGE_RATE = 1_000_000
const EXCHANGE_RATE_TIMEOUT_MS = 10_000
const EXCHANGE_RATE_MAX_BYTES = 64 * 1024

function readPricePerGBMonth(value = process.env.PRICE_PER_GB_MO): number {
  const normalized = value?.trim()
  if (normalized == null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new TypeError('PRICE_PER_GB_MO must be a canonical positive decimal number')
  }
  const price = Number(normalized)
  if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
    throw new TypeError('PRICE_PER_GB_MO must be a bounded positive decimal number')
  }
  return price
}

function hasUsableExchangeRate(data: unknown): data is { rate: number } {
  if (typeof data !== 'object' || data === null || !('rate' in data)) return false
  const { rate } = data
  return (
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate >= MIN_EXCHANGE_RATE &&
    rate <= MAX_EXCHANGE_RATE
  )
}

/**
 * Calculates the satoshi price for file storage.
 *
 * @param {PriceCalculationParams} params - Parameters for price calculation.
 * @returns {Promise<number>} - The price in satoshis.
 */
const getPriceForFile = async ({
  retentionPeriod,
  fileSize
}: PriceCalculationParams): Promise<number> => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 1) {
    throw new RangeError('fileSize must be a positive safe integer')
  }
  if (!Number.isSafeInteger(retentionPeriod) || retentionPeriod < 1) {
    throw new RangeError('retentionPeriod must be a positive safe integer')
  }
  const pricePerGBMonth = readPricePerGBMonth()

  // File size is in bytes, convert to gigabytes
  const fileSizeGB = fileSize / 1000000000

  // Retention period is in minutes, convert it to months
  const retentionPeriodMonths = retentionPeriod / (60 * 24 * 30)

  // Calculate the USD price
  const usdPrice = fileSizeGB * retentionPeriodMonths * pricePerGBMonth

  // Get the exchange rate
  let exchangeRate: number
  try {
    const { data } = await axios.get('https://api.whatsonchain.com/v1/bsv/main/exchangerate', {
      signal: AbortSignal.timeout(EXCHANGE_RATE_TIMEOUT_MS),
      timeout: EXCHANGE_RATE_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: EXCHANGE_RATE_MAX_BYTES,
      maxBodyLength: EXCHANGE_RATE_MAX_BYTES,
      validateStatus: status => status === 200
    })
    if (!hasUsableExchangeRate(data)) {
      throw new TypeError('Invalid rate response')
    }
    exchangeRate = data.rate
  } catch (e) {
    exchangeRate = FALLBACK_EXCHANGE_RATE
    log.error(
      {
        operation: 'price.exchange_rate',
        outcome: 'error',
        fallback_rate: FALLBACK_EXCHANGE_RATE,
        err: e
      },
      'Exchange rate failed, using fallback rate'
    )
  }

  // Exchange rate is in BSV, convert to satoshis
  const exchangeRateInSatoshis = 1 / (exchangeRate / 100000000)

  // Account for server overhead in our prices, so there is a minimum of 10 satoshis
  const satPrice = Math.max(10, Math.floor(usdPrice * exchangeRateInSatoshis))
  if (!Number.isSafeInteger(satPrice) || satPrice < 1 || satPrice > 21e14) {
    throw new RangeError('Calculated storage price is outside the supported satoshi range')
  }
  return satPrice
}

export default getPriceForFile
