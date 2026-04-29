import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // Update AUTH_METHODS table for faucet abuse prevention
  await knex.schema.alterTable("auth_methods", (table) => {
    table.dropForeign(["userId"]);
    table.integer("userId").unsigned().nullable().alter();
    table.boolean("receivedFaucet").defaultTo(false);
    table.unique(["methodType", "config"]);
    table.foreign("userId").references("id").inTable("users").onDelete("SET NULL");
  });

  // Update PAYMENTS table to preserve records after user deletion
  await knex.schema.alterTable("payments", (table) => {
    table.dropForeign(["userId"]);
    table.integer("userId").unsigned().nullable().alter();
    table.foreign("userId").references("id").inTable("users").onDelete("SET NULL");
  });
}

export async function down(knex: Knex): Promise<void> {
  // Revert PAYMENTS table
  await knex.schema.alterTable("payments", (table) => {
    table.dropForeign(["userId"]);
    table.integer("userId").unsigned().notNullable().alter();
    table.foreign("userId").references("id").inTable("users").onDelete("CASCADE");
  });

  // Revert AUTH_METHODS table
  await knex.schema.alterTable("auth_methods", (table) => {
    table.dropForeign(["userId"]);
    table.dropUnique(["methodType", "config"]);
    table.dropColumn("receivedFaucet");
    table.integer("userId").unsigned().notNullable().alter();
    table.foreign("userId").references("id").inTable("users").onDelete("CASCADE");
  });
}
