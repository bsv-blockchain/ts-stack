import type { PaymentReplayStore } from '@bsv/payment-express-middleware'
import type { Knex } from 'knex'

function isDuplicate(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const value = error as { code?: unknown; errno?: unknown }
  return (
    value.code === 'ER_DUP_ENTRY' ||
    value.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    value.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    value.errno === 1062
  )
}

/** Durable, replica-safe BRC-105 transaction replay claims. */
export class KnexPaymentReplayStore implements PaymentReplayStore {
  constructor(
    private readonly knex: Knex,
    private readonly ttlDays: number = 365
  ) {
    if (!Number.isSafeInteger(ttlDays) || (ttlDays !== -1 && ttlDays < 1)) {
      throw new Error('Payment replay TTL must be -1 or a positive integer')
    }
  }

  async claim(transactionId: string): Promise<boolean> {
    const now = new Date()
    const expiresAt =
      this.ttlDays === -1 ? null : new Date(now.getTime() + this.ttlDays * 24 * 60 * 60 * 1_000)
    try {
      await this.knex('payment_replays').insert({
        transaction_id: transactionId,
        created_at: now,
        expires_at: expiresAt
      })
      return true
    } catch (error) {
      if (isDuplicate(error)) return false
      throw error
    }
  }

  async pruneExpired(now = new Date()): Promise<number> {
    return await this.knex('payment_replays')
      .whereNotNull('expires_at')
      .where('expires_at', '<=', now)
      .delete()
  }
}
