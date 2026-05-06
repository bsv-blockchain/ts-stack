/**
 * PersonaAuthMethod
 *
 * Demonstrates a government ID verification flow (mocked for example).
 * In a real scenario, you'd integrate with the Persona or Jumio SDK via webhooks, tokens, etc.
 */

import { AuthMethod, AuthPayload, AuthResult } from "./AuthMethod";

export class PersonaAuthMethod extends AuthMethod {
    public methodType = "PersonaID";

    // Persona/Jumio config would go here
    constructor(private personaConfig: { apiKey: string }) {
        super();
    }

    /**
     * In a real scenario, we might start a Persona session for ID capture.
     * We'll mock that we simply create a "verification session id".
     */
    public async startAuth(presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
        // Create mock "sessionId"
        const sessionId = "persona-session-abc123";

        return {
            success: true,
            message: "Persona session created (mock).",
            data: { sessionId }
        };
    }

    /**
     * Complete an ID verification check. We'll mock success if a certain mock ID is provided.
     */
    public async completeAuth(presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
        const sessionId = payload.sessionId;
        // In real usage, we'd confirm the sessionId is verified with Persona's API.
        if (sessionId === "persona-session-abc123") {
            return {
                success: true,
                message: "ID verified successfully (mock)."
            };
        } else {
            return {
                success: false,
                message: "ID verification failed (mock)."
            };
        }
    }

    /**
     * If ID verification is successful, store relevant data.
     */
    public buildConfigFromPayload(payload: AuthPayload): string {
        return payload.sessionId
    }

    /**
     * For demonstration, if stored config has the same sessionId, we consider it "already linked".
     */
    public isAlreadyLinked(storedConfig: Record<string, any>, payload: AuthPayload): boolean {
        return storedConfig.personaSessionId === payload.sessionId;
    }
}
