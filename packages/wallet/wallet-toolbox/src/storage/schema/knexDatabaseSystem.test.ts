import createKnex from 'knex'
import { knexDatabaseSystem } from './knexDatabaseSystem'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'

const SqliteClient: typeof createKnex.Client = require('knex/lib/dialects/sqlite3/index.js')

describe('Knex database system contract', () => {
  it.each([
    ['better-sqlite3', 'sqlite'],
    ['sqlite3', 'sqlite'],
    ['mysql2', 'mysql'],
    ['pg', 'postgresql'],
    ['postgres', 'postgresql'],
    ['unknown', 'unknown']
  ] as const)('retains %s string client classification', (client, expected) => {
    expect(knexDatabaseSystem({ config: { client } })).toBe(expected)
  })
  it('retains the SQLite class through an independent reader clone', async () => {
    class OwnedSqlite extends SqliteClient {
      _driver() {
        return {}
      }
    }
    const primary = createKnex({ client: OwnedSqlite, useNullAsDefault: true })
    const reader = createKnex(primary.client.config)
    try {
      expect(primary.client.config.client).toBe(OwnedSqlite)
      expect(reader.client.config.client).toBe(OwnedSqlite)
      expect(knexDatabaseSystem(primary.client)).toBe('sqlite')
      expect(knexDatabaseSystem(reader.client)).toBe('sqlite')
      const storage = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions('test'),
        knex: primary,
        snapshotSync: false
      })
      expect(storage.supportsReadSnapshot()).toBe(true)
      expect(storage.supportsWalletReadSnapshot()).toBe(true)
    } finally {
      await reader.destroy()
      await primary.destroy()
    }
  })
})
