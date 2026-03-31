import { e as ParseResult, c as WalletLike } from './types-ClLaGPT6.js';
import { WalletProtocol } from '@bsv/sdk';

/**
 * Parse and validate a wallet://pair?… QR code URI.
 *
 * Checks performed:
 *   - protocol is wallet:
 *   - all required fields present
 *   - expiry not passed
 *   - relay is ws:// or wss://
 *   - origin is http:// or https://
 *   - M1: for wss://, relay hostname must match origin hostname
 *   - backendIdentityKey is a compressed secp256k1 public key
 *   - protocolID is a valid [number, string] JSON tuple
 *   - keyID equals topic (per protocol spec)
 */
declare function parsePairingUri(raw: string): ParseResult;
/**
 * Build a wallet://pair?… URI from session parameters.
 * `pairingTtlMs` controls how long the QR code is valid (default 120 s).
 */
declare function buildPairingUri(params: {
    sessionId: string;
    relayURL: string;
    backendIdentityKey: string;
    protocolID: string;
    origin: string;
    pairingTtlMs?: number;
}): string;

interface CryptoParams {
    protocolID: WalletProtocol;
    keyID: string;
    counterparty: string;
}
/**
 * Encrypt a plaintext string and return a base64url ciphertext.
 * Works in Node.js, browsers, and React Native (no Buffer dependency).
 */
declare function encryptEnvelope(wallet: WalletLike, params: CryptoParams, payload: string): Promise<string>;
/**
 * Decrypt a base64url ciphertext and return the plaintext string.
 * Works in Node.js, browsers, and React Native (no Buffer dependency).
 */
declare function decryptEnvelope(wallet: WalletLike, params: CryptoParams, ciphertextB64: string): Promise<string>;

/** Convert a byte array to a base64url string using @bsv/sdk Utils. */
declare function bytesToBase64url(bytes: number[]): string;
/** Decode a base64url string to a byte array using @bsv/sdk Utils. */
declare function base64urlToBytes(str: string): number[];

export { type CryptoParams as C, buildPairingUri as a, base64urlToBytes as b, bytesToBase64url as c, decryptEnvelope as d, encryptEnvelope as e, parsePairingUri as p };
