/**
 * ShareController
 *
 * Provides endpoints for storing, retrieving, and updating Shamir secret shares.
 * All endpoints require prior OTP verification through the auth flow.
 */

import { Request, Response } from "express";
import {
    AuthIdentityConflictError,
    UserService
} from "../services/UserService";
import { ShareService } from "../services/ShareService";
import {
    getAuthMethodInstance,
    UnsupportedAuthMethodError
} from "../auth-methods/AuthMethodFactory";
import { AuthPayload } from "../auth-methods/AuthMethod";
import { log } from "../logger";
import {
    isAuthMethodType,
    isAuthPayload,
    isHexIdentifier,
    isRecord,
    isShamirShare
} from "../security/requestValidation";
import { User } from "../types";

/**
 * Extract client IP from request, handling proxies
 */
function getClientIp(req: Request): string {
    // Express derives req.ip from the socket and the explicitly configured
    // trust-proxy hop count. Reading X-Forwarded-For directly would let a
    // directly reachable client spoof the audit/rate-limit identity.
    return req.ip || req.socket.remoteAddress || "unknown";
}

type VerifiedIdentity =
    | { success: true; config: string; userId?: number }
    | { success: false; message: string };

async function verifyIdentity(
    methodType: string,
    contextKey: string,
    payload: AuthPayload
): Promise<VerifiedIdentity> {
    const authMethod = getAuthMethodInstance(methodType);
    const authResult = await authMethod.completeAuth(contextKey, payload);
    if (!authResult.success) {
        return {
            success: false,
            message: authResult.message || "OTP verification failed"
        };
    }

    const config = authMethod.buildConfigFromPayload(payload);
    const user = await UserService.findUserByConfig(methodType, config);
    return user
        ? { success: true, config, userId: user.id }
        : { success: true, config };
}

function identityIsBoundToUser(
    identity: VerifiedIdentity & { success: true },
    userId: number
): boolean {
    return identity.userId === userId;
}

type StoreUserResolution =
    | { success: true; user: User }
    | { success: false; status: 401 | 403; message: string };

async function resolveStoreUser(
    methodType: string,
    payload: AuthPayload,
    userIdHash: string,
    ipAddress: string
): Promise<StoreUserResolution> {
    const identity = await verifyIdentity(methodType, userIdHash, payload);
    if (!identity.success) {
        return { success: false, status: 401, message: identity.message };
    }

    const targetUser = await UserService.getUserByUserIdHash(userIdHash);
    if (targetUser) {
        if (!identityIsBoundToUser(identity, targetUser.id)) {
            await ShareService.logAccess(
                targetUser.id,
                ipAddress,
                "store",
                false,
                "Authenticated method is not linked to target user"
            );
            return {
                success: false,
                status: 403,
                message: "Authenticated method is not authorized for this account."
            };
        }
        return { success: true, user: targetUser };
    }

    if (identity.userId !== undefined) {
        const user = await UserService.attachUserIdHash(
            identity.userId,
            userIdHash
        );
        return { success: true, user };
    }

    const user = await UserService.createUserWithUserIdHash(userIdHash);
    await UserService.linkAuthMethod(user.id, methodType, identity.config);
    return { success: true, user };
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
            if (!isRecord(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: "Request body must be a JSON object."
                });
            }
            const { methodType, payload, shareB, userIdHash } = req.body;

            if (
                !isAuthMethodType(methodType) ||
                !isAuthPayload(payload) ||
                !isShamirShare(shareB) ||
                !isHexIdentifier(userIdHash)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "A valid methodType, payload, Shamir share, and 32-byte userIdHash are required."
                });
            }

            const resolution = await resolveStoreUser(
                methodType,
                payload,
                userIdHash,
                ipAddress
            );
            if (!resolution.success) {
                return res.status(resolution.status).json({
                    success: false,
                    message: resolution.message
                });
            }
            const { user } = resolution;

            const existingShare = await ShareService.getShareByUserId(user.id);
            if (existingShare) {
                await ShareService.logAccess(user.id, ipAddress, "store", false, "Share already exists");
                return res.status(409).json({
                    success: false,
                    message: "User already has a stored share. Use /share/update for key rotation."
                });
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
            if (error instanceof UnsupportedAuthMethodError) {
                return res.status(400).json({
                    success: false,
                    message: "Unsupported auth method."
                });
            }
            if (error instanceof AuthIdentityConflictError) {
                return res.status(409).json({
                    success: false,
                    message: "Authenticated identity is already linked to another account."
                });
            }
            log.error({ operation: 'controller.share.store', err: error, outcome: 'error' }, 'storeShare failed');
            res.status(500).json({
                success: false,
                message: "An internal error occurred."
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
            if (!isRecord(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: "Request body must be a JSON object."
                });
            }
            const { methodType, payload, userIdHash } = req.body;

            if (
                !isAuthMethodType(methodType) ||
                !isAuthPayload(payload) ||
                !isHexIdentifier(userIdHash)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "A valid methodType, payload, and 32-byte userIdHash are required."
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

            const identity = await verifyIdentity(methodType, userIdHash, payload);
            if (!identity.success) {
                await ShareService.logAccess(user.id, ipAddress, "retrieve", false, "OTP verification failed");
                return res.status(401).json({
                    success: false,
                    message: identity.message
                });
            }
            if (!identityIsBoundToUser(identity, user.id)) {
                await ShareService.logAccess(
                    user.id,
                    ipAddress,
                    "retrieve",
                    false,
                    "Authenticated method is not linked to target user"
                );
                return res.status(403).json({
                    success: false,
                    message: "Authenticated method is not authorized for this account."
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
            if (error instanceof UnsupportedAuthMethodError) {
                return res.status(400).json({
                    success: false,
                    message: "Unsupported auth method."
                });
            }
            log.error({ operation: 'controller.share.retrieve', err: error, outcome: 'error' }, 'retrieveShare failed');
            res.status(500).json({
                success: false,
                message: "An internal error occurred."
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
            if (!isRecord(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: "Request body must be a JSON object."
                });
            }
            const { methodType, payload, userIdHash, newShareB } = req.body;

            if (
                !isAuthMethodType(methodType) ||
                !isAuthPayload(payload) ||
                !isHexIdentifier(userIdHash) ||
                !isShamirShare(newShareB)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "A valid methodType, payload, 32-byte userIdHash, and Shamir share are required."
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

            const identity = await verifyIdentity(methodType, userIdHash, payload);
            if (!identity.success) {
                await ShareService.logAccess(user.id, ipAddress, "update", false, "OTP verification failed");
                return res.status(401).json({
                    success: false,
                    message: identity.message
                });
            }
            if (!identityIsBoundToUser(identity, user.id)) {
                await ShareService.logAccess(
                    user.id,
                    ipAddress,
                    "update",
                    false,
                    "Authenticated method is not linked to target user"
                );
                return res.status(403).json({
                    success: false,
                    message: "Authenticated method is not authorized for this account."
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
            if (error instanceof UnsupportedAuthMethodError) {
                return res.status(400).json({
                    success: false,
                    message: "Unsupported auth method."
                });
            }
            log.error({ operation: 'controller.share.update', err: error, outcome: 'error' }, 'updateShare failed');
            res.status(500).json({
                success: false,
                message: "An internal error occurred."
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
            if (!isRecord(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: "Request body must be a JSON object."
                });
            }
            const { methodType, payload, userIdHash } = req.body;

            if (
                !isAuthMethodType(methodType) ||
                !isAuthPayload(payload) ||
                !isHexIdentifier(userIdHash)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "A valid methodType, payload, and 32-byte userIdHash are required."
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

            const identity = await verifyIdentity(methodType, userIdHash, payload);
            if (!identity.success) {
                await ShareService.logAccess(user.id, ipAddress, "retrieve", false, "OTP verification failed (delete attempt)");
                return res.status(401).json({
                    success: false,
                    message: identity.message
                });
            }
            if (!identityIsBoundToUser(identity, user.id)) {
                await ShareService.logAccess(
                    user.id,
                    ipAddress,
                    "retrieve",
                    false,
                    "Authenticated method is not linked to target user (delete attempt)"
                );
                return res.status(403).json({
                    success: false,
                    message: "Authenticated method is not authorized for this account."
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
            if (error instanceof UnsupportedAuthMethodError) {
                return res.status(400).json({
                    success: false,
                    message: "Unsupported auth method."
                });
            }
            log.error({ operation: 'controller.share.delete_user', err: error, outcome: 'error' }, 'deleteUser failed');
            res.status(500).json({
                success: false,
                message: "An internal error occurred."
            });
        }
    }
}
