import type { Knex } from 'knex'

const MAX_INT32 = 2_147_483_647

// The initial migration declared satoshis as a 32-bit integer, which cannot hold an output
// above 2,147,483,647 satoshis (about 21.47 BSV). SQLite's INTEGER is already 64-bit, so
// only the other dialects are altered.
function isSqlite(knex: Knex): boolean {
  return String(knex.client.config.client ?? '')
    .toLowerCase()
    .includes('sqlite')
}

export async function up(knex: Knex): Promise<void> {
  if (isSqlite(knex) || !(await knex.schema.hasColumn('outputs', 'satoshis'))) return
  await knex.schema.alterTable('outputs', table => {
    table.bigInteger('satoshis').alter()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (isSqlite(knex) || !(await knex.schema.hasColumn('outputs', 'satoshis'))) return
  // Non-strict MySQL would clamp these values instead of failing the narrowing.
  const tooLarge = await knex('outputs').where('satoshis', '>', MAX_INT32).first('txid')
  if (tooLarge !== undefined) {
    throw new Error(
      `Cannot narrow outputs.satoshis to 32 bits while an output above ${MAX_INT32} satoshis is stored`
    )
  }
  await knex.schema.alterTable('outputs', table => {
    table.integer('satoshis', 15).alter()
  })
}
