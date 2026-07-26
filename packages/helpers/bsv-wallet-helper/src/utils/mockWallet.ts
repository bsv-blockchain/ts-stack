/**
 * Wallet creation utilities for BSV blockchain
 * Based on BSV wallet-toolbox-client
 *
 * Note: makeWallet creates a live network-backed wallet (for integration tests).
 * For hermetic unit tests, use makeMockWallet (based on ProtoWallet, no network).
 */

import { PrivateKey, KeyDeriver, WalletClient, ProtoWallet, WalletInterface } from '@bsv/sdk'
import {
  WalletStorageManager,
  Services,
  Wallet,
  StorageClient,
  WalletSigner
} from '@bsv/wallet-toolbox-client'

/**
 * Creates a test wallet for blockchain testing
 *
 * @param chain - Blockchain network ('test' or 'main')
 * @param storageURL - Storage provider URL
 * @param privateKey - Private key as hex string
 * @returns WalletClient instance (cast from WalletInterface)
 * @throws Error if parameters are invalid or wallet creation fails
 */
export async function makeWallet(
  chain: 'test' | 'main',
  storageURL: string,
  privateKey: string
): Promise<WalletClient> {
  if ((chain as string) !== 'test' && (chain as string) !== 'main') {
    throw new Error(`Invalid chain "${chain as string}". Must be "test" or "main"`)
  }
  if (storageURL.length === 0) {
    throw new Error('storageURL parameter is required')
  }
  if (privateKey.length === 0) {
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
export function createTestPrivateKey(): PrivateKey {
  return PrivateKey.fromRandom()
}

/**
 * Creates a deterministic private key from a seed number
 * Useful for reproducible tests
 */
export function createTestPrivateKeyFromSeed(seed: number): PrivateKey {
  return new PrivateKey(seed)
}

/**
 * Creates a local mock wallet using SDK's ProtoWallet.
 *
 * This implements getPublicKey() and createSignature() using local key derivation
 * and signing. No network calls are made. Ideal for unit tests of P2PKH, OrdP2PKH,
 * OrdLock, getAddress etc.
 *
 * Counterparty 'self' and protocol/keyID derivation is handled consistently between
 * getPublicKey and createSignature.
 *
 * @param privateKey - A PrivateKey instance, or hex string, or numeric seed
 * @returns WalletInterface-compatible mock (sync construction, returned as Promise for API compat)
 */
export async function makeMockWallet(
  privateKey: PrivateKey | string | number
): Promise<WalletInterface> {
  const rootKey = privateKey instanceof PrivateKey ? privateKey : new PrivateKey(privateKey)
  const proto = new ProtoWallet(rootKey)
  // Cast: ProtoWallet provides the cryptographic surface required by the script templates
  return proto as unknown as WalletInterface
}
