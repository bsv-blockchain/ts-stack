/**
 * AccountDeletionController
 *
 * Provides endpoints for users to delete their accounts by proving ownership
 * of their auth method (e.g., phone number) even when they can't access their account.
 */

import { Request, Response } from "express";
import { UserService } from "../services/UserService";
import { AuthMethod } from "../auth-methods/AuthMethod";
import { TwilioAuthMethod } from "../auth-methods/TwilioAuthMethod";

// Simple in-memory rate limiting
const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 3; // Max 3 deletion attempts per phone number per 15 minutes

function checkRateLimit(config: string): boolean {
  const now = Date.now();
  const key = `deletion_${config}`;

  let rateLimitData = rateLimitMap.get(key);

  if (!rateLimitData || (now - rateLimitData.lastReset) > RATE_LIMIT_WINDOW) {
    // Reset window
    rateLimitData = { count: 0, lastReset: now };
    rateLimitMap.set(key, rateLimitData);
  }

  if (rateLimitData.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return false; // Rate limited
  }

  rateLimitData.count++;
  return true; // Allowed
}

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
    default:
      throw new Error(`Unsupported auth method: ${methodType}`);
  }
}

export class AccountDeletionController {
  /**
   * Step 1: Start the account deletion verification process
   * Body must include:
   *   methodType: string (e.g., "TwilioPhone")
   *   payload: any (e.g., { phoneNumber: "+1234567890" })
   */
  public static async startDeletion(req: Request, res: Response) {
    try {
      const { methodType, payload } = req.body;
      if (!methodType || !payload) {
        return res.status(400).json({ message: "methodType and payload are required." });
      }

      const authMethod = getAuthMethodInstance(methodType);
      const config = authMethod.buildConfigFromPayload(payload);

      // Rate limiting to prevent SMS spam attacks
      if (!checkRateLimit(config)) {
        return res.status(429).json({
          message: "Too many deletion attempts. Please try again later."
        });
      }

      // Check if this auth method exists in the system
      const user = await UserService.findUserByConfig(methodType, config);

      // Use a temporary key for this deletion process
      const deletionKey = `deletion_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Always send the same response to prevent enumeration attacks
      if (user) {
        // Account exists - send real OTP via SMS
        const result = await authMethod.startAuth(deletionKey, payload);
        if (!result.success) {
          // SMS sending failed - still return generic message to avoid enumeration
          console.error("Failed to send OTP for deletion:", result.message);
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
      console.error(error);
      res.status(500).json({ message: error.message });
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
      const { methodType, deletionKey, payload } = req.body;
      if (!methodType || !deletionKey || !payload) {
        return res.status(400).json({
          message: "methodType, deletionKey, and payload are required."
        });
      }

      // Verify the deletion key format
      if (!deletionKey.startsWith('deletion_')) {
        return res.status(400).json({ message: "Invalid deletion key format." });
      }

      const authMethod = getAuthMethodInstance(methodType);

      // Verify the auth method (OTP, etc.)
      const result = await authMethod.completeAuth(deletionKey, payload);
      if (!result.success) {
        return res.status(400).json(result);
      }

      // Find the user by auth method config
      const config = authMethod.buildConfigFromPayload(payload);
      const user = await UserService.findUserByConfig(methodType, config);

      if (!user) {
        return res.status(404).json({
          message: "No account found with this authentication method."
        });
      }

      // Delete the user account
      await UserService.deleteUserByPresentationKey(user.presentationKey);

      res.json({
        success: true,
        message: "Account successfully deleted. You can now sign up again if desired."
      });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ message: error.message });
    }
  }
}
