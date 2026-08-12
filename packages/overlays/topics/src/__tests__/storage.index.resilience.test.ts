import { jest } from '@jest/globals'
import type { Db } from 'mongodb'

import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { AnyStorage } from '../any/AnyStorage.js'
import { AppsStorageManager } from '../apps/AppsStorageManager.js'
import { Bsv21StorageManager } from '../bsv21/Bsv21StorageManager.js'
import { BTMSStorageManager } from '../btms/BTMSStorageManager.js'
import { DesktopIntegrityStorage } from '../desktopintegrity/DesktopIntegrityStorage.js'
import { DIDStorageManager } from '../did/DIDStorageManager.js'
import { DstasStorageManager } from '../dstas/DstasStorageManager.js'
import { FractionalizeStorage } from '../fractionalize/FractionalizeStorage.js'
import { HelloWorldStorage } from '../hello/HelloWorldStorage.js'
import { IdentityStorageManager } from '../identity/IdentityStorageManager.js'
import { KVStoreStorageManager } from '../kvstore/KVStoreStorageManager.js'
import { MandalaStorageManager } from '../mandala/MandalaStorageManager.js'
import { MonsterBattleStorage } from '../monsterbattle/MonsterBattleStorage.js'
import { SlackThreadsStorage } from '../slackthreads/SlackThreadsStorage.js'
import { StasStorageManager } from '../stas/StasStorageManager.js'
import { SupplyChainStorage } from '../supplychain/SupplyChainStorage.js'
import { TokenDemoStorage } from '../utility-tokens/TokenDemoStorage.js'
import { UoraDppStorage } from '../uoradpp/UoraDppStorage.js'

/**
 * A collection whose index build fails is the production failure mode that took ls_identity
 * down on overlay-us-1 and overlay-ap-1: legacy rows violate a unique index, the build
 * throws E11000, and every read behind `ensureIndexes()` fails with it.
 */
const indexBuildFailure = (): Error =>
  Object.assign(new Error('Index build failed: E11000 duplicate key error'), {
    name: 'MongoServerError',
    code: 11000
  })

interface Mocks {
  db: Db
  createIndex: jest.Mock
  insertOne: jest.Mock
  updateOne: jest.Mock
}

const mockDb = (createIndex: jest.Mock): Mocks => {
  const toArray = jest.fn(async () => [])
  const cursor: any = {
    project: () => cursor,
    limit: () => cursor,
    skip: () => cursor,
    sort: () => cursor,
    toArray
  }
  const insertOne = jest.fn(async () => ({ acknowledged: true }))
  const updateOne = jest.fn(async () => ({ acknowledged: true, upsertedCount: 1 }))
  const collection = {
    createIndex,
    insertOne,
    updateOne,
    deleteOne: jest.fn(async () => ({ acknowledged: true, deletedCount: 1 })),
    deleteMany: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    findOne: jest.fn(async () => null),
    find: jest.fn(() => cursor),
    countDocuments: jest.fn(async () => 0),
    aggregate: jest.fn(() => cursor)
  }
  // Every manager gets its own collection objects, but they share these mocks.
  const db = { collection: jest.fn(() => collection) } as unknown as Db
  return { db, createIndex, insertOne, updateOne }
}

const failingCreateIndex = (): jest.Mock =>
  jest.fn(async () => {
    throw indexBuildFailure()
  }) as unknown as jest.Mock

const okCreateIndex = (): jest.Mock => jest.fn(async () => 'index') as unknown as jest.Mock

/** Each manager, with the read/write entry point that awaits its index initialization. */
const managers: Array<{ name: string, build: (db: Db) => { trigger: () => Promise<unknown> } }> = [
  { name: 'AnyStorage', build: db => { const manager = new AnyStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'AppsStorageManager', build: db => { const manager = new AppsStorageManager(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'Bsv21StorageManager', build: db => { const manager = new Bsv21StorageManager(db); return { trigger: async () => await manager.deleteToken('t', 0) } } },
  { name: 'BTMSStorageManager', build: db => { const manager = new BTMSStorageManager(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'DesktopIntegrityStorage', build: db => { const manager = new DesktopIntegrityStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'DIDStorageManager', build: db => { const manager = new DIDStorageManager(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'DstasStorageManager', build: db => { const manager = new DstasStorageManager(db); return { trigger: async () => await manager.deleteToken('t', 0) } } },
  { name: 'FractionalizeStorage', build: db => { const manager = new FractionalizeStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'HelloWorldStorage', build: db => { const manager = new HelloWorldStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'IdentityStorageManager', build: db => { const manager = new IdentityStorageManager(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'KVStoreStorageManager', build: db => { const manager = new KVStoreStorageManager(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'MandalaStorageManager', build: db => { const manager = new MandalaStorageManager(db); return { trigger: async () => await manager.deleteToken('t', 0) } } },
  { name: 'MonsterBattleStorage', build: db => { const manager = new MonsterBattleStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'SlackThreadsStorage', build: db => { const manager = new SlackThreadsStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'StasStorageManager', build: db => { const manager = new StasStorageManager(db); return { trigger: async () => await manager.deleteToken('t', 0) } } },
  { name: 'SupplyChainStorage', build: db => { const manager = new SupplyChainStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'TokenDemoStorage', build: db => { const manager = new TokenDemoStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } },
  { name: 'UoraDppStorage', build: db => { const manager = new UoraDppStorage(db); return { trigger: async () => await manager.deleteRecord('t', 0) } } }
]

describe('CollectionIndexes', () => {
  test('creates every declared index once when all builds succeed', async () => {
    const createIndex = okCreateIndex()
    const collection = { createIndex } as any
    const indexes = new CollectionIndexes('Test', () => [
      { label: 'a', collection, keys: { a: 1 } },
      { label: 'b', collection, keys: { b: 1 }, options: { unique: true } }
    ])

    await indexes.ensure()
    await indexes.ensure()

    expect(createIndex).toHaveBeenCalledTimes(2)
    expect((createIndex as jest.Mock).mock.calls[1]).toEqual([{ b: 1 }, { unique: true }])
  })

  test('skips an index that cannot be built and still resolves', async () => {
    const createIndex = jest.fn(async (keys: any) => {
      if (keys?.b === 1) throw indexBuildFailure()
      return 'index'
    }) as unknown as jest.Mock
    const collection = { createIndex } as any
    const indexes = new CollectionIndexes('Test', () => [
      { label: 'a', collection, keys: { a: 1 } },
      { label: 'b', collection, keys: { b: 1 }, options: { unique: true } }
    ])

    await expect(indexes.ensure()).resolves.toBeUndefined()
  })

  test('retries after a failed build rather than caching the rejection', async () => {
    let attempt = 0
    const createIndex = jest.fn(async () => {
      attempt++
      if (attempt === 1) throw indexBuildFailure()
      return 'index'
    }) as unknown as jest.Mock
    const collection = { createIndex } as any
    const indexes = new CollectionIndexes('Test', () => [{ label: 'a', collection, keys: { a: 1 } }])

    await indexes.ensure()
    expect(createIndex).toHaveBeenCalledTimes(1)

    await indexes.ensure()
    expect(createIndex).toHaveBeenCalledTimes(2)

    // Now that a run has succeeded, it is remembered.
    await indexes.ensure()
    expect(createIndex).toHaveBeenCalledTimes(2)
  })
})

describe.each(managers.map(m => [m.name, m.build] as const))('%s index resilience', (_name, build) => {
  test('keeps operating when index creation fails', async () => {
    const { db } = mockDb(failingCreateIndex())
    await expect(build(db).trigger()).resolves.not.toThrow()
  })

  test('retries index creation on the next call after a failure', async () => {
    const createIndex = failingCreateIndex()
    const { db } = mockDb(createIndex)
    const manager = build(db)

    await manager.trigger()
    const afterFirst = (createIndex as jest.Mock).mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    await manager.trigger()
    expect((createIndex as jest.Mock).mock.calls.length).toBeGreaterThan(afterFirst)
  })

  test('does not rebuild indexes once a build has succeeded', async () => {
    const createIndex = okCreateIndex()
    const { db } = mockDb(createIndex)
    const manager = build(db)

    await manager.trigger()
    const afterFirst = (createIndex as jest.Mock).mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    await manager.trigger()
    expect((createIndex as jest.Mock).mock.calls).toHaveLength(afterFirst)
  })
})

describe('outpoint-keyed writes are idempotent', () => {
  const writes: Array<[string, (db: Db) => Promise<unknown>]> = [
    ['AnyStorage', async db => await new AnyStorage(db).storeRecord('t', 0)],
    ['AppsStorageManager', async db => await new AppsStorageManager(db).storeRecord('t', 0, {} as any)],
    ['Bsv21StorageManager', async db => await new Bsv21StorageManager(db).storeToken({ txid: 't', outputIndex: 0 } as any)],
    ['BTMSStorageManager', async db => await new BTMSStorageManager(db).storeRecord('t', 0, 'asset', 1, 'owner')],
    ['DesktopIntegrityStorage', async db => await new DesktopIntegrityStorage(db).storeRecord('t', 0, 'hash')],
    ['DIDStorageManager', async db => await new DIDStorageManager(db).storeRecord('t', 0, 'serial')],
    ['DstasStorageManager', async db => await new DstasStorageManager(db).storeToken({ txid: 't', outputIndex: 0 } as any)],
    ['FractionalizeStorage', async db => await new FractionalizeStorage(db).storeRecord('t', 0)],
    ['HelloWorldStorage', async db => await new HelloWorldStorage(db).storeRecord('t', 0, 'hi')],
    ['KVStoreStorageManager', async db => await new KVStoreStorageManager(db).storeRecord('t', 0, 'k', 'p', 'c')],
    ['MandalaStorageManager', async db => await new MandalaStorageManager(db).storeToken({ txid: 't', outputIndex: 0 } as any)],
    ['MandalaStorageManager (linkage)', async db => await new MandalaStorageManager(db).storeLinkage({ txid: 't', outputIndex: 0 } as any)],
    ['MonsterBattleStorage', async db => await new MonsterBattleStorage(db).storeRecord('t', 0)],
    ['SlackThreadsStorage', async db => await new SlackThreadsStorage(db).storeRecord('t', 0, 'hash')],
    ['StasStorageManager', async db => await new StasStorageManager(db).storeToken({ txid: 't', outputIndex: 0 } as any)],
    ['SupplyChainStorage', async db => await new SupplyChainStorage(db).storeRecord('t', 0, {})],
    ['TokenDemoStorage', async db => await new TokenDemoStorage(db).storeRecord('t', 0, {} as any)],
    ['UoraDppStorage', async db => await new UoraDppStorage(db).storeRecord({ txid: 't', outputIndex: 0 } as any)]
  ]

  test.each(writes)('%s upserts on (txid, outputIndex)', async (_name, write) => {
    const { db, insertOne, updateOne } = mockDb(okCreateIndex())

    await write(db)

    expect(insertOne).not.toHaveBeenCalled()
    expect(updateOne).toHaveBeenCalledTimes(1)
    const [filter, , options] = (updateOne as jest.Mock).mock.calls[0] as any[]
    expect(filter).toEqual({ txid: 't', outputIndex: 0 })
    expect(options).toEqual({ upsert: true })
  })
})
