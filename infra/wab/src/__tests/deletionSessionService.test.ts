import { db } from "../db/knex";
import {
    DeletionSessionRateLimitError,
    DeletionSessionService
} from "../services/DeletionSessionService";
import { UserService } from "../services/UserService";

describe("DeletionSessionService", () => {
    it("stores only a token hash and consumes an active session once", async () => {
        const user = await UserService.createUser("81".repeat(32));
        const config = "+14155550201";
        const token = await DeletionSessionService.create(
            "TwilioPhone",
            config,
            user.id
        );
        const stored = await db("account_deletion_sessions")
            .where({ methodType: "TwilioPhone", config })
            .first();

        expect(token).toMatch(/^deletion_[0-9a-f]{64}$/);
        expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(stored.tokenHash).not.toBe(token);

        const active = await DeletionSessionService.findActive(
            token,
            "TwilioPhone",
            config
        );
        expect(active?.userId).toBe(user.id);
        expect(await DeletionSessionService.consume(active!)).toBe(true);
        expect(await DeletionSessionService.consume(active!)).toBe(false);
        await expect(
            DeletionSessionService.findActive(token, "TwilioPhone", config)
        ).resolves.toBeUndefined();
    });

    it("binds a session to the exact method, identity, and existing user", async () => {
        const user = await UserService.createUser("82".repeat(32));
        const config = "+14155550202";
        const token = await DeletionSessionService.create(
            "TwilioPhone",
            config,
            user.id
        );

        await expect(
            DeletionSessionService.findActive(
                token,
                "TwilioPhone",
                "+14155550999"
            )
        ).resolves.toBeUndefined();
        await expect(
            DeletionSessionService.findActive(token, "OtherMethod", config)
        ).resolves.toBeUndefined();

        const unboundToken = await DeletionSessionService.create(
            "TwilioPhone",
            "+14155550203"
        );
        await expect(
            DeletionSessionService.findActive(
                unboundToken,
                "TwilioPhone",
                "+14155550203"
            )
        ).resolves.toBeUndefined();
    });

    it("rejects expired sessions", async () => {
        const user = await UserService.createUser("83".repeat(32));
        const config = "+14155550204";
        const token = await DeletionSessionService.create(
            "TwilioPhone",
            config,
            user.id
        );
        await db("account_deletion_sessions")
            .where({ methodType: "TwilioPhone", config })
            .update({ expiresAtEpochMs: Date.now() - 1_000 });

        await expect(
            DeletionSessionService.findActive(token, "TwilioPhone", config)
        ).resolves.toBeUndefined();
    });

    it("rate limits deletion intents per external identity", async () => {
        const user = await UserService.createUser("84".repeat(32));
        const config = "+14155550205";
        for (let attempt = 0; attempt < 3; attempt++) {
            await DeletionSessionService.create(
                "TwilioPhone",
                config,
                user.id
            );
        }

        await expect(
            DeletionSessionService.create("TwilioPhone", config, user.id)
        ).rejects.toBeInstanceOf(DeletionSessionRateLimitError);
    });
});
