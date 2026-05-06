import { AuthMethod, AuthPayload, AuthResult } from "./AuthMethod";
import twilio from "twilio";

// Example admin phone number for testing
const ADMIN_PHONE_NUMBERS = [
    { phoneNumber: "+18006382638", otp: "123456" }
]

/**
 * TwilioAuthMethod
 *
 * A concrete implementation of AuthMethod using Twilio Verify for phone verification.
 */
export class TwilioAuthMethod extends AuthMethod {
    public methodType = "TwilioPhone";

    private twilioClient: twilio.Twilio;
    private verifyServiceSid: string;

    /**
     * @param twilioConfig.accountSid        - Your Twilio Account SID
     * @param twilioConfig.authToken         - Your Twilio Auth Token
     * @param twilioConfig.verifyServiceSid  - The Twilio Verify Service SID
     */
    constructor(
        private twilioConfig: {
            accountSid: string;
            authToken: string;
            verifyServiceSid: string;
        }
    ) {
        super();
        this.verifyServiceSid = twilioConfig.verifyServiceSid;
        this.twilioClient = twilio(twilioConfig.accountSid, twilioConfig.authToken);
    }

    /**
     * Initiates the Twilio Verify flow by sending an SMS verification to the provided phone number.
     * Expects `payload.phoneNumber`.
     *
     * @param presentationKey - The user's prospective presentation key (not necessarily in the DB yet).
     * @param payload - Must include { phoneNumber }
     * @returns AuthResult
     */
    public async startAuth(presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
        const phoneNumber = payload.phoneNumber;
        if (!phoneNumber) {
            return { success: false, message: "phoneNumber is required." };
        }

        try {
            const isVoipNumber = await this.isVoipNumber(phoneNumber);
            if (isVoipNumber) {
                return {
                    success: false,
                    message: "VOIP phone numbers are not supported for verification."
                };
            }
        } catch (error: any) {
            console.error("[TwilioAuthMethod] Error validating phone number:", error);
            return {
                success: false,
                message: "Failed to validate phone number for verification."
            };
        }

        try {
            await this.twilioClient.verify.v2
                .services(this.verifyServiceSid)
                .verifications.create({
                    to: phoneNumber,
                    channel: "sms"
                });

            return {
                success: true,
                message: `Verification code sent to ${phoneNumber}.`
            };
        } catch (error: any) {
            console.error("[TwilioAuthMethod] Error in startAuth:", error);
            return {
                success: false,
                message: error.message || "Failed to start Twilio phone verification."
            };
        }
    }

    /**
     * Completes the Twilio Verify flow by checking the provided code against Twilio's Verify service.
     * Expects `payload.phoneNumber` and `payload.otp`.
     *
     * @param presentationKey - The user's prospective presentation key.
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

        try {
            // Mock verification for admin/test accounts
            if (ADMIN_PHONE_NUMBERS.some(admin => admin.phoneNumber === phoneNumber && admin.otp === providedOtp)) {
                return {
                    success: true,
                    message: `Phone number ${phoneNumber} verified successfully.`
                }
            }

            // Attempt to verify the code
            const verificationCheck = await this.twilioClient.verify.v2
                .services(this.verifyServiceSid)
                .verificationChecks.create({
                    to: phoneNumber,
                    code: providedOtp
                });

            if (verificationCheck.status === "approved") {
                // Code is correct, phone verified
                return {
                    success: true,
                    message: `Phone number ${phoneNumber} verified successfully.`
                };
            } else {
                // Code is incorrect or expired
                return {
                    success: false,
                    message: `Verification code invalid or expired. (status=${verificationCheck.status})`
                };
            }
        } catch (error: any) {
            console.error("[TwilioAuthMethod] Error in completeAuth:", error);
            return {
                success: false,
                message: error.message || "Failed to complete Twilio phone verification."
            };
        }
    }

    /**
     * If verification is successful, store the phone number in the config object
     * so that the user can be recognized by that number in the future.
     *
     * @param payload - Must include { phoneNumber }
     * @returns Record<string, any>
     */
    public buildConfigFromPayload(payload: AuthPayload): string {
        return payload.phoneNumber
    }

    /**
     * Checks if this phone number is already linked to the user.
     *
     * @param storedConfig
     * @param payload
     */
    public isAlreadyLinked(storedConfig: Record<string, any>, payload: AuthPayload): boolean {
        return storedConfig.phoneNumber === payload.phoneNumber;
    }

    private async isVoipNumber(phoneNumber: string): Promise<boolean> {
        const lookup = await this.twilioClient.lookups.v2
            .phoneNumbers(phoneNumber)
            .fetch({ fields: "line_type_intelligence" });

        const lineTypeIntelligence = lookup.lineTypeIntelligence as any;
        const lineType =
            typeof lineTypeIntelligence === "string"
                ? lineTypeIntelligence
                : lineTypeIntelligence?.lineType || lineTypeIntelligence?.line_type;

        return (lineType || "").toLowerCase() === "voip";
    }
}
