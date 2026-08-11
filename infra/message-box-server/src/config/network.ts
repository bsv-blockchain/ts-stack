export type PublicWalletChain = 'main' | 'test' | 'ttn'

export function parsePublicWalletChain(value: string | undefined): PublicWalletChain {
  switch (value?.trim().toLowerCase() ?? 'mainnet') {
    case 'main':
    case 'mainnet':
      return 'main'
    case 'test':
    case 'testnet':
      return 'test'
    case 'ttn':
    case 'teratestnet':
      return 'ttn'
    default:
      throw new TypeError(`Unsupported BSV_NETWORK: ${value}`)
  }
}
