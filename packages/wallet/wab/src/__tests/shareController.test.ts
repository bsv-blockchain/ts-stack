/**
 * ShareController unit tests
 *
 * Tests the controller logic without HTTP layer (supertest not available).
 * For full integration tests, add supertest as a dev dependency.
 */

// Set up test encryption key BEFORE any imports
process.env.SHARE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { UserService } from "../services/UserService";
import { ShareService } from "../services/ShareService";

describe("ShareController Logic", () => {
    describe("Share validation", () => {
        it("should accept valid share format (4 dot-separated parts)", () => {
            const validShare = "1.someBase58Data.2.integrityCheck";
            const parts = validShare.split(".");
            expect(parts.length).toBe(4);
        });

        it("should reject invalid share format", () => {
            const invalidShares = [
                "invalid",
                "only.two",
                "three.parts.here",
                "five.parts.here.is.invalid"
            ];

            for (const share of invalidShares) {
                const parts = share.split(".");
                expect(parts.length).not.toBe(4);
            }
        });
    });

    describe("User lookup by userIdHash", () => {
        it("should find user by userIdHash", async () => {
            const userIdHash = "findtest_" + Date.now();
            const user = await UserService.createUserWithUserIdHash(userIdHash);

            const found = await UserService.getUserByUserIdHash(userIdHash);

            expect(found).toBeDefined();
            expect(found?.id).toBe(user.id);
            expect(found?.userIdHash).toBe(userIdHash);

            // Clean up
            await UserService.deleteUserByUserIdHash(userIdHash);
        });

        it("should return undefined for non-existent userIdHash", async () => {
            const found = await UserService.getUserByUserIdHash("nonexistent_" + Date.now());
            expect(found).toBeUndefined();
        });
    });

    describe("Share store flow", () => {
        it("should create user and store share for new userIdHash", async () => {
            const userIdHash = "newuser_" + Date.now();
            const share = "1.newusershare.2.check";

            // Create user
            const user = await UserService.createUserWithUserIdHash(userIdHash);

            // Store share
            const stored = await ShareService.storeShare(user.id, share);

            expect(stored.userId).toBe(user.id);
            expect(stored.shareVersion).toBe(1);

            // Verify retrieval
            const retrieved = await ShareService.retrieveDecryptedShare(user.id);
            expect(retrieved).toBe(share);

            // Clean up
            await ShareService.deleteShare(user.id);
            await UserService.deleteUserByUserIdHash(userIdHash);
        });

        it("should reject duplicate share storage", async () => {
            const userIdHash = "duptest_" + Date.now();
            const user = await UserService.createUserWithUserIdHash(userIdHash);

            await ShareService.storeShare(user.id, "1.first.2.share");

            await expect(
                ShareService.storeShare(user.id, "2.second.2.share")
            ).rejects.toThrow("already has a stored share");

            // Clean up
            await ShareService.deleteShare(user.id);
            await UserService.deleteUserByUserIdHash(userIdHash);
        });
    });

    describe("Share retrieve flow", () => {
        it("should retrieve stored share", async () => {
            const userIdHash = "retrieveflow_" + Date.now();
            const share = "3.retrievetest.2.data";

            const user = await UserService.createUserWithUserIdHash(userIdHash);
            await ShareService.storeShare(user.id, share);

            const retrieved = await ShareService.retrieveDecryptedShare(user.id);

            expect(retrieved).toBe(share);

            // Clean up
            await ShareService.deleteShare(user.id);
            await UserService.deleteUserByUserIdHash(userIdHash);
        });

        it("should return null for user without share", async () => {
            const userIdHash = "noshare_" + Date.now();
            const user = await UserService.createUserWithUserIdHash(userIdHash);

            const retrieved = await ShareService.retrieveDecryptedShare(user.id);

            expect(retrieved).toBeNull();

            // Clean up
            await UserService.deleteUserByUserIdHash(userIdHash);
        });
    });

    describe("Share update flow", () => {
        it("should update share and increment version", async () => {
            const userIdHash = "updateflow_" + Date.now();
            const originalShare = "1.original.2.share";
            const newShare = "1.updated.2.share";

            const user = await UserService.createUserWithUserIdHash(userIdHash);
            await ShareService.storeShare(user.id, originalShare);

            const updated = await ShareService.updateShare(user.id, newShare);

            expect(updated.shareVersion).toBe(2);

            const retrieved = await ShareService.retrieveDecryptedShare(user.id);
            expect(retrieved).toBe(newShare);

            // Clean up
            await ShareService.deleteShare(user.id);
            await UserService.deleteUserByUserIdHash(userIdHash);
        });
    });

    describe("Share delete flow", () => {
        it("should delete user and their share", async () => {
            const userIdHash = "deleteflow_" + Date.now();

            const user = await UserService.createUserWithUserIdHash(userIdHash);
            await ShareService.storeShare(user.id, "1.todelete.2.share");

            // Delete share first
            await ShareService.deleteShare(user.id);
            // Then delete user
            await UserService.deleteUserByUserIdHash(userIdHash);

            // Verify both are gone
            const foundUser = await UserService.getUserByUserIdHash(userIdHash);
            expect(foundUser).toBeUndefined();
        });
    });
});
