import { CurrencyConverter } from '../src/utils/currencyConverter'
import { SUPPORTED_FIAT_CURRENCY_CODES } from '../src/types'

const getBsvExchangeRateMock = jest.fn()
const getFiatExchangeRatesMock = jest.fn()
const validFiatRates = Object.fromEntries(SUPPORTED_FIAT_CURRENCY_CODES.map(code => [code, 1]))

jest.mock('@bsv/wallet-toolbox-client', () => ({
  Services: jest.fn().mockImplementation(() => ({
    getBsvExchangeRate: getBsvExchangeRateMock,
    getFiatExchangeRates: getFiatExchangeRatesMock
  })),
  WalletSettingsManager: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({ currency: 'USD' })
  }))
}))

describe('CurrencyConverter cache behaviour', () => {
  let cc: CurrencyConverter

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    jest.clearAllMocks()

    // first call returns 62 USD/BSV, later calls would return 100
    getBsvExchangeRateMock.mockResolvedValueOnce(62).mockResolvedValue(100)

    // fiat rates are fine staying constant for this test
    getFiatExchangeRatesMock.mockResolvedValue({
      timestamp: new Date(),
      base: 'USD',
      rates: validFiatRates
    })
  })

  afterEach(() => {
    cc?.dispose?.()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  test('uses cached exchange rate inside 5-minute window', async () => {
    cc = new CurrencyConverter()
    await cc.initialize()

    const first = await cc.convertAmount('10000')

    jest.advanceTimersByTime(1000)

    const second = await cc.convertAmount('10000')

    expect(first.hoverText).toBe('$0.0062')
    expect(second.hoverText).toBe('$0.0062')
    expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(1)
  })

  test('checks if the cache is set to 0 if it refreshes or not', async () => {
    cc = new CurrencyConverter(0)
    await cc.initialize()

    const first = await cc.convertAmount('10000')

    jest.advanceTimersByTime(1000)

    const second = await cc.convertAmount('10000')

    expect(first.hoverText).toBe('$0.0062')
    expect(second.hoverText).toBe('$0.0062')
    expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(1)
  })

  test('checks if the cache will properly reset itself', async () => {
    cc = new CurrencyConverter(500)
    await cc.initialize()

    const first = await cc.convertAmount('10000')
    const second = await cc.convertAmount('5000')

    await jest.advanceTimersByTimeAsync(500)

    const third = await cc.convertAmount('10000')

    expect(first.hoverText).toBe('$0.0062')
    expect(second.hoverText).toBe('$0.0031')
    expect(third.hoverText).not.toBe('$0.0062')
    expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(2)
  })

  test('clears failed in-flight requests so a later refresh can recover', async () => {
    getBsvExchangeRateMock
      .mockReset()
      .mockRejectedValueOnce(new Error('private upstream detail'))
      .mockResolvedValue(75)
    cc = new CurrencyConverter(500)

    await expect(cc.fetchExchangeRates()).rejects.toThrow('Failed to fetch exchange rates.')
    await expect(cc.fetchExchangeRates()).resolves.toMatchObject({ usdPerBsv: 75 })
    expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(2)
  })

  test('rejects incomplete or non-finite rate snapshots without replacing the last known rates', async () => {
    getBsvExchangeRateMock.mockReset().mockResolvedValue(Number.POSITIVE_INFINITY)
    cc = new CurrencyConverter(500)
    const originalRates = cc.exchangeRates

    await expect(cc.fetchExchangeRates()).rejects.toThrow('Failed to fetch exchange rates.')
    expect(cc.exchangeRates).toBe(originalRates)

    getBsvExchangeRateMock.mockReset().mockResolvedValue(50)
    getFiatExchangeRatesMock.mockResolvedValueOnce({
      timestamp: new Date(),
      base: 'USD',
      rates: { ...validFiatRates, EUR: Number.NaN }
    })
    await expect(cc.fetchExchangeRates()).rejects.toThrow('Failed to fetch exchange rates.')
    expect(cc.exchangeRates).toBe(originalRates)
  })

  test('reinitialization replaces the refresh timer instead of multiplying it', async () => {
    cc = new CurrencyConverter(500)
    await cc.initialize()
    await cc.initialize()

    await jest.advanceTimersByTimeAsync(500)
    expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(2)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2_147_483_648, 0.5])(
    'rejects unsafe refresh interval %p',
    interval => {
      expect(() => new CurrencyConverter(interval)).toThrow('refreshInterval')
    }
  )
})
