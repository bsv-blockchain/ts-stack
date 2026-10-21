import { toLookupNetworkPreset, toWalletNetwork } from '../utilityHelpers'

describe('wallet chain network mapping', () => {
  it('preserves the BRC-100 testnet response while isolating TTN overlay routing', () => {
    expect(toWalletNetwork('ttn')).toBe('testnet')
    expect(toLookupNetworkPreset('ttn')).toBe('teratestnet')
  })

  it('keeps private and mock chains on local overlay routing', () => {
    expect(toLookupNetworkPreset('stn')).toBe('local')
    expect(toLookupNetworkPreset('tstn')).toBe('local')
    expect(toLookupNetworkPreset('regtest')).toBe('local')
    expect(toLookupNetworkPreset('mock')).toBe('local')
  })

  it('reports regtest to BRC-100 callers as a test network', () => {
    expect(toWalletNetwork('regtest')).toBe('testnet')
  })
})
