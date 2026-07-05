import type { Knex } from 'knex'

export async function up (knex: Knex): Promise<void> {
  const client = (knex.client.config.client || '').toLowerCase()

  // Create the new transactions table
  await knex.schema.createTable('transactions', table => {
    table.increments()
    table.specificType('beef', 'longblob')
    table.string('txid', 64).unique()
  })

  // Move data from outputs table to the new transactions table and ensure deduplication
  if (client.startsWith('mysql')) {
    await knex.raw(`
      INSERT IGNORE INTO transactions (txid, beef)
      SELECT txid, beef
      FROM outputs
      WHERE beef IS NOT NULL
    `)
  } else {
    // SQLite / PostgreSQL: INSERT IGNORE is MySQL-only syntax
    await knex.raw(`
      INSERT INTO transactions (txid, beef)
      SELECT txid, beef
      FROM outputs
      WHERE beef IS NOT NULL
      ON CONFLICT (txid) DO NOTHING
    `)
  }

  // Drop the beef column from the outputs table
  await knex.schema.table('outputs', table => {
    table.dropColumn('beef')
  })
}

export async function down (knex: Knex): Promise<void> {
  const client = (knex.client.config.client || '').toLowerCase()

  // Add the beef column back to the outputs table
  await knex.schema.table('outputs', table => {
    table.binary('beef')
  })

  // Move data back from the transactions table to the outputs table
  if (client.startsWith('mysql')) {
    await knex.raw(`
      UPDATE outputs
      JOIN transactions ON outputs.txid = transactions.txid
      SET outputs.beef = transactions.beef
    `)
  } else {
    // SQLite / PostgreSQL: UPDATE ... JOIN is MySQL-only syntax
    await knex.raw(`
      UPDATE outputs
      SET beef = (SELECT beef FROM transactions WHERE transactions.txid = outputs.txid)
      WHERE txid IN (SELECT txid FROM transactions)
    `)
  }

  // Drop the transactions table
  await knex.schema.dropTable('transactions')
}
