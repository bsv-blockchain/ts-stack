import { SHIPStorage } from '../SHIP/SHIPStorage.js'
import { SLAPStorage } from '../SLAP/SLAPStorage.js'
import { MongoClient, type Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'

const shipFilter = {
  identityKey: 'identity',
  domain: 'https://host.example',
  topic: 'tm_music'
}

const slapFilter = {
  identityKey: 'identity',
  domain: 'https://host.example',
  service: 'ls_music'
}

function duplicateKeyError (): Error & { code: number } {
  return Object.assign(new Error('duplicate key'), { code: 11000 })
}

function createMockDb (overrides: Record<string, unknown> = {}): {
  db: Db
  collection: Record<string, unknown>
} {
  const collection = {
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    createIndex: jest.fn().mockResolvedValue('index'),
    aggregate: jest.fn().mockReturnValue([]),
    indexes: jest.fn().mockResolvedValue([]),
    ...overrides
  }
  return {
    db: { collection: jest.fn().mockReturnValue(collection) } as unknown as Db,
    collection
  }
}

const protocolCases = [
  {
    name: 'SHIP',
    store: async (db: Db) => {
      await new SHIPStorage(db).storeSHIPRecord(
        'txid', 1, shipFilter.identityKey, shipFilter.domain, shipFilter.topic
      )
    }
  },
  {
    name: 'SLAP',
    store: async (db: Db) => {
      await new SLAPStorage(db).storeSLAPRecord(
        'txid', 1, slapFilter.identityKey, slapFilter.domain, slapFilter.service
      )
    }
  }
]

describe('discovery storage initialization and retry behavior', () => {
  it.each(protocolCases)('$name retries an upsert after a concurrent insert wins with E11000', async ({ store }) => {
    const updateOne = jest.fn()
      .mockRejectedValueOnce(duplicateKeyError())
      .mockResolvedValueOnce({ acknowledged: true })
    const { db } = createMockDb({ updateOne })

    await expect(store(db)).resolves.toBeUndefined()

    expect(updateOne).toHaveBeenCalledTimes(2)
  })

  it('memoizes index initialization across concurrent callers', async () => {
    const { db, collection } = createMockDb()
    const storage = new SHIPStorage(db)

    await Promise.all([
      storage.storeSHIPRecord('txid-1', 1, 'identity-1', 'https://one.example', 'tm_music'),
      storage.storeSHIPRecord('txid-2', 2, 'identity-2', 'https://two.example', 'tm_music')
    ])

    expect(collection.indexes).toHaveBeenCalledTimes(1)
    expect(collection.aggregate).toHaveBeenCalledTimes(1)
    expect(collection.createIndex).toHaveBeenCalledTimes(2)
  })

  it('allows index initialization to retry after a transient failure', async () => {
    const indexError = new Error('index build interrupted')
    const createIndex = jest.fn()
      .mockRejectedValueOnce(indexError)
      .mockResolvedValue('index')
    const { db, collection } = createMockDb({ createIndex })
    const storage = new SHIPStorage(db)

    await expect(storage.storeSHIPRecord(
      'txid-1', 1, shipFilter.identityKey, shipFilter.domain, shipFilter.topic
    )).rejects.toThrow('index build interrupted')
    await expect(storage.storeSHIPRecord(
      'txid-2', 2, shipFilter.identityKey, shipFilter.domain, shipFilter.topic
    )).resolves.toBeUndefined()

    expect(collection.indexes).toHaveBeenCalledTimes(2)
    expect(collection.aggregate).toHaveBeenCalledTimes(2)
    expect(createIndex).toHaveBeenCalledTimes(3)
    expect(collection.updateOne).toHaveBeenCalledTimes(1)
  })

  it.each(protocolCases)('$name retries the unique-index migration when a rolling writer races cleanup', async ({ store }) => {
    const error = duplicateKeyError()
    const createIndex = jest.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue('index')
    const { db, collection } = createMockDb({ createIndex })

    await expect(store(db)).resolves.toBeUndefined()

    expect(collection.indexes).toHaveBeenCalledTimes(3)
    expect(collection.aggregate).toHaveBeenCalledTimes(3)
    expect(createIndex).toHaveBeenCalledTimes(4)
    expect(collection.updateOne).toHaveBeenCalledTimes(1)
  })

  it('stops retrying the unique-index migration after three duplicate-key failures', async () => {
    const error = duplicateKeyError()
    const createIndex = jest.fn().mockRejectedValue(error)
    const { db, collection } = createMockDb({ createIndex })

    await expect(new SHIPStorage(db).storeSHIPRecord(
      'txid', 1, shipFilter.identityKey, shipFilter.domain, shipFilter.topic
    )).rejects.toBe(error)

    expect(collection.indexes).toHaveBeenCalledTimes(3)
    expect(collection.aggregate).toHaveBeenCalledTimes(3)
    expect(createIndex).toHaveBeenCalledTimes(3)
    expect(collection.updateOne).not.toHaveBeenCalled()
  })

  it('skips the legacy deduplication scan when the unique index already exists', async () => {
    const indexes = jest.fn().mockResolvedValue([{
      key: { identityKey: 1, domain: 1, topic: 1 },
      name: 'identityKey_1_domain_1_topic_1',
      unique: true
    }])
    const { db, collection } = createMockDb({ indexes })

    await new SHIPStorage(db).storeSHIPRecord(
      'txid', 1, shipFilter.identityKey, shipFilter.domain, shipFilter.topic
    )

    expect(collection.aggregate).not.toHaveBeenCalled()
    expect(collection.createIndex).toHaveBeenCalledTimes(1)
    expect(collection.createIndex).toHaveBeenCalledWith({ domain: 1, topic: 1 })
  })
})

describe('discovery storage MongoDB invariants', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('overlay_discovery_storage_test')
  })

  afterAll(async () => {
    await client.close()
    await mongo.stop()
  })

  beforeEach(async () => {
    await db.dropDatabase()
  })

  it('migrates SHIP duplicates, retaining newest before accepting a refresh', async () => {
    const records = db.collection('shipRecords')
    await records.insertMany([
      { ...shipFilter, txid: 'older-txid', outputIndex: 0, createdAt: new Date('2026-01-01') },
      { ...shipFilter, txid: 'newer-txid', outputIndex: 1, createdAt: new Date('2026-02-01') }
    ])
    const storage = new SHIPStorage(db)

    expect(await storage.findRecord({
      domain: shipFilter.domain,
      topics: [shipFilter.topic],
      identityKey: shipFilter.identityKey
    })).toEqual([{ txid: 'newer-txid', outputIndex: 1 }])

    await storage.storeSHIPRecord(
      'fresh-txid', 2, shipFilter.identityKey, shipFilter.domain, shipFilter.topic
    )
    const remaining = await records.find(shipFilter).toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toEqual(expect.objectContaining({
      txid: 'fresh-txid',
      outputIndex: 2
    }))
  })

  it('migrates SLAP duplicates, retaining newest before accepting a refresh', async () => {
    const records = db.collection('slapRecords')
    await records.insertMany([
      { ...slapFilter, txid: 'older-txid', outputIndex: 0, createdAt: new Date('2026-01-01') },
      { ...slapFilter, txid: 'newer-txid', outputIndex: 1, createdAt: new Date('2026-02-01') }
    ])
    const storage = new SLAPStorage(db)

    expect(await storage.findRecord(slapFilter)).toEqual([
      { txid: 'newer-txid', outputIndex: 1 }
    ])

    await storage.storeSLAPRecord(
      'fresh-txid', 2, slapFilter.identityKey, slapFilter.domain, slapFilter.service
    )
    const remaining = await records.find(slapFilter).toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toEqual(expect.objectContaining({
      txid: 'fresh-txid',
      outputIndex: 2
    }))
  })

  it('deduplicates large legacy groups in bounded batches', async () => {
    const records = db.collection('shipRecords')
    await records.insertMany(Array.from({ length: 1205 }, (_, index) => ({
      ...shipFilter,
      txid: `txid-${index}`,
      outputIndex: index,
      createdAt: new Date(2026, 0, 1, 0, 0, 0, index)
    })))

    await new SHIPStorage(db).ensureIndexes()

    const remaining = await records.find(shipFilter).toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toEqual(expect.objectContaining({
      txid: 'txid-1204',
      outputIndex: 1204
    }))
  })

  it('self-initializes SHIP indexes and enforces uniqueness under concurrent upserts', async () => {
    const storage = new SHIPStorage(db)
    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      await storage.storeSHIPRecord(
        `txid-${index}`, index, shipFilter.identityKey, shipFilter.domain, shipFilter.topic
      )
    }))

    expect(await db.collection('shipRecords').countDocuments(shipFilter)).toBe(1)
    expect(await db.collection('shipRecords').indexes()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: { identityKey: 1, domain: 1, topic: 1 },
        unique: true
      }),
      expect.objectContaining({ key: { domain: 1, topic: 1 } })
    ]))
  })

  it('self-initializes SLAP indexes and enforces uniqueness under concurrent upserts', async () => {
    const storage = new SLAPStorage(db)
    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      await storage.storeSLAPRecord(
        `txid-${index}`, index, slapFilter.identityKey, slapFilter.domain, slapFilter.service
      )
    }))

    expect(await db.collection('slapRecords').countDocuments(slapFilter)).toBe(1)
    expect(await db.collection('slapRecords').indexes()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: { identityKey: 1, domain: 1, service: 1 },
        unique: true
      }),
      expect.objectContaining({ key: { domain: 1, service: 1 } })
    ]))
  })
})
