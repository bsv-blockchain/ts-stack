import type { Knex } from 'knex'

/** Durable replay claims required by KnexSessionManager on every HTTP replica. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('auth_message_nonces', table => {
    // Initial requests use `initial:` plus a 66-character identity key;
    // authenticated messages use the 64-character session nonce.
    table.string('sessionNonce', 130).notNullable()
    table.string('messageNonce', 64).notNullable()
    table.bigInteger('expiresAt').notNullable()
    table.primary(['sessionNonce', 'messageNonce'])
    table.index('expiresAt', 'idx_auth_message_nonces_expires')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('auth_message_nonces'))) return
  if ((await knex('auth_message_nonces').first('sessionNonce')) != null) {
    throw new Error('Cannot drop auth_message_nonces while durable replay claims exist')
  }
  await knex.schema.dropTable('auth_message_nonces')
}
