import { knex as createKnex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { KnexMigrations } from '../schema/KnexMigrations'

const sqliteFixtures: Knex[] = []
const sqliteQueries = new WeakMap<Knex, string[]>()
function emptySqlite(migrations: { currentVersion: ReturnType<typeof jest.fn>; down: ReturnType<typeof jest.fn> }) {
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  sqliteFixtures.push(db)
  // Knex exposes a fresh Migrator per getter access; install this deliberate
  // failure fixture once while actual auxiliary-schema SQL remains real.
  Object.defineProperty(db, 'migrate', { value: migrations })
  const queries: string[] = []
  db.on('query', (query: { sql: string }) => queries.push(query.sql))
  sqliteQueries.set(db, queries)
  return db
}
afterEach(async () => {
  const results = await Promise.allSettled(sqliteFixtures.splice(0).map(async db => await db.destroy()))
  const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, 'Migration fixture databases did not drain')
})

function storageWithKnex(knex: object): StorageKnex {
  return {
    knex,
    chain: 'test',
    stopRetainedReadSnapshots: jest.fn(async () => undefined),
    stopPreparedBeefTasks: jest.fn(async () => undefined)
  } as unknown as StorageKnex
}

describe('StorageKnex migration failure boundaries', () => {
  test('retains MySQL transaction settings without SQLite pragmas', async () => {
    const knex = {
      client: { config: { client: 'mysql2' } },
      raw: jest.fn(),
      migrate: {
        latest: jest.fn().mockResolvedValue([1, ['fixture']]),
        currentVersion: jest.fn().mockResolvedValue('fixture')
      }
    }
    await expect(StorageKnex.prototype.migrate.call(storageWithKnex(knex), 'wallet', '1'.repeat(64))).resolves.toBe(
      'fixture'
    )
    expect(knex.migrate.latest).toHaveBeenCalledWith(expect.objectContaining({ disableTransactions: false }))
    expect(knex.raw).not.toHaveBeenCalled()
  })

  test('dropAllData stops only at the explicit empty-schema state', async () => {
    const knex = emptySqlite({
      currentVersion: jest.fn().mockResolvedValueOnce('202609170001').mockResolvedValueOnce('none'),
      down: jest.fn().mockResolvedValue([1, ['202609170001']])
    })

    await StorageKnex.prototype.dropAllData.call(storageWithKnex(knex))

    expect(knex.migrate.down).toHaveBeenCalledTimes(1)
    expect(sqliteQueries.get(knex)!.filter(sql => sql.startsWith('PRAGMA foreign_keys'))).toEqual([
      'PRAGMA foreign_keys = OFF;',
      'PRAGMA foreign_keys = ON;'
    ])
  })

  test.each([
    ['throws', () => Promise.reject(new Error('rollback failed'))],
    ['returns no result', () => Promise.resolve(undefined)]
  ])('propagates when rollback %s and always restores SQLite foreign keys', async (_name, down) => {
    const knex = emptySqlite({
      currentVersion: jest.fn().mockResolvedValue('202609170001'),
      down: jest.fn(down)
    })

    await expect(StorageKnex.prototype.dropAllData.call(storageWithKnex(knex))).rejects.toThrow(
      _name === 'throws' ? 'rollback failed' : 'database migration rollback returned no result'
    )
    expect(sqliteQueries.get(knex)!.at(-1)).toBe('PRAGMA foreign_keys = ON;')
  })

  test('migrate restores SQLite foreign keys when migration fails', async () => {
    const knex = {
      client: { config: { client: 'better-sqlite3' } },
      raw: jest.fn().mockResolvedValue(undefined),
      migrate: {
        latest: jest.fn().mockRejectedValue(new Error('migration failed')),
        currentVersion: jest.fn()
      }
    }

    await expect(StorageKnex.prototype.migrate.call(storageWithKnex(knex), 'wallet', '1'.repeat(64))).rejects.toThrow(
      'migration failed'
    )
    expect(knex.raw).toHaveBeenLastCalledWith('PRAGMA foreign_keys = ON;')
  })
})

test('dropAllData bounds a migrator that never reaches the empty schema', async () => {
  const database = emptySqlite({
    currentVersion: jest.fn().mockResolvedValue('unfinished'),
    down: jest.fn().mockResolvedValue([1, ['fixture']])
  })
  await expect(StorageKnex.prototype.dropAllData.call(storageWithKnex(database))).rejects.toThrow(
    'database migration rollback did not reach the empty schema'
  )
  expect(database.migrate.down).toHaveBeenCalledTimes(
    Object.keys(new KnexMigrations('test', '', '', 1024).migrations).length
  )
  expect(sqliteQueries.get(database)!.at(-1)).toBe('PRAGMA foreign_keys = ON;')
})

test('MySQL full deletion does not issue SQLite generation operations', async () => {
  const catalogs: string[] = []
  const database = Object.assign(
    (table: string) => {
      expect(table).toMatch(/^information_schema\./)
      catalogs.push(table)
      const query = {
        whereRaw: () => query,
        whereIn: () => query,
        whereNotIn: () => query,
        where: () => query,
        select: () => query,
        limit: async () => []
      }
      return query
    },
    {
      client: { config: { client: 'mysql2' } },
      transaction: jest.fn(),
      raw: jest.fn(async (sql: string) => {
        expect(sql).not.toMatch(/sqlite|PRAGMA/i)
        if (sql.startsWith('SELECT @@sql_mode'))
          return [
            [
              {
                sqlMode: '',
                charset: 'utf8mb4',
                collation: 'utf8mb4_bin',
                definer: 'fixture@localhost',
                databaseCollation: 'utf8mb4_bin'
              }
            ],
            []
          ]
        if (sql.startsWith('substr(')) return undefined
        expect(sql).toContain('information_schema.')
        return [[], []]
      }),
      migrate: { currentVersion: jest.fn().mockResolvedValue('none'), down: jest.fn() }
    }
  )
  await StorageKnex.prototype.dropAllData.call(storageWithKnex(database))
  expect(database.transaction).not.toHaveBeenCalled()
  expect(database.raw.mock.calls.some(([sql]) => sql.includes('information_schema.TABLES'))).toBe(true)
  expect(database.raw.mock.calls.some(([sql]) => sql.includes('information_schema.TRIGGERS'))).toBe(true)
  expect(catalogs.length).toBeGreaterThan(0)
  expect(catalogs.every(table => table.startsWith('information_schema.'))).toBe(true)
  expect(database.migrate.down).not.toHaveBeenCalled()
})
