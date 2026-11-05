import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { WERR_INVALID_PARAMETER } from '../../../src/sdk/WERR_errors'
import 'fake-indexeddb/auto'

describe('listOutputs BRC-112 balance prefix', () => {
  jest.setTimeout(120000)
  let ctx: TestWalletNoSetup

  beforeEach(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName ?? 'listOutputsBrc112')
  })

  afterEach(async () => {
    await ctx.wallet.destroy()
  })

  test('balance default reports the satoshi sum with no outputs', async () => {
    const balance = await ctx.wallet.listOutputs({ basket: 'balance default' })
    expect(balance.outputs).toEqual([])
    expect(typeof balance.totalOutputs).toBe('number')
    expect(balance.totalOutputs).toBeGreaterThan(0)
  })

  test('balance p <module> <basket> is rejected, as BRC-112 requires', async () => {
    for (const basket of ['balance p color abc', 'balance p color balance abc', 'balance p btms']) {
      await expect(ctx.wallet.listOutputs({ basket })).rejects.toThrow(WERR_INVALID_PARAMETER)
      await expect(ctx.wallet.listOutputs({ basket })).rejects.toThrow(/BRC-112/)
    }
  })
})
