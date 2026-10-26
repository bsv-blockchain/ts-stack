import type { Knex } from 'knex'

/**
 * Exact-request bindings for delivery payments. The prepared row is committed
 * before wallet mutation. attempt_token gives one request ownership of the
 * prepared state; wallet_accepted is persisted after a failed message
 * transaction so the same request can finish without internalizing twice.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('message_payment_intents', table => {
    table.string('transaction_id', 64).primary()
    table.string('request_digest', 64).notNullable()
    table.string('status', 32).notNullable()
    table.string('attempt_token', 64).notNullable()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now())
    table.index(['status', 'updated_at'], 'message_payment_intents_status_index')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('message_payment_intents'))) return
  const durableIntent = await knex('message_payment_intents').first('transaction_id')
  if (durableIntent != null) {
    throw new Error(
      'Cannot drop message_payment_intents while durable payment recovery evidence exists'
    )
  }
  await knex.schema.dropTable('message_payment_intents')
}
