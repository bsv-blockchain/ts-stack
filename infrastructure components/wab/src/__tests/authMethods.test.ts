import { TwilioAuthMethod } from "../auth-methods/TwilioAuthMethod";

describe("AuthMethods", () => {
    describe("TwilioAuthMethod", () => {
        let method: TwilioAuthMethod;

        beforeEach(() => {
            method = new TwilioAuthMethod({
                accountSid: process.env.TWILIO_ACCOUNT_SID || "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                authToken: process.env.TWILIO_AUTH_TOKEN || "test_auth_token",
                verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || "VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            });
        });

        it("should successfully authenticate with admin phone number", async () => {
            const adminPhone = "+18006382638";
            const completeResult = await method.completeAuth("someKey", {
                phoneNumber: adminPhone,
                otp: "123456"
            });
            expect(completeResult.success).toBe(true);
            expect(completeResult.message).toContain("verified successfully");
        });

        it("should fail with wrong OTP for admin phone", async () => {
            const adminPhone = "+18006382638";
            const completeResult = await method.completeAuth("someKey", {
                phoneNumber: adminPhone,
                otp: "wrong"
            });
            expect(completeResult.success).toBe(false);
        });

        it("should fail with non-admin phone without real Twilio", async () => {
            const completeResult = await method.completeAuth("someKey", {
                phoneNumber: "+1234567890",
                otp: "123456"
            });
            // Will fail because mock Twilio credentials won't work
            expect(completeResult.success).toBe(false);
        });

        it("should require phoneNumber in payload", async () => {
            const completeResult = await method.completeAuth("someKey", {
                otp: "123456"
            });
            expect(completeResult.success).toBe(false);
            expect(completeResult.message).toContain("phoneNumber and otp are required");
        });

        it("should require otp in payload", async () => {
            const completeResult = await method.completeAuth("someKey", {
                phoneNumber: "+1234567890"
            });
            expect(completeResult.success).toBe(false);
            expect(completeResult.message).toContain("phoneNumber and otp are required");
        });

        it("should build config from payload", () => {
            const config = method.buildConfigFromPayload({ phoneNumber: "+1234567890" });
            expect(config).toBe("+1234567890");
        });

        it("should check if already linked", () => {
            const isLinked = method.isAlreadyLinked(
                { phoneNumber: "+1234567890" } as any,
                { phoneNumber: "+1234567890" }
            );
            expect(isLinked).toBe(true);

            const notLinked = method.isAlreadyLinked(
                { phoneNumber: "+1111111111" } as any,
                { phoneNumber: "+1234567890" }
            );
            expect(notLinked).toBe(false);
        });
    });
});
