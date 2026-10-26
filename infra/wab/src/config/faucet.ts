import { parsePublicWalletChain, type PublicWalletChain } from './network'

export const DEFAULT_WAB_FAUCET_AMOUNT = 1000
const MAX_SATOSHIS = 21e14
const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const MAX_STORAGE_URL_LENGTH = 2048

export interface FaucetWalletConfig {
  chain: PublicWalletChain
  rootKeyHex: string
  storageUrl: string
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

export function readFaucetWalletConfig(
  values: {
    network?: string
    rootKeyHex?: string
    storageUrl?: string
  } = {
    network: process.env.BSV_NETWORK,
    rootKeyHex: process.env.SERVER_PRIVATE_KEY,
    storageUrl: process.env.STORAGE_URL
  }
): FaucetWalletConfig {
  const rootKeyHex = values.rootKeyHex?.trim()
  if (rootKeyHex == null || !/^[0-9a-fA-F]{64}$/.test(rootKeyHex)) {
    throw new Error('SERVER_PRIVATE_KEY must be exactly 64 hexadecimal characters.')
  }
  const scalar = BigInt(`0x${rootKeyHex}`)
  if (scalar === 0n || scalar >= SECP256K1_ORDER) {
    throw new Error('SERVER_PRIVATE_KEY must be a valid nonzero secp256k1 private scalar.')
  }

  const storageUrlValue = values.storageUrl?.trim()
  if (
    storageUrlValue == null ||
    storageUrlValue.length === 0 ||
    storageUrlValue.length > MAX_STORAGE_URL_LENGTH
  ) {
    throw new Error('STORAGE_URL must be a bounded absolute HTTPS URL.')
  }
  let storageUrl: URL
  try {
    storageUrl = new URL(storageUrlValue)
  } catch {
    throw new Error('STORAGE_URL must be a bounded absolute HTTPS URL.')
  }
  const secure = storageUrl.protocol === 'https:'
  const loopbackDevelopment =
    storageUrl.protocol === 'http:' && isLoopbackHostname(storageUrl.hostname)
  if (
    (!secure && !loopbackDevelopment) ||
    storageUrl.username !== '' ||
    storageUrl.password !== '' ||
    storageUrl.hash !== ''
  ) {
    throw new Error(
      'STORAGE_URL must use HTTPS (or loopback HTTP) without credentials or a fragment.'
    )
  }

  return {
    chain: parsePublicWalletChain(values.network),
    rootKeyHex: rootKeyHex.toLowerCase(),
    storageUrl: storageUrl.href
  }
}

export function readFaucetAmount(value = process.env.COMMISSION_FEE): number {
  const normalized = value?.trim()
  // Preserve the existing zero/unset behavior: both select the 1,000-satoshi
  // demonstration default rather than disabling the faucet.
  if (normalized == null || normalized === '' || normalized === '0') {
    return DEFAULT_WAB_FAUCET_AMOUNT
  }
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('COMMISSION_FEE must be zero or a positive integer satoshi amount.')
  }
  const amount = Number(normalized)
  if (!Number.isSafeInteger(amount) || amount > MAX_SATOSHIS) {
    throw new Error('COMMISSION_FEE exceeds the safe satoshi range.')
  }
  return amount
}

export function validateFaucetConfig(): void {
  readFaucetAmount()
  readFaucetWalletConfig()
}
