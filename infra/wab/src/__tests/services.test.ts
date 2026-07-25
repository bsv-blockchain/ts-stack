import {
    AuthIdentityConflictError,
    UserService
} from "../services/UserService";
import { db } from "../db/knex";

// Mock the parts of @bsv/sdk that UserService uses in faucet logic so tests don't require
// crypto randomness or a real wallet backend. Keep other exports intact.
jest.mock("@bsv/sdk", () => {
    const actual = jest.requireActual("@bsv/sdk");
    return {
        ...actual,
        // Deterministic Random
        Random: (_n: number) => new Uint8Array([1, 2, 3, 4]),
        // Minimal Curve stub sufficient for code path .g.mul(k).x.umod(n).toArray()
        Curve: class {
            public g = {
                mul: (_k: any) => ({ x: { umod: (_n: any) => ({ toArray: () => [1] }) } })
            };
            public n = 1;
        },
        // RPuzzle stub with lock().toHex()
        RPuzzle: class {
            constructor(_type: string) {}
            lock(_r: any) {
                return { toHex: () => "51" }; // OP_TRUE as harmless hex
            }
        },
        // Wallet client stub
        Setup: {
            createWalletClientNoEnv: jest.fn().mockResolvedValue({
                createAction: jest.fn().mockResolvedValue({ txid: "tx123", tx: [1, 2, 3] })
            })
        },
        // Utils hex stub to keep k serialization stable
        Utils: { ...actual.Utils, toHex: (_arr: Uint8Array) => "00" }
    };
});

describe("UserService", () => {

    describe("User CRUD operations", () => {
        it("should create and retrieve user", async () => {
            const key = "serviceTestKey_" + Date.now();
            const user = await UserService.createUser(key);
            expect(user.id).toBeDefined();
            expect(user.presentationKey).toBe(key);

            const fetched = await UserService.getUserByPresentationKey(key);
            expect(fetched?.presentationKey).toBe(key);
        });

        it("should get user by ID", async () => {
            const key = "getUserByIdTest_" + Date.now();
            const user = await UserService.createUser(key);
            
            const fetched = await UserService.getUserById(user.id);
            expect(fetched?.id).toBe(user.id);
            expect(fetched?.presentationKey).toBe(key);
        });

        it("should delete user", async () => {
            const key = "deleteKey_" + Date.now();
            await UserService.createUser(key);
            await UserService.deleteUserByPresentationKey(key);
            const fetched = await UserService.getUserByPresentationKey(key);
            expect(fetched).toBeUndefined();
        });
    });

    describe("Auth method operations", () => {
        it("should return undefined for non-existent config", async () => {
            const foundUser = await UserService.findUserByConfig("TwilioPhone", "+1999999999999");
            expect(foundUser).toBeUndefined();
        });

        it("never reassigns an authentication identity between live users", async () => {
            const first = await UserService.createUser("11".repeat(32));
            const second = await UserService.createUser("22".repeat(32));
            const config = "+14155550111";
            await UserService.linkAuthMethod(first.id, "TwilioPhone", config);

            await expect(
                UserService.linkAuthMethod(second.id, "TwilioPhone", config)
            ).rejects.toBeInstanceOf(AuthIdentityConflictError);

            const owner = await UserService.findUserByConfig("TwilioPhone", config);
            expect(owner?.id).toBe(first.id);
        });

        it("relinks an orphaned identity without clearing faucet history", async () => {
            const first = await UserService.createUser("33".repeat(32));
            const second = await UserService.createUser("44".repeat(32));
            const method = await UserService.linkAuthMethod(
                first.id,
                "TwilioPhone",
                "+14155550112"
            );
            await db("auth_methods")
                .where({ id: method.id })
                .update({ userId: null, receivedFaucet: true });

            const relinked = await UserService.linkAuthMethod(
                second.id,
                "TwilioPhone",
                "+14155550112"
            );

            expect(relinked.userId).toBe(second.id);
            expect(Boolean(relinked.receivedFaucet)).toBe(true);
        });

        it("attaches a Shamir identity hash only once", async () => {
            const user = await UserService.createUser("55".repeat(32));
            const firstHash = "66".repeat(32);
            const attached = await UserService.attachUserIdHash(user.id, firstHash);

            expect(attached.userIdHash).toBe(firstHash);
            await expect(
                UserService.attachUserIdHash(user.id, "77".repeat(32))
            ).rejects.toBeInstanceOf(AuthIdentityConflictError);
        });
    });
});
