/**
 * ShareService
 *
 * Provides methods for storing, retrieving, and managing Shamir secret shares.
 * Implements server-side encryption of shares using AES-256-GCM before database storage.
 * Includes rate limiting and access logging for security.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { db } from "../db/knex";
import { ShamirShareEntity, ShareAccessLogEntity, RateLimitConfig } from "../types";

// Server encryption key - must be 32 bytes (256 bits) for AES-256
// In production, this should come from a secure key management system (HSM, KMS)
const SERVER_ENCRYPTION_KEY = process.env.SHARE_ENCRYPTION_KEY || "";

// Rate limit configuration
const RATE_LIMITS: Record<string, RateLimitConfig> = {
    retrieve: { maxAttempts: 5, windowMinutes: 15, lockoutMinutes: 30 },
    store: { maxAttempts: 3, windowMinutes: 60, lockoutMinutes: 60 },
    update: { maxAttempts: 3, windowMinutes: 30, lockoutMinutes: 60 }
};

export class ShareService {
    /**
     * Get the encryption key as a Buffer, validating it exists and is correct length
     */
    private static getEncryptionKey(): Buffer {
        if (!SERVER_ENCRYPTION_KEY) {
            throw new Error("SHARE_ENCRYPTION_KEY environment variable not set");
        }
        const keyBuffer = Buffer.from(SERVER_ENCRYPTION_KEY, "hex");
        if (keyBuffer.length !== 32) {
            throw new Error("SHARE_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
        }
        return keyBuffer;
    }

    /**
     * Encrypt a share using AES-256-GCM
     * Returns the encrypted data, nonce, and auth tag
     */
    static encryptShare(share: string): { encrypted: Buffer; nonce: string; tag: string } {
        const key = this.getEncryptionKey();
        const nonce = randomBytes(12); // 96-bit nonce for GCM
        const cipher = createCipheriv("aes-256-gcm", key, nonce);

        const encrypted = Buffer.concat([
            cipher.update(share, "utf8"),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();

        return {
            encrypted,
            nonce: nonce.toString("hex"),
            tag: tag.toString("hex")
        };
    }

    /**
     * Decrypt a share using AES-256-GCM
     */
    static decryptShare(encrypted: Buffer, nonce: string, tag: string): string {
        const key = this.getEncryptionKey();
        const nonceBuffer = Buffer.from(nonce, "hex");
        const tagBuffer = Buffer.from(tag, "hex");

        const decipher = createDecipheriv("aes-256-gcm", key, nonceBuffer);
        decipher.setAuthTag(tagBuffer);

        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);

        return decrypted.toString("utf8");
    }

    /**
     * Store a new Shamir share for a user
     * The share is encrypted before storage
     */
    static async storeShare(userId: number, share: string): Promise<ShamirShareEntity> {
        // Check if user already has a share (should use update instead)
        const existing = await this.getShareByUserId(userId);
        if (existing) {
            throw new Error("User already has a stored share. Use updateShare instead.");
        }

        const { encrypted, nonce, tag } = this.encryptShare(share);

        const [id] = await db("shamir_shares").insert({
            userId,
            shareEncrypted: encrypted,
            shareNonce: nonce,
            shareTag: tag,
            shareVersion: 1
        });

        const result = await db<ShamirShareEntity>("shamir_shares")
            .where({ id })
            .first();

        if (!result) {
            throw new Error("Failed to store share");
        }

        return result;
    }

    /**
     * Retrieve a share by user ID
     * Returns the decrypted share
     */
    static async getShareByUserId(userId: number): Promise<ShamirShareEntity | undefined> {
        return db<ShamirShareEntity>("shamir_shares").where({ userId }).first();
    }

    /**
     * Retrieve and decrypt a share for a user
     * This is the method called after OTP verification
     */
    static async retrieveDecryptedShare(userId: number): Promise<string | null> {
        const shareEntity = await this.getShareByUserId(userId);
        if (!shareEntity) {
            return null;
        }

        return this.decryptShare(
            shareEntity.shareEncrypted,
            shareEntity.shareNonce,
            shareEntity.shareTag
        );
    }

    /**
     * Update an existing share (for key rotation)
     * Increments the share version
     */
    static async updateShare(userId: number, newShare: string): Promise<ShamirShareEntity> {
        const existing = await this.getShareByUserId(userId);
        if (!existing) {
            throw new Error("No existing share found for user. Use storeShare instead.");
        }

        const { encrypted, nonce, tag } = this.encryptShare(newShare);

        await db("shamir_shares")
            .where({ userId })
            .update({
                shareEncrypted: encrypted,
                shareNonce: nonce,
                shareTag: tag,
                shareVersion: existing.shareVersion + 1,
                updated_at: db.fn.now()
            });

        const updated = await this.getShareByUserId(userId);
        if (!updated) {
            throw new Error("Failed to update share");
        }

        return updated;
    }

    /**
     * Delete a user's share
     */
    static async deleteShare(userId: number): Promise<void> {
        await db("shamir_shares").where({ userId }).del();
    }

    /**
     * Log a share access attempt
     */
    static async logAccess(
        userId: number,
        ipAddress: string,
        action: "store" | "retrieve" | "update",
        success: boolean,
        failureReason?: string
    ): Promise<void> {
        await db("share_access_log").insert({
            userId,
            ipAddress,
            action,
            success,
            failureReason: failureReason || null
        });
    }

    /**
     * Check if a user/IP is rate limited for a specific action
     * Returns true if the request should be blocked
     */
    static async isRateLimited(
        userId: number,
        ipAddress: string,
        action: "store" | "retrieve" | "update"
    ): Promise<{ limited: boolean; retryAfterMinutes?: number }> {
        const config = RATE_LIMITS[action];
        if (!config) {
            return { limited: false };
        }

        const windowStart = new Date(Date.now() - config.windowMinutes * 60 * 1000);

        // Check failed attempts within the window for this user
        const failedAttempts = await db("share_access_log")
            .where({ userId, action, success: false })
            .where("timestamp", ">=", windowStart)
            .count("* as count")
            .first() as { count: string | number } | undefined;

        const attemptCount = Number(failedAttempts?.count || 0);

        if (attemptCount >= config.maxAttempts) {
            // Find the oldest attempt in the window to calculate retry time
            const oldestAttempt = await db<ShareAccessLogEntity>("share_access_log")
                .where({ userId, action, success: false })
                .where("timestamp", ">=", windowStart)
                .orderBy("timestamp", "asc")
                .first();

            if (oldestAttempt) {
                const lockoutEnd = new Date(
                    new Date(oldestAttempt.timestamp).getTime() +
                    config.lockoutMinutes * 60 * 1000
                );
                const now = new Date();

                if (lockoutEnd > now) {
                    const retryAfterMinutes = Math.ceil(
                        (lockoutEnd.getTime() - now.getTime()) / 60000
                    );
                    return { limited: true, retryAfterMinutes };
                }
            }
        }

        // Also check IP-based rate limiting (more aggressive)
        const ipFailedAttempts = await db("share_access_log")
            .where({ ipAddress, action, success: false })
            .where("timestamp", ">=", windowStart)
            .count("* as count")
            .first() as { count: string | number } | undefined;

        const ipAttemptCount = Number(ipFailedAttempts?.count || 0);

        // IP limit is 2x the user limit to catch distributed attacks
        if (ipAttemptCount >= config.maxAttempts * 2) {
            return { limited: true, retryAfterMinutes: config.lockoutMinutes };
        }

        return { limited: false };
    }

    /**
     * Get recent access logs for a user (for debugging/audit)
     */
    static async getAccessLogs(
        userId: number,
        limit: number = 10
    ): Promise<ShareAccessLogEntity[]> {
        return db<ShareAccessLogEntity>("share_access_log")
            .where({ userId })
            .orderBy("timestamp", "desc")
            .limit(limit);
    }
}
