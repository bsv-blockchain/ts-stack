/// <reference types="jest" />

import { KVStoreStorageManager } from '../KVStoreStorageManager.js'
import { MongoClient, Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { WalletProtocol } from '@bsv/sdk'
import { KVStoreRecordFactory } from './testFactories.js'

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
    KVStoreRecordFactory.reset()
  })

  afterEach(async () => {
    await db.collection('kvstoreRecords').deleteMany({})
  })

  describe('Record Operations', () => {
    describe('storeRecord', () => {
      it('should store a new KVStore record with all required fields', async () => {
        const record = KVStoreRecordFactory.create()

        await storageManager.storeRecord(
          record.txid,
          record.outputIndex,
          record.key,
          record.protocolID,
          record.controller
        )

        const storedRecords = await db.collection('kvstoreRecords').find({}).toArray()
        expect(storedRecords).toHaveLength(1)
        expect(storedRecords[0]).toMatchObject({
          txid: record.txid,
          outputIndex: record.outputIndex,
          key: record.key,
          protocolID: record.protocolID,
          controller: record.controller
        })
        expect(storedRecords[0].createdAt).toBeInstanceOf(Date)
        expect(storedRecords[0].createdAt.getTime()).toBeCloseTo(Date.now(), -2)
      })

      it('should store multiple records with different data', async () => {
        const records = KVStoreRecordFactory.createMany(3)

        for (const record of records) {
          await storageManager.storeRecord(
            record.txid,
            record.outputIndex,
            record.key,
            record.protocolID,
            record.controller
          )
        }

        const storedRecords = await db.collection('kvstoreRecords').find({}).toArray()
        expect(storedRecords).toHaveLength(3)

        // Verify each record was stored correctly
        records.forEach((expectedRecord, index) => {
          expect(storedRecords.some(stored => stored.txid === expectedRecord.txid)).toBe(true)
        })
      })

      it('should handle records with same key but different controllers', async () => {
        const sharedKey = 'shared-key'
        const record1 = KVStoreRecordFactory.create({ key: sharedKey, controller: 'controller1' })
        const record2 = KVStoreRecordFactory.create({ key: sharedKey, controller: 'controller2' })

        await storageManager.storeRecord(record1.txid, record1.outputIndex, record1.key, record1.protocolID, record1.controller)
        await storageManager.storeRecord(record2.txid, record2.outputIndex, record2.key, record2.protocolID, record2.controller)

        const storedRecords = await db.collection('kvstoreRecords').find({}).toArray()
        expect(storedRecords).toHaveLength(2)
        expect(storedRecords.every(r => r.key === sharedKey)).toBe(true)
        expect(new Set(storedRecords.map(r => r.controller))).toEqual(new Set(['controller1', 'controller2']))
      })
    })

    describe('deleteRecord', () => {
      it('should delete an existing record by txid and outputIndex', async () => {
        const record = KVStoreRecordFactory.create()

        await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
        await storageManager.deleteRecord(record.txid, record.outputIndex)

        const records = await db.collection('kvstoreRecords').find({}).toArray()
        expect(records).toHaveLength(0)
      })

      it('should only delete the specified record when multiple exist', async () => {
        const records = KVStoreRecordFactory.createMany(3)

        for (const record of records) {
          await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
        }

        await storageManager.deleteRecord(records[1].txid, records[1].outputIndex)

        const remainingRecords = await db.collection('kvstoreRecords').find({}).toArray()
        expect(remainingRecords).toHaveLength(2)
        expect(remainingRecords.map(r => r.txid)).toEqual(
          expect.arrayContaining([records[0].txid, records[2].txid])
        )
        expect(remainingRecords.map(r => r.txid)).not.toContain(records[1].txid)
      })

      it('should handle deletion of non-existent record gracefully', async () => {
        // This shouldn't throw an error even if the record doesn't exist
        await expect(storageManager.deleteRecord('non-existent-txid', 0)).resolves.not.toThrow()

        const records = await db.collection('kvstoreRecords').find({}).toArray()
        expect(records).toHaveLength(0)
      })
    })
  })

  describe('Query Operations', () => {
    describe('findWithFilters', () => {
      beforeEach(async () => {
        // Setup test data for filter tests
        const records = [
          KVStoreRecordFactory.create({ key: 'shared-key', controller: 'controller1' }),
          KVStoreRecordFactory.create({ key: 'shared-key', controller: 'controller2' }),
          KVStoreRecordFactory.create({ key: 'unique-key', controller: 'controller1' }),
          KVStoreRecordFactory.create({
            key: 'protocol-test',
            controller: 'controller3',
            protocolID: JSON.stringify([2, 'different'] as WalletProtocol)
          })
        ]

        for (const record of records) {
          await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
        }
      })

      it('should find records by key filter', async () => {
        const results = await storageManager.findWithFilters({ key: 'shared-key' })

        expect(results).toHaveLength(2)
        expect(results.every(r => r.key === 'shared-key')).toBe(true)
        expect(new Set(results.map(r => r.controller))).toEqual(new Set(['controller1', 'controller2']))
      })

      it('should find records by controller filter', async () => {
        const results = await storageManager.findWithFilters({ controller: 'controller1' })

        expect(results).toHaveLength(2)
        expect(results.every(r => r.controller === 'controller1')).toBe(true)
        expect(new Set(results.map(r => r.key))).toEqual(new Set(['shared-key', 'unique-key']))
      })

      it('should find records by protocolID filter', async () => {
        const protocolID1: WalletProtocol = [1, 'kvstore']
        const results = await storageManager.findWithFilters({ protocolID: protocolID1 })

        expect(results).toHaveLength(3) // All records except the one with different protocol
        expect(results.every(r => r.protocolID === JSON.stringify(protocolID1))).toBe(true)
      })

      it('should support combined filters (key + controller)', async () => {
        const results = await storageManager.findWithFilters({
          key: 'shared-key',
          controller: 'controller1'
        })

        expect(results).toHaveLength(1)
        expect(results[0].key).toBe('shared-key')
        expect(results[0].controller).toBe('controller1')
      })

      it('should return empty array when no records match filters', async () => {
        const results = await storageManager.findWithFilters({ key: 'non-existent-key' })

        expect(results).toHaveLength(0)
        expect(Array.isArray(results)).toBe(true)
      })

      it('should support pagination with limit and skip', async () => {
        // Add more records for pagination test
        const additionalRecords = KVStoreRecordFactory.createMany(6, { key: 'paginate-test' })
        for (const record of additionalRecords) {
          await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
        }

        const results = await storageManager.findWithFilters(
          { key: 'paginate-test' },
          'all', // tagQueryMode
          3, // limit
          2, // skip
          'asc' // sortOrder
        )

        expect(results).toHaveLength(3)
        expect(results.every(r => r.key === 'paginate-test')).toBe(true)
      })

      it('should support sorting by creation date', async () => {
        // Clear existing data and create time-ordered records
        await db.collection('kvstoreRecords').deleteMany({})

        const timeOrderedRecords = []
        for (let i = 0; i < 3; i++) {
          const record = KVStoreRecordFactory.create({ key: `time-test-${i}` })
          await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
          timeOrderedRecords.push(record)
          await new Promise(resolve => setTimeout(resolve, 2)) // Small delay for different timestamps
        }

        // Test ascending order
        const ascResults = await storageManager.findWithFilters({}, 'all', 50, 0, 'asc')
        expect(ascResults).toHaveLength(3)
        expect(ascResults[0].txid).toBe(timeOrderedRecords[0].txid)
        expect(ascResults[2].txid).toBe(timeOrderedRecords[2].txid)

        // Test descending order (default)
        const descResults = await storageManager.findWithFilters({}, 'all', 50, 0, 'desc')
        expect(descResults).toHaveLength(3)
        expect(descResults[0].txid).toBe(timeOrderedRecords[2].txid)
        expect(descResults[2].txid).toBe(timeOrderedRecords[0].txid)
      })
    })

    describe('findAllRecords', () => {
      it('should return all records when no specific filters applied', async () => {
        const records = KVStoreRecordFactory.createMany(5)

        for (const record of records) {
          await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
        }

        const results = await storageManager.findAllRecords()

        expect(results).toHaveLength(5)
        // Verify all records are returned
        const resultTxids = new Set(results.map(r => r.txid))
        const expectedTxids = new Set(records.map(r => r.txid))
        expect(resultTxids).toEqual(expectedTxids)
      })

      it('should respect pagination parameters', async () => {
        // Create 10 records for pagination test
        const records = KVStoreRecordFactory.createMany(10)

        for (const record of records) {
          await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
        }

        const results = await storageManager.findAllRecords(5, 3, 'desc')

        expect(results).toHaveLength(5)
        // With skip=3, limit=5, we should get records 4-8 (0-indexed: 3-7)
      })

      it('should return empty array when no records exist', async () => {
        const results = await storageManager.findAllRecords()

        expect(results).toHaveLength(0)
        expect(Array.isArray(results)).toBe(true)
      })

      it('should handle large pagination skip values gracefully', async () => {
        const records = KVStoreRecordFactory.createMany(3)

        for (const record of records) {
          await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)
        }

        // Skip more records than exist
        const results = await storageManager.findAllRecords(10, 100)

        expect(results).toHaveLength(0)
        expect(Array.isArray(results)).toBe(true)
      })
    })

    describe('Edge Cases and Error Handling', () => {
      it('should handle malformed filter objects gracefully', async () => {
        const record = KVStoreRecordFactory.create()
        await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)

        // Empty filter object should return all records
        const results = await storageManager.findWithFilters({})
        expect(results).toHaveLength(1)
      })

      it('should handle very long key values', async () => {
        const longKey = 'a'.repeat(1000) // Very long key
        const record = KVStoreRecordFactory.create({ key: longKey })

        await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)

        const results = await storageManager.findWithFilters({ key: longKey })
        expect(results).toHaveLength(1)
        expect(results[0].key).toBe(longKey)
      })

      it('should handle special characters in keys and values', async () => {
        const specialKey = 'test-key-with-!@#$%^&*()_+{}[]|\\:";\'<>?,./'
        const record = KVStoreRecordFactory.create({ key: specialKey })

        await storageManager.storeRecord(record.txid, record.outputIndex, record.key, record.protocolID, record.controller)

        const results = await storageManager.findWithFilters({ key: specialKey })
        expect(results).toHaveLength(1)
        expect(results[0].key).toBe(specialKey)
      })
    })
  })

  describe('Tag Query Mode Tests', () => {
    beforeEach(async () => {
      // Setup test data with tags
      const recordsWithTags = [
        { key: 'music-track', controller: 'controller1', tags: ['music', 'rock', 'album'] },
        { key: 'video-clip', controller: 'controller2', tags: ['video', 'music'] },
        { key: 'news-article', controller: 'controller3', tags: ['news', 'politics'] },
        { key: 'tech-review', controller: 'controller4', tags: ['tech', 'review', 'mobile'] },
        { key: 'mixed-content', controller: 'controller5', tags: ['music', 'news'] }
      ]

      for (const recordData of recordsWithTags) {
        const record = KVStoreRecordFactory.create(recordData)
        await storageManager.storeRecord(
          record.txid,
          record.outputIndex,
          record.key,
          record.protocolID,
          record.controller,
          recordData.tags
        )
      }
    })

    describe('tagQueryMode = "all" (default)', () => {
      it('should find records that contain ALL specified tags', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['music', 'rock'] },
          'all' // tagQueryMode
        )

        expect(results).toHaveLength(1)
        expect(results[0].key).toBe('music-track')
        expect(results[0].tags).toEqual(expect.arrayContaining(['music', 'rock', 'album']))
      })

      it('should return empty array when no records contain ALL tags', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['music', 'politics'] }, // No record has both
          'all'
        )

        expect(results).toHaveLength(0)
      })

      it('should work with single tag queries', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['news'] },
          'all'
        )

        expect(results).toHaveLength(2) // news-article and mixed-content
        expect(results.map(r => r.key)).toEqual(
          expect.arrayContaining(['news-article', 'mixed-content'])
        )
      })

      it('should default to "all" mode when tagQueryMode not specified', async () => {
        const resultsWithExplicitAll = await storageManager.findWithFilters(
          { tags: ['music', 'rock'] },
          'all'
        )

        const resultsWithDefault = await storageManager.findWithFilters(
          { tags: ['music', 'rock'] }
          // tagQueryMode defaults to 'all'
        )

        expect(resultsWithDefault).toHaveLength(resultsWithExplicitAll.length)
        expect(resultsWithDefault[0]?.key).toBe(resultsWithExplicitAll[0]?.key)
      })
    })

    describe('tagQueryMode = "any"', () => {
      it('should find records that contain ANY of the specified tags', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['music', 'politics'] },
          'any' // tagQueryMode
        )

        expect(results).toHaveLength(4) // music-track, video-clip, news-article, mixed-content
        const keys = results.map(r => r.key)
        expect(keys).toEqual(
          expect.arrayContaining(['music-track', 'video-clip', 'news-article', 'mixed-content'])
        )
      })

      it('should find all records with a common tag', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['music'] },
          'any'
        )

        expect(results).toHaveLength(3) // music-track, video-clip, mixed-content
        const keys = results.map(r => r.key)
        expect(keys).toEqual(
          expect.arrayContaining(['music-track', 'video-clip', 'mixed-content'])
        )
      })

      it('should return empty array when no records contain ANY of the tags', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['nonexistent-tag', 'another-missing-tag'] },
          'any'
        )

        expect(results).toHaveLength(0)
      })

      it('should work with single tag in "any" mode', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['tech'] },
          'any'
        )

        expect(results).toHaveLength(1)
        expect(results[0].key).toBe('tech-review')
      })
    })

    describe('Combined with other filters', () => {
      it('should combine tagQueryMode "all" with key filter', async () => {
        const results = await storageManager.findWithFilters(
          { 
            key: 'music-track',
            tags: ['music', 'rock'] 
          },
          'all'
        )

        expect(results).toHaveLength(1)
        expect(results[0].key).toBe('music-track')
      })

      it('should combine tagQueryMode "any" with controller filter', async () => {
        const results = await storageManager.findWithFilters(
          { 
            controller: 'controller2',
            tags: ['music', 'politics'] // Only video-clip (controller2) has 'music'
          },
          'any'
        )

        expect(results).toHaveLength(1)
        expect(results[0].key).toBe('video-clip')
        expect(results[0].controller).toBe('controller2')
      })

      it('should work with pagination in tag queries', async () => {
        const results = await storageManager.findWithFilters(
          { tags: ['music'] },
          'any',
          2, // limit
          0, // skip
          'desc' // sortOrder
        )

        expect(results).toHaveLength(2)
        expect(results.every(r => r.tags?.includes('music'))).toBe(true)
      })
    })

    describe('Edge cases', () => {
      it('should handle empty tags array', async () => {
        const results = await storageManager.findWithFilters(
          { tags: [] },
          'all'
        )

        // Empty tags should return all records (no tag filter applied)
        expect(results).toHaveLength(5)
      })

      it('should handle records without tags when querying with tagQueryMode', async () => {
        // Add a record without tags
        const recordWithoutTags = KVStoreRecordFactory.create({ key: 'no-tags-record' })
        await storageManager.storeRecord(
          recordWithoutTags.txid,
          recordWithoutTags.outputIndex,
          recordWithoutTags.key,
          recordWithoutTags.protocolID,
          recordWithoutTags.controller
          // No tags parameter
        )

        const results = await storageManager.findWithFilters(
          { tags: ['music'] },
          'any'
        )

        // Should only return records with tags that match
        expect(results).toHaveLength(3)
        expect(results.every(r => r.tags?.includes('music'))).toBe(true)
        expect(results.map(r => r.key)).not.toContain('no-tags-record')
      })
    })
  })
})
