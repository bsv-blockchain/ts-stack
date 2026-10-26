import type { PaymentReplayStore } from '@bsv/payment-express-middleware'
import type { Knex } from 'knex'

/**
 * Message Box replay stores must be able to claim a body-payment transaction
 * in the same database transaction that makes its messages visible. Claims
 * made through claimInTransaction must be non-expiring and must not be pruned.
 */
export interface TransactionalPaymentReplayStore extends PaymentReplayStore {
  claimInTransaction: (
    transactionId: string,
    transaction: Knex.Transaction
  ) => boolean | Promise<boolean>
}
