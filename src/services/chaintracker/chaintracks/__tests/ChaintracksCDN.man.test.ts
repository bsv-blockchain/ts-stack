import { createDefaultKnexChaintracksOptions } from '../createDefaultKnexChaintracksOptions'
import { Chaintracks } from '../Chaintracks'
import { wait } from '../../../../utility/utilityHelpers'
import { Chain } from '../../../../sdk'
import { createDefaultNoDbChaintracksOptions } from '../createDefaultNoDbChaintracksOptions'
import { ChaintracksFs } from '../util/ChaintracksFs'
import { LocalCdnServer } from './LocalCdnServer'
import { _tu } from '../../../../../test/utils/TestUtilsWalletStorage'

const rootFolder = './src/services/chaintracker/chaintracks/__tests/data'

describe('Chaintracks CDN procedures', () => {
  jest.setTimeout(99999999)

  let logSpy: jest.SpyInstance,
    capturedLogs: string[] = []
  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '))
    })
  })

  test('3 NoDb export mainnet', async () => {
    if (_tu.noEnv('main')) return
    await NoDbBody('main', true)
  })

  test('4 NoDb export testnet', async () => {
    await NoDbBody('test', true)
  })

  async function NoDbBody(chain: Chain, exportHeaders?: boolean) {
    const o = createDefaultNoDbChaintracksOptions(chain)
    const c = new Chaintracks(o)
    await c.makeAvailable()

    c.subscribeHeaders(header => {
      console.log(`Header received: ${header.height} ${header.hash}`)
    })

    if (exportHeaders) {
      const rootFolder = './src/services/chaintracker/chaintracks/__tests/data/export'
      await c.exportBulkHeaders(rootFolder, ChaintracksFs, `https://cdn.projectbabbage.com/blockheaders`, 100000)
    }
    //let done = false
    //for (; !done; ) {
    await wait(1000)
    //}

    await c.destroy()
  }
})
