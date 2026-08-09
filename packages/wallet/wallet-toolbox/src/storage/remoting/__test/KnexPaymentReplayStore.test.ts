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
    expect(() => new KnexPaymentReplayStore(database, -2)).toThrow('ttlDays')
    expect(() => new KnexPaymentReplayStore(database, 1.5)).toThrow('ttlDays')
  })

  it('stores non-expiring claims without an expiry timestamp', async () => {
    const store = new KnexPaymentReplayStore(database, -1)

    await expect(store.claim('non-expiring')).resolves.toBe(true)
    await expect(database('payment_replays').where({ transactionId: 'non-expiring' }).first()).resolves.toMatchObject({
      expiresAt: null,
      transactionId: 'non-expiring'
    })
  })

  it.each([
    { code: 'ER_DUP_ENTRY' },
    { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' },
    { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    { errno: 1062 }
  ])('recognizes supported duplicate-key errors without accepting a replay', async duplicateError => {
    const insert = jest.fn(async () => await Promise.reject(duplicateError))
    const fakeKnex = jest.fn(() => ({ insert })) as unknown as Knex
    const store = new KnexPaymentReplayStore(fakeKnex)

    await expect(store.claim('duplicate')).resolves.toBe(false)
  })

  it.each([null, 'database failed', { code: 'SOME_OTHER_ERROR' }])(
    'does not hide non-duplicate database failures',
    async databaseError => {
      const insert = jest.fn(async () => await Promise.reject(databaseError))
      const fakeKnex = jest.fn(() => ({ insert })) as unknown as Knex
      const store = new KnexPaymentReplayStore(fakeKnex)

      await expect(store.claim('failed')).rejects.toBe(databaseError)
    }
  )

  it('passes the requested cutoff to the pruning query', async () => {
    const remove = jest.fn(async () => 3)
    const where = jest.fn(() => ({ delete: remove }))
    const whereNotNull = jest.fn(() => ({ where }))
    const fakeKnex = jest.fn(() => ({ whereNotNull })) as unknown as Knex
    const store = new KnexPaymentReplayStore(fakeKnex)
    const cutoff = new Date('2026-08-04T00:00:00.000Z')

    await expect(store.pruneExpired(cutoff)).resolves.toBe(3)
    expect(whereNotNull).toHaveBeenCalledWith('expiresAt')
    expect(where).toHaveBeenCalledWith('expiresAt', '<=', cutoff)
  })
})
