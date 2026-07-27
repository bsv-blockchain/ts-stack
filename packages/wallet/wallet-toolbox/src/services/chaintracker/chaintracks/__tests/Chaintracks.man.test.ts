// Operator-only long-running chain synchronization coverage.
import { Chaintracks } from '../Chaintracks'
import { Chain } from '../../../../sdk'
import { createDefaultNoDbChaintracksOptions } from '../createDefaultNoDbChaintracksOptions'
import { _tu } from '../../../../../test/utils/TestUtilsWalletStorage'

describe('Chaintracks tests', () => {
  jest.setTimeout(99999999)

  let logSpy: jest.SpyInstance
  const capturedLogs: string[] = []
  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '))
    })
  })

  test('1 NoDb mainnet', async () => {
    if (_tu.noEnv('main')) return
    const height = await noDbBody('main')
    expect(height).toBeGreaterThan(0)
  })

  test('2 NoDb testnet', async () => {
    if (_tu.noEnv('test')) return
    const height = await noDbBody('test')
    expect(height).toBeGreaterThan(0)
  })

  async function noDbBody(chain: Chain): Promise<number> {
    const o = createDefaultNoDbChaintracksOptions(chain)
    const c = new Chaintracks(o)
    try {
      await c.makeAvailable()
      c.subscribeHeaders(header => {
        console.log(`Header received: ${header.height} ${header.hash}`)
      })
      return await c.getPresentHeight()
    } finally {
      await c.destroy()
    }
  }
})
