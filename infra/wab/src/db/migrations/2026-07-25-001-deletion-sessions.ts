import { Knex } from "knex";

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
        table.index(["methodType", "config", "createdAtEpochMs"]);
        table.index(["expiresAtEpochMs", "consumedAtEpochMs"]);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("account_deletion_sessions");
}
