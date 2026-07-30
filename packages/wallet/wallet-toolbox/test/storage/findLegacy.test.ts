import { _tu, TestWalletNoSetup } from '../utils/TestUtilsWalletStorage'

describe('find tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('storagefindLegacytest'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('storagefindLegacytest'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('finds a sending output in the legacy fixture', async () => {
    for (const { storage } of ctxs) {
      {
        const r = await storage.findOutputs({
          partial: { userId: 1, basketId: 1 },
          txStatus: ['sending']
        })
        expect(r).toHaveLength(1)
        expect(r[0].txid).toBe('a3a8fe7f541c1383ff7b975af49b27284ae720af5f2705d8409baaf519190d26')
        expect(r[0].vout).toBe(2)
      }
    }
  })
})
