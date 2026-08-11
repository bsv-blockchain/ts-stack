import { parsePublicWalletChain } from '../network.js'

describe('parsePublicWalletChain', () => {
  it.each([
    [undefined, 'main'],
    ['mainnet', 'main'],
    ['testnet', 'test'],
    ['ttn', 'ttn'],
    ['teratestnet', 'ttn']
  ] as const)('maps %s to %s', (value, expected) => {
    expect(parsePublicWalletChain(value)).toBe(expected)
  })

  it('rejects unknown networks instead of falling back to mainnet', () => {
    expect(() => parsePublicWalletChain('staging')).toThrow('Unsupported BSV_NETWORK')
  })
})
