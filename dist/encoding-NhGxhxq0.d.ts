import { WalletProtocol, WalletInterface } from '@bsv/sdk';

type WalletLike = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>;
declare const PROTOCOL_ID: WalletProtocol;
/** Outer envelope routed by the relay — ciphertext is never decoded by the relay. */
interface WireEnvelope {
    topic: string;
    ciphertext: string;
    mobileIdentityKey?: string;
}
/** Inner RPC request (plaintext after decryption). */
interface RpcRequest {
    id: string;
    seq: number;
    method: string;
    params: unknown;
}
/** Inner RPC response (plaintext after decryption). */
interface RpcResponse {
    id: string;
    seq: number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
}
type SessionStatus = 'pending' | 'connected' | 'disconnected' | 'expired';
interface Session {
    id: string;
    status: SessionStatus;
    createdAt: number;
    expiresAt: number;
    desktopToken: string;
    mobileIdentityKey?: string;
    pairingStartedAt?: number;
}
interface SessionInfo {
    sessionId: string;
    status: SessionStatus;
    qrDataUrl?: string;
}
/** Parameters encoded in a wallet://pair?… QR code. */
interface PairingParams {
    topic: string;
    relay: string;
    backendIdentityKey: string;
    protocolID: string;
    keyID: string;
    origin: string;
    expiry: string;
}
type ParseResult = {
    params: PairingParams;
    error: null;
} | {
    params: null;
    error: string;
};

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

export { type CryptoParams as C, PROTOCOL_ID as P, type RpcRequest as R, type Session as S, type WireEnvelope as W, type SessionStatus as a, type RpcResponse as b, type WalletLike as c, type PairingParams as d, type ParseResult as e, type SessionInfo as f, base64urlToBytes as g, buildPairingUri as h, bytesToBase64url as i, decryptEnvelope as j, encryptEnvelope as k, parsePairingUri as p };
