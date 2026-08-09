import { _tu } from '../utils/TestUtilsWalletStorage'
import {
  AUTH_SESSION_MIGRATION,
  CREATE_ACTION_FUNDING_INDEX_MIGRATION,
  KnexMigrations,
  MONITOR_CREATED_AT_INDEX_MIGRATION,
  StorageKnex,
  wait
} from '../../src/index.all'
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
      const knexMySQL = _tu.createLocalMySQL(process.env.MYSQL_MIGRATION_TEST_DATABASE ?? 'migratetest')
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
        if (await knex.migrate.currentVersion(config) === 'none') break
        const r = await knex.migrate.down(config)
        expect(r).toBeTruthy()
      }
      expect(await knex.migrate.currentVersion(config)).toBe('none')
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
      expect(r.created_at).toBeInstanceOf(Date)
      expect(r.updated_at).toBeInstanceOf(Date)
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
      const migration = await source.getMigration(
        '2026-04-30-001 add wasBroadcast and rebroadcastAttempts to proven_tx_reqs'
      )
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

  test('4 creates shared sessions and the monitor checkpoint index', async () => {
    const localSQLiteFile = await _tu.newTmpFile('migratesessions.sqlite', false, false, false)
    const knex = _tu.createLocalSQLite(localSQLiteFile)

    try {
      await knex.schema.createTable('monitor_events', table => {
        table.increments('id')
        table.string('event', 64).notNullable()
        table.timestamp('created_at').notNullable()
      })

      const source = new KnexMigrations('test', 'session migration test', '1'.repeat(64), 1000)
      const authMigration = await source.getMigration(AUTH_SESSION_MIGRATION)
      const monitorMigration = await source.getMigration(MONITOR_CREATED_AT_INDEX_MIGRATION)
      await authMigration.up(knex)
      await monitorMigration.up(knex)

      await expect(knex.schema.hasTable('auth_sessions')).resolves.toBe(true)
      const indexes = await knex('sqlite_master')
        .where({ type: 'index' })
        .whereIn('name', [
          'idx_auth_sessions_identity_updated',
          'idx_auth_sessions_expires',
          'idx_monitor_events_created_at'
        ])
        .pluck('name')
      expect(indexes.sort()).toEqual([
        'idx_auth_sessions_expires',
        'idx_auth_sessions_identity_updated',
        'idx_monitor_events_created_at'
      ])

      await monitorMigration.down?.(knex)
      await authMigration.down?.(knex)
      await expect(knex.schema.hasTable('auth_sessions')).resolves.toBe(false)
    } finally {
      await knex.destroy()
    }
  })

  test('5 creates and uses the createAction funding selection index', async () => {
    const localSQLiteFile = await _tu.newTmpFile('migratefundingindex.sqlite', false, false, false)
    const knex = _tu.createLocalSQLite(localSQLiteFile)

    try {
      await knex.schema.createTable('outputs', table => {
        table.increments('outputId')
        table.integer('userId').notNullable()
        table.integer('basketId').notNullable()
        table.boolean('spendable').notNullable()
        table.integer('spentBy').nullable()
        table.bigInteger('satoshis').notNullable()
      })
      const source = new KnexMigrations('test', 'funding index test', '1'.repeat(64), 1000)
      const migration = await source.getMigration(CREATE_ACTION_FUNDING_INDEX_MIGRATION)
      await migration.up(knex)

      await expect(knex('sqlite_master')
        .where({ type: 'index', name: 'idx_outputs_funding_selection' })
        .first()).resolves.toBeDefined()
      const plan = await knex.raw(
        'EXPLAIN QUERY PLAN SELECT outputId FROM outputs ' +
        'WHERE userId = ? AND basketId = ? AND spendable = ? AND spentBy IS NULL',
        [1, 1, true]
      ) as Array<{ detail: string }>
      expect(plan.some(step => step.detail.includes('idx_outputs_funding_selection'))).toBe(true)

      await migration.down?.(knex)
      await expect(knex('sqlite_master')
        .where({ type: 'index', name: 'idx_outputs_funding_selection' })
        .first()).resolves.toBeUndefined()
    } finally {
      await knex.destroy()
    }
  })

  test.each([
    {
      migrationName: '2026-02-27-001 add listOutputs path indexes',
      supportIndex: 'outputs_userid_foreign',
      addedIndexes: [
        'idx_tx_labels_map_tx_deleted',
        'idx_output_tags_map_output_deleted_tag',
        'idx_outputs_user_basket_spendable_outputid',
        'idx_outputs_user_spendable_outputid'
      ]
    },
    {
      migrationName: '2026-02-27-002 add createAction path indexes',
      supportIndex: 'outputs_spentby_foreign',
      addedIndexes: [
        'idx_outputs_spentby',
        'idx_outputs_user_basket_spendable_satoshis'
      ]
    }
  ])('6 restores the MySQL support index before rolling back $migrationName', async ({
    migrationName,
    supportIndex,
    addedIndexes
  }) => {
    const index = jest.fn()
    const dropIndex = jest.fn()
    const table = { index, dropIndex }
    const raw = jest.fn()
      .mockResolvedValueOnce([[{ database_type: 'MySQL' }]])
      .mockResolvedValueOnce([[]])
    const alterTable = jest.fn(async (
      _tableName: string,
      callback: (tableBuilder: typeof table) => void
    ) => { callback(table) })
    const knex = { raw, schema: { alterTable } } as unknown as Knex
    const source = new KnexMigrations('test', 'MySQL rollback test', '1'.repeat(64), 1000)
    const migration = await source.getMigration(migrationName)

    await migration.down?.(knex)

    expect(index).toHaveBeenCalledWith(expect.any(Array), supportIndex)
    expect(dropIndex.mock.calls.map(call => call[1])).toEqual(addedIndexes)
  })

  test.each([
    '2026-02-27-001 add listOutputs path indexes',
    '2026-02-27-002 add createAction path indexes'
  ])('7 preserves an existing MySQL foreign-key support index while rolling back %s', async migrationName => {
    const index = jest.fn()
    const dropIndex = jest.fn()
    const table = { index, dropIndex }
    const raw = jest.fn()
      .mockResolvedValueOnce([[{ database_type: 'MySQL' }]])
      .mockResolvedValueOnce([[{ Key_name: 'existing_support_index' }]])
    const alterTable = jest.fn(async (
      _tableName: string,
      callback: (tableBuilder: typeof table) => void
    ) => { callback(table) })
    const knex = { raw, schema: { alterTable } } as unknown as Knex
    const source = new KnexMigrations('test', 'MySQL rollback test', '1'.repeat(64), 1000)
    const migration = await source.getMigration(migrationName)

    await migration.down?.(knex)

    expect(index).not.toHaveBeenCalled()
    expect(dropIndex).toHaveBeenCalled()
  })

  test.each([
    '2026-02-27-001 add listOutputs path indexes',
    '2026-02-27-002 add createAction path indexes'
  ])('8 rolls back %s without MySQL support-index repair on SQLite', async migrationName => {
    const dropIndex = jest.fn()
    const raw = jest.fn(async () => await Promise.reject(
      Object.assign(new Error('SQLite does not implement VERSION()'), { code: 'SQLITE_ERROR' })
    ))
    const alterTable = jest.fn(async (
      _tableName: string,
      callback: (tableBuilder: { dropIndex: typeof dropIndex }) => void
    ) => { callback({ dropIndex }) })
    const knex = { raw, schema: { alterTable } } as unknown as Knex
    const source = new KnexMigrations('test', 'SQLite rollback test', '1'.repeat(64), 1000)
    const migration = await source.getMigration(migrationName)

    await migration.down?.(knex)

    expect(dropIndex).toHaveBeenCalled()
  })
})
