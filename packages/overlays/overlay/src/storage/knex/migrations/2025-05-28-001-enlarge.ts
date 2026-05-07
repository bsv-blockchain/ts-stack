// migrations/005_enlarge_blobs.ts
import type { Knex } from 'knex'

export async function up (knex: Knex): Promise<void> {
  const client = (knex.client.config.client || '').toLowerCase()

  if (client.startsWith('mysql')) {
    await knex.schema.alterTable('outputs', table => {
      table.specificType('outputScript', 'LONGBLOB').alter()
    })
  } else if (client === 'sqlite3') {
    await knex.schema.alterTable('outputs', table => {
      table.binary('outputScript').alter()
    })
  }

  if (client.startsWith('mysql')) {
    await knex.schema.alterTable('transactions', table => {
      table.specificType('beef', 'LONGBLOB').alter()
    })
  } else if (client === 'sqlite3') {
    await knex.schema.alterTable('transactions', table => {
      table.binary('beef').alter()
    })
  }
}

export async function down (knex: Knex): Promise<void> {
  const client = (knex.client.config.client || '').toLowerCase()

  if (client.startsWith('mysql') || client === 'sqlite3') {
    await knex.schema.alterTable('outputs', table => {
      table.binary('outputScript').alter()
    })
  }

  if (client.startsWith('mysql') || client === 'sqlite3') {
    await knex.schema.alterTable('transactions', table => {
      table.binary('beef').alter()
    })
  }
}
