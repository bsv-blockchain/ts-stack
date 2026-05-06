import { UserService } from "../services/UserService";

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
            const user = await UserService.createUser(key);
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
    });
});
