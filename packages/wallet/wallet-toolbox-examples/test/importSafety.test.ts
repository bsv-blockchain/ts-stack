import { Setup } from '@bsv/wallet-toolbox'

describe('module import safety', () => {
  test('does not generate keys, create wallets, or run transaction examples on import', () => {
    const makeEnv = jest.spyOn(Setup, 'makeEnv').mockImplementation(() => '')
    const createWalletClient = jest.spyOn(Setup, 'createWalletClient')

    jest.isolateModules(() => {
      require('../src/index')
      require('../src/beef')
    })

    expect(makeEnv).not.toHaveBeenCalled()
    expect(createWalletClient).not.toHaveBeenCalled()
  })
})
