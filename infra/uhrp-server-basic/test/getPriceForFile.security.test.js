process.env.PRICE_PER_GB_MO = '1'

jest.mock('axios', () => ({
  get: jest.fn(async () => ({ data: { rate: 30 } }))
}))

const getPriceForFile = require('../out/src/utils/getPriceForFile').default
const axios = require('axios')

test.each([
  { fileSize: 0, retentionPeriod: 1 },
  { fileSize: -1, retentionPeriod: 1 },
  { fileSize: 1.5, retentionPeriod: 1 },
  { fileSize: Number.POSITIVE_INFINITY, retentionPeriod: 1 },
  { fileSize: 1, retentionPeriod: 0 },
  { fileSize: 1, retentionPeriod: 1.5 }
])('rejects invalid financial inputs %#', async value => {
  await expect(getPriceForFile(value)).rejects.toThrow('positive safe integer')
})

test('returns a bounded integer price for valid inputs', async () => {
  await expect(getPriceForFile({ fileSize: 1024, retentionPeriod: 60 })).resolves.toBe(10)
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

test.each(['1usd', '1e3', '-1', '0', 'Infinity', '1000001'])(
  'rejects ambiguous or out-of-range PRICE_PER_GB_MO %s',
  async configuredPrice => {
    const previous = process.env.PRICE_PER_GB_MO
    process.env.PRICE_PER_GB_MO = configuredPrice
    try {
      await expect(getPriceForFile({ fileSize: 1024, retentionPeriod: 60 })).rejects.toThrow(
        'PRICE_PER_GB_MO'
      )
    } finally {
      process.env.PRICE_PER_GB_MO = previous
    }
  }
)
