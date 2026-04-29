/**
 * ShareController
 *
 * Provides endpoints for storing, retrieving, and updating Shamir secret shares.
 * All endpoints require prior OTP verification through the auth flow.
 */

import { Request, Response } from "express";
import { UserService } from "../services/UserService";
import { ShareService } from "../services/ShareService";
import { AuthMethod } from "../auth-methods/AuthMethod";
import { TwilioAuthMethod } from "../auth-methods/TwilioAuthMethod";
import { DevConsoleAuthMethod } from "../auth-methods/DevConsoleAuthMethod";

// Singleton for dev auth method
const dev = new DevConsoleAuthMethod();

/**
 * Returns the appropriate AuthMethod instance given a methodType.
 */
function getAuthMethodInstance(methodType: string): AuthMethod {
    switch (methodType) {
        case "TwilioPhone":
            return new TwilioAuthMethod({
                accountSid: process.env.TWILIO_ACCOUNT_SID!,
                authToken: process.env.TWILIO_AUTH_TOKEN!,
                verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID!
            });
        case "DevConsole":
            return dev;
        default:
            throw new Error(`Unsupported auth method: ${methodType}`);
    }
}

/**
 * Extract client IP from request, handling proxies
 */
function getClientIp(req: Request): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
        return forwarded.split(",")[0].trim();
    }
    return req.socket.remoteAddress || "unknown";
}

export class ShareController {
    /**
     * Store a new Shamir share (Share B) for a user
     *
     * This endpoint is called after successful OTP verification during new wallet creation.
     * The share is encrypted server-side before storage.
     *
     * Request body:
     *   - methodType: string (auth method used)
     *   - payload: object (contains OTP and auth method specific data)
     *   - shareB: string (the Shamir share to store)
     *   - userIdHash: string (SHA256 hash of user's identity key)
     */
    public static async storeShare(req: Request, res: Response) {
        const ipAddress = getClientIp(req);

        try {
            const { methodType, payload, shareB, userIdHash } = req.body;

            if (!methodType || !payload || !shareB || !userIdHash) {
                return res.status(400).json({
                    success: false,
                    message: "methodType, payload, shareB, and userIdHash are required."
                });
            }

            // Validate share format (should be in Shamir backup format: x.y.threshold.integrity)
            const shareParts = shareB.split(".");
            if (shareParts.length !== 4) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid share format. Expected Shamir backup format."
                });
            }

            // First verify the OTP
            const authMethod = getAuthMethodInstance(methodType);
            const authResult = await authMethod.completeAuth(userIdHash, payload);

            if (!authResult.success) {
                return res.status(401).json({
                    success: false,
                    message: authResult.message || "OTP verification failed"
                });
            }

            // Check if user already exists with this userIdHash
            let user = await UserService.getUserByUserIdHash(userIdHash);

            if (user) {
                // User exists - check if they already have a share
                const existingShare = await ShareService.getShareByUserId(user.id);
                if (existingShare) {
                    // Log the failed attempt
                    await ShareService.logAccess(user.id, ipAddress, "store", false, "Share already exists");
                    return res.status(409).json({
                        success: false,
                        message: "User already has a stored share. Use /share/update for key rotation."
                    });
                }
            } else {
                // Create new user with userIdHash
                const config = authMethod.buildConfigFromPayload(payload);
                user = await UserService.createUserWithUserIdHash(userIdHash);
                await UserService.linkAuthMethod(user.id, methodType, config);
            }

            // Check rate limiting
            const rateLimit = await ShareService.isRateLimited(user.id, ipAddress, "store");
            if (rateLimit.limited) {
                await ShareService.logAccess(user.id, ipAddress, "store", false, "Rate limited");
                return res.status(429).json({
                    success: false,
                    message: `Too many attempts. Try again in ${rateLimit.retryAfterMinutes} minutes.`
                });
            }

            // Store the share
            await ShareService.storeShare(user.id, shareB);
            await ShareService.logAccess(user.id, ipAddress, "store", true);

            res.json({
                success: true,
                message: "Share stored successfully",
                userId: user.id
            });
        } catch (error: any) {
            console.error("[ShareController] storeShare error:", error);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * Retrieve a user's Shamir share (Share B)
     *
     * This endpoint is called during wallet recovery after OTP verification.
     * Returns the decrypted share to the client.
     *
     * Request body:
     *   - methodType: string (auth method used)
     *   - payload: object (contains OTP and auth method specific data)
     *   - userIdHash: string (SHA256 hash of user's identity key)
     */
    public static async retrieveShare(req: Request, res: Response) {
        const ipAddress = getClientIp(req);

        try {
            const { methodType, payload, userIdHash } = req.body;

            if (!methodType || !payload || !userIdHash) {
                return res.status(400).json({
                    success: false,
                    message: "methodType, payload, and userIdHash are required."
                });
            }

            // Find user by userIdHash
            const user = await UserService.getUserByUserIdHash(userIdHash);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: "User not found"
                });
            }

            // Check rate limiting before OTP verification
            const rateLimit = await ShareService.isRateLimited(user.id, ipAddress, "retrieve");
            if (rateLimit.limited) {
                await ShareService.logAccess(user.id, ipAddress, "retrieve", false, "Rate limited");
                return res.status(429).json({
                    success: false,
                    message: `Too many attempts. Try again in ${rateLimit.retryAfterMinutes} minutes.`
                });
            }

            // Verify OTP
            const authMethod = getAuthMethodInstance(methodType);
            const authResult = await authMethod.completeAuth(userIdHash, payload);

            if (!authResult.success) {
                await ShareService.logAccess(user.id, ipAddress, "retrieve", false, "OTP verification failed");
                return res.status(401).json({
                    success: false,
                    message: authResult.message || "OTP verification failed"
                });
            }

            // Retrieve and decrypt the share
            const share = await ShareService.retrieveDecryptedShare(user.id);
            if (!share) {
                await ShareService.logAccess(user.id, ipAddress, "retrieve", false, "No share found");
                return res.status(404).json({
                    success: false,
                    message: "No share found for this user"
                });
            }

            await ShareService.logAccess(user.id, ipAddress, "retrieve", true);

            res.json({
                success: true,
                shareB: share,
                message: "Share retrieved successfully"
            });
        } catch (error: any) {
            console.error("[ShareController] retrieveShare error:", error);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * Update a user's Shamir share (for key rotation)
     *
     * This endpoint allows users to replace their Share B with a new one,
     * typically during key rotation. Requires OTP verification.
     *
     * Request body:
     *   - methodType: string (auth method used)
     *   - payload: object (contains OTP and auth method specific data)
     *   - userIdHash: string (SHA256 hash of user's identity key)
     *   - newShareB: string (the new Shamir share)
     */
    public static async updateShare(req: Request, res: Response) {
        const ipAddress = getClientIp(req);

        try {
            const { methodType, payload, userIdHash, newShareB } = req.body;

            if (!methodType || !payload || !userIdHash || !newShareB) {
                return res.status(400).json({
                    success: false,
                    message: "methodType, payload, userIdHash, and newShareB are required."
                });
            }

            // Validate share format
            const shareParts = newShareB.split(".");
            if (shareParts.length !== 4) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid share format. Expected Shamir backup format."
                });
            }

            // Find user
            const user = await UserService.getUserByUserIdHash(userIdHash);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: "User not found"
                });
            }

            // Check rate limiting
            const rateLimit = await ShareService.isRateLimited(user.id, ipAddress, "update");
            if (rateLimit.limited) {
                await ShareService.logAccess(user.id, ipAddress, "update", false, "Rate limited");
                return res.status(429).json({
                    success: false,
                    message: `Too many attempts. Try again in ${rateLimit.retryAfterMinutes} minutes.`
                });
            }

            // Verify OTP
            const authMethod = getAuthMethodInstance(methodType);
            const authResult = await authMethod.completeAuth(userIdHash, payload);

            if (!authResult.success) {
                await ShareService.logAccess(user.id, ipAddress, "update", false, "OTP verification failed");
                return res.status(401).json({
                    success: false,
                    message: authResult.message || "OTP verification failed"
                });
            }

            // Update the share
            const updated = await ShareService.updateShare(user.id, newShareB);
            await ShareService.logAccess(user.id, ipAddress, "update", true);

            res.json({
                success: true,
                message: "Share updated successfully",
                shareVersion: updated.shareVersion
            });
        } catch (error: any) {
            console.error("[ShareController] updateShare error:", error);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * Delete a user's account and their stored Shamir share
     *
     * This endpoint allows Shamir users to delete their account.
     * Requires OTP verification to prevent unauthorized deletion.
     *
     * Request body:
     *   - methodType: string (auth method used)
     *   - payload: object (contains OTP and auth method specific data)
     *   - userIdHash: string (SHA256 hash of user's identity key)
     */
    public static async deleteUser(req: Request, res: Response) {
        const ipAddress = getClientIp(req);

        try {
            const { methodType, payload, userIdHash } = req.body;

            if (!methodType || !payload || !userIdHash) {
                return res.status(400).json({
                    success: false,
                    message: "methodType, payload, and userIdHash are required."
                });
            }

            // Find user by userIdHash
            const user = await UserService.getUserByUserIdHash(userIdHash);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: "User not found"
                });
            }

            // Check rate limiting (reuse retrieve limits for delete operations)
            const rateLimit = await ShareService.isRateLimited(user.id, ipAddress, "retrieve");
            if (rateLimit.limited) {
                await ShareService.logAccess(user.id, ipAddress, "retrieve", false, "Rate limited (delete attempt)");
                return res.status(429).json({
                    success: false,
                    message: `Too many attempts. Try again in ${rateLimit.retryAfterMinutes} minutes.`
                });
            }

            // Verify OTP
            const authMethod = getAuthMethodInstance(methodType);
            const authResult = await authMethod.completeAuth(userIdHash, payload);

            if (!authResult.success) {
                await ShareService.logAccess(user.id, ipAddress, "retrieve", false, "OTP verification failed (delete attempt)");
                return res.status(401).json({
                    success: false,
                    message: authResult.message || "OTP verification failed"
                });
            }

            // Delete the user's share first (if exists)
            await ShareService.deleteShare(user.id);

            // Delete the user account (cascades to auth_methods via FK)
            await UserService.deleteUserByUserIdHash(userIdHash);

            res.json({
                success: true,
                message: "Account and all associated data deleted successfully."
            });
        } catch (error: any) {
            console.error("[ShareController] deleteUser error:", error);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
}
