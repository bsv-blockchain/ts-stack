import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { KnexMigrations, SNAPSHOT_SQLITE_INDEX_MIGRATION } from '../schema/KnexMigrations'
import {
  installGeneration,
  metadata,
  progress,
  names,
  addSnapshotSqliteSourceIndexes,
  readPlan,
  validateInstalled
} from '../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../schema/snapshotSqliteIndexBootstrap'
import { readGenerationIndexState } from '../schema/snapshotSqliteIndexState'
import {
  migrateGeneration,
  refuseGenerationDowngrade,
  dropGenerationForDataDeletion
} from '../schema/snapshotSqliteIndexMigration'
import { retiredTables } from '../schema/snapshotSqliteLegacyOwnership'
import { migrateBeforeSqliteGeneration } from '../../../test/utils/snapshotHistoricalMigrations'

function fixture(tableName = 'knex_migrations') {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
    migrations: { tableName }
  })
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  return { k, source }
}
async function seed(source: StorageKnex, count: number) {
  await source.makeAvailable()
  const userId = (await source.findOrInsertUser('02' + '11'.repeat(32))).user.userId
  for (let start = 0; start < count; start += 100) {
    await source.knex('tx_labels').insert(
      Array.from({ length: Math.min(100, count - start) }, (_, i) => ({
        userId,
        label: `generation-${start + i}`,
        isDeleted: false,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01')
      }))
    )
  }
}

test.each(['knex_migrations', 'custom_snapshot_journal'])(
  'registered migration resumes and publishes %s only after bounded copy/retirement',
  async tableName => {
    const { k, source } = fixture(tableName)
    try {
      await migrateBeforeSqliteGeneration(source, 'registry', 'synthetic-registry')
      await seed(source, 600)
      const before = await k('tx_labels').orderBy('txLabelId')
      let pages = 0
      const failure = new Error('interrupt second generation source page')
      const stop = (q: { sql: string }) => {
        if (q.sql.startsWith('select `txLabelId` as `rowId`') && ++pages === 2) throw failure
      }
      k.on('query', stop)
      try {
        await expect(source.migrate('registry', 'synthetic-registry')).rejects.toBe(failure)
      } finally {
        k.off('query', stop)
      }
      expect(pages).toBe(2)
      expect(await k(progress).where('stream', 3).first('afterId')).toEqual({ afterId: 256 })
      expect(await k(tableName).where('name', SNAPSHOT_SQLITE_INDEX_MIGRATION)).toEqual([])
      expect(await readGenerationIndexState(k, { tableName })).toBe(false)
      expect((await k.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
      await expect(source.migrate('registry', 'synthetic-registry')).resolves.toBe(
        await KnexMigrations.latestMigration()
      )
      expect(await readGenerationIndexState(k, { tableName })).toBe('v2')
      expect(await k('tx_labels').orderBy('txLabelId')).toEqual(before)
      expect(await k(names.profile).where('snapshotTableId', 3)).toHaveLength(600)
      for (const table of retiredTables) expect(await k.schema.hasTable(table)).toBe(false)
      expect(await k(tableName).where('name', SNAPSHOT_SQLITE_INDEX_MIGRATION)).toHaveLength(1)
      await expect(source.migrate('registry', 'synthetic-registry')).resolves.toBe(
        await KnexMigrations.latestMigration()
      )
      const migrationSource = new KnexMigrations('test', 'registry', 'synthetic-registry', 1024)
      expect(migrationSource.migrations[SNAPSHOT_SQLITE_INDEX_MIGRATION].config).toEqual({ transaction: false })
      await expect(k.migrate.down({ migrationSource, name: SNAPSHOT_SQLITE_INDEX_MIGRATION })).rejects.toThrow(
        'downgrade is unsupported'
      )
      expect(await k('tx_labels').orderBy('txLabelId')).toEqual(before)
      expect(await readGenerationIndexState(k, { tableName })).toBe('v2')
    } finally {
      await source.destroy()
    }
  }
)

test.each(['complete', 'unpublished'] as const)(
  'explicit dropAllData preserves its contract for a %s generation',
  async phase => {
    const { k, source } = fixture()
    try {
      await migrateBeforeSqliteGeneration(source, 'deletion', 'synthetic-deletion')
      await seed(source, 3)
      if (phase === 'complete') await source.migrate('deletion', 'synthetic-deletion')
      else await copyGenerationPage(k, await installGeneration(k))
      expect(await k.schema.hasTable(metadata)).toBe(true)
      await source.dropAllData()
      expect(await k.schema.hasTable(metadata)).toBe(false)
      expect(await k.schema.hasTable('snapshot_index_install_lock_v2')).toBe(false)
      expect(await k.schema.hasTable('users')).toBe(false)
      expect(await k.schema.hasTable('tx_labels')).toBe(false)
      expect(await k('knex_migrations')).toEqual([])
      expect(await k('sqlite_master').where('name', 'like', 'snapshot_%')).toEqual([])
      await source.dropAllData()
    } finally {
      await source.destroy()
    }
  }
)

test('MySQL retains its existing migration and deletion behavior without SQLite operations', async () => {
  const database = { client: { config: { client: 'mysql2' } } } as Knex
  await expect(migrateGeneration(database)).resolves.toBeUndefined()
  await expect(refuseGenerationDowngrade(database)).resolves.toBeUndefined()
  await expect(dropGenerationForDataDeletion(database)).resolves.toBeUndefined()
})

test('empty migration adapters without a dialect label do not issue SQLite cleanup commands', async () => {
  const currentVersion = jest.fn(async (_config: Knex.MigratorConfig) => 'none')
  const down = jest.fn(),
    raw = jest.fn()
  const database = { client: { config: {} }, migrate: { currentVersion, down }, raw } as unknown as Knex
  // Use the actual provider's lifecycle methods instead of a partial prototype receiver.
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: database })
  await source.dropAllData()
  expect(currentVersion).toHaveBeenCalledTimes(1)
  expect(currentVersion.mock.calls[0][0].disableTransactions).toBe(false)
  expect(down).not.toHaveBeenCalled()
  expect(raw).not.toHaveBeenCalled()
})

// Additive source ownership includes auxiliary indexes outside the thirteen
// source tables, while exact definitions and the old source inventory remain guarded.
test('owned source and auxiliary index additions preserve rows and rebind only the source inventory', async () => {
  const { k, source } = fixture()
  try {
    await source.migrate('additive-indexes', 'synthetic-additive-indexes')
    await seed(source, 1)
    const rows = await k('tx_labels').orderBy('txLabelId'),
      before = await readPlan(k)
    const statements = [
      'CREATE INDEX test_source_added ON tx_labels (label)',
      'CREATE INDEX test_auxiliary_added ON prepared_beefs (state)'
    ]
    await k.transaction(async trx => {
      await addSnapshotSqliteSourceIndexes(trx, statements, async () => {
        for (const sql of statements) await trx.raw(sql)
      })
      const after = await readPlan(trx)
      await validateInstalled(trx, after)
      expect(JSON.parse(after.source)).toEqual(
        [
          ...JSON.parse(before.source),
          { type: 'index', name: 'test_source_added', tbl_name: 'tx_labels', sql: statements[0] }
        ].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      )
      expect(await trx('sqlite_master').where('name', 'test_auxiliary_added').first('sql')).toEqual({
        sql: statements[1]
      })
    })
    expect(await k('tx_labels').orderBy('txLabelId')).toEqual(rows)
  } finally {
    await source.destroy()
  }
})

test.each(['wrong auxiliary definition', 'unlisted source index', 'removed existing source index'] as const)(
  'additive source migration refuses %s and rolls back every change',
  async fault => {
    const { k, source } = fixture()
    try {
      await source.migrate('additive-refusal', 'synthetic-additive-refusal')
      const before = await k('sqlite_master').orderBy(['type', 'name']),
        metadataBefore = await k(metadata)
      const statements = [
        'CREATE INDEX test_source_added ON tx_labels (label)',
        'CREATE INDEX test_auxiliary_added ON prepared_beefs (state)'
      ]
      await expect(
        k.transaction(async trx => {
          await addSnapshotSqliteSourceIndexes(trx, statements, async () => {
            await trx.raw(statements[0])
            await trx.raw(
              fault === 'wrong auxiliary definition'
                ? 'CREATE INDEX test_auxiliary_added ON prepared_beefs (preparedBeefId)'
                : statements[1]
            )
            if (fault === 'unlisted source index') await trx.raw('CREATE INDEX test_unlisted ON tx_labels (userId)')
            if (fault === 'removed existing source index') await trx.raw('DROP INDEX brc38_import_target_txLabels')
          })
        })
      ).rejects.toThrow(fault === 'wrong auxiliary definition' ? 'definition mismatch' : 'unowned schema object')
      expect(await k('sqlite_master').orderBy(['type', 'name'])).toEqual(before)
      expect(await k(metadata)).toEqual(metadataBefore)
    } finally {
      await source.destroy()
    }
  }
)
