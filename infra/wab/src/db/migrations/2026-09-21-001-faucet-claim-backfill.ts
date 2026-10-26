import { Knex } from 'knex'

export const orphanedFaucetReconciliationMessage =
  'Uncorrelatable orphaned WAB faucet history requires operator reconciliation before this migration can continue.'

export async function up(knex: Knex): Promise<void> {
  const orphanedPayment = await knex('payments').select('id').whereNull('userId').first()
  if (orphanedPayment != null) {
    throw new Error(orphanedFaucetReconciliationMessage)
  }

  const candidates = await knex('auth_methods')
    .select('auth_methods.id')
    .join('payments', 'payments.userId', 'auth_methods.userId')
    .whereNotNull('auth_methods.userId')
    .andWhere(query =>
      query
        .where({ 'auth_methods.receivedFaucet': false })
        .orWhereNull('auth_methods.receivedFaucet')
    )
  const ids = [...new Set(candidates.map(candidate => Number(candidate.id)))]
  if (ids.length === 0) return

  const updated = await knex('auth_methods')
    .whereIn('id', ids)
    .andWhere(query => query.where({ receivedFaucet: false }).orWhereNull('receivedFaucet'))
    .update({ receivedFaucet: true })
  if (updated !== ids.length) {
    throw new Error('WAB faucet claim backfill changed unexpectedly; retry before serving traffic.')
  }
}

// Faucet consumption is durable security history and must not be cleared on rollback.
export async function down(_knex: Knex): Promise<void> {}
