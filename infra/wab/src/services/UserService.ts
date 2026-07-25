/**
 * UserService
 *
 * Provides utility methods to handle storing and retrieving user data,
 * linking/unlinking auth methods, and retrieving faucet payments.
 */

import { Setup } from "@bsv/wallet-toolbox";
import { db } from "../db/knex";
import { User, AuthMethodEntity, PaymentEntity } from "../types";
import { Curve, Random, RPuzzle, Utils } from '@bsv/sdk'
import { log } from "../logger";

//temp solution 
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY
const STORAGE_URL = process.env.STORAGE_URL
const BSV_NETWORK = process.env.BSV_NETWORK

export class AuthIdentityConflictError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "AuthIdentityConflictError";
    }
}

export class UserService {
    /**
     * Create a new user with a given presentationKey
     */
    static async createUser(presentationKey: string): Promise<User> {
        // Note: SQLite does not support RETURNING. Knex will return the inserted row id as a number in SQLite,
        // while in MySQL it may return an object when specifying returning columns.
        const insertResult: any = await db("users").insert({ presentationKey });

        const insertedId = Array.isArray(insertResult)
            ? (typeof insertResult[0] === "number"
                ? insertResult[0]
                : (insertResult[0]?.id as number | undefined))
            : (typeof insertResult === "number"
                ? insertResult
                : (insertResult?.id as number | undefined));

        const user = await this.getUserById(insertedId as number);
        if (!user) {
            throw new Error("User creation failed");
        }
        return user;
    }

    /**
     * Retrieve user by ID
     */
    static async getUserById(id: number): Promise<User | undefined> {
        return db<User>("users").where({ id }).first();
    }

    /**
     * Retrieve user by presentationKey
     */
    static async getUserByPresentationKey(key: string): Promise<User | undefined> {
        return db<User>("users").where({ presentationKey: key }).first();
    }

    /**
     * Delete a user (and cascade the other records)
     */
    static async deleteUserByPresentationKey(key: string): Promise<void> {
        await db("users").where({ presentationKey: key }).del();
    }

    /**
     * Retrieve user by userIdHash (for Shamir flow)
     */
    static async getUserByUserIdHash(userIdHash: string): Promise<User | undefined> {
        return db<User>("users").where({ userIdHash }).first();
    }

    /**
     * Create a new user with userIdHash (for Shamir flow)
     * Uses a placeholder presentationKey since legacy field is NOT NULL
     */
    /**
     * Delete a user by userIdHash (for Shamir flow)
     */
    static async deleteUserByUserIdHash(userIdHash: string): Promise<void> {
        await db("users").where({ userIdHash }).del();
    }

    static async createUserWithUserIdHash(userIdHash: string): Promise<User> {
        // Generate a unique placeholder for the legacy presentationKey field
        const placeholderKey = `shamir_${userIdHash.substring(0, 48)}`;

        const insertResult: any = await db("users").insert({
            presentationKey: placeholderKey,
            userIdHash
        });

        const insertedId = Array.isArray(insertResult)
            ? (typeof insertResult[0] === "number"
                ? insertResult[0]
                : (insertResult[0]?.id as number | undefined))
            : (typeof insertResult === "number"
                ? insertResult
                : (insertResult?.id as number | undefined));

        const user = await this.getUserById(insertedId as number);
        if (!user) {
            throw new Error("User creation failed");
        }
        return user;
    }

    /**
     * Attach a Shamir identity hash to an existing legacy user exactly once.
     * A user or hash that is already bound elsewhere fails closed.
     */
    static async attachUserIdHash(userId: number, userIdHash: string): Promise<User> {
        const current = await this.getUserById(userId);
        if (!current) {
            throw new AuthIdentityConflictError("Authenticated user no longer exists.");
        }
        if (current.userIdHash === userIdHash) {
            return current;
        }
        if (current.userIdHash) {
            throw new AuthIdentityConflictError(
                "Authenticated identity is already bound to another Shamir account."
            );
        }

        try {
            const updated = await db("users")
                .where({ id: userId })
                .whereNull("userIdHash")
                .update({ userIdHash });
            if (updated !== 1) {
                throw new AuthIdentityConflictError(
                    "Authenticated identity could not be bound safely."
                );
            }
        } catch (error) {
            if (error instanceof AuthIdentityConflictError) throw error;
            throw new AuthIdentityConflictError(
                "Shamir identity hash is already bound to another user."
            );
        }

        const user = await this.getUserById(userId);
        if (!user || user.userIdHash !== userIdHash) {
            throw new AuthIdentityConflictError(
                "Authenticated identity could not be bound safely."
            );
        }
        return user;
    }

    /**
     * Link an AuthMethod to the user
     * Checks if this auth method (methodType + config) already exists.
     * If it belongs to a deleted account (`userId` is null), reuse it without
     * clearing its faucet history. Never move an identity between live users.
     */
    static async linkAuthMethod(
        userId: number,
        methodType: string,
        config: string
    ): Promise<AuthMethodEntity> {
        // Check if this auth method already exists (from previous signup)
        const existing = await db<AuthMethodEntity>("auth_methods")
            .where({ methodType, config })
            .first();

        if (existing) {
            if (existing.userId === userId) {
                return existing;
            }
            if (existing.userId !== null) {
                throw new AuthIdentityConflictError(
                    "Authentication method is already linked to another user."
                );
            }

            // Reuse an orphaned method from a deleted account, preserving
            // receivedFaucet so account deletion cannot reset faucet history.
            const updated = await db("auth_methods")
                .where({ id: existing.id })
                .whereNull("userId")
                .update({ userId });
            if (updated !== 1) {
                throw new AuthIdentityConflictError(
                    "Authentication method could not be linked safely."
                );
            }

            return {
                ...existing,
                userId
            };
        }

        // Create new auth method
        const insertResult: any = await db("auth_methods").insert(
            {
                userId,
                methodType,
                config,
                receivedFaucet: false
            },
            ["id"]
        );
        const firstResult = Array.isArray(insertResult)
            ? insertResult[0]
            : insertResult;
        const authMethodId = typeof firstResult === "number"
            ? firstResult
            : firstResult?.id;
        if (!Number.isSafeInteger(authMethodId) || authMethodId < 1) {
            throw new Error("Failed to determine new auth method ID");
        }
        const authMethod = await db<AuthMethodEntity>("auth_methods")
            .where({ id: authMethodId })
            .first();

        if (!authMethod) {
            throw new Error("Failed to create auth method record");
        }
        return authMethod;
    }

    /**
     * Find user by auth method config (email, phone, etc.)
     * Returns undefined if auth method doesn't exist or has no linked user
     */
    static async findUserByConfig(
        methodType: string,
        config: string
    ): Promise<User | undefined> {
        const authMethod = await db<AuthMethodEntity>("auth_methods")
            .where({
                methodType,
                config
            })
            .first();

        if (!authMethod || !authMethod.userId) {
            return undefined;
        }
        return await this.getUserById(authMethod.userId);
    }

    /**
     * Check if an auth method exists for user with the same config (to see if already linked).
     */
    static async getAuthMethodsByUserId(userId: number): Promise<AuthMethodEntity[]> {
        return db<AuthMethodEntity>("auth_methods").where({ userId });
    }

    static async getAuthMethodById(id: number): Promise<AuthMethodEntity | undefined> {
        return db<AuthMethodEntity>("auth_methods").where({ id }).first();
    }

    static async deleteAuthMethodById(id: number): Promise<void> {
        await db("auth_methods").where({ id }).del();
    }

    /**
     * Mark all auth methods for a user as having received the faucet.
     * This prevents re-claiming even if the user deletes and re-signs up.
     */
    static async markFaucetReceived(userId: number): Promise<void> {
        await db("auth_methods")
            .where({ userId })
            .update({ receivedFaucet: true });
    }

    /**
     * Retrieve or create a faucet payment for a user.
     */
    static async getOrCreateFaucetPayment(userId: number, faucetAmount: number): Promise<PaymentEntity> {
        let payment = await db<PaymentEntity>("payments").where({ userId }).first();
        if (!payment) {
            // Generate a random 32-byte value for k (since there's no fromRandom equivalent)
            const k = Random(32)
            // Create an RPuzzle instance (using type 'raw' in this example)
            const rPuzzle = new RPuzzle('raw')
            const c = new Curve()
            let r = c.g.mul(k).x?.umod(c.n)?.toArray()
            if (r !== null && r !== undefined) {
                r = r[0] > 127 ? [0, ...r] : r
            }
            const lockingScript = rPuzzle.lock(r!)

            const wallet = await Setup.createWalletClientNoEnv({
                chain: BSV_NETWORK === 'testnet' ? 'test' : 'main',
                rootKeyHex: SERVER_PRIVATE_KEY as string,
                storageUrl: STORAGE_URL as string
            });

            const { txid, tx } = await wallet.createAction({
                description: 'Here is your funds!',
                outputs: [
                    {
                        lockingScript: lockingScript.toHex(),
                        satoshis: faucetAmount,
                        outputDescription: 'Faucet payment'
                    }
                ],
                options: {
                    randomizeOutputs: false,
                    acceptDelayedBroadcast: false
                }
            })
            log.info({ operation: 'service.user.faucet_funding', txid }, 'Funding txid created')

            // For demonstration, we pretend the "paymentData" is a simple JSON with a "txid"
            const [paymentId] = await db("payments").insert(
                {
                    userId,
                    k: Utils.toHex(k),
                    beef: Buffer.from(tx as number[]),
                    amount: faucetAmount,
                    outputIndex: 0,
                    txid
                },
                ["id"]
            );
            payment = await db<PaymentEntity>("payments")
                .where({ id: paymentId })
                .first();
        }
        if (!payment) {
            throw new Error("Failed to create or retrieve faucet payment");
        }
        return payment;
    }
}
