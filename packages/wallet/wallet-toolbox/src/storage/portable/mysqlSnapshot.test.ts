import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'

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

const exactReads = [
  ['proof id', (storage: StorageKnex, trx: TrxToken) => storage.findProvenTxs({ partial: { provenTxId: 1 }, trx })],
  [
    'proof txid',
    (storage: StorageKnex, trx: TrxToken) => storage.findProvenTxs({ partial: { txid: '11'.repeat(32) }, trx })
  ],
  [
    'checkpoint id',
    (storage: StorageKnex, trx: TrxToken) => storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 }, trx })
  ],
  [
    'checkpoint identity',
    (storage: StorageKnex, trx: TrxToken) =>
      storage.findSyncStates({ partial: { userId: 1, storageIdentityKey: 'source' }, trx })
  ]
] as const

test.each(exactReads)(
  'MySQL snapshot %s uses a consistent read while writable transactions still lock',
  async (_name, read) => {
    const fixture = mysqlFixture()
    try {
      await fixture.storage.readSnapshot(async trx => {
        await read(fixture.storage, trx)
      })
      expect(fixture.events.filter(sql => sql.startsWith('SELECT'))).toHaveLength(1)
      expect(fixture.events.some(sql => sql.endsWith('FOR UPDATE'))).toBe(false)
      fixture.events.length = 0
      await fixture.db.transaction(async trx => {
        await read(fixture.storage, trx)
      })
      expect(fixture.events.filter(sql => sql.endsWith('FOR UPDATE'))).toHaveLength(1)
    } finally {
      await fixture.db.destroy()
      jest.restoreAllMocks()
    }
  }
)

test('snapshot classification follows its token across providers without classifying another transaction', async () => {
  const fixture = mysqlFixture()
  const other = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: fixture.db })
  other._settings = fixture.storage._settings
  try {
    await fixture.storage.readSnapshot(async trx => {
      await other.findProvenTxs({ partial: { provenTxId: 1 }, trx })
      await fixture.db.transaction(write => other.findProvenTxs({ partial: { provenTxId: 1 }, trx: write }))
      await other.findProvenTxs({ partial: { provenTxId: 1 }, trx })
    })
    const selects = fixture.events.filter(sql => sql.startsWith('SELECT'))
    expect(selects).toHaveLength(3)
    expect(selects.map(sql => sql.endsWith('FOR UPDATE'))).toEqual([false, true, false])
  } finally {
    await fixture.db.destroy()
    jest.restoreAllMocks()
  }
})

test.each([false, true])(
  'retained MySQL views keep exact reads consistent through callback settlement (failure=%s)',
  async fail => {
    const fixture = mysqlFixture()
    const failure = new Error('retained read failed')
    jest.spyOn(fixture.storage, 'readSettings').mockResolvedValue(fixture.storage.getSettings())
    try {
      const view = await fixture.storage.openReadSnapshot({ lifetimeMs: 30000 })
      const result = view.read(async trx => {
        await fixture.storage.findProvenTxs({ partial: { provenTxId: 1 }, trx })
        await fixture.storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 }, trx })
        if (fail) throw failure
        return 19
      })
      if (fail) {
        await expect(result).rejects.toBe(failure)
        await expect(view.close()).rejects.toBe(failure)
      } else {
        await expect(result).resolves.toBe(19)
        await view.close()
      }
      expect(fixture.events.filter(sql => sql.startsWith('SELECT'))).toHaveLength(2)
      expect(fixture.events.some(sql => sql.endsWith('FOR UPDATE'))).toBe(false)
      fixture.events.length = 0
      await fixture.db.transaction(trx => fixture.storage.findProvenTxs({ partial: { provenTxId: 1 }, trx }))
      expect(fixture.events.filter(sql => sql.endsWith('FOR UPDATE'))).toHaveLength(1)
    } finally {
      await fixture.db.destroy()
      jest.restoreAllMocks()
    }
  }
)

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
