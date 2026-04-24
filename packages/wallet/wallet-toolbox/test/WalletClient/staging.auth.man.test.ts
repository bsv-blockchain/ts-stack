import { GetPublicKeyArgs } from '@bsv/sdk'
import { WalletError } from '../../src/sdk/WalletError'
import { WERR_REVIEW_ACTIONS } from '../../src/sdk/WERR_errors'
import { _tu } from '../utils/TestUtilsWalletStorage'

describe('staging.auth.man tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    try {
      const setup = await _tu.createTestWallet('test')
      const args: GetPublicKeyArgs = {
        identityKey: true
      }
      const r = await setup.wallet.getPublicKey(args)
      expect(true).toBe(true)
    } catch (eu: unknown) {
      const e = WalletError.fromUnknown(eu) as WERR_REVIEW_ACTIONS
      expect(true).toBe(false)
    }
  })
})
