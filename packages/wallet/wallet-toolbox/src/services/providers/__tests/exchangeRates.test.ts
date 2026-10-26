import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { WalletServicesOptions } from '../../../sdk/WalletServices.interfaces'
import { createDefaultWalletServicesOptions } from '../../createDefaultWalletServicesOptions'
import { getExchangeRatesIo, updateChaintracksFiatExchangeRates, updateExchangeratesapi } from '../exchangeRates'

describe('exchangeRates tests', () => {
  jest.setTimeout(99999999)

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('validates Chaintracks HTTP and payload status before returning rates', async () => {
    const options = {
      chaintracksFiatExchangeRatesUrl: 'https://rates.example'
    } as WalletServicesOptions
    const success = {
      status: 'success',
      value: {
        timestamp: '2026-07-28T00:00:00.000Z',
        base: 'USD',
        rates: { EUR: 0.9 }
      }
    }
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(success), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success), { status: 200 }))
    options.fiatExchangeRatesFetch = fetchMock

    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).rejects.toThrow('returned status 503')
    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).rejects.toThrow('returned a failure status')
    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).resolves.toMatchObject({
      base: 'USD',
      rates: { EUR: 0.9 },
      timestamp: expect.any(Date)
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenLastCalledWith(
      new URL('https://rates.example/'),
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal)
      })
    )
  })

  test('rejects insecure provider URLs and malformed financial values', async () => {
    const fetchMock = jest.fn<typeof fetch>()
    const options = {
      chaintracksFiatExchangeRatesUrl: 'http://127.0.0.1/rates',
      fiatExchangeRatesFetch: fetchMock
    } as unknown as WalletServicesOptions

    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).rejects.toThrow('credential-free HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()

    options.chaintracksFiatExchangeRatesUrl = 'https://rates.example'
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'success',
          value: {
            timestamp: new Date().toISOString(),
            base: 'USD',
            rates: { EUR: -1 }
          }
        }),
        { status: 200 }
      )
    )
    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).rejects.toThrow(
      'EUR rate must be finite, positive, and bounded'
    )

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'success',
          value: {
            timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            base: 'USD',
            rates: { EUR: 1 }
          }
        }),
        { status: 200 }
      )
    )
    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).rejects.toThrow(
      'timestamp is invalid or too far in the future'
    )
  })

  test('rejects a private HTTPS provider address with the default transport', async () => {
    const options = {
      chaintracksFiatExchangeRatesUrl: 'https://127.0.0.1/rates'
    } as WalletServicesOptions

    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).rejects.toThrow('non-public address')
  })

  test('requires exact Exchange Rates API verdicts and canonical bounded rates', async () => {
    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            timestamp,
            base: 'EUR',
            date,
            rates: { USD: 1.1, EUR: 1, GBP: 0.8 }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: 'true',
            timestamp,
            base: 'EUR',
            date,
            rates: { USD: 1.1 }
          }),
          { status: 200 }
        )
      )

    await expect(getExchangeRatesIo('secret&symbols=JPY', ['USD', 'EUR', 'GBP'], fetchMock)).resolves.toMatchObject({
      success: true,
      rates: { USD: 1.1, GBP: 0.8 }
    })
    const requested = fetchMock.mock.calls[0][0] as URL
    expect(requested.searchParams.get('access_key')).toBe('secret&symbols=JPY')
    expect(requested.searchParams.get('symbols')).toBe('USD,EUR,GBP')

    await expect(getExchangeRatesIo('secret', ['USD'], fetchMock)).rejects.toThrow('returned malformed data')
  })

  test('does not accept exchange-rate fields inherited from Object.prototype', async () => {
    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'success')
    let thrown: unknown
    try {
      Object.defineProperty(Object.prototype, 'success', {
        value: true,
        configurable: true,
        enumerable: false,
        writable: true
      })
      const fetchMock = jest
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ timestamp, base: 'USD', date, rates: {} }), { status: 200 }))
      try {
        await getExchangeRatesIo('secret', [], fetchMock)
      } catch (error) {
        thrown = error
      }
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, 'success')
      else Object.defineProperty(Object.prototype, 'success', previous)
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('returned malformed data')
  })

  test('rejects oversized response declarations before reading JSON', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(256 * 1024 + 1) }
      })
    )
    const options = {
      chaintracksFiatExchangeRatesUrl: 'https://rates.example',
      fiatExchangeRatesFetch: fetchMock
    } as unknown as WalletServicesOptions

    await expect(updateChaintracksFiatExchangeRates(['EUR'], options)).rejects.toThrow('response is too large')
  })

  test('0', async () => {
    if (_tu.noEnv('main')) return
    const o = createDefaultWalletServicesOptions('main')
    // Define a real API key here when running this test intentionally.
    o.exchangeratesapiKey = ''
    // The default api key for this service is severely use limited,
    // do not run this test aggressively. Without substituting your own key.
    // o.exchangeratesapiKey = 'YOUR_API_KEY'
    if (!o.exchangeratesapiKey) return
    const r = await updateExchangeratesapi(['EUR', 'GBP', 'USD'], o)
    expect(r).toBeDefined()
  })
})
