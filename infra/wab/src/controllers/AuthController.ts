/**
 * AuthController
 *
 * Provides endpoints to start/complete an auth method and retrieve the presentation key.
 */

import { Request, Response } from "express";
import {
    AuthIdentityConflictError,
    UserService
} from "../services/UserService";
import {
    getAuthMethodInstance,
    UnsupportedAuthMethodError
} from "../auth-methods/AuthMethodFactory";
import { InvalidAuthPayloadError } from "../auth-methods/AuthMethod";
import {
    isAuthMethodType,
    isAuthPayload,
    isHexIdentifier,
    isRecord
} from "../security/requestValidation";
import { log } from "../logger";

export class AuthController {
    /**
     * Step 1: Start the auth process (e.g. send OTP, create session, etc.)
     * Body must include:
     *   methodType: string
     *   presentationKey: string (the random 256-bit key from client)
     *   payload: any (whatever the chosen method needs)
     */
    public static async startAuth(req: Request, res: Response) {
        try {
            if (!isRecord(req.body)) {
                return res.status(400).json({ message: "Request body must be a JSON object." });
            }
            const { methodType, presentationKey, payload } = req.body;
            if (
                !isAuthMethodType(methodType) ||
                !isHexIdentifier(presentationKey) ||
                !isAuthPayload(payload)
            ) {
                return res.status(400).json({
                    message: "A valid methodType, 32-byte presentationKey, and payload are required."
                });
            }

            const authMethod = getAuthMethodInstance(methodType);
            const result = await authMethod.startAuth(presentationKey, payload);
            res.json(result);
        } catch (error: any) {
            if (
                error instanceof UnsupportedAuthMethodError ||
                error instanceof InvalidAuthPayloadError
            ) {
                return res.status(400).json({ message: error.message });
            }
            log.error({ operation: 'controller.auth.start', err: error, outcome: 'error' }, 'startAuth failed');
            res.status(500).json({ message: "An internal error occurred." });
        }
    }

    /**
     * Step 2: Complete the auth process. If successful:
     *  - If user doesn't exist, create them with the given presentationKey
     *  - If user exists, retrieve their stored presentationKey
     *  - Link the AuthMethod to that user if not already linked
     *  Return the final presentationKey to the client.
     */
    public static async completeAuth(req: Request, res: Response) {
        try {
            if (!isRecord(req.body)) {
                return res.status(400).json({ message: "Request body must be a JSON object." });
            }
            const { methodType, presentationKey, payload } = req.body;
            if (
                !isAuthMethodType(methodType) ||
                !isHexIdentifier(presentationKey) ||
                !isAuthPayload(payload)
            ) {
                return res.status(400).json({
                    message: "A valid methodType, 32-byte presentationKey, and payload are required."
                });
            }

            const authMethod = getAuthMethodInstance(methodType);
            const result = await authMethod.completeAuth(presentationKey, payload);
            if (!result.success) {
                return res.json(result);
            }

            // Auth successful, find or create user by auth method config
            const config = authMethod.buildConfigFromPayload(payload)
            let user = await UserService.findUserByConfig(methodType, config)
            if (!user) {
                user = await UserService.createUser(presentationKey)
                await UserService.linkAuthMethod(user.id, methodType, config);
            }

            // Return the presentationKey from DB (ensures the user gets the stored key if user is existing)
            res.json({
                success: true,
                presentationKey: user.presentationKey,
                message: result.message
            });
        } catch (error: any) {
            if (
                error instanceof UnsupportedAuthMethodError ||
                error instanceof InvalidAuthPayloadError
            ) {
                return res.status(400).json({ message: error.message });
            }
            if (error instanceof AuthIdentityConflictError) {
                return res.status(409).json({
                    success: false,
                    message: "Authentication method is already linked to another account."
                });
            }
            log.error({ operation: 'controller.auth.complete', err: error, outcome: 'error' }, 'completeAuth failed');
            res.status(500).json({ message: "An internal error occurred." });
        }
    }
}
