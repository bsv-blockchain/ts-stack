import { knex as makeKnex, Knex } from 'knex'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { StorageKnex } from '../StorageKnex'
import { managedChangeOutputFields } from '../methods/managedChange'

const env = _tu.getEnvFlags('test')
const describePostgres = env.runPostgres ? describe : describe.skip

/**
 * Postgres-specific StorageKnex behavior. Requires `RUNPOSTGRES` and
 * `POSTGRES_CONNECTION`.
 */
describePostgres('StorageKnex on Postgres', () => {
  const database = 'storageknexpostgrestest'
  let connection: Knex.PgConnectionConfig
  const opened: Array<{ destroy: () => Promise<void> }> = []

  beforeAll(async () => {
    await (await _tu.createLocalPostgres(database)).destroy()
    connection = { ...JSON.parse(process.env.POSTGRES_CONNECTION ?? '{}'), database }
  })

  afterEach(async () => {
    for (const o of opened.splice(0)) await o.destroy()
  })

  function plainKnex(): Knex {
    const knex = makeKnex({ client: 'pg', connection, pool: { min: 1, max: 2 } })
    opened.push(knex)
    return knex
  }

  async function openStorage(knex: Knex = plainKnex()): Promise<StorageKnex> {
    const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'test', knex })
    opened.unshift(storage)
    await storage.dropAllData()
    await storage.migrate('postgres storage test', '1'.repeat(64))
    await storage.makeAvailable()
    return storage
  }

  test('returns int8 values as numbers on a plain pg knex', async () => {
    const knex = plainKnex()
    // A connection acquired before StorageKnex installs its parser.
    expect(await knex.raw('select 1::int8 as v')).toMatchObject({ rows: [{ v: '1' }] })
    const storage = await openStorage(knex)

    const { tx } = await _tu.insertTestTransaction(storage)
    const satoshis = 2_100_000_000_000_000
    const output = await _tu.insertTestOutput(storage, tx, 0, satoshis)

    const row = await knex('outputs').where({ outputId: output.outputId }).first('satoshis')
    expect(row.satoshis).toBe(satoshis)
    expect((await storage.findOutputs({ partial: { outputId: output.outputId } }))[0].satoshis).toBe(satoshis)
    expect(await storage.countOutputs({ partial: { userId: tx.userId } })).toBe(1)
    expect(await knex.raw('select 1::int8 as v')).toMatchObject({ rows: [{ v: 1 }] })

    // Other knex instances, and the process-wide pg defaults, are untouched.
    expect(await plainKnex().raw('select 1::int8 as v')).toMatchObject({ rows: [{ v: '1' }] })
  })

  test('a duplicate find-or-insert insert does not abort the surrounding transaction', async () => {
    const storage = await openStorage()
    const user = await _tu.insertTestUser(storage)
    const label = await storage.findOrInsertTxLabel(user.userId, 'existing')
    const duplicate = { ...label, txLabelId: 0 }

    await storage.transaction(async trx => {
      await expect(storage.insertTxLabel(duplicate, trx)).rejects.toThrow()
      const found = await storage.findTxLabels({ partial: { userId: user.userId, label: 'existing' }, trx })
      expect(found.map(l => l.txLabelId)).toEqual([label.txLabelId])
      const again = await storage.findOrInsertTxLabel(user.userId, 'existing', trx)
      expect(again.txLabelId).toBe(label.txLabelId)
    })
  })

  test('allocateChangeInput skips an output reserved while it waited for the row lock', async () => {
    const storage = await openStorage()
    const user = await _tu.insertTestUser(storage)
    const basket = await _tu.insertTestOutputBasket(storage, user)
    const { tx: source } = await _tu.insertTestTransaction(storage, user, false, { status: 'completed' })
    const { tx: spending } = await _tu.insertTestTransaction(storage, user)
    const output = await _tu.insertTestOutput(storage, source, 0, 1000, basket, false, {
      ...managedChangeOutputFields
    })

    const locker = plainKnex()
    const lock = await locker.transaction()
    try {
      await lock('outputs').where({ outputId: output.outputId }).forUpdate().first('outputId')
      const allocation = storage.allocateChangeInput(
        user.userId,
        basket.basketId,
        1000,
        undefined,
        false,
        spending.transactionId
      )
      // Wait until the allocation is blocked on the row lock.
      for (let i = 0; ; i++) {
        const waiting = await locker('pg_stat_activity')
          .where({ datname: database, wait_event_type: 'Lock' })
          .count({ count: '*' })
        if (Number(waiting[0].count) > 0) break
        if (i > 200) throw new Error('allocateChangeInput did not wait for the row lock')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const now = new Date()
      const later = new Date(now.getTime() + 60_000)
      const [{ actionBatchId }] = await lock('action_batches')
        .insert({
          created_at: now,
          updated_at: now,
          userId: user.userId,
          batchId: 'reserving-batch',
          status: 'active',
          expiresAt: later,
          hardExpiresAt: later
        })
        .returning('actionBatchId')
      await lock('action_batch_outputs').insert({
        created_at: now,
        updated_at: now,
        actionBatchId,
        outputId: output.outputId
      })
      await lock.commit()

      await expect(allocation).resolves.toBeUndefined()
      const [stored] = await storage.findOutputs({ partial: { outputId: output.outputId } })
      expect(stored.spentBy).toBeUndefined()
      expect(stored.spendable).toBe(true)
    } finally {
      if (!lock.isCompleted()) await lock.rollback()
    }
  })
})
