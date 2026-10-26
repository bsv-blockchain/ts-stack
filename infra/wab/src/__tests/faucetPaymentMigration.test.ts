import knex, { Knex } from 'knex'
import {
  down as rollbackPaymentReservations,
  faucetPaymentRollbackMessage,
  faucetPaymentUserUnique,
  up as addPaymentReservations
} from '../db/migrations/2026-09-18-001-faucet-payment-reservations'
import {
  orphanedFaucetReconciliationMessage,
  up as backfillFaucetClaims
} from '../db/migrations/2026-09-21-001-faucet-claim-backfill'

describe('faucet payment reservation migration', () => {
  async function createPaymentDatabase(): Promise<Knex> {
    const database = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await database.schema.createTable('payments', table => {
      table.increments('id').primary()
      table.integer('userId').nullable()
    })
    return database
  }

  async function paymentIndexNames(database: Knex): Promise<string[]> {
    const indexes = (await database.raw('PRAGMA index_list("payments")')) as Array<{
      name: string
    }>
    return indexes.map(index => index.name)
  }

  it('uses a stable unique-index name within the MySQL identifier limit', () => {
    expect(faucetPaymentUserUnique).toBe('payments_user_id_unique')
    expect(faucetPaymentUserUnique.length).toBeLessThanOrEqual(64)
  })

  it('resumes after the status-column DDL committed without the unique index', async () => {
    const database = await createPaymentDatabase()
    try {
      await database.schema.alterTable('payments', table => {
        table.string('status', 16).notNullable().defaultTo('ready')
      })
      await database('payments').insert({ userId: 7 })

      await addPaymentReservations(database)
      await addPaymentReservations(database)

      await expect(database.schema.hasColumn('payments', 'status')).resolves.toBe(true)
      await expect(paymentIndexNames(database)).resolves.toContain(faucetPaymentUserUnique)
      await expect(database('payments').insert({ userId: 7 })).rejects.toThrow()
    } finally {
      await database.destroy()
    }
  })

  it('refuses rollback without changing the schema when any payment evidence exists', async () => {
    const database = await createPaymentDatabase()
    try {
      await addPaymentReservations(database)
      await database('payments').insert({ userId: 9, status: 'creating' })

      await expect(rollbackPaymentReservations(database)).rejects.toThrow(
        faucetPaymentRollbackMessage
      )

      await expect(database.schema.hasColumn('payments', 'status')).resolves.toBe(true)
      await expect(paymentIndexNames(database)).resolves.toContain(faucetPaymentUserUnique)
    } finally {
      await database.destroy()
    }
  })

  it('reverses an empty reservation schema and tolerates a retry', async () => {
    const database = await createPaymentDatabase()
    try {
      await addPaymentReservations(database)

      await rollbackPaymentReservations(database)
      await rollbackPaymentReservations(database)

      await expect(database.schema.hasColumn('payments', 'status')).resolves.toBe(false)
      await expect(paymentIndexNames(database)).resolves.not.toContain(faucetPaymentUserUnique)
    } finally {
      await database.destroy()
    }
  })

  async function createBackfillDatabase(): Promise<Knex> {
    const database = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await database.schema.createTable('auth_methods', table => {
      table.increments('id').primary()
      table.integer('userId').nullable()
      table.boolean('receivedFaucet').nullable()
    })
    await database.schema.createTable('payments', table => {
      table.increments('id').primary()
      table.integer('userId').nullable()
      table.string('status').notNullable()
    })
    return database
  }

  it('backfills every linked identity for ready, ambiguous, and unknown faucet payments', async () => {
    const database = await createBackfillDatabase()
    try {
      await database('auth_methods').insert([
        { id: 1, userId: 10, receivedFaucet: false },
        { id: 2, userId: 10, receivedFaucet: true },
        { id: 3, userId: 11, receivedFaucet: false },
        { id: 4, userId: 12, receivedFaucet: false }
      ])
      await database('payments').insert([
        { userId: 10, status: 'ready' },
        { userId: 11, status: 'creating' },
        { userId: 12, status: 'future-state' }
      ])

      await backfillFaucetClaims(database)

      const methods = await database('auth_methods').select('id', 'receivedFaucet').orderBy('id')
      expect(methods.map(method => [method.id, Boolean(method.receivedFaucet)])).toEqual([
        [1, true],
        [2, true],
        [3, true],
        [4, true]
      ])
    } finally {
      await database.destroy()
    }
  })

  it.each(['ready', 'future-state'])(
    'requires operator reconciliation for an orphaned %s payment',
    async status => {
      const database = await createBackfillDatabase()
      try {
        await database('payments').insert({ userId: null, status })

        await expect(backfillFaucetClaims(database)).rejects.toThrow(
          orphanedFaucetReconciliationMessage
        )
      } finally {
        await database.destroy()
      }
    }
  )
})
