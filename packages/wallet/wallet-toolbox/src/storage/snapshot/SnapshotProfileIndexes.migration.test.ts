import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { KnexMigrations } from '../schema/KnexMigrations'
import { SNAPSHOT_RELATION_INDEX_MIGRATION } from '../schema/snapshotRelationIndexMigration'
import {
  readSnapshotProfileIndexState,
  SNAPSHOT_PROFILE_INDEX_MIGRATION
} from '../schema/snapshotProfileIndexMigration'

test('registered profile bootstrap survives reopening and publishes its journal only after all pages commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-profile-migration-'))
  const options = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  }
  let database = knex(options)
  let source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: database })
  const migrationSource = new KnexMigrations('test', 'profile migration', 'synthetic-profile-migration', 1024)
  try {
    expect((await migrationSource.getMigration(SNAPSHOT_PROFILE_INDEX_MIGRATION)).config).toEqual({
      transaction: false
    })
    await source.migrate('profile migration', 'synthetic-profile-migration')
    await source.makeAvailable()
    await database.migrate.down({ migrationSource, name: SNAPSHOT_PROFILE_INDEX_MIGRATION, disableTransactions: false })
    const priorJournal = await database('knex_migrations').orderBy('id')
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    for (let batch = 0; batch < 3; batch++) {
      await database('tx_labels').insert(
        Array.from({ length: 200 }, (_, index) => ({
          userId: user.userId,
          label: `label-${batch * 200 + index}`,
          isDeleted: false,
          created_at: new Date('2026-01-01'),
          updated_at: new Date('2026-01-01')
        }))
      )
    }
    let pages = 0
    const failure = new Error('synthetic interrupted profile bootstrap')
    const interrupt = (query: { sql: string }): void => {
      if (query.sql.startsWith('select `txLabelId`, `userId` from `tx_labels`') && ++pages === 2) throw failure
    }
    database.on('query', interrupt)
    try {
      await expect(source.migrate('profile migration', 'synthetic-profile-migration')).rejects.toBe(failure)
    } finally {
      database.off('query', interrupt)
    }
    expect(await database('knex_migrations').orderBy('id')).toEqual(priorJournal)
    expect(await database('snapshot_profile_index_progress').where('snapshotTableId', 3).first()).toEqual({
      snapshotTableId: 3,
      afterRowId: 256,
      complete: 0
    })
    expect(await readSnapshotProfileIndexState(database)).toBe(false)
    expect((await database.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
    await source.destroy()
    database = knex(options)
    source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: database })
    await expect(source.migrate('profile migration', 'synthetic-profile-migration')).resolves.toBe(
      SNAPSHOT_RELATION_INDEX_MIGRATION
    )
    expect(await readSnapshotProfileIndexState(database)).toBe(true)
    expect(await database('snapshot_profile_keys').where('snapshotTableId', 3).count({ count: '*' }).first()).toEqual({
      count: 600
    })
    expect(
      await database('knex_migrations').where('name', SNAPSHOT_PROFILE_INDEX_MIGRATION).count({ count: '*' }).first()
    ).toEqual({ count: 1 })
    await database.migrate.down({ migrationSource, name: SNAPSHOT_PROFILE_INDEX_MIGRATION, disableTransactions: false })
    expect(await database.schema.hasTable('snapshot_profile_keys')).toBe(false)
    expect(await database.schema.hasTable('snapshot_profile_index_progress')).toBe(false)
    expect(await database('knex_migrations').orderBy('id')).toEqual(priorJournal)
    expect(await database('tx_labels').count({ count: '*' }).first()).toEqual({ count: 600 })
  } finally {
    await source.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
