import type { WalletProtocol, WalletInterface } from '@bsv/sdk';
export type WalletLike = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt' | 'createSignature'>;
export declare const PROTOCOL_ID: WalletProtocol;
/** Outer envelope routed by the relay — ciphertext is never decoded by the relay. */
export interface WireEnvelope {
    topic: string;
    ciphertext: string;
    mobileIdentityKey?: string;
}
/** Inner RPC request (plaintext after decryption). */
export interface RpcRequest {
    id: string;
    seq: number;
    method: string;
    params: unknown;
}
/** Inner RPC response (plaintext after decryption). */
export interface RpcResponse {
    id: string;
    seq: number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
}
export type SessionStatus = 'pending' | 'connected' | 'disconnected' | 'expired';
export interface Session {
    id: string;
    status: SessionStatus;
    createdAt: number;
    expiresAt: number;
    desktopToken: string;
    mobileIdentityKey?: string;
    pairingStartedAt?: number;
}
export interface SessionInfo {
    sessionId: string;
    status: SessionStatus;
    qrDataUrl?: string;
    pairingUri?: string;
    desktopToken?: string;
}
/** Parameters encoded in a wallet://pair?… QR code. */
export interface PairingParams {
    topic: string;
    backendIdentityKey: string;
    protocolID: string;
    origin: string;
    expiry: string;
    sig?: string;
}
export type ParseResult = {
    params: PairingParams;
    error: null;
} | {
    params: null;
    error: string;
};
/**
 * The wallet RPC methods that can be called on a paired mobile wallet.
 * Matches the default implemented method set in WalletPairingSession.
 */
export declare const WALLET_METHOD_NAMES: readonly ["getPublicKey", "listOutputs", "createAction", "signAction", "createSignature", "listActions", "internalizeAction", "acquireCertificate", "relinquishCertificate", "listCertificates", "revealCounterpartyKeyLinkage", "createHmac", "verifyHmac", "encrypt", "decrypt", "verifySignature"];
export type WalletMethodName = typeof WALLET_METHOD_NAMES[number];
/** A wallet RPC request tracked by WalletRelayClient. */
export interface WalletRequest {
    requestId: string;
    method: WalletMethodName;
    params: unknown;
    timestamp: number;
}
/** A wallet RPC response tracked by WalletRelayClient. */
export interface WalletResponse {
    requestId: string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
    timestamp: number;
}
/** An entry in the WalletRelayClient request log. */
export interface RequestLogEntry {
    request: WalletRequest;
    response?: WalletResponse;
    pending: boolean;
}
//# sourceMappingURL=types.d.ts.map