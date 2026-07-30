import { Knex } from "knex";

export const deletionSessionIndexNames = {
    authentication: "acct_del_sessions_method_config_created_idx",
    expiration: "acct_del_sessions_expiry_consumed_idx",
} as const;

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("account_deletion_sessions", (table) => {
        table.increments("id").primary();
        table.string("tokenHash", 64).notNullable().unique();
        table
            .integer("userId")
            .unsigned()
            .nullable()
            .references("id")
            .inTable("users")
            .onDelete("SET NULL");
        table.string("methodType", 64).notNullable();
        table.string("config", 255).notNullable();
        table.bigInteger("expiresAtEpochMs").notNullable();
        table.bigInteger("consumedAtEpochMs").nullable();
        table.bigInteger("createdAtEpochMs").notNullable();
        table.index(
            ["methodType", "config", "createdAtEpochMs"],
            deletionSessionIndexNames.authentication,
        );
        table.index(
            ["expiresAtEpochMs", "consumedAtEpochMs"],
            deletionSessionIndexNames.expiration,
        );
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("account_deletion_sessions");
}
