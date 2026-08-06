import path from "node:path";
import { Knex } from "knex";

function readPoolValue(name: string, fallback: number, allowZero = false): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const pattern = allowZero ? /^\d+$/ : /^[1-9]\d*$/;
    if (!pattern.test(raw)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
    return value;
}

const productionPool = {
    min: readPoolValue("WAB_DB_POOL_MIN", 2, true),
    max: readPoolValue("WAB_DB_POOL_MAX", 10)
};
if (productionPool.min > productionPool.max) {
    throw new Error("WAB_DB_POOL_MIN must not exceed WAB_DB_POOL_MAX");
}

const connectionConfig = {
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    database: process.env.DB_NAME!,
    host: process.env.DB_HOST!,
    port: Number.parseInt(process.env.DB_PORT!),
};

const config: { [key: string]: Knex.Config } = {
    development: {
        client: "sqlite3",
        connection: { filename: "./dev.sqlite3" },
        useNullAsDefault: true
    },
    test: {
        client: "sqlite3",
        connection: {
            filename: ":memory:"
        },
        useNullAsDefault: true,
        migrations: {
            directory: path.resolve(__dirname, "db/migrations")
        },
        pool: {
            min: 1,
            max: 1,
            afterCreate: (conn: any, cb: any) => {
                // Keep connection alive for duration of tests
                cb(null, conn);
            }
        }
    },
    production: {
        client: process.env.DB_CLIENT || "mysql2",
        connection: connectionConfig,
        pool: productionPool,
        migrations: {
            tableName: "knex_migrations"
        }
    }
};

export default config;
