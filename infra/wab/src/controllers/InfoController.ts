/**
 * InfoController
 *
 * Provides a public endpoint with server info: supported Auth Methods, faucet info, etc.
 */

import { Request, Response } from "express";
import { getSupportedAuthMethodTypes } from "../auth-methods/AuthMethodFactory";

export class InfoController {
    /**
     * Return the WAB server info, including supported Auth Methods, faucet enablement, etc.
     */
    public static getInfo(req: Request, res: Response): void {
        // Hard-coded for demonstration
        const supportedAuthMethods = getSupportedAuthMethodTypes();
        const faucetEnabled = true;
        const faucetAmount = 1000; // satoshis

        res.json({
            supportedAuthMethods,
            faucetEnabled,
            faucetAmount
        });
    }
}
