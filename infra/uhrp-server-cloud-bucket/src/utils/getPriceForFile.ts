import axios from 'axios'

const { PRICE_PER_GB_MO } = process.env

interface PriceCalculationParams {
  retentionPeriod: number
  fileSize: number
}

/**
 * Calculates the satoshi price for file storage.
 *
 * @param {PriceCalculationParams} params - Parameters for price calculation.
 * @returns {Promise<number>} - The price in satoshis.
 */
const getPriceForFile = async ({ retentionPeriod, fileSize }: PriceCalculationParams): Promise<number> => {
  if (!PRICE_PER_GB_MO) {
    throw new Error('PRICE_PER_GB_MO is undefined')
  }

  const pricePerGBMonth = parseFloat(PRICE_PER_GB_MO)
  if (isNaN(pricePerGBMonth)) {
    throw new Error('PRICE_PER_GB_MO must be a valid number')
  }

  // File size is in bytes, convert to gigabytes
  const fileSizeGB = fileSize / 1000000000

  // Retention period is in minutes, convert it to months
  const retentionPeriodMonths = retentionPeriod / (60 * 24 * 30)

  // Calculate the USD price
  const usdPrice = fileSizeGB * retentionPeriodMonths * pricePerGBMonth

  // Get the exchange rate
  let exchangeRate: number
  try {
    const { data } = await axios.get(
      'https://api.whatsonchain.com/v1/bsv/main/exchangerate'
    )
    if (typeof data !== 'object' || isNaN(data.rate)) {
      throw new Error('Invalid rate response')
    }
    exchangeRate = data.rate
  } catch (e) {
    exchangeRate = 30
    console.error('Exchange rate failed, using fallback rate of 30', e)
  }

  // Exchange rate is in BSV, convert to satoshis
  const exchangeRateInSatoshis = 1 / (exchangeRate / 100000000)

  // Account for server overhead in our prices, so there is a minimum of 10 satoshis
  let satPrice = Math.max(10, Math.floor(usdPrice * exchangeRateInSatoshis));
  return satPrice
}

export default getPriceForFile