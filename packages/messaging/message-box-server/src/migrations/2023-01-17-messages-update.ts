import { Knex } from 'knex'

export async function up (knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (table) => {
    table.dropColumn('acknowledged')
  })
}

export async function down (knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (table) => {
    table.boolean('acknowledged').defaultTo(false)
  })
}
