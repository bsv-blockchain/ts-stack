import * as dotenv from 'dotenv'
import { Services } from '../../index.client'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import type { FiatCurrencyCode, FiatExchangeRates } from '../../sdk/WalletServices.interfaces'

dotenv.config()

describe('getFiatExchangeRate service tests', () => {
  jest.setTimeout(99999999)

  function makeFetchedRates (rates: Record<string, number>): FiatExchangeRates {
    return {
      timestamp: new Date('2026-03-25T00:00:00.000Z'),
      base: 'USD',
      rates
    }
  }

  test('0 uses the chaintracks fiat service without an exchangeratesapi key', async () => {
    const options = Services.createDefaultOptions('main')
    options.fiatExchangeRates = {
      timestamp: new Date('2020-01-01T00:00:00.000Z'),
      base: 'USD',
      rates: { USD: 1 },
      rateTimestamps: { USD: new Date('2020-01-01T00:00:00.000Z') }
    }
    const services = new Services(options)
    expect(services.updateFiatExchangeRateServices.count).toBe(1)
    expect(services.updateFiatExchangeRateServices.name).toBe('ChaintracksFiatRates')
    const chaintracksService = jest.fn(async () => makeFetchedRates({ EUR: 0.8, GBP: 0.5 }))
    services.updateFiatExchangeRateServices.services[0].service = chaintracksService

    await expect(services.getFiatExchangeRate('EUR', 'GBP')).resolves.toBeCloseTo(1.6)
    expect(chaintracksService).toHaveBeenCalledWith(['EUR', 'GBP'], services.options)
  })

  test('1 uses only exchangeratesapi when an api key is configured', async () => {
    const options = Services.createDefaultOptions('main')
    options.exchangeratesapiKey = 'test-api-key'
    options.fiatExchangeRates = {
      timestamp: new Date('2020-01-01T00:00:00.000Z'),
      base: 'USD',
      rates: { USD: 1 },
      rateTimestamps: { USD: new Date('2020-01-01T00:00:00.000Z') }
    }
    const services = new Services(options)
    expect(services.updateFiatExchangeRateServices.count).toBe(1)
    expect(services.updateFiatExchangeRateServices.name).toBe('exchangeratesapi')
    expect(
      services.updateFiatExchangeRateServices.services.find(s => s.name === 'ChaintracksFiatRates')
    ).toBeUndefined()

    const exchangeratesapiService = jest.fn(async () => makeFetchedRates({ EUR: 0.92 }))
    services.updateFiatExchangeRateServices.services[0].service = exchangeratesapiService

    await expect(services.getFiatExchangeRate('EUR')).resolves.toBeCloseTo(0.92)
    expect(exchangeratesapiService).toHaveBeenCalledWith(['EUR'], services.options)
  })

  test('2 returns 1 without refreshing when the requested currency matches the base', async () => {
    const options = Services.createDefaultOptions('main')
    const services = new Services(options)
    const updateFiatExchangeRates = jest.spyOn(services, 'updateFiatExchangeRates')

    await expect(services.getFiatExchangeRate('USD')).resolves.toBe(1)
    expect(updateFiatExchangeRates).not.toHaveBeenCalled()
  })

  test('3 throws when the requested currency rate is unavailable after refresh', async () => {
    const options = Services.createDefaultOptions('main')
    const services = new Services(options)

    jest
      .spyOn(services, 'updateFiatExchangeRates')
      .mockImplementation(async (_targetCurrencies: FiatCurrencyCode[]) => {
        services.options.fiatExchangeRates = {
          ...services.options.fiatExchangeRates,
          rates: {
            USD: 1
          }
        }

        return services.options.fiatExchangeRates
      })

    await expect(services.getFiatExchangeRate('EUR')).rejects.toThrow(WERR_INVALID_PARAMETER)
    await expect(services.getFiatExchangeRate('EUR')).rejects.toThrow(
      "valid fiat currency 'EUR' with an exchange rate."
    )
  })

  test('4 throws when the requested base rate is unavailable after refresh', async () => {
    const options = Services.createDefaultOptions('main')
    const services = new Services(options)

    jest
      .spyOn(services, 'updateFiatExchangeRates')
      .mockImplementation(async (_targetCurrencies: FiatCurrencyCode[]) => {
        services.options.fiatExchangeRates = {
          ...services.options.fiatExchangeRates,
          rates: {
            EUR: 0.8
          }
        }

        return services.options.fiatExchangeRates
      })

    await expect(services.getFiatExchangeRate('EUR', 'GBP')).rejects.toThrow(WERR_INVALID_PARAMETER)
    await expect(services.getFiatExchangeRate('EUR', 'GBP')).rejects.toThrow(
      "valid fiat currency 'GBP' with an exchange rate."
    )
  })

  test('5 chaintracks works against the real service without an exchangeratesapi key', async () => {
    const options = Services.createDefaultOptions('main')
    options.fiatExchangeRates = {
      timestamp: new Date('2020-01-01T00:00:00.000Z'),
      base: 'USD',
      rates: { USD: 1 },
      rateTimestamps: { USD: new Date('2020-01-01T00:00:00.000Z') }
    }

    const services = new Services(options)
    const eurPerUsd = await services.getFiatExchangeRate('EUR')

    expect(eurPerUsd).toBeGreaterThan(0)
    expect(services.updateFiatExchangeRateServices.name).toBe('ChaintracksFiatRates')
    expect(services.options.fiatExchangeRates.rates.EUR).toBeGreaterThan(0)
  })

  test('6 exchangeratesapi works when EXCHANGERATESAPI_KEY is set', async () => {
    const apiKey = process.env.EXCHANGERATESAPI_KEY
    if (!apiKey) return

    const options = Services.createDefaultOptions('main')
    options.exchangeratesapiKey = apiKey
    options.fiatExchangeRates = {
      timestamp: new Date('2020-01-01T00:00:00.000Z'),
      base: 'USD',
      rates: { USD: 1 },
      rateTimestamps: { USD: new Date('2020-01-01T00:00:00.000Z') }
    }

    const services = new Services(options)
    const eurPerUsd = await services.getFiatExchangeRate('EUR')

    expect(eurPerUsd).toBeGreaterThan(0)
    expect(services.updateFiatExchangeRateServices.name).toBe('exchangeratesapi')
  })
})
