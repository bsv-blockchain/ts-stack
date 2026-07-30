import { deletionSessionIndexNames } from "../db/migrations/2026-07-25-001-deletion-sessions";

describe("account deletion session migration", () => {
    it("uses stable index names within the MySQL identifier limit", () => {
        const names = Object.values(deletionSessionIndexNames);
        expect(names).toHaveLength(2);
        for (const name of names) {
            expect(name.length).toBeLessThanOrEqual(64);
        }
    });
});
