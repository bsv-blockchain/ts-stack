import { AuthMethod } from "./AuthMethod";
import { DevConsoleAuthMethod } from "./DevConsoleAuthMethod";
import { TwilioAuthMethod } from "./TwilioAuthMethod";

export class UnsupportedAuthMethodError extends Error {
    public constructor(methodType: string) {
        super(`Unsupported auth method: ${methodType}`);
        this.name = "UnsupportedAuthMethodError";
    }
}

const devConsoleAuthMethod = new DevConsoleAuthMethod();

/**
 * The console auth method deliberately discloses an OTP in application logs.
 * It therefore requires both an explicit opt-in and a non-production runtime.
 */
export function isDevConsoleAuthEnabled(): boolean {
    const environment = process.env.NODE_ENV?.trim().toLowerCase();
    const nonProduction = environment === "development" || environment === "test";
    return nonProduction && process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED === "true";
}

export function getSupportedAuthMethodTypes(): string[] {
    return isDevConsoleAuthEnabled()
        ? ["TwilioPhone", "DevConsole"]
        : ["TwilioPhone"];
}

export function getAuthMethodInstance(methodType: string): AuthMethod {
    switch (methodType) {
        case "TwilioPhone":
            return new TwilioAuthMethod({
                accountSid: process.env.TWILIO_ACCOUNT_SID!,
                authToken: process.env.TWILIO_AUTH_TOKEN!,
                verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID!
            });
        case "DevConsole":
            if (isDevConsoleAuthEnabled()) {
                return devConsoleAuthMethod;
            }
            throw new UnsupportedAuthMethodError(methodType);
        default:
            throw new UnsupportedAuthMethodError(methodType);
    }
}
