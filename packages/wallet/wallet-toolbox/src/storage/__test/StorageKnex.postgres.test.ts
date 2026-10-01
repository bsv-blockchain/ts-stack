import { knex as makeKnex, Knex } from 'knex'
import { types as pgTypes } from 'pg'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { StorageKnex } from '../StorageKnex'

const env = _tu.getEnvFlags('test')
const describePostgres = env.runPostgres ? describe : describe.skip

/**
 * Postgres-specific StorageKnex behavior. Requires `RUNPOSTGRES` and
 * `POSTGRES_CONNECTION`.
 */
describePostgres('StorageKnex on Postgres', () => {
  const database = 'storageknexpostgrestest'
  let connection: Knex.PgConnectionConfig

  beforeAll(async () => {
    await (await _tu.createLocalPostgres(database)).destroy()
    connection = { ...JSON.parse(process.env.POSTGRES_CONNECTION ?? '{}'), database }
  })

  test('returns int8 values as numbers on a plain pg knex', async () => {
    const knex = makeKnex({ client: 'pg', connection, pool: { min: 1, max: 2 } })
    // A connection acquired before StorageKnex installs its parser.
    expect(await knex.raw('select 1::int8 as v')).toMatchObject({ rows: [{ v: '1' }] })
    const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'test', knex })
    try {
      await storage.dropAllData()
      await storage.migrate('postgres int8 test', '1'.repeat(64))
      await storage.makeAvailable()

      const { tx } = await _tu.insertTestTransaction(storage)
      const satoshis = 2_100_000_000_000_000
      const output = await _tu.insertTestOutput(storage, tx, 0, satoshis)

      const row = await knex('outputs').where({ outputId: output.outputId }).first('satoshis')
      expect(row.satoshis).toBe(satoshis)
      expect((await storage.findOutputs({ partial: { outputId: output.outputId } }))[0].satoshis).toBe(satoshis)
      expect(await storage.countOutputs({ partial: { userId: tx.userId } })).toBe(1)
      expect(await knex.raw('select 1::int8 as v')).toMatchObject({ rows: [{ v: 1 }] })

      // The process-wide pg defaults are untouched.
      expect(pgTypes.getTypeParser(20, 'text')('5')).toBe('5')
    } finally {
      await storage.destroy()
    }
  })
})
