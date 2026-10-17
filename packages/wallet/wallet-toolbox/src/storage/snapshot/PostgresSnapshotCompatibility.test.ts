import { knex, type Knex } from 'knex'
import { KnexMigrations } from '../schema/KnexMigrations'
import { forSnapshotSqlDialect } from '../schema/snapshotSqlMigration'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { SNAPSHOT_JOURNAL_SOURCE_MIGRATION, SNAPSHOT_JOURNAL_DESTINATION_MIGRATION } from '../schema/KnexMigrations'

const entries = [
  '2026-09-30-001 add durable snapshot sync',
  '2026-09-30-002 add snapshot archive staging',
  '2026-09-30-003 add snapshot archive requests',
  '2026-10-01-001 add snapshot archive source owners',
  '2026-10-01-002 add snapshot archive source guards',
  SNAPSHOT_JOURNAL_SOURCE_MIGRATION
]

test('Postgres snapshot auxiliary migrations never execute SQLite or MySQL SQL', async () => {
  const k = knex({ client: 'pg', connection: { database: 'unused' }, pool: { min: 0, max: 1 } })
  const source = new KnexMigrations('test', 'postgres compatibility', '1'.repeat(64), 10000)
  const names = (await source.getMigrations()).filter(name => name.includes('snapshot'))
  expect(names).toHaveLength(11)
  expect(names).toEqual(expect.arrayContaining(entries))
  const query = jest.spyOn(k.client, 'query').mockRejectedValue(new Error('Snapshot SQL reached Postgres'))
  const acquire = jest.spyOn(k.client, 'acquireConnection').mockRejectedValue(new Error('Snapshot opened Postgres'))
  try {
    for (const name of names) {
      const migration = await source.getMigration(name)
      await migration.up(k)
      await migration.down?.(k)
    }
    expect(query).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
    expect(storage.supportsReadSnapshot()).toBe(false)
    expect(storage.supportsRetainedReadSnapshot()).toBe(false)
    expect(storage.supportsWalletReadSnapshot()).toBe(false)
    expect(storage.getSnapshotSync()).toBeUndefined()
    expect(await storage.supportsSnapshotArchiveSource()).toBe(false)
    await storage.destroy()
  } finally {
    query.mockRestore()
    acquire.mockRestore()
    await k.destroy()
  }
})

test.each(['better-sqlite3', 'mysql2'])(
  '%s keeps its existing snapshot migration lifecycle and failures',
  async client => {
    const k = knex({ client, connection: {}, pool: { min: 0, max: 1 } })
    try {
      const error = new Error('Existing migration failure')
      const migrate = jest.fn<Promise<void>, [Knex]>().mockRejectedValue(error)
      await expect(forSnapshotSqlDialect(migrate)(k)).rejects.toBe(error)
      expect(migrate).toHaveBeenCalledWith(k)
    } finally {
      await k.destroy()
    }
  }
)

test('explicit PostgreSQL data deletion preserves both journal rollback no-ops without snapshot SQL or acquisition', async () => {
  const k = knex({ client: 'pg', connection: { database: 'unused' }, pool: { min: 0, max: 1 } })
  const names = [SNAPSHOT_JOURNAL_SOURCE_MIGRATION, SNAPSHOT_JOURNAL_DESTINATION_MIGRATION]
  const completed: string[] = []
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  const query = jest.spyOn(k.client, 'query').mockRejectedValue(new Error('Snapshot deletion SQL reached Postgres'))
  const acquire = jest
    .spyOn(k.client, 'acquireConnection')
    .mockRejectedValue(new Error('Snapshot deletion opened Postgres'))
  const migrator = k.migrate
  const migratorAccess = jest.spyOn(k, 'migrate', 'get').mockReturnValue(migrator)
  const version = jest
    .spyOn(migrator, 'currentVersion')
    .mockImplementation(async () => names[completed.length] ?? 'none')
  const down = jest.spyOn(migrator, 'down').mockImplementation(async config => {
    const name = names[completed.length]
    expect(name).toBeDefined()
    const migration = await config!.migrationSource!.getMigration(name)
    await migration.down(k)
    completed.push(name)
    return [1, [name]]
  })
  try {
    await storage.dropAllData()
    expect(completed).toEqual(names)
    expect(down).toHaveBeenCalledTimes(2)
    expect(query).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(storage.getSnapshotSync()).toBeUndefined()
  } finally {
    version.mockRestore()
    down.mockRestore()
    migratorAccess.mockRestore()
    query.mockRestore()
    acquire.mockRestore()
    await storage.destroy()
    await k.destroy()
  }
})
