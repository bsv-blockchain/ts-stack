import { HexString } from "@bsv/sdk";

/**
 * Represents minimal user entity
 */
export interface User {
    id: number;
    presentationKey: string;
    userIdHash?: string;  // SHA256 of identity key (for Shamir flow)
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Represents an Auth Method row
 */
export interface AuthMethodEntity {
    id: number;
    userId: number | null;
    methodType: string;
    config: string;
    receivedFaucet: boolean;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Represents a Payment row
 */
export interface PaymentEntity {
    id: number;
    userId: number | null;
    beef: Buffer;
    txid: string;
    k: HexString;
    amount: number;
    outputIndex: number;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Represents a Shamir Share stored on the server (Share B)
 * The share is encrypted with AES-256-GCM using a server-managed key
 */
export interface ShamirShareEntity {
    id: number;
    userId: number;
    shareEncrypted: Buffer;  // AES-256-GCM encrypted share
    shareNonce: string;      // GCM nonce (IV) as hex
    shareTag: string;        // GCM auth tag as hex
    shareVersion: number;    // For key rotation tracking
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Represents a share access log entry for rate limiting and audit
 */
export interface ShareAccessLogEntity {
    id: number;
    userId: number;
    ipAddress: string;
    action: 'store' | 'retrieve' | 'update';
    success: boolean;
    failureReason?: string;
    timestamp: string;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
    maxAttempts: number;
    windowMinutes: number;
    lockoutMinutes: number;
}
