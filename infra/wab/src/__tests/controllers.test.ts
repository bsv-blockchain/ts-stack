// IMPORTANT: mock Twilio before importing controllers so they pick up the mock
jest.mock("../auth-methods/TwilioAuthMethod", () => {
    return {
        TwilioAuthMethod: class {
            buildConfigFromPayload(payload: any) {
                return payload?.phoneNumber ?? "";
            }
            async startAuth() {
                return { success: true, message: "started" };
            }
            async completeAuth(_presentationKey: string, payload: any) {
                if (payload?.phoneNumber === "+14155550100" && payload?.otp === "123456") {
                    return { success: true, message: "verified successfully" };
                }
                return { success: false, message: "invalid otp" };
            }
        }
    };
});

import { UserService } from "../services/UserService";
import { ShareService } from "../services/ShareService";

let AuthController: typeof import("../controllers/AuthController")["AuthController"]; 
let UserController: typeof import("../controllers/UserController")["UserController"]; 
let InfoController: typeof import("../controllers/InfoController")["InfoController"]; 
let AccountDeletionController: typeof import("../controllers/AccountDeletionController")["AccountDeletionController"]; 
let ShareController: typeof import("../controllers/ShareController")["ShareController"];


// Mock Express request/response objects
const mockRequest = (body: any = {}, params: any = {}) => ({
    body,
    params,
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" }
}) as any;

const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
};

describe("Controllers", () => {
    const testPresentationKey = "ab".repeat(32);
    const verifiedPhone = "+14155550100";

    beforeAll(async () => {
        // Dynamically import after mocks are set up
        ({ AuthController } = await import("../controllers/AuthController"));
        ({ UserController } = await import("../controllers/UserController"));
        ({ InfoController } = await import("../controllers/InfoController"));
        ({ AccountDeletionController } = await import("../controllers/AccountDeletionController"));
        ({ ShareController } = await import("../controllers/ShareController"));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("InfoController", () => {
        it("should return server info", () => {
            const req = mockRequest();
            const res = mockResponse();

            InfoController.getInfo(req, res);

            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    supportedAuthMethods: expect.arrayContaining(["TwilioPhone"]),
                    faucetEnabled: true
                })
            );
        });

        it("never advertises console OTP authentication in production", () => {
            const previousNodeEnv = process.env.NODE_ENV;
            const previousEnabled = process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED;
            process.env.NODE_ENV = "production";
            process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED = "true";
            const res = mockResponse();

            try {
                InfoController.getInfo(mockRequest(), res);

                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({
                        supportedAuthMethods: ["TwilioPhone"]
                    })
                );
            } finally {
                if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
                else process.env.NODE_ENV = previousNodeEnv;
                if (previousEnabled === undefined) delete process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED;
                else process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED = previousEnabled;
            }
        });
    });

    describe("AuthController with verified phone", () => {
        it("should complete auth successfully after provider verification", async () => {
            // Mock UserService so controller test doesn't depend on DB specifics
            jest.spyOn(UserService, "findUserByConfig").mockResolvedValueOnce(undefined as any);
            jest.spyOn(UserService, "createUser").mockResolvedValueOnce({ id: 1, presentationKey: testPresentationKey } as any);
            jest.spyOn(UserService, "linkAuthMethod").mockResolvedValueOnce({ id: 1 } as any);

            const req = mockRequest({
                methodType: "TwilioPhone",
                presentationKey: testPresentationKey,
                payload: { phoneNumber: verifiedPhone, otp: "123456" }
            });
            const res = mockResponse();

            await AuthController.completeAuth(req, res);

            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: true,
                    presentationKey: testPresentationKey
                })
            );
            jest.restoreAllMocks();
        });

        it("should fail with wrong OTP", async () => {
            const req = mockRequest({
                methodType: "TwilioPhone",
                presentationKey: testPresentationKey,
                payload: { phoneNumber: verifiedPhone, otp: "wrong" }
            });
            const res = mockResponse();

            await AuthController.completeAuth(req, res);

            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: false
                })
            );
        });
    });

    describe("UserController", () => {
        it("should list linked methods", async () => {
            jest.spyOn(UserService, "getUserByPresentationKey").mockResolvedValueOnce({ id: 1, presentationKey: testPresentationKey } as any);
            jest.spyOn(UserService, "getAuthMethodsByUserId").mockResolvedValueOnce([] as any);
            const req = mockRequest({ presentationKey: testPresentationKey });
            const res = mockResponse();

            await UserController.listLinkedMethods(req, res);

            expect(res.json).toHaveBeenCalled();
            const callArgs = res.json.mock.calls[0][0];
            expect(callArgs.authMethods).toBeDefined();
            expect(Array.isArray(callArgs.authMethods)).toBe(true);
            jest.restoreAllMocks();
        });

        it("should delete user", async () => {
            jest.spyOn(UserService, "getUserByPresentationKey").mockResolvedValueOnce({ id: 1, presentationKey: testPresentationKey } as any);
            jest.spyOn(UserService, "deleteUserByPresentationKey").mockResolvedValueOnce(undefined as any);
            const req = mockRequest({ presentationKey: testPresentationKey });
            const res = mockResponse();

            await UserController.deleteUser(req, res);

            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: true
                })
            );
            jest.restoreAllMocks();
        });
    });

    describe("AccountDeletionController", () => {
        it("should start deletion process", async () => {
            const req = mockRequest({
                methodType: "TwilioPhone",
                payload: { phoneNumber: verifiedPhone }
            });
            const res = mockResponse();

            await AccountDeletionController.startDeletion(req, res);

            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: true,
                    deletionKey: expect.stringContaining("deletion_")
                })
            );
        });

        it("rejects a forged deletion token even with a valid OTP", async () => {
            const req = mockRequest({
                methodType: "TwilioPhone",
                deletionKey: `deletion_${"a".repeat(64)}`,
                payload: { phoneNumber: verifiedPhone, otp: "123456" }
            });
            const res = mockResponse();

            await AccountDeletionController.completeDeletion(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: false,
                    message: "Invalid or expired deletion session."
                })
            );
        });

        it("deletes only the account bound to a verified single-use session", async () => {
            const presentationKey = "ac".repeat(32);
            const phoneNumber = verifiedPhone;
            const user = await UserService.createUser(presentationKey);
            await UserService.linkAuthMethod(user.id, "TwilioPhone", phoneNumber);
            const startResponse = mockResponse();

            await AccountDeletionController.startDeletion(mockRequest({
                methodType: "TwilioPhone",
                payload: { phoneNumber }
            }), startResponse);

            const deletionKey = startResponse.json.mock.calls[0][0].deletionKey;
            expect(deletionKey).toMatch(/^deletion_[0-9a-f]{64}$/);

            const completeResponse = mockResponse();
            await AccountDeletionController.completeDeletion(mockRequest({
                methodType: "TwilioPhone",
                deletionKey,
                payload: { phoneNumber, otp: "123456" }
            }), completeResponse);

            expect(completeResponse.json).toHaveBeenCalledWith({
                success: true,
                message: "Account successfully deleted. You can now sign up again if desired."
            });
            await expect(
                UserService.getUserByPresentationKey(presentationKey)
            ).resolves.toBeUndefined();
            await expect(
                UserService.findUserByConfig("TwilioPhone", phoneNumber)
            ).resolves.toBeUndefined();

            const replayResponse = mockResponse();
            await AccountDeletionController.completeDeletion(mockRequest({
                methodType: "TwilioPhone",
                deletionKey,
                payload: { phoneNumber, otp: "123456" }
            }), replayResponse);
            expect(replayResponse.status).toHaveBeenCalledWith(400);
        });
    });

    describe("ShareController identity binding", () => {
        const victimHash = "cd".repeat(32);
        const victim = {
            id: 10,
            presentationKey: `shamir_${victimHash.slice(0, 48)}`,
            userIdHash: victimHash
        };
        const attacker = {
            id: 20,
            presentationKey: "ef".repeat(32)
        };
        const verifiedPayload = {
            phoneNumber: verifiedPhone,
            otp: "123456"
        };

        function mockIdentityMismatch() {
            jest.spyOn(UserService, "getUserByUserIdHash")
                .mockResolvedValue(victim as any);
            jest.spyOn(UserService, "findUserByConfig")
                .mockResolvedValue(attacker as any);
            jest.spyOn(ShareService, "isRateLimited")
                .mockResolvedValue({ limited: false } as any);
            jest.spyOn(ShareService, "logAccess")
                .mockResolvedValue(undefined as any);
        }

        it("does not retrieve a victim share with an attacker's valid OTP", async () => {
            mockIdentityMismatch();
            const retrieve = jest.spyOn(
                ShareService,
                "retrieveDecryptedShare"
            ).mockResolvedValue("2.3.2.deadbeef");
            const res = mockResponse();

            await ShareController.retrieveShare(mockRequest({
                methodType: "TwilioPhone",
                payload: verifiedPayload,
                userIdHash: victimHash
            }), res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(retrieve).not.toHaveBeenCalled();
        });

        it("does not update a victim share with an attacker's valid OTP", async () => {
            mockIdentityMismatch();
            const update = jest.spyOn(ShareService, "updateShare");
            const res = mockResponse();

            await ShareController.updateShare(mockRequest({
                methodType: "TwilioPhone",
                payload: verifiedPayload,
                userIdHash: victimHash,
                newShareB: "2.3.2.deadbeef"
            }), res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(update).not.toHaveBeenCalled();
        });

        it("does not delete a victim account with an attacker's valid OTP", async () => {
            mockIdentityMismatch();
            const deleteShare = jest.spyOn(ShareService, "deleteShare");
            const deleteUser = jest.spyOn(UserService, "deleteUserByUserIdHash");
            const res = mockResponse();

            await ShareController.deleteUser(mockRequest({
                methodType: "TwilioPhone",
                payload: verifiedPayload,
                userIdHash: victimHash
            }), res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(deleteShare).not.toHaveBeenCalled();
            expect(deleteUser).not.toHaveBeenCalled();
        });

        it("does not store over a victim account with an attacker's valid OTP", async () => {
            mockIdentityMismatch();
            const store = jest.spyOn(ShareService, "storeShare");
            const res = mockResponse();

            await ShareController.storeShare(mockRequest({
                methodType: "TwilioPhone",
                payload: verifiedPayload,
                shareB: "2.3.2.deadbeef",
                userIdHash: victimHash
            }), res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(store).not.toHaveBeenCalled();
        });

        it("retrieves a share when the verified identity owns the target user", async () => {
            jest.spyOn(UserService, "getUserByUserIdHash")
                .mockResolvedValue(victim as any);
            jest.spyOn(UserService, "findUserByConfig")
                .mockResolvedValue(victim as any);
            jest.spyOn(ShareService, "isRateLimited")
                .mockResolvedValue({ limited: false } as any);
            jest.spyOn(ShareService, "logAccess")
                .mockResolvedValue(undefined as any);
            jest.spyOn(ShareService, "retrieveDecryptedShare")
                .mockResolvedValue("2.3.2.deadbeef");
            const res = mockResponse();

            await ShareController.retrieveShare(mockRequest({
                methodType: "TwilioPhone",
                payload: verifiedPayload,
                userIdHash: victimHash
            }), res);

            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith({
                success: true,
                shareB: "2.3.2.deadbeef",
                message: "Share retrieved successfully"
            });
        });
    });
});
