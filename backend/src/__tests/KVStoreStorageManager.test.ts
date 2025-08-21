import { KVStoreStorageManager } from '../KVStoreStorageManager.js'
import { MongoClient, Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'

describe('KVStoreStorageManager', () => {
  let mongoServer: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let storageManager: KVStoreStorageManager

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create()
    const uri = mongoServer.getUri()
    client = new MongoClient(uri)
    await client.connect()
    db = client.db('test-kvstore')
  })

  afterAll(async () => {
    await client.close()
    await mongoServer.stop()
  })

  beforeEach(() => {
    storageManager = new KVStoreStorageManager(db)
  })

  afterEach(async () => {
    await db.collection('kvstoreRecords').deleteMany({})
  })

  describe('storeRecord', () => {
    it('should store a new KVStore record', async () => {
      const txid = 'test-txid-123'
      const outputIndex = 0
      const protectedKey = 'dGVzdC1wcm90ZWN0ZWQta2V5'

      await storageManager.storeRecord(txid, outputIndex, protectedKey)

      const records = await db.collection('kvstoreRecords').find({}).toArray()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        txid,
        outputIndex,
        protectedKey
      })
      expect(records[0].createdAt).toBeInstanceOf(Date)
    })
  })

  describe('deleteRecord', () => {
    it('should delete a KVStore record', async () => {
      const txid = 'test-txid-123'
      const outputIndex = 0
      const protectedKey = 'dGVzdC1wcm90ZWN0ZWQta2V5'

      await storageManager.storeRecord(txid, outputIndex, protectedKey)
      await storageManager.deleteRecord(txid, outputIndex)

      const records = await db.collection('kvstoreRecords').find({}).toArray()
      expect(records).toHaveLength(0)
    })
  })

  describe('findByProtectedKey', () => {
    it('should find records by protected key', async () => {
      const protectedKey = 'dGVzdC1wcm90ZWN0ZWQta2V5'
      
      await storageManager.storeRecord('txid1', 0, protectedKey)
      await storageManager.storeRecord('txid2', 1, protectedKey)
      await storageManager.storeRecord('txid3', 0, 'different-key')

      const results = await storageManager.findByProtectedKey(protectedKey)
      
      expect(results).toHaveLength(2)
      expect(results).toEqual(
        expect.arrayContaining([
          { txid: 'txid1', outputIndex: 0 },
          { txid: 'txid2', outputIndex: 1 }
        ])
      )
    })

    it('should respect pagination parameters', async () => {
      const protectedKey = 'dGVzdC1wcm90ZWN0ZWQta2V5'
      
      for (let i = 0; i < 5; i++) {
        await storageManager.storeRecord(`txid${i}`, i, protectedKey)
      }

      const results = await storageManager.findByProtectedKey(
        protectedKey,
        2, // limit
        1, // skip
        'asc'
      )
      
      expect(results).toHaveLength(2)
    })
  })

  describe('findAllRecords', () => {
    it('should return all records when no filter is applied', async () => {
      await storageManager.storeRecord('txid1', 0, 'key1')
      await storageManager.storeRecord('txid2', 1, 'key2')
      await storageManager.storeRecord('txid3', 0, 'key3')

      const results = await storageManager.findAllRecords()
      
      expect(results).toHaveLength(3)
    })

    it('should respect pagination for all records', async () => {
      for (let i = 0; i < 10; i++) {
        await storageManager.storeRecord(`txid${i}`, i, `key${i}`)
      }

      const results = await storageManager.findAllRecords(5, 3)
      
      expect(results).toHaveLength(5)
    })
  })
})
