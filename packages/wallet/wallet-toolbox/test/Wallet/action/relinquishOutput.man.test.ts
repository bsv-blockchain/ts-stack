import { RelinquishOutputArgs } from '@bsv/sdk'
import { sdk, StorageKnex } from '../../../src/index.all'
import { _tu, expectToThrowWERR, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { getBeefForTransaction } from '../../../src/storage/methods/getBeefForTransaction'

describe('RelinquishOutputArgs tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('relinquishActionTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('relinquishActionTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('1_default', async () => {
    const outputTxid = '2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122'
    const expectedResult = { relinquished: true }

    for (const { wallet, activeStorage: storage } of ctxs) {
      const args: RelinquishOutputArgs = {
        basket: 'default',
        output: `${outputTxid}.0`
      }

      const r1 = await wallet.relinquishOutput(args)
      await expect(Promise.resolve(r1)).resolves.toEqual(expectedResult)
    }
  })
})
