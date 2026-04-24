import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('Wallet getNetwork Tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('getNetworkTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('getNetworkTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('should return the correct network', async () => {
    for (const { wallet } of ctxs) {
      const result = await wallet.getNetwork({})
      // Replace 'testnet' with the expected network for your test environment
      expect(result).toEqual({ network: 'testnet' })
    }
  })
})
