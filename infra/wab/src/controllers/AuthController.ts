/**
 * AuthController
 *
 * Provides endpoints to start/complete an auth method and retrieve the presentation key.
 */

import { Request, Response } from "express";
import { UserService } from "../services/UserService";
import { AuthMethod } from "../auth-methods/AuthMethod";
import { TwilioAuthMethod } from "../auth-methods/TwilioAuthMethod";
import { DevConsoleAuthMethod } from "../auth-methods/DevConsoleAuthMethod";

// Singleton instance to maintain state between requests, given dev only in memory use.
const dev = new DevConsoleAuthMethod()

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
        // Add support for other auth methods if required.
        // case "PersonaID":
        //     return new PersonaAuthMethod({ apiKey: "mockApiKey" });
        default:
            throw new Error(`Unsupported auth method: ${methodType}`);
    }
}

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
            const { methodType, presentationKey, payload } = req.body;
            if (!methodType || !presentationKey || !payload) {
                return res.status(400).json({ message: "methodType, presentationKey, and payload are required." });
            }

            const authMethod = getAuthMethodInstance(methodType);
            const result = await authMethod.startAuth(presentationKey, payload);
            res.json(result);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
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
            const { methodType, presentationKey, payload } = req.body;
            if (!methodType || !presentationKey || !payload) {
                return res.status(400).json({ message: "methodType, presentationKey, and payload are required." });
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
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    }
}
