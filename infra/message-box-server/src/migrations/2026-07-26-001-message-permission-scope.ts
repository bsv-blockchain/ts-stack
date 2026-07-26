import { Knex } from 'knex'

/**
 * SQL UNIQUE constraints treat NULL values as distinct. The historical
 * (recipient, sender, message_box) key therefore allowed duplicate box-wide
 * permissions where sender is NULL. A normalized, non-null scope closes that
 * gap without changing the public sender representation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('message_permissions', table => {
    table.string('sender_scope', 255).notNullable().defaultTo('')
  })

  await knex('message_permissions').update({
    sender_scope: knex.raw("COALESCE(sender, '')")
  })

  const rows = await knex('message_permissions')
    .select('id', 'recipient', 'sender_scope', 'message_box')
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc')

  const seen = new Set<string>()
  const duplicateIds: number[] = []
  for (const row of rows) {
    const key = JSON.stringify([row.recipient, row.sender_scope, row.message_box])
    if (seen.has(key)) duplicateIds.push(row.id)
    else seen.add(key)
  }
  if (duplicateIds.length > 0) {
    await knex('message_permissions').whereIn('id', duplicateIds).del()
  }

  await knex.schema.alterTable('message_permissions', table => {
    table.dropUnique(['recipient', 'sender', 'message_box'])
    table.unique(['recipient', 'message_box', 'sender_scope'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('message_permissions', table => {
    table.dropUnique(['recipient', 'message_box', 'sender_scope'])
    table.unique(['recipient', 'sender', 'message_box'])
    table.dropColumn('sender_scope')
  })
}
