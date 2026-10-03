import { StorageKnex } from '../StorageKnex'
import { KnexMigrations } from '../schema/KnexMigrations'

function absentGeneration() {
  return jest.fn(async (scope: (trx: object) => Promise<void>) => {
    await scope({ schema: { hasTable: jest.fn().mockResolvedValue(false) } })
  })
}

function storageWithKnex(knex: object): StorageKnex {
  return { knex, chain: 'test' } as unknown as StorageKnex
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
    const knex = {
      client: { config: { client: 'better-sqlite3' } },
      transaction: absentGeneration(),
      raw: jest.fn().mockResolvedValue(undefined),
      migrate: {
        currentVersion: jest.fn().mockResolvedValueOnce('202609170001').mockResolvedValueOnce('none'),
        down: jest.fn().mockResolvedValue([1, ['202609170001']])
      }
    }

    await StorageKnex.prototype.dropAllData.call(storageWithKnex(knex))

    expect(knex.migrate.down).toHaveBeenCalledTimes(1)
    expect(knex.raw.mock.calls.map(call => call[0])).toEqual([
      'PRAGMA foreign_keys = OFF;',
      'PRAGMA foreign_keys = ON;'
    ])
  })

  test.each([
    ['throws', () => Promise.reject(new Error('rollback failed'))],
    ['returns no result', () => Promise.resolve(undefined)]
  ])('propagates when rollback %s and always restores SQLite foreign keys', async (_name, down) => {
    const knex = {
      client: { config: { client: 'better-sqlite3' } },
      transaction: absentGeneration(),
      raw: jest.fn().mockResolvedValue(undefined),
      migrate: {
        currentVersion: jest.fn().mockResolvedValue('202609170001'),
        down: jest.fn(down)
      }
    }

    await expect(StorageKnex.prototype.dropAllData.call(storageWithKnex(knex))).rejects.toThrow(
      _name === 'throws' ? 'rollback failed' : 'database migration rollback returned no result'
    )
    expect(knex.raw).toHaveBeenLastCalledWith('PRAGMA foreign_keys = ON;')
  })

  test('migrate restores SQLite foreign keys when migration fails', async () => {
    const knex = {
      client: { config: { client: 'better-sqlite3' } },
      transaction: absentGeneration(),
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
  const database = {
    client: { config: { client: 'better-sqlite3' } },
    transaction: absentGeneration(),
    raw: jest.fn().mockResolvedValue(undefined),
    migrate: {
      currentVersion: jest.fn().mockResolvedValue('unfinished'),
      down: jest.fn().mockResolvedValue([1, ['fixture']])
    }
  }
  await expect(StorageKnex.prototype.dropAllData.call(storageWithKnex(database))).rejects.toThrow(
    'database migration rollback did not reach the empty schema'
  )
  expect(database.migrate.down).toHaveBeenCalledTimes(
    Object.keys(new KnexMigrations('test', '', '', 1024).migrations).length
  )
  expect(database.raw).toHaveBeenLastCalledWith('PRAGMA foreign_keys = ON;')
})

test('MySQL full deletion does not issue SQLite generation operations', async () => {
  const database = {
    client: { config: { client: 'mysql2' } },
    transaction: jest.fn(),
    raw: jest.fn(),
    migrate: { currentVersion: jest.fn().mockResolvedValue('none'), down: jest.fn() }
  }
  await StorageKnex.prototype.dropAllData.call(storageWithKnex(database))
  expect(database.transaction).not.toHaveBeenCalled()
  expect(database.raw).not.toHaveBeenCalled()
  expect(database.migrate.down).not.toHaveBeenCalled()
})
