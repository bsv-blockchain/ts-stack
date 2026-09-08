import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('demo_accounts', table => {
    table.string('id', 36).primary()
    table.string('phoneNumber', 16).notNullable().unique()
    table.string('label', 100).notNullable()
    table.string('codeDigest', 64).notNullable()
    table.bigInteger('expiresAtEpochMs').notNullable()
    table.bigInteger('revokedAtEpochMs').nullable()
    table.integer('failedAttempts').notNullable().defaultTo(0)
    table.bigInteger('createdAtEpochMs').notNullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('demo_accounts')
}
