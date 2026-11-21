import { knex, type Knex } from 'knex'
import { mysqlReadSnapshotFixture as mysqlFixture } from '../../../test/utils/mysqlReadSnapshotFixture'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'

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
  ['proof id', (storage: StorageKnex, trx?: TrxToken) => storage.findProvenTxs({ partial: { provenTxId: 1 }, trx })],
  [
    'proof txid',
    (storage: StorageKnex, trx?: TrxToken) => storage.findProvenTxs({ partial: { txid: '11'.repeat(32) }, trx })
  ],
  [
    'checkpoint id',
    (storage: StorageKnex, trx?: TrxToken) => storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 }, trx })
  ],
  [
    'checkpoint identity',
    (storage: StorageKnex, trx?: TrxToken) =>
      storage.findSyncStates({ partial: { userId: 1, storageIdentityKey: 'source' }, trx })
  ]
] as const

test('ordinary Postgres checkpoint metadata retains its lock while proof reads preserve their existing policy', async () => {
  const fixture = mysqlFixture()
  fixture.storage.getSettings().dbtype = 'Postgres'
  try {
    await fixture.db.transaction(async trx => {
      await fixture.storage.findProvenTxs({ partial: { provenTxId: 1 }, trx })
      await fixture.storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 }, trx })
    })
    const queries = fixture.events.filter(sql => sql.startsWith('SELECT'))
    expect(queries).toHaveLength(2)
    expect(queries.map(sql => sql.endsWith('FOR UPDATE'))).toEqual([false, true])
  } finally {
    await fixture.db.destroy()
    jest.restoreAllMocks()
  }
})

test('unsupported Postgres snapshots reject before opening a database transaction', async () => {
  const db = knex({ client: 'pg' })
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: db })
  const fixture = mysqlFixture()
  storage._settings = { ...fixture.storage.getSettings(), dbtype: 'Postgres' }
  const transaction = jest.spyOn(db.client, 'transaction')
  const read = jest.fn(async () => 7)
  try {
    await expect(storage.readSnapshot(read)).rejects.toThrow(
      'Coherent wallet source snapshots require SQLite or MySQL isolation'
    )
    expect(transaction).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  } finally {
    await db.destroy()
    await fixture.db.destroy()
    jest.restoreAllMocks()
  }
})

test('a completed transaction is refused before the snapshot callback and its reserved connection is discarded', async () => {
  const fixture = mysqlFixture()
  let completed: Knex.Transaction | undefined
  const original = Object.getOwnPropertyDescriptor(fixture.db, 'transaction')
  if (original === undefined) throw new Error('Expected the installed Knex transaction delegate')
  try {
    await fixture.db.transaction(async trx => {
      completed = trx
    })
    if (completed === undefined) throw new Error('Expected a completed fixture transaction')
    expect(completed.isCompleted()).toBe(true)
    const expired = completed
    fixture.events.length = 0
    // The installed Knex delegate is configurable but not writable. Preserve
    // its complete descriptor while injecting a late completed callback token.
    Object.defineProperty(fixture.db, 'transaction', {
      ...original,
      value: async (callback: (trx: Knex.Transaction) => Promise<unknown>) => await callback(expired)
    })
    const read = jest.fn(async () => 7)
    await expect(fixture.storage.readSnapshot(read)).rejects.toThrow('MySQL snapshot transaction did not begin')
    expect(read).not.toHaveBeenCalled()
    expect(fixture.events).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'CLOSE', 'RELEASE'])
  } finally {
    Object.defineProperty(fixture.db, 'transaction', original)
    await fixture.db.destroy()
    jest.restoreAllMocks()
  }
})

test.each(exactReads)('MySQL %s outside a transaction preserves its ordinary unlocked read', async (_name, read) => {
  const fixture = mysqlFixture()
  try {
    await read(fixture.storage)
    const queries = fixture.events.filter(sql => sql.startsWith('SELECT'))
    expect(queries).toHaveLength(1)
    expect(queries[0].endsWith('FOR UPDATE')).toBe(false)
    expect(fixture.events).not.toContain('BEGIN')
  } finally {
    await fixture.db.destroy()
    jest.restoreAllMocks()
  }
})

test.each([0, 1])(
  'checkpoint rows retain date and boolean normalization in both transaction modes (init=%s)',
  async init => {
    const when = '2026-10-03T00:00:00.000Z'
    const fixture = mysqlFixture(undefined, [
      { syncStateId: 1, userId: 1, created_at: when, updated_at: when, when, init }
    ])
    try {
      const assertRows = (rows: Awaited<ReturnType<StorageKnex['findSyncStates']>>) => {
        expect(rows).toHaveLength(1)
        expect(rows[0]).toEqual({
          syncStateId: 1,
          userId: 1,
          created_at: new Date(when),
          updated_at: new Date(when),
          when: new Date(when),
          init: init === 1
        })
      }
      assertRows(await fixture.storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 } }))
      await fixture.storage.readSnapshot(async trx => {
        assertRows(await fixture.storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 }, trx }))
      })
      await fixture.db.transaction(async trx => {
        assertRows(await fixture.storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 }, trx }))
      })
      const queries = fixture.events.filter(sql => sql.startsWith('SELECT'))
      expect(queries).toHaveLength(3)
      expect(queries.map(sql => sql.endsWith('FOR UPDATE'))).toEqual([false, false, true])
    } finally {
      await fixture.db.destroy()
      jest.restoreAllMocks()
    }
  }
)

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
