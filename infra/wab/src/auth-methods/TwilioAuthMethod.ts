import {
    AuthMethod,
    AuthPayload,
    AuthResult,
    InvalidAuthPayloadError
} from "./AuthMethod";
import twilio from "twilio";
import { log } from "../logger";

const E164_PHONE_NUMBER = /^\+[1-9][0-9]{7,14}$/;

function canonicalPhoneNumber(payload: AuthPayload): string {
    if (typeof payload.phoneNumber !== "string") {
        throw new InvalidAuthPayloadError("phoneNumber is required.");
    }
    const phoneNumber = payload.phoneNumber.trim();
    if (!E164_PHONE_NUMBER.test(phoneNumber)) {
        throw new InvalidAuthPayloadError(
            "phoneNumber must use canonical E.164 format."
        );
    }
    return phoneNumber;
}

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
    public async startAuth(_presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
        let phoneNumber: string;
        try {
            phoneNumber = canonicalPhoneNumber(payload);
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "Invalid phoneNumber."
            };
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
            log.error({ operation: 'auth.twilio.validate_phone', err: error, outcome: 'error' }, 'Error validating phone number');
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
            log.error({ operation: 'auth.twilio.start', err: error, outcome: 'error' }, 'Error starting Twilio phone verification');
            return {
                success: false,
                message: "Failed to start Twilio phone verification."
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
    public async completeAuth(_presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
        const providedOtp = payload.otp;
        if (typeof providedOtp !== "string" || providedOtp.length === 0) {
            return {
                success: false,
                message: "phoneNumber and otp are required."
            };
        }

        let phoneNumber: string;
        try {
            phoneNumber = canonicalPhoneNumber(payload);
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "Invalid phoneNumber."
            };
        }

        try {
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
            log.error({ operation: 'auth.twilio.complete', err: error, outcome: 'error' }, 'Error completing Twilio phone verification');
            return {
                success: false,
                message: "Failed to complete Twilio phone verification."
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
        return canonicalPhoneNumber(payload);
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
