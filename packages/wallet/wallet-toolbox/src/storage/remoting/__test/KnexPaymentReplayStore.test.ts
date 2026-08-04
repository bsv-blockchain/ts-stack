import { knex as makeKnex, type Knex } from 'knex'
import { KnexMigrations, PAYMENT_REPLAY_MIGRATION } from '../../schema/KnexMigrations'
import { KnexPaymentReplayStore } from '../KnexPaymentReplayStore'

describe('KnexPaymentReplayStore', () => {
  let database: Knex

  beforeEach(async () => {
    database = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    const migrations = new KnexMigrations('test', 'payment replay tests', '1'.repeat(64), 1024)
    await (await migrations.getMigration(PAYMENT_REPLAY_MIGRATION)).up(database)
  })

  afterEach(async () => {
    await database.destroy()
  })

  it('atomically accepts a transaction once and prunes expired claims', async () => {
    const store = new KnexPaymentReplayStore(database, 1)
    await expect(store.claim('transaction-id')).resolves.toBe(true)
    await expect(store.claim('transaction-id')).resolves.toBe(false)
    await database('payment_replays').update({ expiresAt: new Date(0) })
    await expect(store.pruneExpired()).resolves.toBe(1)
  })

  it('supports explicit non-expiring claims and rejects invalid TTL values', () => {
    expect(() => new KnexPaymentReplayStore(database, -1)).not.toThrow()
    expect(() => new KnexPaymentReplayStore(database, 0)).toThrow('ttlDays')
  })
})
