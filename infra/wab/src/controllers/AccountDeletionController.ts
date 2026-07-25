/**
 * AccountDeletionController
 *
 * Provides endpoints for users to delete their accounts by proving ownership
 * of their auth method (e.g., phone number) even when they can't access their account.
 */

import { Request, Response } from "express";
import { UserService } from "../services/UserService";
import {
  getAuthMethodInstance,
  UnsupportedAuthMethodError
} from "../auth-methods/AuthMethodFactory";
import { InvalidAuthPayloadError } from "../auth-methods/AuthMethod";
import {
  DeletionSessionRateLimitError,
  DeletionSessionService
} from "../services/DeletionSessionService";
import {
  isAuthMethodType,
  isAuthPayload,
  isRecord
} from "../security/requestValidation";
import { log } from "../logger";

export class AccountDeletionController {
  /**
   * Step 1: Start the account deletion verification process
   * Body must include:
   *   methodType: string (e.g., "TwilioPhone")
   *   payload: any (e.g., { phoneNumber: "+1234567890" })
   */
  public static async startDeletion(req: Request, res: Response) {
    try {
      if (!isRecord(req.body)) {
        return res.status(400).json({ message: "Request body must be a JSON object." });
      }
      const { methodType, payload } = req.body;
      if (!isAuthMethodType(methodType) || !isAuthPayload(payload)) {
        return res.status(400).json({ message: "A valid methodType and payload are required." });
      }

      const authMethod = getAuthMethodInstance(methodType);
      const config = authMethod.buildConfigFromPayload(payload);

      // Check if this auth method exists in the system
      const user = await UserService.findUserByConfig(methodType, config);

      // Persist a hashed, expiring, single-use intent even for unknown
      // identities so start responses and per-identity limits do not reveal
      // whether an account exists.
      const deletionKey = await DeletionSessionService.create(
        methodType,
        config,
        user?.id
      );

      // Always send the same response to prevent enumeration attacks
      if (user) {
        // Account exists - send real OTP via SMS
        const result = await authMethod.startAuth(deletionKey, payload);
        if (!result.success) {
          // SMS sending failed - still return generic message to avoid enumeration
          log.error({ operation: 'controller.account_deletion.request', reason: result.message, outcome: 'error' }, 'Failed to send OTP for deletion');
        }
      }
      // If no user exists, we do nothing (no SMS sent)

      // Always return identical response regardless of account existence
      // OTP should ONLY arrive via SMS, never in API response
      res.json({
        success: true,
        deletionKey,
        message: "If an account exists with this authentication method, a verification code has been sent."
      });
    } catch (error: any) {
      if (
        error instanceof UnsupportedAuthMethodError ||
        error instanceof InvalidAuthPayloadError
      ) {
        return res.status(400).json({ message: error.message });
      }
      if (error instanceof DeletionSessionRateLimitError) {
        return res.status(429).json({ message: error.message });
      }
      log.error({ operation: 'controller.account_deletion.request', err: error, outcome: 'error' }, 'requestDeletion failed');
      res.status(500).json({ message: "An internal error occurred." });
    }
  }

  /**
   * Step 2: Complete the account deletion after verifying ownership
   * Body must include:
   *   methodType: string
   *   deletionKey: string (from step 1)
   *   payload: any (e.g., { phoneNumber: "+1234567890", otp: "123456" })
   */
  public static async completeDeletion(req: Request, res: Response) {
    try {
      if (!isRecord(req.body)) {
        return res.status(400).json({ message: "Request body must be a JSON object." });
      }
      const { methodType, deletionKey, payload } = req.body;
      if (
        !isAuthMethodType(methodType) ||
        typeof deletionKey !== "string" ||
        !isAuthPayload(payload)
      ) {
        return res.status(400).json({
          message: "A valid methodType, deletionKey, and payload are required."
        });
      }

      const authMethod = getAuthMethodInstance(methodType);
      const config = authMethod.buildConfigFromPayload(payload);
      const session = await DeletionSessionService.findActive(
        deletionKey,
        methodType,
        config
      );
      if (!session) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired deletion session."
        });
      }

      // Verify the auth method (OTP, etc.)
      const result = await authMethod.completeAuth(deletionKey, payload);
      if (!result.success) {
        return res.status(400).json(result);
      }

      // Re-resolve both sides immediately before deletion. The verified
      // external identity, session snapshot, and live account must all agree.
      const user = await UserService.getUserById(Number(session.userId));
      const configUser = await UserService.findUserByConfig(methodType, config);
      if (!user || configUser?.id !== user.id) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired deletion session."
        });
      }

      if (!await DeletionSessionService.consume(session)) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired deletion session."
        });
      }

      // Delete the user account
      await UserService.deleteUserByPresentationKey(user.presentationKey);

      res.json({
        success: true,
        message: "Account successfully deleted. You can now sign up again if desired."
      });
    } catch (error: any) {
      if (
        error instanceof UnsupportedAuthMethodError ||
        error instanceof InvalidAuthPayloadError
      ) {
        return res.status(400).json({ message: error.message });
      }
      log.error({ operation: 'controller.account_deletion.complete', err: error, outcome: 'error' }, 'completeDeletion failed');
      res.status(500).json({ message: "An internal error occurred." });
    }
  }
}
