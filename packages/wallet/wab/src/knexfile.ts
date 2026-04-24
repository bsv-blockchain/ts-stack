import path from "path";
import { Knex } from "knex";

const connectionConfig = {
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    database: process.env.DB_NAME!,
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
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
        pool: { min: 2, max: 10 },
        migrations: {
            tableName: "knex_migrations"
        }
    }
};

export default config;
