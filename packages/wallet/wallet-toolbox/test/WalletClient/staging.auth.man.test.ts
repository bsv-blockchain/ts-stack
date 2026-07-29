import { GetPublicKeyArgs } from '@bsv/sdk'
import { _tu } from '../utils/TestUtilsWalletStorage'

describe('staging.auth.man tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    const setup = await _tu.createTestWallet('test')
    try {
      const args: GetPublicKeyArgs = {
        identityKey: true
      }
      const r = await setup.wallet.getPublicKey(args)
      expect(r.publicKey.toString()).toBe(setup.identityKey)
    } finally {
      await setup.wallet.destroy()
    }
  })
})
