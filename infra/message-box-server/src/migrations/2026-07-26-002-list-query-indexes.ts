import { Knex } from 'knex'

/**
 * Keep the bounded list endpoints efficient as their tables grow. Column order
 * mirrors the equality filters first and deterministic page ordering second.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', table => {
    table.index(
      ['recipient', 'messageBoxId', 'created_at', 'messageId'],
      'messages_recipient_box_page_index'
    )
  })

  await knex.schema.alterTable('device_registrations', table => {
    table.index(['identity_key', 'updated_at'], 'device_registrations_identity_updated_index')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('device_registrations', table => {
    table.dropIndex(['identity_key', 'updated_at'], 'device_registrations_identity_updated_index')
  })

  await knex.schema.alterTable('messages', table => {
    table.dropIndex(
      ['recipient', 'messageBoxId', 'created_at', 'messageId'],
      'messages_recipient_box_page_index'
    )
  })
}
