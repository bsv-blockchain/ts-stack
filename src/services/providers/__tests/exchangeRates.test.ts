import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { WalletServicesOptions } from '../../../sdk/WalletServices.interfaces'
import { createDefaultWalletServicesOptions } from '../../createDefaultWalletServicesOptions'
import { updateExchangeratesapi } from '../exchangeRates'

describe('exchangeRates tests', () => {
  jest.setTimeout(99999999)

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
