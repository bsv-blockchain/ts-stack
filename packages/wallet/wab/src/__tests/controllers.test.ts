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
                if (payload?.phoneNumber === "+18006382638" && payload?.otp === "123456") {
                    return { success: true, message: "verified successfully" };
                }
                return { success: false, message: "invalid otp" };
            }
        }
    };
});

import { UserService } from "../services/UserService";

let AuthController: typeof import("../controllers/AuthController")["AuthController"]; 
let FaucetController: typeof import("../controllers/FaucetController")["FaucetController"]; 
let UserController: typeof import("../controllers/UserController")["UserController"]; 
let InfoController: typeof import("../controllers/InfoController")["InfoController"]; 
let AccountDeletionController: typeof import("../controllers/AccountDeletionController")["AccountDeletionController"]; 


// Mock Express request/response objects
const mockRequest = (body: any = {}, params: any = {}) => ({
    body,
    params,
    query: {}
}) as any;

const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
};

describe("Controllers", () => {
    const testPresentationKey = "testkey_" + Date.now();

    beforeAll(async () => {
        // Dynamically import after mocks are set up
        ({ AuthController } = await import("../controllers/AuthController"));
        ({ FaucetController } = await import("../controllers/FaucetController"));
        ({ UserController } = await import("../controllers/UserController"));
        ({ InfoController } = await import("../controllers/InfoController"));
        ({ AccountDeletionController } = await import("../controllers/AccountDeletionController"));
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
    });

    describe("AuthController with admin phone", () => {
        const adminPhone = "+18006382638";

        it("should complete auth successfully with admin phone", async () => {
            // Mock UserService so controller test doesn't depend on DB specifics
            jest.spyOn(UserService, "findUserByConfig").mockResolvedValueOnce(undefined as any);
            jest.spyOn(UserService, "createUser").mockResolvedValueOnce({ id: 1, presentationKey: testPresentationKey } as any);
            jest.spyOn(UserService, "linkAuthMethod").mockResolvedValueOnce({ id: 1 } as any);

            const req = mockRequest({
                methodType: "TwilioPhone",
                presentationKey: testPresentationKey,
                payload: { phoneNumber: adminPhone, otp: "123456" }
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
                payload: { phoneNumber: adminPhone, otp: "wrong" }
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
            const adminPhone = "+18006382638";
            const req = mockRequest({
                methodType: "TwilioPhone",
                payload: { phoneNumber: adminPhone }
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
    });
});
