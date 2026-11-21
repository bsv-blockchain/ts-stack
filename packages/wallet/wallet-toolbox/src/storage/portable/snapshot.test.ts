import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageIdb } from '../StorageIdb'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { exportBRC38, exportBRC38Json, exportBRC39 } from './index'
import { runInSeries } from '../../utility/runInSeries'

const identity = '02' + '11'.repeat(32)
const foreignIdentity = '03' + '22'.repeat(32)
const stores: StorageProvider[] = []
const directories: string[] = []

async function sqlitePair(): Promise<[StorageKnex, StorageKnex]> {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-snapshot-'))
  directories.push(directory)
  const open = () => {
    const storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
    stores.push(storage)
    return storage
  }
  const source = open()
  await source.knex.raw('PRAGMA journal_mode = WAL')
  await source.migrate('original source', 'source-storage')
  await source.makeAvailable()
  const peer = open()
  await peer.makeAvailable()
  return [source, peer]
}

async function idbPair(): Promise<[StorageIdb, StorageIdb]> {
  const name = `wallet-snapshot-${randomUUID()}`
  const open = async () => {
    const storage = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
    storage.dbName = name
    stores.push(storage)
    await storage.migrate('original source', 'source-storage')
    await storage.makeAvailable()
    return storage
  }
  return [await open(), await open()]
}

afterEach(async () => {
  jest.restoreAllMocks()
  const closed = stores.splice(0)
  await runInSeries(closed, store => store.destroy())
  await runInSeries(closed.filter(store => store instanceof StorageIdb), store => store.dropAllData())
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})

test('SQLite export holds one source view while a separate WAL writer commits between table reads', async () => {
  const [source, peer] = await sqlitePair()
  const { user } = await source.findOrInsertUser(identity)
  await source.findOrInsertTxLabel(user.userId, 'before capture')
  const find = source.findTransactions.bind(source)
  jest.spyOn(source, 'findTransactions').mockImplementationOnce(async args => {
    const rows = await find(args)
    await peer.transaction(async trx => {
      await peer.updateUser(user.userId, { activeStorage: 'later-primary', updated_at: new Date() }, trx)
      await peer.insertTxLabel(
        {
          txLabelId: 0,
          userId: user.userId,
          label: 'after capture',
          isDeleted: false,
          created_at: new Date(),
          updated_at: new Date()
        },
        trx
      )
    })
    return rows
  })
  const captured = await exportBRC38(source, identity)
  expect(captured.user.activeStorage).toBe(user.activeStorage)
  expect(captured.tables.txLabels.map(row => row.label)).toEqual(['before capture'])
  expect((await exportBRC38(source, identity)).tables.txLabels.map(row => row.label)).toEqual([
    'before capture',
    'after capture'
  ])
  expect((await peer.findUserByIdentityKey(identity))?.activeStorage).toBe('later-primary')
})

test('IndexedDB capture excludes an independently queued write and releases it after capture', async () => {
  const [source, peer] = await idbPair()
  const { user } = await source.findOrInsertUser(identity)
  await source.findOrInsertTxLabel(user.userId, 'before capture')
  const find = source.findTransactions.bind(source)
  let pending: Promise<unknown> | undefined
  jest.spyOn(source, 'findTransactions').mockImplementationOnce(async args => {
    const rows = await find(args)
    pending = peer.findOrInsertTxLabel(user.userId, 'after capture')
    return rows
  })
  const captured = await exportBRC38(source, identity)
  expect(captured.tables.txLabels.map(row => row.label)).toEqual(['before capture'])
  expect(pending).toBeDefined()
  await pending
  expect((await exportBRC38(source, identity)).tables.txLabels.map(row => row.label)).toEqual([
    'before capture',
    'after capture'
  ])
})

test.each([sqlitePair, idbPair])(
  'source metadata comes from the database view and wallet profiles remain separate (%#)',
  async pair => {
    const [source] = await pair()
    const { user } = await source.findOrInsertUser(identity)
    const { user: foreign } = await source.findOrInsertUser(foreignIdentity)
    await source.findOrInsertTxLabel(user.userId, 'own label')
    await source.findOrInsertTxLabel(foreign.userId, 'foreign label')
    source.getSettings().storageName = 'stale cached name'
    const captured = await exportBRC38(source, identity)
    expect(captured.sourceStorage.storageName).toBe('original source')
    expect(captured.user.identityKey).toBe(identity)
    expect(captured.tables.txLabels.map(row => row.label)).toEqual(['own label'])
    expect(source.getSettings().storageName).toBe('stale cached name')
  }
)

test.each([sqlitePair, idbPair])('capture failure releases the view without writing wallet data (%#)', async pair => {
  const [source] = await pair()
  const { user } = await source.findOrInsertUser(identity)
  const failure = new Error('capture stopped')
  const read = jest.spyOn(source, 'findOutputs').mockRejectedValueOnce(failure)
  await expect(exportBRC38(source, identity)).rejects.toBe(failure)
  read.mockRestore()
  await source.findOrInsertTxLabel(user.userId, 'write after failure')
  expect((await exportBRC38(source, identity)).tables.txLabels.map(row => row.label)).toEqual(['write after failure'])
})

test('a provider without a coherent read implementation refuses a complete source export', async () => {
  const [source] = await sqlitePair()
  await source.findOrInsertUser(identity)
  jest.spyOn(source, 'readSnapshot').mockImplementation(StorageProvider.prototype.readSnapshot)
  jest.spyOn(source, 'supportsReadSnapshot').mockReturnValue(false)
  const reads = jest.spyOn(source, 'findTransactions')
  await expect(exportBRC38(source, identity, { requireSnapshot: true })).rejects.toThrow(
    'Coherent wallet source snapshots are not supported'
  )
  await expect(exportBRC38Json(source, identity, { requireSnapshot: true })).rejects.toThrow(
    'Coherent wallet source snapshots are not supported'
  )
  await expect(exportBRC39(source, identity, 'synthetic password', { requireSnapshot: true })).rejects.toThrow(
    'Coherent wallet source snapshots are not supported'
  )
  expect(reads).not.toHaveBeenCalled()
  const legacy = await exportBRC38(source, identity)
  expect(legacy.user.identityKey).toBe(identity)
  expect(reads).toHaveBeenCalledTimes(1)
})
