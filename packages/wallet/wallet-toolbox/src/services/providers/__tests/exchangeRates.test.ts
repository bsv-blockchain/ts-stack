import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { WalletServicesOptions } from '../../../sdk/WalletServices.interfaces'
import { createDefaultWalletServicesOptions } from '../../createDefaultWalletServicesOptions'
import {
  updateChaintracksFiatExchangeRates,
  updateExchangeratesapi
} from '../exchangeRates'

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
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(success), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success), { status: 200 }))

    await expect(
      updateChaintracksFiatExchangeRates(['EUR'], options)
    ).rejects.toThrow('returned status 503')
    await expect(
      updateChaintracksFiatExchangeRates(['EUR'], options)
    ).rejects.toThrow('returned status 200')
    await expect(
      updateChaintracksFiatExchangeRates(['EUR'], options)
    ).resolves.toMatchObject({
      base: 'USD',
      rates: { EUR: 0.9 },
      timestamp: expect.any(Date)
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
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
