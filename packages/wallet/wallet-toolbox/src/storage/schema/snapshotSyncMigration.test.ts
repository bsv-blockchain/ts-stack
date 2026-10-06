import { knex, type Knex } from 'knex'
import { addSnapshotSyncTables, removeSnapshotSyncTables } from './snapshotSyncMigration'

const names = ['snapshot_sync_sessions', 'snapshot_sync_ids', 'snapshot_sync_primary_epochs']

test('SQLite migration preserves user data, counts primary transitions and removes only its auxiliary objects', async () => {
  const k = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await k.raw('PRAGMA foreign_keys = ON')
    await k.schema.createTable('users', table => {
      table.increments('userId')
      table.string('activeStorage')
    })
    await k('users').insert({ userId: 1, activeStorage: 'source' })
    await addSnapshotSyncTables(k)
    await addSnapshotSyncTables(k)
    await k('users').where({ userId: 1 }).update({ userId: 1 })
    await k('users').where({ userId: 1 }).update({ activeStorage: 'source' })
    expect(await k('snapshot_sync_primary_epochs')).toHaveLength(0)
    await k('users').where({ userId: 1 }).update({ activeStorage: 'destination' })
    await k('users').where({ userId: 1 }).update({ activeStorage: 'source' })
    expect(await k('snapshot_sync_primary_epochs')).toEqual([{ userId: 1, epoch: 2 }])
    await expect(k('snapshot_sync_primary_epochs').insert({ userId: 999, epoch: 1 })).rejects.toThrow('FOREIGN KEY')
    const columns = await k('snapshot_sync_ids').columnInfo()
    expect(Object.keys(columns)).toEqual(['userId', 'sourceStorageIdentityKey', 'entity', 'incomingId', 'localId'])
    await removeSnapshotSyncTables(k)
    await removeSnapshotSyncTables(k)
    expect(await k('users')).toEqual([{ userId: 1, activeStorage: 'source' }])
    for (const name of names) expect(await k.schema.hasTable(name)).toBe(false)
  } finally {
    await k.destroy()
  }
})

test('MySQL migration repairs separately committed DDL without duplicating tables, keys or its trigger', async () => {
  // Compile every builder against real Knex MySQL SQL generation. The native
  // MySQL fixture separately qualifies execution and trigger semantics.
  const compiler = knex({ client: 'mysql2' })
  const tables = new Set<string>()
  const foreignKeys = new Set<string>()
  const ddl: string[] = []
  let trigger = false
  let interrupted = false
  const database = {
    client: { config: { client: 'mysql2' } },
    schema: {
      hasTable: async (name: string) => tables.has(name),
      createTable: async (name: string, build: (table: Knex.CreateTableBuilder) => void) => {
        ddl.push(
          ...compiler.schema
            .createTable(name, build)
            .toSQL()
            .map(query => query.sql)
        )
        tables.add(name)
      },
      table: async (name: string, build: (table: Knex.AlterTableBuilder) => void) => {
        if (!interrupted) {
          interrupted = true
          throw new Error('interrupted after table DDL')
        }
        ddl.push(
          ...compiler.schema
            .table(name, build)
            .toSQL()
            .map(query => query.sql)
        )
        foreignKeys.add(name + '_user')
      }
    },
    raw: async (sql: string, bindings?: string[]) => {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        expect(bindings).toEqual([expect.stringMatching(/^snapshot_sync_/), expect.stringMatching(/_user$/)])
        return [foreignKeys.has(bindings![1]) ? [{ name: bindings![1] }] : []]
      }
      if (sql.includes('information_schema.TRIGGERS')) {
        expect(bindings).toEqual(['snapshot_sync_primary_change'])
        return [trigger ? [{ name: 'snapshot_sync_primary_change' }] : []]
      }
      if (sql.startsWith('CREATE TRIGGER snapshot_sync_primary_change')) {
        ddl.push(sql)
        trigger = true
        return []
      }
      throw new Error('Unexpected migration query')
    }
  } as unknown as Knex
  try {
    await expect(addSnapshotSyncTables(database)).rejects.toThrow('interrupted after table DDL')
    expect([...tables]).toEqual(names)
    expect(foreignKeys.size).toBe(0)
    await addSnapshotSyncTables(database)
    const completed = [...ddl]
    await addSnapshotSyncTables(database)
    expect(ddl).toEqual(completed)
    expect(foreignKeys.size).toBe(3)
    expect(trigger).toBe(true)
    for (const sql of ddl.filter(sql => sql.startsWith('create table')))
      expect(sql).toContain('`userId` int unsigned not null')
    const mappings = ddl.find(sql => sql.startsWith('create table `snapshot_sync_ids`'))!
    expect(mappings).toContain('`incomingId` bigint unsigned not null')
    expect(mappings).toContain('`localId` bigint unsigned not null')
    expect(mappings).toContain('primary key (`userId`, `sourceStorageIdentityKey`, `entity`, `incomingId`)')
    expect(ddl.filter(sql => sql.startsWith('alter table'))).toHaveLength(3)
    for (const sql of ddl.filter(sql => sql.startsWith('alter table')))
      expect(sql).toContain('foreign key (`userId`) references `users` (`userId`)')
    expect(ddl.at(-1)).toContain('NOT (OLD.activeStorage <=> NEW.activeStorage)')
    expect(ddl.at(-1)).toContain('ON DUPLICATE KEY UPDATE epoch = epoch + 1')
  } finally {
    await compiler.destroy()
  }
})
