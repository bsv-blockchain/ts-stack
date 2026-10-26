jest.mock('@bsv/wallet-toolbox', () => ({
  Setup: {
    getEnv: jest.fn(),
    createWalletClient: jest.fn()
  },
  sdk: {
    Validation: {
      parseWalletOutpoint: jest.fn()
    }
  }
}))

jest.mock('@bsv/wallet-toolbox/out/src/sdk', () => ({
  specOpWalletBalance: 'specOpWalletBalance'
}))

import { Setup, sdk } from '@bsv/wallet-toolbox'
import { balanceSpecOp, balances, walletBalance } from '../src/balances'

const txidA = 'aa'.repeat(32)
const txidB = 'bb'.repeat(32)
const environment = {
  identityKey: 'identity-one',
  identityKey2: 'identity-two',
  devKeys: {
    'identity-one': 'private-one',
    'identity-two': 'private-two'
  }
}

function setupWith(walletOverrides: Record<string, unknown> = {}) {
  return {
    wallet: {
      listOutputs: jest.fn(),
      balance: jest.fn(),
      destroy: jest.fn(async () => undefined),
      ...walletOverrides
    }
  }
}

describe('balance examples', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    ;(Setup.getEnv as jest.Mock).mockReturnValue(environment)
    ;(sdk.Validation.parseWalletOutpoint as jest.Mock).mockImplementation((outpoint: string) => {
      const [txid, vout] = outpoint.split('.')
      return { txid, vout: Number(vout) }
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('paginates canonical outputs for both identities and always destroys each wallet', async () => {
    const first = setupWith({
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          totalOutputs: 3,
          outputs: [
            { outpoint: `${txidA.toUpperCase()}.0`, satoshis: 3 },
            { outpoint: `${txidB}.1`, satoshis: 4 }
          ]
        })
        .mockResolvedValueOnce({
          totalOutputs: 3,
          outputs: [{ outpoint: `${'cc'.repeat(32)}.2`, satoshis: 5 }]
        })
    })
    const second = setupWith({
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 0, outputs: [] })
    })
    ;(Setup.createWalletClient as jest.Mock)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)

    await balances()

    expect(first.wallet.listOutputs).toHaveBeenNthCalledWith(1, {
      basket: 'default',
      limit: 10,
      offset: 0
    })
    expect(first.wallet.listOutputs).toHaveBeenNthCalledWith(2, {
      basket: 'default',
      limit: 10,
      offset: 2
    })
    expect(console.log).toHaveBeenCalledWith('balance for identity-one = 12')
    expect(console.log).toHaveBeenCalledWith('balance for identity-two = 0')
    expect(first.wallet.destroy).toHaveBeenCalledTimes(1)
    expect(second.wallet.destroy).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ totalOutputs: -1, outputs: [] }, 'invalid or excessive output count'],
    [{ totalOutputs: 100_001, outputs: [] }, 'invalid or excessive output count'],
    [{ totalOutputs: 1.5, outputs: [] }, 'invalid or excessive output count'],
    [
      { totalOutputs: 1, outputs: [{ outpoint: `${txidA}.0`, satoshis: -1 }] },
      'non-negative safe integer'
    ]
  ])('rejects unsafe wallet pagination %# and still destroys the wallet', async (page, message) => {
    const setup = setupWith({ listOutputs: jest.fn().mockResolvedValue(page) })
    ;(Setup.createWalletClient as jest.Mock).mockResolvedValue(setup)

    await expect(balances()).rejects.toThrow(message)
    expect(setup.wallet.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects repeated outpoints across pages after canonicalizing the txid', async () => {
    const setup = setupWith({
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [{ outpoint: `${txidA.toUpperCase()}.0`, satoshis: 1 }]
        })
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [{ outpoint: `${txidA}.0`, satoshis: 1 }]
        })
    })
    ;(Setup.createWalletClient as jest.Mock).mockResolvedValue(setup)

    await expect(balances()).rejects.toThrow('repeated an output across pages')
    expect(setup.wallet.destroy).toHaveBeenCalledTimes(1)
  })

  it('requests the balance special operation and validates its result', async () => {
    const setup = setupWith({
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 42, outputs: [] })
    })
    ;(Setup.createWalletClient as jest.Mock).mockResolvedValue(setup)

    await balanceSpecOp()

    expect(setup.wallet.listOutputs).toHaveBeenCalledWith({ basket: 'specOpWalletBalance' })
    expect(console.log).toHaveBeenCalledWith('balance for identity-one = 42')
    expect(setup.wallet.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects an unsafe special-operation balance and still destroys the wallet', async () => {
    const setup = setupWith({
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: Number.NaN, outputs: [] })
    })
    ;(Setup.createWalletClient as jest.Mock).mockResolvedValue(setup)

    await expect(balanceSpecOp()).rejects.toThrow('non-negative safe integer')
    expect(setup.wallet.destroy).toHaveBeenCalledTimes(1)
  })

  it('uses the wallet balance extension and validates its result', async () => {
    const setup = setupWith({ balance: jest.fn().mockResolvedValue(21) })
    ;(Setup.createWalletClient as jest.Mock).mockResolvedValue(setup)

    await walletBalance()

    expect(setup.wallet.balance).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith('balance for identity-one = 21')
    expect(setup.wallet.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects an unsafe wallet balance and still destroys the wallet', async () => {
    const setup = setupWith({ balance: jest.fn().mockResolvedValue(21e14 + 1) })
    ;(Setup.createWalletClient as jest.Mock).mockResolvedValue(setup)

    await expect(walletBalance()).rejects.toThrow('non-negative safe integer')
    expect(setup.wallet.destroy).toHaveBeenCalledTimes(1)
  })
})
