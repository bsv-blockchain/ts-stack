/* eslint-env jest */
// setup env vars before require
process.env.PRICE_PER_GB_MO = 0.03

const getPriceForFile = require('../getPriceForFile').default
const axios = require('axios')
const { log } = require('../../logger')

jest.mock('axios')
jest.mock('../../logger', () => ({
  log: {
    error: jest.fn()
  }
}))

let valid

describe('getPriceForFile', () => {
  beforeEach(() => {
    axios.get.mockReturnValue({ data: { rate: 200 } })
    valid = {
      fileSize: 580 * 1000000, // 580 MB
      retentionPeriod: 525600 * 8 // 8 years
    }
  })
  afterEach(() => {
    jest.clearAllMocks()
  })
  it('Returns the correct number', async () => {
    const returnValue = await getPriceForFile(valid)
    expect(returnValue).toEqual(846799)
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.whatsonchain.com/v1/bsv/main/exchangerate',
      expect.objectContaining({
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
        maxBodyLength: 64 * 1024,
        signal: expect.any(AbortSignal)
      })
    )
  })
  it('Logs an error and uses 30 if the rate request fails', async () => {
    axios.get.mockReturnValue({ data: null })
    const returnValue = await getPriceForFile(valid)
    expect(returnValue).toEqual(5645333)
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'price.exchange_rate',
        outcome: 'error',
        fallback_rate: 30,
        err: expect.any(Error)
      }),
      'Exchange rate failed, using fallback rate'
    )
  })
  it.each([
    [{ rate: '200' }, 'string'],
    [{ rate: Number.NaN }, 'NaN'],
    [{ rate: Number.POSITIVE_INFINITY }, 'infinite'],
    [{ rate: 1_000_001 }, 'implausibly high'],
    [{ rate: 0.001 }, 'implausibly low'],
    [{ rate: 0 }, 'zero'],
    [{ rate: -1 }, 'negative']
  ])('rejects a %s exchange rate and uses the safe fallback (%s)', async data => {
    axios.get.mockReturnValue({ data })

    await expect(getPriceForFile(valid)).resolves.toEqual(5645333)
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'price.exchange_rate',
        fallback_rate: 30,
        err: expect.any(TypeError)
      }),
      'Exchange rate failed, using fallback rate'
    )
  })
  it('Works with different exchange rates', async () => {
    // As the exchange rate increases, number of satoshis decreases as they are more valuable
    axios.get.mockReturnValue({ data: { rate: 300 } })
    let returnValue = await getPriceForFile(valid)
    expect(returnValue).toEqual(564533)
    axios.get.mockReturnValue({ data: { rate: 400 } })
    returnValue = await getPriceForFile(valid)
    expect(returnValue).toEqual(423399)
    axios.get.mockReturnValue({ data: { rate: 500 } })
    returnValue = await getPriceForFile(valid)
    expect(returnValue).toEqual(338719)
    axios.get.mockReturnValue({ data: { rate: 40000 } })
    returnValue = await getPriceForFile(valid)
    expect(returnValue).toEqual(4233)
    axios.get.mockReturnValue({ data: { rate: 800000 } })
    returnValue = await getPriceForFile(valid)
    expect(returnValue).toEqual(211)
  })

  it.each(['1usd', '1e3', '-1', '0', 'Infinity', '1000001'])(
    'rejects ambiguous or out-of-range PRICE_PER_GB_MO %s',
    async configuredPrice => {
      const previous = process.env.PRICE_PER_GB_MO
      process.env.PRICE_PER_GB_MO = configuredPrice
      try {
        await expect(getPriceForFile(valid)).rejects.toThrow('PRICE_PER_GB_MO')
      } finally {
        process.env.PRICE_PER_GB_MO = previous
      }
    }
  )
})
