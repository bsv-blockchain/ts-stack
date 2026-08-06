import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', table => {
    table.timestamp('expires_at').nullable()
    table.index(['expires_at', 'messageId'], 'messages_expiration_index')
  })

  await knex.schema.createTable('message_resource_locks', table => {
    table.string('identity_key', 255).primary()
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('auth_sessions', table => {
    // Auth nonces are intentionally bounded by the middleware. Keeping the
    // indexed value at 255 characters also stays within conservative MySQL
    // utf8mb4 primary-key limits.
    table.string('sessionNonce', 255).primary()
    table.string('peerNonce', 1024).nullable()
    table.string('peerIdentityKey', 255).nullable().index()
    table.boolean('isAuthenticated').notNullable().defaultTo(false)
    table.bigInteger('lastUpdate').notNullable()
    table.boolean('certificatesRequired').nullable()
    table.boolean('certificatesValidated').nullable()
    table.bigInteger('expiresAt').notNullable().index()
  })

  await knex.schema.createTable('payment_replays', table => {
    table.string('transaction_id', 64).primary()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('expires_at').nullable().index()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payment_replays')
  await knex.schema.dropTableIfExists('auth_sessions')
  await knex.schema.dropTableIfExists('message_resource_locks')
  await knex.schema.alterTable('messages', table => {
    table.dropIndex(['expires_at', 'messageId'], 'messages_expiration_index')
    table.dropColumn('expires_at')
  })
}
