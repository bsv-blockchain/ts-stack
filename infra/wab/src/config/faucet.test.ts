import { DEFAULT_WAB_FAUCET_AMOUNT, readFaucetAmount, readFaucetWalletConfig } from './faucet'

describe('WAB faucet configuration', () => {
  it('preserves the default while accepting only safe integer amounts', () => {
    expect(readFaucetAmount(undefined)).toBe(DEFAULT_WAB_FAUCET_AMOUNT)
    expect(readFaucetAmount('0')).toBe(DEFAULT_WAB_FAUCET_AMOUNT)
    expect(readFaucetAmount('2500')).toBe(2500)
    for (const value of ['-1', '1.5', '1e3', 'Infinity', '9007199254740992']) {
      expect(() => readFaucetAmount(value)).toThrow()
    }
  })

  it('requires one exact private key, supported chain, and secure storage authority', () => {
    expect(
      readFaucetWalletConfig({
        network: 'testnet',
        rootKeyHex: '1'.padStart(64, '0'),
        storageUrl: 'https://storage.example.com/wallet'
      })
    ).toEqual({
      chain: 'test',
      rootKeyHex: '1'.padStart(64, '0'),
      storageUrl: 'https://storage.example.com/wallet'
    })

    for (const rootKeyHex of ['', '0'.repeat(64), 'g'.repeat(64), '1'.repeat(65)]) {
      expect(() =>
        readFaucetWalletConfig({
          network: 'testnet',
          rootKeyHex,
          storageUrl: 'https://storage.example.com'
        })
      ).toThrow('SERVER_PRIVATE_KEY')
    }
    for (const storageUrl of [
      'http://storage.example.com',
      'https://user:pass@storage.example.com',
      'https://storage.example.com/#secret',
      'not-a-url'
    ]) {
      expect(() =>
        readFaucetWalletConfig({
          network: 'testnet',
          rootKeyHex: '1'.padStart(64, '0'),
          storageUrl
        })
      ).toThrow('STORAGE_URL')
    }
    expect(() =>
      readFaucetWalletConfig({
        network: 'unknown',
        rootKeyHex: '1'.padStart(64, '0'),
        storageUrl: 'https://storage.example.com'
      })
    ).toThrow('BSV_NETWORK')
  })

  it('permits explicit loopback HTTP for local development only', () => {
    expect(
      readFaucetWalletConfig({
        network: 'test',
        rootKeyHex: '1'.padStart(64, '0'),
        storageUrl: 'http://127.0.0.1:3000'
      }).storageUrl
    ).toBe('http://127.0.0.1:3000/')
  })
})
