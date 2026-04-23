/// <reference types="jest" />

import KVStoreLookupServiceFactory from '../KVStoreLookupServiceFactory.js'
import { KVStoreStorageManager } from '../KVStoreStorageManager.js'
import { MongoClient, Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { PushDrop } from '@bsv/sdk'
import { kvProtocol } from '../types.js'

// Note: Jest globals (describe, it, expect) are available via jest setup

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
      const mockProtocolID = Buffer.from(JSON.stringify([1, 'kvstore']), 'utf8')
      const mockKey = Buffer.from('test-key', 'utf8')
      const mockValue = Buffer.from('test-value', 'utf8')
      const mockController = Buffer.from('02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c', 'hex')
      const mockSignature = Buffer.alloc(64, 'sig')

      const payload = {
        mode: 'locking-script' as const,
        txid: 'test-txid-123',
        outputIndex: 0,
        topic: 'tm_kvstore',
        lockingScript: Buffer.from('mock-script')
      }

      // Mock PushDrop.decode to return our test data with correct field order
      const originalDecode = PushDrop.decode
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [
          mockProtocolID,  // field 0: protocolID
          mockKey,         // field 1: key 
          mockValue,       // field 2: value
          mockController,  // field 3: controller
          mockSignature    // field 4: signature
        ]
      })

      await lookupService.outputAdmittedByTopic(payload)

      // Verify record was stored with correct fields
      const records = await db.collection('kvstoreRecords').find({}).toArray()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        txid: 'test-txid-123',
        outputIndex: 0,
        key: 'test-key',
        protocolID: JSON.stringify([1, 'kvstore']),
        controller: '02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c'
      })
      expect(records[0].createdAt).toBeInstanceOf(Date)

      // Restore original function
      PushDrop.decode = originalDecode
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
        topic: 'tm_kvstore',
        lockingScript: Buffer.from('test')
      }

      // Mock PushDrop.decode to return invalid field count (only 3 fields instead of 5)
      const originalDecode = PushDrop.decode
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [
          Buffer.from('protocol'),
          Buffer.from('key'),
          Buffer.from('value')
          // Missing controller and signature
        ]
      })

      await expect(lookupService.outputAdmittedByTopic(payload))
        .rejects.toThrow(`KVStore token must have ${Object.keys(kvProtocol).length - 1} fields (old format) or ${Object.keys(kvProtocol).length} fields (with tags), got 3 fields`)

      // Restore original function
      PushDrop.decode = originalDecode
    })
  })

  describe('outputSpent', () => {
    it('should delete record when output is spent', async () => {
      // First store a record with updated signature
      const storageManager = new KVStoreStorageManager(db)
      await storageManager.storeRecord(
        'test-txid-123',
        0,
        'test-key',
        JSON.stringify([1, 'kvstore']),
        '02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c'
      )

      const payload = {
        mode: 'none' as const,
        txid: 'test-txid-123',
        outputIndex: 0,
        topic: 'tm_kvstore'
      }

      await lookupService.outputSpent(payload)

      const records = await db.collection('kvstoreRecords').find({}).toArray()
      expect(records).toHaveLength(0)
    })
  })

  describe('lookup', () => {
    beforeEach(async () => {
      const storageManager = new KVStoreStorageManager(db)
      // Update to new storeRecord signature: (txid, outputIndex, key, protocolID, controller)
      await storageManager.storeRecord('txid1', 0, 'test-key-1', JSON.stringify([1, 'kvstore']), 'controller1')
      await storageManager.storeRecord('txid2', 1, 'test-key-1', JSON.stringify([1, 'kvstore']), 'controller1')
      await storageManager.storeRecord('txid3', 0, 'test-key-2', JSON.stringify([1, 'kvstore']), 'controller2')
    })

    it('should find records by key', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          key: 'test-key-1'
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

    it('should find records by controller', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          controller: 'controller1'
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

    it('should find records by protocolID', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          protocolID: [1, 'kvstore']
        }
      }

      const results = await lookupService.lookup(question)

      expect(results).toHaveLength(3) // All records have same protocolID
    })

    it('should reject queries without selectors', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {}
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('Must specify at least one selector: key, controller, protocolID, or tags')
    })

    it('should reject pagination-only queries', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          limit: 2,
          skip: 1
        }
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('Must specify at least one selector: key, controller, protocolID, or tags')
    })

    it('should reject ordering-only queries', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          sortOrder: 'asc'
        }
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('Must specify at least one selector: key, controller, protocolID, or tags')
    })

    it('should reject empty tag selector queries', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          tags: []
        }
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('Must specify at least one selector: key, controller, protocolID, or tags')
    })

    it('should support pagination and sorting with a selector', async () => {
      const question = {
        service: 'ls_kvstore',
        query: {
          protocolID: [1, 'kvstore'],
          limit: 2,
          skip: 1,
          sortOrder: 'asc'
        }
      }

      const results = await lookupService.lookup(question)
      expect(results).toHaveLength(2)
    })

    it('should throw error for invalid service', async () => {
      const question = {
        service: 'invalid-service',
        query: { key: 'test-key' }
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('Lookup service not supported')
    })

    it('should throw error for missing query', async () => {
      const question = {
        service: 'ls_kvstore',
        query: null
      }

      await expect(lookupService.lookup(question))
        .rejects.toThrow('A valid query must be provided')
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
