import { knex as makeKnex } from 'knex'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { sdk } from '../../index.client'
import { StorageKnex } from '../StorageKnex'

/**
 * Regression test for a self-deadlock on single-connection pools.
 *
 * knex forces `{ min: 1, max: 1 }` on the sqlite dialect, so there is exactly one connection.
 * Any query issued against `this.knex` while a caller's transaction holds that connection can
 * never be granted: the transaction will not release until the query returns, and the query
 * cannot run until the transaction releases. It fails with
 * `KnexTimeoutError: Timeout acquiring a connection... Are you missing a .transacting(trx) call?`
 *
 * `verifyReadyForDatabaseAccess(trx)` is on every write path and lazily populates `_settings`.
 * When that cache is cold and the first access happens inside a transaction, `readSettings`
 * must run on the caller's transaction rather than the pool, or the whole write deadlocks.
 *
 * `acquireConnectionTimeout` is lowered so a regression fails in seconds rather than the
 * 60s default.
 */
describe('readSettings honours a caller-supplied transaction', () => {
  jest.setTimeout(60000)

  const chain: sdk.Chain = 'test'
  let dbFile: string

  beforeAll(async () => {
    // Migrate once so a settings row exists, then drop this storage entirely: the test needs a
    // StorageKnex whose `_settings` cache is COLD, which `makeAvailable()` would defeat.
    dbFile = await _tu.newTmpFile('readsettingstrx.sqlite', false, false, false)
    const seed = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: _tu.createLocalSQLite(dbFile)
    })
    await seed.dropAllData()
    await seed.migrate('readSettings trx test', '1'.repeat(64))
    await seed.destroy()
  })

  test('verifyReadyForDatabaseAccess does not deadlock when settings are read inside a transaction', async () => {
    const knex = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: dbFile },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      acquireConnectionTimeout: 5000
    })
    const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain, knex })

    try {
      // Cold cache: the settings read below is this instance's first database access.
      expect(storage['_settings']).toBeUndefined()

      const dbtype = await knex.transaction(async trx => {
        return await storage.verifyReadyForDatabaseAccess(trx as unknown as sdk.TrxToken)
      })

      expect(dbtype).toBe('SQLite')
      expect(storage['_settings']).toBeDefined()
    } finally {
      await storage.destroy()
    }
  })

  test('readSettings accepts a transaction directly', async () => {
    const knex = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: dbFile },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      acquireConnectionTimeout: 5000
    })
    const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain, knex })

    try {
      const settings = await knex.transaction(async trx => {
        return await storage.readSettings(trx as unknown as sdk.TrxToken)
      })

      expect(settings.chain).toBe(chain)
      expect(settings.dbtype).toBe('SQLite')
    } finally {
      await storage.destroy()
    }
  })
})
