import knex, { Knex } from "knex";
import * as path from "path";
import config from "../knexfile";

const environment = process.env.NODE_ENV || "production";
const knexConfig = (config as any)[environment] as Knex.Config;

export const db = knex(knexConfig);

export async function migrateLatest() {
    console.log("🔍 Checking for pending database migrations...");

    try {
        const [batchNo, log] = await db.migrate.latest({
            directory: path.join(__dirname, "migrations")
        });

        if (log.length === 0) {
            console.log("Database is up to date (no migrations needed)");
        } else {
            console.log(`Ran ${log.length} migration(s):`);
            log.forEach((migration: string) => {
                console.log(`   - ${migration}`);
            });
            console.log(`   Batch: ${batchNo}`);
        }
    } catch (error: any) {
        console.error("Migration failed:", error.message);
        throw error; // Re-throw to prevent server from starting
    }
}
