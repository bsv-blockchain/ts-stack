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
    pairingUri?: string;
    desktopToken?: string;
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
 * The wallet RPC methods that can be called on a paired mobile wallet.
 * Matches the default implemented method set in WalletPairingSession.
 */
type WalletMethodName = 'getPublicKey' | 'listOutputs' | 'createAction' | 'signAction' | 'createSignature' | 'listActions' | 'internalizeAction' | 'acquireCertificate' | 'relinquishCertificate' | 'listCertificates' | 'revealCounterpartyKeyLinkage';
/** A wallet RPC request tracked by WalletRelayClient. */
interface WalletRequest {
    requestId: string;
    method: WalletMethodName;
    params: unknown;
    timestamp: number;
}
/** A wallet RPC response tracked by WalletRelayClient. */
interface WalletResponse {
    requestId: string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
    timestamp: number;
}
/** An entry in the WalletRelayClient request log. */
interface RequestLogEntry {
    request: WalletRequest;
    response?: WalletResponse;
    pending: boolean;
}

export { PROTOCOL_ID as P, type RpcRequest as R, type Session as S, type WireEnvelope as W, type SessionStatus as a, type RpcResponse as b, type WalletLike as c, type PairingParams as d, type ParseResult as e, type SessionInfo as f, type WalletMethodName as g, type RequestLogEntry as h, type WalletRequest as i, type WalletResponse as j };
