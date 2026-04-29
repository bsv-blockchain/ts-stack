/**
 * AuthMethod is the abstract base that all Auth Method implementations must follow.
 */

import { db } from "../db/knex";
import { User } from "../types";

/**
 * Represents the data needed to start or complete an auth method.
 */
export interface AuthPayload {
    [key: string]: any;
}

/**
 * Represents a possible result or needed data after an auth attempt
 */
export interface AuthResult {
    success: boolean;
    message?: string;
    // Additional data relevant to the method
    data?: Record<string, any>;
}

/**
 * Abstract class that all AuthMethods implement.
 */
export abstract class AuthMethod {
    public abstract methodType: string;

    /**
     * Start an authentication or linking flow.
     * This might create a verification request, etc.
     */
    public abstract startAuth(presentationKey: string, payload: AuthPayload): Promise<AuthResult>;

    /**
     * Complete an authentication or linking flow, verifying codes, sessions, etc.
     * If successful, ensures the user is considered "authenticated".
     */
    public abstract completeAuth(presentationKey: string, payload: AuthPayload): Promise<AuthResult>;

    /**
     * Return the config object to store in the DB if fully linked.
     * Typically called after a successful `completeAuth`.
     */
    public abstract buildConfigFromPayload(payload: AuthPayload): string;

    /**
     * A utility to check if a user is already linked with this method,
     * given the stored config in the DB vs. an input that might identify them.
     * Return boolean or throw if not relevant.
     */
    public isAlreadyLinked(storedConfig: Record<string, any>, payload: AuthPayload): boolean {
        return false;
    }
}
