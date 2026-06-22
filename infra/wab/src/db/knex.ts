import knex, { Knex } from "knex";
import * as path from "path";
import config from "../knexfile";
import { log } from "../logger";

const environment = process.env.NODE_ENV || "production";
const knexConfig = (config as any)[environment] as Knex.Config;

export const db = knex(knexConfig);

export async function migrateLatest() {
    log.info({ operation: 'db.migrate' }, 'Checking for pending database migrations');

    try {
        const [batchNo, migrations] = await db.migrate.latest({
            directory: path.join(__dirname, "migrations")
        });

        if (migrations.length === 0) {
            log.info({ operation: 'db.migrate' }, 'Database is up to date (no migrations needed)');
        } else {
            log.info({ operation: 'db.migrate', migration_count: migrations.length, batch: batchNo, migrations }, 'Ran database migrations');
        }
    } catch (error: any) {
        log.error({ operation: 'db.migrate', err: error, outcome: 'error' }, 'Migration failed');
        throw error; // Re-throw to prevent server from starting
    }
}
