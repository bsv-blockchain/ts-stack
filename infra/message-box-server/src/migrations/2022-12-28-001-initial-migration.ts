import { Knex } from 'knex'

export async function up (knex: Knex): Promise<void> {
  await knex.schema.createTable('messageBox', (table) => {
    table.increments('messageBoxId').primary()
    table.timestamps(true, true)
    table.string('type').notNullable() // What type of messages go in here?
    table.string('identityKey').notNullable() // Who's message box is this?
    table.unique(['type', 'identityKey'])
  })

  await knex.schema.createTable('messages', (table) => {
    table.increments('messageId').primary()
    table.timestamps(true, true)
    table
      .integer('messageBoxId')
      .unsigned()
      .references('messageBoxId')
      .inTable('messageBox')
      .onDelete('CASCADE') // All messages get deleted if the messageBox is deleted
    table.string('sender').notNullable()
    table.string('recipient').notNullable()
    table.text('body', 'longtext').notNullable() // Contents of the message
    table.boolean('acknowledged').defaultTo(false)
  })
}

export async function down (knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('messages')
  await knex.schema.dropTableIfExists('messageBox')
}
