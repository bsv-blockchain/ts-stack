import type { PairingParams, ParseResult } from '../types.js';
/** Default accepted URI schemes for parsePairingUri. */
export declare const DEFAULT_ACCEPTED_SCHEMAS: ReadonlySet<string>;
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
export declare function parsePairingUri(raw: string, acceptedSchemas?: ReadonlySet<string>): ParseResult;
/**
 * Build a bsv-browser://pair?… URI from session parameters.
 * `pairingTtlMs` controls how long the QR code is valid (default 120 s).
 * Pass `expiry` (Unix seconds) to override the computed value — required when
 * signing so the same value is used in both the signature and the URI.
 *
 * Note: the relay URL is intentionally omitted. The mobile fetches it at
 * connect-time from the origin server — see WalletPairingSession.resolveRelay().
 */
export declare function buildPairingUri(params: {
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
export declare function verifyPairingSignature(params: PairingParams): Promise<boolean>;
//# sourceMappingURL=pairingUri.d.ts.map