/* eslint-disable no-new */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Collection, Db } from 'mongodb'
import { IdentityStorageManager } from '../backend/src/IdentityStorageManager'
import { IdentityRecord, IdentityAttributes } from '../backend/src/types'
import { Certificate } from '@bsv/sdk'

describe('IdentityStorageManager', () => {
  let mockDb: jest.Mocked<Db>
  let mockCollection: jest.Mocked<Collection<IdentityRecord>>
  let manager: IdentityStorageManager

  beforeAll(() => {
    // Prepare a mocked Db and Collection
    mockCollection = {
      createIndex: jest.fn().mockResolvedValue('indexName'),
      insertOne: jest.fn().mockResolvedValue({ acknowledged: true, insertedId: 'mockId' }),
      deleteOne: jest.fn().mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
      find: jest.fn(),
      project: jest.fn(),
      toArray: jest.fn()
    } as any

    // The `find` method returns a cursor-like object which can chain `project(...).toArray()`
    const mockCursor = {
      project: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([])
    }
    mockCollection.find.mockReturnValue(mockCursor as any)

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection)
    } as any
  })

  beforeEach(() => {
    jest.clearAllMocks()
    manager = new IdentityStorageManager(mockDb)
  })

  describe('constructor', () => {
    it('should create and store the collection', () => {
      expect(mockDb.collection).toHaveBeenCalledWith('identityRecords')
    })

    it('should create indexes for common lookup query patterns', () => {
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ txid: 1, outputIndex: 1 }, { unique: true })
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ 'certificate.serialNumber': 1 })
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ 'certificate.subject': 1 })
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ 'certificate.certifier': 1 })
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ 'certificate.subject': 1, 'certificate.certifier': 1 })
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ 'certificate.subject': 1, 'certificate.type': 1 })
    })

    it('should create a text index on searchableAttributes', () => {
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ searchableAttributes: 'text' })
    })
  })

  describe('storeRecord', () => {
    it('should insert a new record into the collection', async () => {
      const txid = 'someTxid'
      const outputIndex = 1
      const certificate = new Certificate(
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 32 bytes base64
        'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', // 32 bytes base64
        '022222222222222222222222222222222222222222222222222222222222222222', // subject (33 bytes hex)
        '033333333333333333333333333333333333333333333333333333333333333333', // certifier (33 bytes hex)
        'revocationTxid.0',
        {
          firstName: 'Alice',
          lastName: 'Example',
          profilePhoto: 'someBase64Photo',
          icon: 'someBase64Icon'
        },
        '3045022100abcdef...'
      )

      await manager.storeRecord(txid, outputIndex, certificate)

      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1)
      const insertArg = mockCollection.insertOne.mock.calls[0][0]
      expect(insertArg.txid).toEqual(txid)
      expect(insertArg.outputIndex).toEqual(outputIndex)
      expect(insertArg.certificate).toEqual(certificate)
      expect(insertArg.createdAt).toBeInstanceOf(Date)

      // Ensure profilePhoto and icon do NOT appear in searchableAttributes
      expect(insertArg.searchableAttributes).toContain('Alice')
      expect(insertArg.searchableAttributes).toContain('Example')
      expect(insertArg.searchableAttributes).not.toContain('someBase64Photo')
      expect(insertArg.searchableAttributes).not.toContain('someBase64Icon')
    })
  })

  describe('deleteRecord', () => {
    it('should delete a matching record from the collection', async () => {
      const txid = 'txidForDelete'
      const outputIndex = 2

      await manager.deleteRecord(txid, outputIndex)

      expect(mockCollection.deleteOne).toHaveBeenCalledTimes(1)
      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ txid, outputIndex })
    })
  })

  describe('findByAttribute', () => {
    it('should return empty array if attributes is empty or undefined', async () => {
      const res1 = await manager.findByAttribute({}, ['cert1'])
      const res2 = await manager.findByAttribute(undefined as any, ['cert1'])
      expect(res1).toEqual([])
      expect(res2).toEqual([])
      expect(mockCollection.find).not.toHaveBeenCalled()
    })

    it('should call findRecordWithQuery with "any" attribute for fuzzy search', async () => {
      const attributes: IdentityAttributes = { any: 'Alice' }
      const certifiers = ['cert1']

      // Setup mock to return a known array
      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'txidA', outputIndex: 0 },
          { txid: 'txidB', outputIndex: 1 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await manager.findByAttribute(attributes, certifiers)
      expect(mockCollection.find).toHaveBeenCalledTimes(1)
      expect(results).toEqual([
        { txid: 'txidA', outputIndex: 0 },
        { txid: 'txidB', outputIndex: 1 }
      ])
    })

    it('should handle specific attributes (non-"any")', async () => {
      const attributes: IdentityAttributes = { firstName: 'Alice', lastName: 'Test' }
      const certifiers = ['cert1', 'cert2']

      // Setup mock
      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'txidC', outputIndex: 2 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await manager.findByAttribute(attributes, certifiers)
      expect(results).toEqual([{ txid: 'txidC', outputIndex: 2 }])

      // Check that find was called with a query that includes $and
      expect(mockCollection.find).toHaveBeenCalled()
      // We won't deep-equal the exact query object; we just check it was used
    })
  })

  describe('findByIdentityKey', () => {
    it('should return empty array if identityKey is undefined', async () => {
      const results = await manager.findByIdentityKey(undefined as any)
      expect(results).toEqual([])
      expect(mockCollection.find).not.toHaveBeenCalled()
    })

    it('should construct query and call findRecordWithQuery', async () => {
      const identityKey = '022222222222222222222222222222222222222222222222222222222222222222'
      const certifiers = ['033333333333333333333333333333333333333333333333333333333333333333']

      // Setup mock
      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'testTxid', outputIndex: 9 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await manager.findByIdentityKey(identityKey, certifiers)
      expect(mockCollection.find).toHaveBeenCalled()
      expect(results).toEqual([{ txid: 'testTxid', outputIndex: 9 }])
    })
  })

  describe('findByCertifier', () => {
    it('should return empty array if certifiers is undefined or empty', async () => {
      const result1 = await manager.findByCertifier(undefined as any)
      const result2 = await manager.findByCertifier([])

      expect(result1).toEqual([])
      expect(result2).toEqual([])
      expect(mockCollection.find).not.toHaveBeenCalled()
    })

    it('should find records by certifiers', async () => {
      const certifiers = [
        '033333333333333333333333333333333333333333333333333333333333333333',
        '044444444444444444444444444444444444444444444444444444444444444444'
      ]
      // Setup mock
      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'certTxid1', outputIndex: 0 },
          { txid: 'certTxid2', outputIndex: 1 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await manager.findByCertifier(certifiers)
      expect(mockCollection.find).toHaveBeenCalled()
      expect(results).toEqual([
        { txid: 'certTxid1', outputIndex: 0 },
        { txid: 'certTxid2', outputIndex: 1 }
      ])
    })
  })

  describe('findByCertificateType', () => {
    it('should return empty array if required parameters are missing or empty', async () => {
      const result1 = await manager.findByCertificateType(undefined as any, 'someKey', ['cert1'])
      const result2 = await manager.findByCertificateType([], 'someKey', ['cert1'])
      const result3 = await manager.findByCertificateType(['type1'], undefined as any, ['cert1'])
      expect(result1).toEqual([])
      expect(result2).toEqual([])
      expect(result3).toEqual([])
      expect(mockCollection.find).not.toHaveBeenCalled()
    })

    it('should find by certificateType, identityKey, and certifiers', async () => {
      const types = ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
      const identityKey = '022222222222222222222222222222222222222222222222222222222222222222'
      const certifiers = ['033333333333333333333333333333333333333333333333333333333333333333']

      // Setup mock
      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'typeTxid', outputIndex: 7 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await manager.findByCertificateType(types, identityKey, certifiers)
      expect(mockCollection.find).toHaveBeenCalled()
      expect(results).toEqual([{ txid: 'typeTxid', outputIndex: 7 }])
    })

    it('should find by certificateType and identityKey without certifiers (across certifiers)', async () => {
      const types = ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
      const identityKey = '022222222222222222222222222222222222222222222222222222222222222222'

      // Setup mock
      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'typeTxidNoCertifier', outputIndex: 8 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await manager.findByCertificateType(types, identityKey)
      expect(mockCollection.find).toHaveBeenCalledWith({
        'certificate.subject': identityKey,
        'certificate.type': { $in: types }
      })
      expect(results).toEqual([{ txid: 'typeTxidNoCertifier', outputIndex: 8 }])
    })
  })

  describe('findByCertificateSerialNumber', () => {
    it('should return empty array if serialNumber is undefined or empty string', async () => {
      const result1 = await manager.findByCertificateSerialNumber(undefined as any)
      const result2 = await manager.findByCertificateSerialNumber('')
      expect(result1).toEqual([])
      expect(result2).toEqual([])
      expect(mockCollection.find).not.toHaveBeenCalled()
    })

    it('should find by certificate.serialNumber', async () => {
      const serialNumber = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

      // Setup mock
      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ txid: 'snTxid', outputIndex: 11 }])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await manager.findByCertificateSerialNumber(serialNumber)
      expect(mockCollection.find).toHaveBeenCalled()
      expect(results).toEqual([{ txid: 'snTxid', outputIndex: 11 }])
    })
  })

  describe('Integration of findRecordWithQuery', () => {
    it('should query the DB, project, and map results to UTXOReference', async () => {
      const testQuery = { 'certificate.certifier': { $in: ['fakeCertifier'] } }

      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'qTxid1', outputIndex: 9 },
          { txid: 'qTxid2', outputIndex: 10 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      // We can simulate calling findByCertifier or directly do an "as any" hack:
      const results = await (manager as any).findRecordWithQuery(testQuery)
      expect(mockCollection.find).toHaveBeenCalledWith(testQuery)
      expect(mockCursor.project).toHaveBeenCalledWith({ txid: 1, outputIndex: 1 })
      expect(results).toEqual([
        { txid: 'qTxid1', outputIndex: 9 },
        { txid: 'qTxid2', outputIndex: 10 }
      ])
    })

    it('should apply limit and offset to cursor when provided', async () => {
      const testQuery = { 'certificate.subject': 'someIdentityKey' }

      const mockCursor = {
        project: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { txid: 'qTxid3', outputIndex: 11 }
        ])
      }
      mockCollection.find.mockReturnValue(mockCursor as any)

      const results = await (manager as any).findRecordWithQuery(testQuery, 3, 4)
      expect(mockCollection.find).toHaveBeenCalledWith(testQuery)
      expect(mockCursor.project).toHaveBeenCalledWith({ txid: 1, outputIndex: 1 })
      expect(mockCursor.limit).toHaveBeenCalledWith(3)
      expect(mockCursor.skip).toHaveBeenCalledWith(4)
      expect(results).toEqual([
        { txid: 'qTxid3', outputIndex: 11 }
      ])
    })
  })
})
