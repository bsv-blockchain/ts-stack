import { WalletClient } from '@bsv/sdk'
import { createWallet } from '../../browser'

const IDENTITY_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'

describe('browser wallet initialization boundary', () => {
  afterEach(() => {
    Reflect.deleteProperty(Object.prototype, 'publicKey')
    jest.restoreAllMocks()
  })

  it('does not accept an inherited identity-key result', async () => {
    Object.defineProperty(Object.prototype, 'publicKey', {
      value: IDENTITY_KEY,
      configurable: true
    })
    jest.spyOn(WalletClient.prototype, 'getPublicKey').mockResolvedValue({} as never)

    await expect(createWallet()).rejects.toThrow('Invalid getPublicKey result publicKey')
  })

  it('rejects an accessor-backed identity result without invoking it', async () => {
    const getter = jest.fn(() => IDENTITY_KEY)
    const result = Object.defineProperty({}, 'publicKey', { get: getter, enumerable: true })
    jest.spyOn(WalletClient.prototype, 'getPublicKey').mockResolvedValue(result as never)

    await expect(createWallet()).rejects.toThrow('Invalid getPublicKey result')
    expect(getter).not.toHaveBeenCalled()
  })
})
