import { sdk } from '../../../src/index.client'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('Wallet getVersion Tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('getVersionTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('getVersionTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('should return the correct wallet version', async () => {
    for (const { wallet } of ctxs) {
      const result = await wallet.getVersion({})
      expect(result).toEqual({ version: 'wallet-brc100-1.0.0' })
    }
  })
})
