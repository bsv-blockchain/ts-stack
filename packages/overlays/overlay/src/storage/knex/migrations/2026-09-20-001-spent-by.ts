import type { Knex } from 'knex'

/** Add the transaction identity needed to distinguish retries from double spends. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.table('outputs', table => {
    table.string('spentBy', 64).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.table('outputs', table => {
    table.dropColumn('spentBy')
  })
}
