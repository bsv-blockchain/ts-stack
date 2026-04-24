import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // SHAMIR_SHARES table - stores encrypted Share B for each user
    await knex.schema.createTable("shamir_shares", (table) => {
        table.increments("id").primary();
        table
            .integer("userId")
            .unsigned()
            .references("id")
            .inTable("users")
            .onDelete("CASCADE");
        table.binary("shareEncrypted").notNullable(); // AES-256-GCM encrypted share
        table.string("shareNonce", 64).notNullable(); // GCM nonce (IV)
        table.string("shareTag", 64).notNullable(); // GCM auth tag
        table.integer("shareVersion").defaultTo(1); // For key rotation tracking
        table.timestamps(true, true);
        table.unique(["userId"]);
    });

    // Add userIdHash to users table for identity-based lookup
    // (replaces presentationKey-based lookup for new Shamir flow)
    await knex.schema.alterTable("users", (table) => {
        table.string("userIdHash", 64).nullable().unique(); // SHA256 of identity key
    });

    // SHARE_ACCESS_LOG table - for rate limiting and audit
    await knex.schema.createTable("share_access_log", (table) => {
        table.increments("id").primary();
        table
            .integer("userId")
            .unsigned()
            .references("id")
            .inTable("users")
            .onDelete("CASCADE");
        table.string("ipAddress", 45).notNullable(); // IPv6 max length
        table.string("action", 20).notNullable(); // 'store', 'retrieve', 'update'
        table.boolean("success").notNullable();
        table.string("failureReason", 255).nullable();
        table.timestamp("timestamp").defaultTo(knex.fn.now());
    });

    // Index for efficient rate limit queries
    await knex.schema.alterTable("share_access_log", (table) => {
        table.index(["userId", "timestamp"]);
        table.index(["ipAddress", "timestamp"]);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("share_access_log");
    await knex.schema.dropTableIfExists("shamir_shares");

    await knex.schema.alterTable("users", (table) => {
        table.dropColumn("userIdHash");
    });
}
