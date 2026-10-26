import type { Knex } from 'knex'

const OUTPUTS_UNIQUE = 'uq_outputs_txid_output_index_topic'
const APPLIED_UNIQUE = 'uq_applied_transactions_txid_topic'

async function assertNoDuplicateRows(
  knex: Knex,
  table: string,
  columns: string[]
): Promise<void> {
  const duplicate = await knex(table)
    .select(columns)
    .count({ duplicateCount: '*' })
    .groupBy(columns)
    .havingRaw('COUNT(*) > 1')
    .first()

  if (duplicate !== undefined) {
    throw new Error(
      `Cannot enforce ${table} uniqueness while duplicate ${columns.join('/')} rows exist`
    )
  }
}

export async function up(knex: Knex): Promise<void> {
  await assertNoDuplicateRows(knex, 'outputs', ['txid', 'outputIndex', 'topic'])
  await assertNoDuplicateRows(knex, 'applied_transactions', ['txid', 'topic'])

  await knex.schema.table('outputs', table => {
    table.unique(['txid', 'outputIndex', 'topic'], OUTPUTS_UNIQUE)
  })
  await knex.schema.table('applied_transactions', table => {
    table.unique(['txid', 'topic'], APPLIED_UNIQUE)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.table('applied_transactions', table => {
    table.dropUnique(['txid', 'topic'], APPLIED_UNIQUE)
  })
  await knex.schema.table('outputs', table => {
    table.dropUnique(['txid', 'outputIndex', 'topic'], OUTPUTS_UNIQUE)
  })
}
