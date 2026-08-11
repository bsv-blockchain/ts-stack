export type UHRPChain = 'main' | 'test' | 'ttn'
export type UHRPLookupPreset = 'mainnet' | 'testnet' | 'teratestnet'

export function uhrpNetwork(value = process.env.BSV_NETWORK): {
  chain: UHRPChain
  lookupPreset: UHRPLookupPreset
} {
  switch (value?.trim().toLowerCase() ?? 'mainnet') {
    case 'main':
    case 'mainnet':
      return { chain: 'main', lookupPreset: 'mainnet' }
    case 'test':
    case 'testnet':
      return { chain: 'test', lookupPreset: 'testnet' }
    case 'ttn':
    case 'teratestnet':
      return { chain: 'ttn', lookupPreset: 'teratestnet' }
    default:
      throw new TypeError(`Unsupported BSV_NETWORK: ${value}`)
  }
}
