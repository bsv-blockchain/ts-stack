import { e as ParseResult, d as PairingParams, c as WalletLike } from './types-BIOdtOVN.js';
import { WalletProtocol } from '@bsv/sdk';

/** Default accepted URI schemes for parsePairingUri. */
declare const DEFAULT_ACCEPTED_SCHEMAS: ReadonlySet<string>;
/**
 * Parse and validate a bsv-browser://pair?… QR code URI.
 *
 * Checks performed:
 *   - protocol is in acceptedSchemas (default: bsv-browser:)
 *   - all required fields present
 *   - expiry not passed
 *   - origin is http:// or https://
 *   - backendIdentityKey is a compressed secp256k1 public key
 *   - protocolID is a valid [number, string] JSON tuple
 *
 * Note: the relay URL is no longer embedded in the QR. It is fetched at
 * connect-time from the origin server via HTTPS, which is the trust anchor.
 * See WalletPairingSession.resolveRelay().
 *
 * @param raw - The raw URI string to parse.
 * @param acceptedSchemas - Set of accepted URI schemes (e.g. `new Set(['my-app:'])`).
 *   Defaults to `DEFAULT_ACCEPTED_SCHEMAS`. Pass your own set to support custom deep-link
 *   schemes used by third-party wallet apps.
 */
declare function parsePairingUri(raw: string, acceptedSchemas?: ReadonlySet<string>): ParseResult;
/**
 * Build a bsv-browser://pair?… URI from session parameters.
 * `pairingTtlMs` controls how long the QR code is valid (default 120 s).
 * Pass `expiry` (Unix seconds) to override the computed value — required when
 * signing so the same value is used in both the signature and the URI.
 *
 * Note: the relay URL is intentionally omitted. The mobile fetches it at
 * connect-time from the origin server — see WalletPairingSession.resolveRelay().
 */
declare function buildPairingUri(params: {
    sessionId: string;
    backendIdentityKey: string;
    protocolID: string;
    origin: string;
    pairingTtlMs?: number;
    expiry?: number;
    sig?: string;
    schema?: string;
}): string;
/**
 * Verify the `sig` field embedded in a parsed PairingParams object.
 *
 * Uses `ProtoWallet(new PrivateKey(1))` (the "anyone" verifier) to confirm the
 * signature over `topic|backendIdentityKey|origin|expiry` was produced by the
 * private key behind `backendIdentityKey`. No mobile wallet is needed.
 *
 * Returns `true` immediately (no-op) when `params.sig` is absent — backward
 * compatible with servers that have `signQrCodes: false`.
 * Returns `false` on any verification failure.
 */
declare function verifyPairingSignature(params: PairingParams): Promise<boolean>;

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

export { type CryptoParams as C, DEFAULT_ACCEPTED_SCHEMAS as D, buildPairingUri as a, base64urlToBytes as b, bytesToBase64url as c, decryptEnvelope as d, encryptEnvelope as e, parsePairingUri as p, verifyPairingSignature as v };
