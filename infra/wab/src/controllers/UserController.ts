/**
 * UserController
 *
 * Provides endpoints to get the list of linked Auth Methods, unlink an Auth Method,
 * or delete the user's entire record (including the presentation key).
 */

import { Request, Response } from "express";
import { UserService } from "../services/UserService";
import {
    isHexIdentifier,
    isPositiveSafeInteger,
    isRecord
} from "../security/requestValidation";
import { log } from "../logger";
import { User } from "../types";

type PresentedUser =
    | { success: true; user: User }
    | { success: false; status: 400 | 404; message: string };

async function resolvePresentedUser(body: unknown): Promise<PresentedUser> {
    if (!isRecord(body) || !isHexIdentifier(body.presentationKey)) {
        return {
            success: false,
            status: 400,
            message: "A 32-byte presentationKey is required."
        };
    }
    const user = await UserService.getUserByPresentationKey(body.presentationKey);
    return user
        ? { success: true, user }
        : { success: false, status: 404, message: "User not found" };
}

function sendPresentedUserFailure(
    res: Response,
    resolution: PresentedUser & { success: false }
) {
    return res.status(resolution.status).json({ message: resolution.message });
}

export class UserController {
    /**
     * List the user's linked Auth Methods.
     * Body must include { presentationKey } as proof of authentication.
     */
    public static async listLinkedMethods(req: Request, res: Response) {
        try {
            const resolution = await resolvePresentedUser(req.body);
            if (!resolution.success) {
                return sendPresentedUserFailure(res, resolution);
            }

            const authMethods = await UserService.getAuthMethodsByUserId(
                resolution.user.id
            );
            res.json({ authMethods });
        } catch (error: any) {
            log.error({ operation: 'controller.user.list_linked_methods', err: error, outcome: 'error' }, 'listLinkedMethods failed');
            res.status(500).json({ message: "An internal error occurred." });
        }
    }

    /**
     * Unlink a single AuthMethod from the user.
     * Body must include { presentationKey, authMethodId }.
     */
    public static async unlinkMethod(req: Request, res: Response) {
        try {
            if (!isRecord(req.body)) {
                return res.status(400).json({ message: "Request body must be a JSON object." });
            }
            const { presentationKey, authMethodId } = req.body;
            if (
                !isHexIdentifier(presentationKey) ||
                !isPositiveSafeInteger(authMethodId)
            ) {
                return res
                    .status(400)
                    .json({ message: "A 32-byte presentationKey and positive authMethodId are required." });
            }

            const user = await UserService.getUserByPresentationKey(presentationKey);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            const method = await UserService.getAuthMethodById(authMethodId);
            if (method?.userId !== user.id) {
                return res.status(404).json({ message: "Auth Method not found or not linked to user" });
            }

            await UserService.deleteAuthMethodById(method.id);
            res.json({ success: true, message: "Auth Method unlinked." });
        } catch (error: any) {
            log.error({ operation: 'controller.user.unlink_method', err: error, outcome: 'error' }, 'unlinkMethod failed');
            res.status(500).json({ message: "An internal error occurred." });
        }
    }

    /**
     * Delete the user's entire record (including all methods and the presentation key).
     * Body must include { presentationKey }.
     */
    public static async deleteUser(req: Request, res: Response) {
        try {
            const resolution = await resolvePresentedUser(req.body);
            if (!resolution.success) {
                return sendPresentedUserFailure(res, resolution);
            }

            await UserService.deleteUserByPresentationKey(
                resolution.user.presentationKey
            );
            res.json({ success: true, message: "User (and all linked data) deleted." });
        } catch (error: any) {
            log.error({ operation: 'controller.user.delete_user', err: error, outcome: 'error' }, 'deleteUser failed');
            res.status(500).json({ message: "An internal error occurred." });
        }
    }
}
