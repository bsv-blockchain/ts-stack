import type { WalletProtocol } from '@bsv/sdk';
import type { WalletLike } from '../types.js';
export interface CryptoParams {
    protocolID: WalletProtocol;
    keyID: string;
    counterparty: string;
}
/**
 * Encrypt a plaintext string and return a base64url ciphertext.
 * Works in Node.js, browsers, and React Native (no Buffer dependency).
 */
export declare function encryptEnvelope(wallet: WalletLike, params: CryptoParams, payload: string): Promise<string>;
/**
 * Decrypt a base64url ciphertext and return the plaintext string.
 * Works in Node.js, browsers, and React Native (no Buffer dependency).
 */
export declare function decryptEnvelope(wallet: WalletLike, params: CryptoParams, ciphertextB64: string): Promise<string>;
//# sourceMappingURL=crypto.d.ts.map