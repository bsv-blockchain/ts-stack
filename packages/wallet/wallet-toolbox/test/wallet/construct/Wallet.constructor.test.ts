import { sdk } from '../../../src/index.client'
import { _tu, TestSetup1Wallet } from '../../utils/TestUtilsWalletStorage'

describe('Wallet constructor tests', () => {
  jest.setTimeout(99999999)

  const chain: sdk.Chain = 'test'
  const ctxs: TestSetup1Wallet[] = []
  const env = _tu.getEnv(chain)

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(
        await _tu.createMySQLTestSetup1Wallet({
          databaseName: 'walletConstruct',
          chain,
          rootKeyHex: '1'.repeat(64)
        })
      )
    }
    ctxs.push(
      await _tu.createSQLiteTestSetup1Wallet({
        databaseName: 'walletConstruct',
        chain,
        rootKeyHex: '2'.repeat(64)
      })
    )
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('0', async () => {
    for (const { activeStorage: storage, userId, wallet } of ctxs) {
      {
        const labels = await storage.findTxLabels({ partial: { userId } })
        const label = labels[0].label
        const r = await wallet.listActions({
          labels: [label]
        })
        expect(r.totalActions).toBe(1)
      }

      {
        const baskets = await storage.findOutputBaskets({ partial: { userId } })
        const basket = baskets[0].name
        const r = await wallet.listOutputs({
          basket
        })
        expect(r.totalOutputs).toBe(1)
      }
    }
  })
})
