import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations, StorageKnex, wait } from '../../src/index.all'
import { Knex } from 'knex'

describe('KnexMigrations tests', () => {
  jest.setTimeout(99999999)

  const knexs: Knex[] = []
  const env = _tu.getEnvFlags('test')

  beforeAll(async () => {
    const localSQLiteFile = await _tu.newTmpFile('migratetest.sqlite', true, false, false)
    const knexSQLite = _tu.createLocalSQLite(localSQLiteFile)
    knexs.push(knexSQLite)

    if (env.runMySQL) {
      const knexMySQL = _tu.createLocalMySQL('migratetest')
      knexs.push(knexMySQL)
    }
  })

  afterAll(async () => {
    for (const knex of knexs) {
      await knex.destroy()
    }
  })

  let done0 = false
  const waitFor0 = async () => {
    while (!done0) await wait(100)
  }
  let done1 = false
  const waitFor1 = async () => {
    while (!done1) await wait(100)
  }

  test('0 migragte down', async () => {
    for (const knex of knexs) {
      const config = {
        migrationSource: new KnexMigrations('test', '0 migration test', '1'.repeat(64), 1000)
      }
      const count = Object.keys(config.migrationSource.migrations).length
      for (let i = 0; i < count; i++) {
        try {
          const r = await knex.migrate.down(config)
          expect(r).toBeTruthy()
        } catch (eu: unknown) {
          break
        }
      }
    }
    done0 = true
  })

  test('1 migragte to latest', async () => {
    await waitFor0()
    for (const knex of knexs) {
      const config = {
        migrationSource: new KnexMigrations('test', '0 migration test', '1'.repeat(64), 1000)
      }
      const latest = await KnexMigrations.latestMigration()
      await knex.migrate.latest(config)
      const version = await knex.migrate.currentVersion(config)

      expect(version).toBe(latest.split('_')[0])
    }
    done1 = true
  })

  test('2 getSettings', async () => {
    await waitFor1()
    for (const knex of knexs) {
      const storage = new StorageKnex({
        ...StorageKnex.defaultOptions(),
        chain: 'test',
        knex
      })
      await storage.makeAvailable()
      const r = await storage.getSettings()
      expect(r.created_at instanceof Date).toBe(true)
      expect(r.updated_at instanceof Date).toBe(true)
      expect(r.chain).toBe('test')
      expect(r.maxOutputScript).toBe(1000)
    }
  })

  test('3 backfills wasBroadcast for live ProvenTxReq statuses', async () => {
    const localSQLiteFile = await _tu.newTmpFile('migratebackfilltest.sqlite', false, false, false)
    const knex = _tu.createLocalSQLite(localSQLiteFile)

    try {
      await knex.schema.createTable('proven_tx_reqs', table => {
        table.increments('provenTxReqId')
        table.string('status', 16).notNullable()
      })
      await knex('proven_tx_reqs').insert([
        { status: 'unmined' },
        { status: 'callback' },
        { status: 'unconfirmed' },
        { status: 'completed' },
        { status: 'sending' },
        { status: 'invalid' }
      ])

      const source = new KnexMigrations('test', 'backfill migration test', '1'.repeat(64), 1000)
      const migration = await source.getMigration('2026-04-30-001 add wasBroadcast and rebroadcastAttempts to proven_tx_reqs')
      await migration.up(knex)

      const rows = await knex('proven_tx_reqs').select('status', 'wasBroadcast', 'rebroadcastAttempts')
      const byStatus = Object.fromEntries(rows.map(row => [row.status, row]))

      for (const status of ['unmined', 'callback', 'unconfirmed', 'completed']) {
        expect(Boolean(byStatus[status].wasBroadcast)).toBe(true)
        expect(byStatus[status].rebroadcastAttempts).toBe(0)
      }
      for (const status of ['sending', 'invalid']) {
        expect(Boolean(byStatus[status].wasBroadcast)).toBe(false)
        expect(byStatus[status].rebroadcastAttempts).toBe(0)
      }
    } finally {
      await knex.destroy()
    }
  })
})
