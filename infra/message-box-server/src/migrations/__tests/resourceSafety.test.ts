import knexFactory, { type Knex } from 'knex'
import { down, up } from '../2026-08-04-001-resource-safety.js'
import { KnexPaymentReplayStore } from '../../security/KnexPaymentReplayStore.js'

describe('Message Box resource safety migration', () => {
  let database: Knex

  beforeEach(async () => {
    database = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await database.schema.createTable('messages', table => {
      table.string('messageId').primary()
      table.string('body').notNullable()
    })
  })

  afterEach(async () => {
    await database.destroy()
  })

  it('creates durable shared-state tables and reverses cleanly', async () => {
    await up(database)
    await expect(database.schema.hasColumn('messages', 'expires_at')).resolves.toBe(true)
    await expect(database.schema.hasTable('message_resource_locks')).resolves.toBe(true)
    await expect(database.schema.hasTable('auth_sessions')).resolves.toBe(true)
    await expect(database.schema.hasTable('payment_replays')).resolves.toBe(true)

    const replayStore = new KnexPaymentReplayStore(database, 1)
    await expect(replayStore.claim('txid')).resolves.toBe(true)
    await expect(replayStore.claim('txid')).resolves.toBe(false)
    const ordinaryClaim = await database('payment_replays')
      .where({ transaction_id: 'txid' })
      .first('expires_at')
    expect(ordinaryClaim.expires_at).not.toBeNull()

    await expect(
      database.transaction(async transaction => {
        await expect(replayStore.claimInTransaction('rolled-back', transaction)).resolves.toBe(true)
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')
    await expect(replayStore.claim('rolled-back')).resolves.toBe(true)

    await database.transaction(async transaction => {
      await expect(replayStore.claimInTransaction('body-payment', transaction)).resolves.toBe(true)
    })
    await expect(
      database('payment_replays').where({ transaction_id: 'body-payment' }).first('expires_at')
    ).resolves.toEqual({ expires_at: null })

    const afterConfiguredTtl = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000)
    await expect(replayStore.pruneExpired(afterConfiguredTtl)).resolves.toBe(2)
    await expect(
      database('payment_replays').where({ transaction_id: 'body-payment' })
    ).resolves.toHaveLength(1)
    await database.transaction(async transaction => {
      await expect(replayStore.claimInTransaction('body-payment', transaction)).resolves.toBe(false)
    })

    await down(database)
    await expect(database.schema.hasColumn('messages', 'expires_at')).resolves.toBe(false)
    await expect(database.schema.hasTable('auth_sessions')).resolves.toBe(false)
  })
})
