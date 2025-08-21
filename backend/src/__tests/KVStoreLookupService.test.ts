import KVStoreLookupServiceFactory from '../KVStoreLookupServiceFactory.js'
import { KVStoreStorageManager } from '../KVStoreStorageManager.js'
import { MongoClient, Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Utils } from '@bsv/sdk'

describe('KVStoreLookupService', () => {
  let mongoServer: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let lookupService: any

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
    lookupService = KVStoreLookupServiceFactory(db)
  })

  afterEach(async () => {
    await db.collection('kvstoreRecords').deleteMany({})
  })

  describe('outputAdmittedByTopic', () => {
    it('should process valid KVStore token output', async () => {
      const mockProtectedKey = Buffer.alloc(32, 'test')
      const mockValue = Buffer.from('test-value', 'utf8')
      
      // Create mock locking script with PushDrop fields
      const mockLockingScript = Buffer.concat([
        Buffer.from([mockProtectedKey.length]),
        mockProtectedKey,
        Buffer.from([mockValue.length]),
        mockValue
      ])

      const payload = {
        mode: 'locking-script' as const,
        txid: 'test-txid-123',
        outputIndex: 0,
        topic: 'kvstore',
        lockingScript: mockLockingScript
      }

      // Mock PushDrop.decode to return our test data
      const originalDecode = require('@bsv/sdk').PushDrop.decode
      require('@bsv/sdk').PushDrop.decode = jest.fn().mockReturnValue({
        fields: [mockProtectedKey, mockValue]
      })

      await lookupService.outputAdmittedByTopic(payload)

      // Verify record was stored
      const records = await db.collection('kvstoreRecords').find({}).toArray()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        txid: 'test-txid-123',
        outputIndex: 0,
        protectedKey: Utils.toBase64(mockProtectedKey)
      })

      // Restore original function
      require('@bsv/sdk').PushDrop.decode = originalDecode
    })

    it('should ignore non-kvstore topics', async () => {
      const payload = {
        mode: 'locking-script' as const,
        txid: 'test-txid-123',
        outputIndex: 0,
        topic: 'different-topic',
        lockingScript: Buffer.from('test')
      }

      await lookupService.outputAdmittedByTopic(payload)

      const records = await db.collection('kvstoreRecords').find({}).toArray()
      expect(records).toHaveLength(0)
    })

    it('should throw error for invalid field count', async () => {
      const payload = {
        mode: 'locking-script' as const,
        txid: 'test-txid-123',
        outputIndex: 0,
        topic: 'kvstore',
        lockingScript: Buffer.from('test')
      }

      // Mock PushDrop.decode to return invalid field count
      const originalDecode = require('@bsv/sdk').PushDrop.decode
      require('@bsv/sdk').PushDrop.decode = jest.fn().mockReturnValue({
        fields: [Buffer.from('single-field')]
      })

      await expect(lookupService.outputAdmittedByTopic(payload))
        .rejects.toThrow('KVStore token must have exactly two PushDrop fields')

      // Restore original function
      require('@bsv/sdk').PushDrop.decode = originalDecode
    })
  })

  describe('outputSpent', () => {
    it('should delete record when output is spent', async () => {
      // First store a record
      const storageManager = new KVStoreStorageManager(db)
      await storageManager.storeRecord('test-txid-123', 0, 'test-key')

      const payload = {
        mode: 'none' as const,
        txid: 'test-txid-123',
        outputIndex: 0,
        topic: 'kvstore'
      }

      await lookupService.outputSpent(payload)

      const records = await db.collection('kvstoreRecords').find({}).toArray()
      expect(records).toHaveLength(0)
    })
  })

  describe('lookup', () => {
    beforeEach(async () => {
      const storageManager = new KVStoreStorageManager(db)
      await storageManager.storeRecord('txid1', 0, 'test-key-1')
      await storageManager.storeRecord('txid2', 1, 'test-key-1')
      await storageManager.storeRecord('txid3', 0, 'test-key-2')
    })

    it('should find records by protected key', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          protectedKey: 'test-key-1'
        }
      }

      const results = await lookupService.lookup(question)
      
      expect(results).toHaveLength(2)
      expect(results).toEqual(
        expect.arrayContaining([
          { txid: 'txid1', outputIndex: 0 },
          { txid: 'txid2', outputIndex: 1 }
        ])
      )
    })

    it('should return all records when no specific query', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {}
      }

      const results = await lookupService.lookup(question)
      
      expect(results).toHaveLength(3)
    })

    it('should throw error for invalid service', async () => {
      const question = {
        service: 'invalid-service',
        query: { protectedKey: 'test-key' }
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('Lookup service not supported!')
    })

    it('should throw error for missing query', async () => {
      const question = {
        service: 'ls_kvstore',
        query: null
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('A valid query must be provided!')
    })
  })

  describe('getMetaData', () => {
    it('should return service metadata', async () => {
      const metadata = await lookupService.getMetaData()
      
      expect(metadata).toEqual({
        name: 'KVStore Lookup Service',
        shortDescription: 'Find KVStore key-value pairs stored on-chain with efficient lookups by protected key.'
      })
    })
  })

  describe('getDocumentation', () => {
    it('should return documentation string', async () => {
      const docs = await lookupService.getDocumentation()
      
      expect(typeof docs).toBe('string')
      expect(docs).toContain('KVStore Lookup Service')
    })
  })
})
