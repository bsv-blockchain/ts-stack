import axios from 'axios'
import { log } from '../logger'

const { PRICE_PER_GB_MO } = process.env

interface PriceCalculationParams {
  retentionPeriod: number
  fileSize: number
}

const FALLBACK_EXCHANGE_RATE = 30

function hasUsableExchangeRate(data: unknown): data is { rate: number } {
  if (typeof data !== 'object' || data === null || !('rate' in data)) return false
  const { rate } = data
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
}

async function fetchExchangeRate(): Promise<number> {
  try {
    const response = await axios.get('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
    if (!hasUsableExchangeRate(response.data)) {
      throw new TypeError('Invalid rate response')
    }
    return response.data.rate
  } catch (error) {
    log.error(
      {
        operation: 'exchange_rate.fetch',
        outcome: 'error',
        fallback_rate: FALLBACK_EXCHANGE_RATE,
        err: error
      },
      'Exchange rate failed, using fallback rate'
    )
    return FALLBACK_EXCHANGE_RATE
  }
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
  if (!PRICE_PER_GB_MO) {
    throw new Error('PRICE_PER_GB_MO is undefined')
  }

  const pricePerGBMonth = Number.parseFloat(PRICE_PER_GB_MO)
  if (Number.isNaN(pricePerGBMonth)) {
    throw new TypeError('PRICE_PER_GB_MO must be a valid number')
  }

  // File size is in bytes, convert to gigabytes
  const fileSizeGB = fileSize / 1000000000

  // Retention period is in minutes, convert it to months
  const retentionPeriodMonths = retentionPeriod / (60 * 24 * 30)

  // Calculate the USD price
  const usdPrice = fileSizeGB * retentionPeriodMonths * pricePerGBMonth

  const exchangeRate = await fetchExchangeRate()

  // Exchange rate is in BSV, convert to satoshis
  const exchangeRateInSatoshis = 1 / (exchangeRate / 100000000)

  // Account for server overhead in our prices, so there is a minimum of 10 satoshis
  const satPrice = Math.max(10, Math.floor(usdPrice * exchangeRateInSatoshis))
  return satPrice
}

export default getPriceForFile
