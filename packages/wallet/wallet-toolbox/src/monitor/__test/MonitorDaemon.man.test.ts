import { MonitorDaemon } from '../MonitorDaemon'
import { Chain } from '../../sdk/types'
import { Services } from '../../services/Services'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { createDefaultNoDbChaintracksOptions } from '../../services/chaintracker/chaintracks/createDefaultNoDbChaintracksOptions'
import { Chaintracks } from '../../services/chaintracker/chaintracks/Chaintracks'

describe('MonitorDaemon tests', () => {
  jest.setTimeout(99999999)

  test('0 mainnet', async () => {
    await test0Body('main')
  })

  test('0a testnet', async () => {
    await test0Body('test')
  })

  async function test0Body(chain: Chain) {
    const env = _tu.getEnv(chain)

    const servicesOptions = Services.createDefaultOptions(chain)
    if (env.taalApiKey) {
      servicesOptions.taalApiKey = env.taalApiKey
      servicesOptions.arcConfig.apiKey = env.taalApiKey
    }
    if (env.whatsonchainApiKey) servicesOptions.whatsOnChainApiKey = env.whatsonchainApiKey
    if (env.bitailsApiKey) servicesOptions.bitailsApiKey = env.bitailsApiKey

    const u = undefined
    const maxRetained = 32
    const chaintracksOptions = createDefaultNoDbChaintracksOptions(chain, env.whatsonchainApiKey, u, maxRetained)
    const chaintracks = new Chaintracks(chaintracksOptions)
    servicesOptions.chaintracks = chaintracks

    const d = new MonitorDaemon({
      chain: 'test',
      mySQLConnection: env.cloudMySQLConnection,
      servicesOptions,
      chaintracks
    })

    await d.runDaemon()
  }
})
