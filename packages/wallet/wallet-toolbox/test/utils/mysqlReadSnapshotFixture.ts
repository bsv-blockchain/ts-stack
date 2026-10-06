import { knex } from 'knex'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { StorageProvider } from '../../src/storage/StorageProvider'

export function mysqlReadSnapshotFixture(failAt?: string, selectedRows: readonly unknown[] = []) {
  const db = knex({ client: 'mysql2' })
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: db })
  const events: string[] = []
  const failure = new Error('synthetic database failure')
  const connection = {
    destroy() {
      events.push('CLOSE')
    },
    query(
      query: { sql: string },
      _bindings: unknown,
      callback: (error: Error | null, rows?: unknown[], fields?: unknown[]) => void
    ) {
      const sql = query.sql.toUpperCase().replace(/;$/, '')
      events.push(sql)
      if (sql === failAt) return callback(failure)
      // Exercise the actual installed Knex transaction builder against MySQL's
      // comma-separated characteristic grammar. The combined options emitted
      // invalid syntax before this regression was found with real MySQL 8.4.
      if (sql.includes('REPEATABLE READ READ ONLY')) return callback(new Error('invalid MySQL syntax'))
      callback(null, sql.startsWith('SELECT') ? structuredClone([...selectedRows]) : [], [])
    }
  }
  const acquire = jest.spyOn(db.client, 'acquireConnection').mockResolvedValue(connection)
  jest.spyOn(db.client, 'releaseConnection').mockImplementation(() => {
    events.push('RELEASE')
    return Promise.resolve()
  })
  storage._settings = {
    created_at: new Date(0),
    updated_at: new Date(0),
    storageIdentityKey: 'synthetic-storage',
    storageName: 'synthetic MySQL',
    chain: 'test',
    dbtype: 'MySQL',
    maxOutputScript: 1024
  }
  jest.spyOn(storage, 'makeAvailable').mockResolvedValue(storage._settings)
  return { storage, db, events, failure, acquire }
}
