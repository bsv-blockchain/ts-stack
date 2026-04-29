import { AuthMethod, AuthPayload, AuthResult } from "./AuthMethod";

/**
 * DevConsoleAuthMethod
 *
 * A development-only auth method that generates OTP codes and logs them to the console.
 * This allows developers to authenticate without requiring external services like Twilio.
 */
export class DevConsoleAuthMethod extends AuthMethod {
    public methodType = "DevConsole";

    // In-memory storage for OTP codes (only for development)
    private otpStorage: Map<string, { otp: string; expiresAt: number; presentationKey: string }> = new Map();

    /**
     * Generates a random 6-digit OTP and logs it to the console.
     * Expects `payload.phoneNumber` (could be phone number, email, or any identifier).
     *
     * @param presentationKey - The user's prospective presentation key
     * @param payload - Must include { phoneNumber }
     * @returns AuthResult
     */
    public async startAuth(presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
        const phoneNumber = payload.phoneNumber;
        if (!phoneNumber) {
            return { success: false, message: "phoneNumber is required." };
        }

        // Generate a 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Store OTP with 10-minute expiration
        const expiresAt = Date.now() + (10 * 60 * 1000);
        this.otpStorage.set(phoneNumber, { otp, expiresAt, presentationKey });

        // Log OTP to console for development use
        console.log("=".repeat(60));
        console.log("🔐 DEVELOPMENT OTP CODE");
        console.log("=".repeat(60));
        console.log(`Identifier: ${phoneNumber}`);
        console.log(`OTP Code: ${otp}`);
        console.log(`Expires: ${new Date(expiresAt).toLocaleString()}`);
        console.log(`Presentation Key: ${presentationKey}`);
        console.log("=".repeat(60));

        return {
            success: true,
            message: `Development OTP sent for ${phoneNumber}. Check console logs.`,
            data: { phoneNumber }
        };
    }

    /**
     * Verifies the provided OTP against the stored value.
     * Expects `payload.phoneNumber` and `payload.otp`.
     *
     * @param presentationKey - The user's prospective presentation key
     * @param payload - Must include { phoneNumber, otp }
     * @returns AuthResult
     */
    public async completeAuth(presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
        const phoneNumber = payload.phoneNumber;
        const providedOtp = payload.otp;

        if (!phoneNumber || !providedOtp) { 
            return {
                success: false,
                message: "phoneNumber and otp are required."
            };
        }

        console.log({ payload, store: this.otpStorage })

        const storedData = this.otpStorage.get(phoneNumber);
        if (!storedData) {
            return {
                success: false,
                message: "No OTP found for this session. Please start authentication first."
            };
        }

        // Check if OTP has expired
        if (Date.now() > storedData.expiresAt) {
            this.otpStorage.delete(phoneNumber);
            return {
                success: false,
                message: "OTP has expired. Please request a new one."
            };
        }

        // Check if OTP matches
        if (storedData.otp !== providedOtp) {
            return {
                success: false,
                message: "Invalid OTP code."
            };
        }

        // Clean up stored OTP after successful verification
        this.otpStorage.delete(phoneNumber);

        console.log(`✅ Development auth successful for ${phoneNumber}`);

        return {
            success: true,
            message: `Development authentication successful for ${phoneNumber}.`
        };
    }

    /**
     * Stores the identifier in the config object for future recognition.
     *
     * @param payload - Must include { phoneNumber }
     * @returns string
     */
    public buildConfigFromPayload(payload: AuthPayload): string {
        return payload.phoneNumber;
    }

    /**
     * Checks if this identifier is already linked to the user.
     *
     * @param storedConfig - The stored configuration
     * @param payload - Must include { phoneNumber }
     */
    public isAlreadyLinked(storedConfig: Record<string, any>, payload: AuthPayload): boolean {
        return storedConfig.phoneNumber === payload.phoneNumber;
    }

    /**
     * Utility method to clear expired OTPs (can be called periodically)
     */
    public clearExpiredOtps(): void {
        const now = Date.now();
        for (const [key, data] of this.otpStorage.entries()) {
            if (now > data.expiresAt) {
                this.otpStorage.delete(key);
            }
        }
    }
}
