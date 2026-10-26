import knexFactory from 'knex'
import { down, up } from '../2026-09-21-001-message-payment-intents.js'

describe('message payment intent migration', () => {
  it('creates an exact-request-bound durable intent table', async () => {
    const database = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    try {
      await up(database)
      await database('message_payment_intents').insert({
        transaction_id: 'a'.repeat(64),
        request_digest: 'b'.repeat(64),
        status: 'prepared',
        attempt_token: 'd'.repeat(64)
      })
      await expect(database('message_payment_intents').first()).resolves.toMatchObject({
        transaction_id: 'a'.repeat(64),
        request_digest: 'b'.repeat(64),
        status: 'prepared',
        attempt_token: 'd'.repeat(64)
      })
      await expect(
        database('message_payment_intents').insert({
          transaction_id: 'a'.repeat(64),
          request_digest: 'c'.repeat(64),
          status: 'prepared',
          attempt_token: 'e'.repeat(64)
        })
      ).rejects.toThrow()
      await expect(down(database)).rejects.toThrow(
        'Cannot drop message_payment_intents while durable payment recovery evidence exists'
      )
      await expect(database.schema.hasTable('message_payment_intents')).resolves.toBe(true)
      await expect(database('message_payment_intents').first()).resolves.toMatchObject({
        transaction_id: 'a'.repeat(64),
        status: 'prepared'
      })

      await database('message_payment_intents').delete()
      await down(database)
      await expect(database.schema.hasTable('message_payment_intents')).resolves.toBe(false)
      await expect(down(database)).resolves.toBeUndefined()
    } finally {
      await database.destroy()
    }
  })
})
