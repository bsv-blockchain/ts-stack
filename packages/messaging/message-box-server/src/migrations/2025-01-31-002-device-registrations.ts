import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Create device registrations table for FCM push notifications
  await knex.schema.createTable('device_registrations', (table) => {
    table.increments('id').primary()
    table.timestamp('created_at').defaultTo(knex.fn.now())
    table.timestamp('updated_at').defaultTo(knex.fn.now())
    table.string('identity_key', 255).notNullable() // User's identity key
    table.string('fcm_token', 500).notNullable() // Firebase Cloud Messaging token (can be long)
    table.string('device_id', 255).nullable() // Optional device identifier
    table.string('platform', 50).nullable() // 'ios', 'android', 'web', etc.
    table.timestamp('last_used').nullable() // When this token was last successfully used
    table.boolean('active').defaultTo(true) // Whether this token is still active

    // Unique constraint to prevent duplicate token registrations
    table.unique(['fcm_token'])

    // Index for efficient lookups by identity key
    table.index('identity_key')
    table.index(['identity_key', 'active'])
    table.index('last_used')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('device_registrations')
}
