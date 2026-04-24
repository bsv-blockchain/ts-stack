import { AbortActionArgs } from '@bsv/sdk'
import { sdk } from '../../../src/index.client'
import { _tu, expectToThrowWERR, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('abortAction tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')

  beforeAll(async () => {})

  afterAll(async () => {})

  test('0 invalid params', async () => {
    const ctxs: TestWalletNoSetup[] = []
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('abortActionTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('abortActionTests'))
    for (const { wallet } of ctxs) {
      const invalidArgs: AbortActionArgs[] = [
        { reference: '' },
        { reference: '====' },
        { reference: 'a'.repeat(301) },
        { reference: 'a'.repeat(300) }
        // Oh so many things to test...
      ]

      for (const args of invalidArgs) {
        await expectToThrowWERR(sdk.WERR_INVALID_PARAMETER, () => wallet.abortAction(args))
      }
    }
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('1_abort reference 49f878d8405589', async () => {
    const ctxs: TestWalletNoSetup[] = []
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('abortActionTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('abortActionTests'))
    for (const { wallet } of ctxs) {
      await wallet.abortAction({ reference: 'Sfh42EBViQ==' })
    }
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })
})
