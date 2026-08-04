import type { PaymentReplayStore } from '@bsv/payment-express-middleware'
import type { Knex } from 'knex'

function isDuplicate(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const value = error as { code?: unknown; errno?: unknown }
  return value.code === 'ER_DUP_ENTRY' || value.errno === 1062
}

/** Compatible durable store; the wallet-toolbox migration owns its table. */
export class KnexPaymentReplayStore implements PaymentReplayStore {
  constructor(
    private readonly knex: Knex,
    private readonly ttlDays: number
  ) {}

  async claim(transactionId: string): Promise<boolean> {
    const now = new Date()
    try {
      await this.knex('payment_replays').insert({
        transactionId,
        createdAt: now,
        expiresAt:
          this.ttlDays === -1
            ? null
            : new Date(now.getTime() + this.ttlDays * 86_400_000)
      })
      return true
    } catch (error) {
      if (isDuplicate(error)) return false
      throw error
    }
  }
}
