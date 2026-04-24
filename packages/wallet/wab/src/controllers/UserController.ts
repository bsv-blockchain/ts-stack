/**
 * UserController
 *
 * Provides endpoints to get the list of linked Auth Methods, unlink an Auth Method,
 * or delete the user's entire record (including the presentation key).
 */

import { Request, Response } from "express";
import { UserService } from "../services/UserService";

export class UserController {
    /**
     * List the user's linked Auth Methods.
     * Body must include { presentationKey } as proof of authentication.
     */
    public static async listLinkedMethods(req: Request, res: Response) {
        try {
            const { presentationKey } = req.body;
            if (!presentationKey) {
                return res.status(400).json({ message: "presentationKey is required" });
            }

            const user = await UserService.getUserByPresentationKey(presentationKey);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            const authMethods = await UserService.getAuthMethodsByUserId(user.id);
            res.json({ authMethods });
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    }

    /**
     * Unlink a single AuthMethod from the user.
     * Body must include { presentationKey, authMethodId }.
     */
    public static async unlinkMethod(req: Request, res: Response) {
        try {
            const { presentationKey, authMethodId } = req.body;
            if (!presentationKey || !authMethodId) {
                return res
                    .status(400)
                    .json({ message: "presentationKey and authMethodId are required" });
            }

            const user = await UserService.getUserByPresentationKey(presentationKey);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            const method = await UserService.getAuthMethodById(authMethodId);
            if (!method || method.userId !== user.id) {
                return res.status(404).json({ message: "Auth Method not found or not linked to user" });
            }

            await UserService.deleteAuthMethodById(method.id);
            res.json({ success: true, message: "Auth Method unlinked." });
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    }

    /**
     * Delete the user's entire record (including all methods and the presentation key).
     * Body must include { presentationKey }.
     */
    public static async deleteUser(req: Request, res: Response) {
        try {
            const { presentationKey } = req.body;
            if (!presentationKey) {
                return res.status(400).json({ message: "presentationKey is required" });
            }

            const user = await UserService.getUserByPresentationKey(presentationKey);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            await UserService.deleteUserByPresentationKey(user.presentationKey);
            res.json({ success: true, message: "User (and all linked data) deleted." });
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    }
}
