/**
 * Wallet creation utilities for BSV blockchain
 * Based on BSV wallet-toolbox-client
 */

import {
  PrivateKey,
  KeyDeriver,
  WalletInterface,
  WalletClient
} from '@bsv/sdk'
import { WalletStorageManager, Services, Wallet, StorageClient, WalletSigner } from '@bsv/wallet-toolbox-client'

/**
 * Creates a test wallet for blockchain testing
 *
 * @param chain - Blockchain network ('test' or 'main')
 * @param storageURL - Storage provider URL
 * @param privateKey - Private key as hex string
 * @returns WalletClient instance (cast from WalletInterface)
 * @throws Error if parameters are invalid or wallet creation fails
 */
export async function makeWallet (
  chain: 'test' | 'main',
  storageURL: string,
  privateKey: string
): Promise<WalletClient> {
  // Validate parameters
  if (!chain) {
    throw new Error('chain parameter is required (must be "test" or "main")')
  }
  if (chain !== 'test' && chain !== 'main') {
    throw new Error(`Invalid chain "${chain}". Must be "test" or "main"`)
  }
  if (!storageURL) {
    throw new Error('storageURL parameter is required')
  }
  if (!privateKey) {
    throw new Error('privateKey parameter is required')
  }

  try {
    // Create key deriver from private key
    const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'))
    const storageManager = new WalletStorageManager(keyDeriver.identityKey)
    const signer = new WalletSigner(chain, keyDeriver, storageManager)
    const services = new Services(chain)
    const wallet = new Wallet(signer, services)
    const client = new StorageClient(wallet, storageURL)

    // Initialize wallet storage
    await client.makeAvailable()
    await storageManager.addWalletStorageProvider(client)

    // Cast to WalletClient for test compatibility
    return wallet as unknown as WalletClient
  } catch (error) {
    // Provide helpful error context
    if (error instanceof Error) {
      throw new Error(`Failed to create wallet: ${error.message}`)
    }
    throw new Error('Failed to create wallet: Unknown error')
  }
}

/**
 * Creates a random private key for testing
 */
export function createTestPrivateKey (): PrivateKey {
  return PrivateKey.fromRandom()
}

/**
 * Creates a deterministic private key from a seed number
 * Useful for reproducible tests
 */
export function createTestPrivateKeyFromSeed (seed: number): PrivateKey {
  return new PrivateKey(seed)
}
