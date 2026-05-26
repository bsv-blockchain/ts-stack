/**
 * Wallet creation utilities for BSV blockchain
 * Based on BSV wallet-toolbox-client
 */
import { PrivateKey, WalletClient } from '@bsv/sdk';
/**
 * Creates a test wallet for blockchain testing
 *
 * @param chain - Blockchain network ('test' or 'main')
 * @param storageURL - Storage provider URL
 * @param privateKey - Private key as hex string
 * @returns WalletClient instance (cast from WalletInterface)
 * @throws Error if parameters are invalid or wallet creation fails
 */
export declare function makeWallet(chain: 'test' | 'main', storageURL: string, privateKey: string): Promise<WalletClient>;
/**
 * Creates a random private key for testing
 */
export declare function createTestPrivateKey(): PrivateKey;
/**
 * Creates a deterministic private key from a seed number
 * Useful for reproducible tests
 */
export declare function createTestPrivateKeyFromSeed(seed: number): PrivateKey;
//# sourceMappingURL=mockWallet.d.ts.map