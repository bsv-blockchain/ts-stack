import { Knex } from 'knex'

export async function up (knex: Knex): Promise<void> {
  // Drop the existing 'messageId' column
  await knex.schema.alterTable('messages', (table) => {
    table.dropColumn('messageId')
  })

  // Add 'messageId' back as a unique string
  await knex.schema.alterTable('messages', (table) => {
    table.string('messageId').unique().notNullable()
  })
}

export async function down (knex: Knex): Promise<void> {
  // Drop the new 'messageId' column
  await knex.schema.alterTable('messages', (table) => {
    table.dropColumn('messageId')
  })

  // Restore 'messageId' as an auto-incrementing primary key
  await knex.schema.alterTable('messages', (table) => {
    table.increments('messageId').primary()
  })
}
