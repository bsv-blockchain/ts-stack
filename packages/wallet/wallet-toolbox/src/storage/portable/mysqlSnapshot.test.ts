import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'

function mysqlFixture(failAt?: string) {
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
      callback(null, [], [])
    }
  }
  const acquire = jest.spyOn(db.client, 'acquireConnection').mockResolvedValue(connection)
  jest.spyOn(db.client, 'releaseConnection').mockImplementation(() => {
    events.push('RELEASE')
    return Promise.resolve()
  })
  jest.spyOn(storage, 'makeAvailable').mockResolvedValue({
    created_at: new Date(0),
    updated_at: new Date(0),
    storageIdentityKey: 'synthetic-storage',
    storageName: 'synthetic MySQL',
    chain: 'test',
    dbtype: 'MySQL',
    maxOutputScript: 1024
  })
  return { storage, db, events, failure, acquire }
}

test('MySQL snapshot uses one reserved connection and valid next-transaction characteristics', async () => {
  const fixture = mysqlFixture()
  try {
    const result = await fixture.storage.readSnapshot(async trx => {
      await (trx as Knex.Transaction).raw('SELECT 1')
      return 17
    })
    expect(result).toBe(17)
    expect(fixture.acquire).toHaveBeenCalledTimes(1)
    expect(fixture.events).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      'BEGIN',
      'SELECT 1',
      'COMMIT',
      'RELEASE'
    ])
  } finally {
    await fixture.db.destroy()
    jest.restoreAllMocks()
  }
})

test.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'BEGIN', 'SELECT 1', 'COMMIT'])(
  'MySQL snapshot discards a failed connection before returning it to the pool (%s)',
  async failAt => {
    const fixture = mysqlFixture(failAt)
    try {
      const capture = jest.fn((trx: object) => (trx as Knex.Transaction).raw('SELECT 1').then(() => undefined))
      await expect(fixture.storage.readSnapshot(capture)).rejects.toBe(fixture.failure)
      await new Promise(resolve => setImmediate(resolve))
      expect(fixture.acquire).toHaveBeenCalledTimes(1)
      expect(fixture.events.slice(-2)).toEqual(['CLOSE', 'RELEASE'])
      if (failAt === 'SELECT 1') expect(fixture.events).toContain('ROLLBACK')
      if (failAt === 'BEGIN' || failAt.startsWith('SET TRANSACTION')) expect(capture).not.toHaveBeenCalled()
    } finally {
      await fixture.db.destroy()
      jest.restoreAllMocks()
    }
  }
)
