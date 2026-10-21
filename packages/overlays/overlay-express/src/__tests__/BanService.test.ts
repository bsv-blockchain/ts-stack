import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { BanService } from '../BanService.js'
import { Db } from 'mongodb'

const TXID_A = 'ab'.repeat(32)
const TXID_B = 'cd'.repeat(32)
const TXID_C = 'ef'.repeat(32)

describe('BanService', () => {
  let banService: BanService
  let mockCollection: any
  let mockDb: Db

  beforeEach(() => {
    jest.clearAllMocks()

    mockCollection = {
      createIndex: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      updateOne: jest.fn<(...args: any[]) => any>().mockResolvedValue({}),
      deleteOne: jest.fn<(...args: any[]) => any>().mockResolvedValue({}),
      findOne: jest.fn<(...args: any[]) => any>().mockResolvedValue(null),
      find: jest.fn<(...args: any[]) => any>().mockReturnValue({
        sort: jest.fn<(...args: any[]) => any>().mockReturnValue({
          toArray: jest.fn<(...args: any[]) => any>().mockResolvedValue([])
        })
      }),
      countDocuments: jest.fn<(...args: any[]) => any>().mockResolvedValue(0)
    }

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection)
    } as unknown as Db

    banService = new BanService(mockDb)
  })

  describe('constructor', () => {
    it('should initialize with the bannedRecords collection', () => {
      expect(mockDb.collection).toHaveBeenCalledWith('bannedRecords')
    })
  })

  describe('ensureIndexes', () => {
    it('should create unique compound index on type+value and index on bannedAt', async () => {
      await banService.ensureIndexes()

      expect(mockCollection.createIndex).toHaveBeenCalledTimes(2)
      expect(mockCollection.createIndex).toHaveBeenCalledWith(
        { type: 1, value: 1 },
        { unique: true }
      )
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ bannedAt: -1 })
    })
  })

  describe('banDomain', () => {
    it('should upsert a domain ban with default reason', async () => {
      await banService.banDomain('https://bad-host.com')

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { type: 'domain', value: 'https://bad-host.com' },
        {
          $set: expect.objectContaining({
            type: 'domain',
            value: 'https://bad-host.com',
            reason: 'Manually banned',
            bannedBy: undefined
          })
        },
        { upsert: true }
      )
    })

    it('should use custom reason and bannedBy', async () => {
      await banService.banDomain('https://spam.com', 'Spam host', 'admin-key-123')

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { type: 'domain', value: 'https://spam.com' },
        {
          $set: expect.objectContaining({
            reason: 'Spam host',
            bannedBy: 'admin-key-123'
          })
        },
        { upsert: true }
      )
    })

    it('should reject non-string domain (NoSQL injection prevention)', async () => {
      await expect(banService.banDomain({ $ne: '' } as any)).rejects.toThrow(
        'Invalid input: expected a string value'
      )
    })
  })

  describe('unbanDomain', () => {
    it('should delete a domain ban', async () => {
      await banService.unbanDomain('https://unbanned.com')

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({
        type: 'domain',
        value: 'https://unbanned.com'
      })
    })

    it('should reject non-string domain', async () => {
      await expect(banService.unbanDomain({ $ne: '' } as any)).rejects.toThrow(
        'Invalid input: expected a string value'
      )
    })
  })

  describe('isDomainBanned', () => {
    it('should return true when domain is banned', async () => {
      mockCollection.findOne.mockResolvedValue({ type: 'domain', value: 'https://banned.com' })

      const result = await banService.isDomainBanned('https://banned.com')

      expect(result).toBe(true)
      expect(mockCollection.findOne).toHaveBeenCalledWith({
        type: 'domain',
        value: 'https://banned.com'
      })
    })

    it('should return false when domain is not banned', async () => {
      mockCollection.findOne.mockResolvedValue(null)

      const result = await banService.isDomainBanned('https://good-host.com')

      expect(result).toBe(false)
    })

    it('should reject non-string domain', async () => {
      await expect(banService.isDomainBanned(123 as any)).rejects.toThrow(
        'Invalid input: expected a string value'
      )
    })
  })

  describe('banOutpoint', () => {
    it('should upsert an outpoint ban with formatted value', async () => {
      await banService.banOutpoint(TXID_A, 0)

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { type: 'outpoint', value: `${TXID_A}.0` },
        {
          $set: expect.objectContaining({
            type: 'outpoint',
            value: `${TXID_A}.0`,
            domain: undefined,
            reason: 'Manually banned'
          })
        },
        { upsert: true }
      )
    })

    it('should include domain, reason, and bannedBy when provided', async () => {
      await banService.banOutpoint(TXID_B, 2, 'Stale token', 'https://host.com', 'admin-key')

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { type: 'outpoint', value: `${TXID_B}.2` },
        {
          $set: expect.objectContaining({
            value: `${TXID_B}.2`,
            domain: 'https://host.com',
            reason: 'Stale token',
            bannedBy: 'admin-key'
          })
        },
        { upsert: true }
      )
    })

    it('should reject non-string txid', async () => {
      await expect(banService.banOutpoint({ $ne: '' } as any, 0)).rejects.toThrow(
        'Invalid input: expected a string value'
      )
    })
  })

  describe('unbanOutpoint', () => {
    it('should delete an outpoint ban', async () => {
      await banService.unbanOutpoint(TXID_C, 1)

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({
        type: 'outpoint',
        value: `${TXID_C}.1`
      })
    })

    it('should reject non-string txid', async () => {
      await expect(banService.unbanOutpoint(42 as any, 0)).rejects.toThrow(
        'Invalid input: expected a string value'
      )
    })
  })

  describe('isOutpointBanned', () => {
    it('should return true when outpoint is banned', async () => {
      mockCollection.findOne.mockResolvedValue({ type: 'outpoint', value: `${TXID_A}.0` })

      const result = await banService.isOutpointBanned(TXID_A, 0)

      expect(result).toBe(true)
      expect(mockCollection.findOne).toHaveBeenCalledWith({
        type: 'outpoint',
        value: `${TXID_A}.0`
      })
    })

    it('should return false when outpoint is not banned', async () => {
      mockCollection.findOne.mockResolvedValue(null)

      const result = await banService.isOutpointBanned(TXID_B, 5)

      expect(result).toBe(false)
    })

    it('should reject non-string txid', async () => {
      await expect(banService.isOutpointBanned(null as any, 0)).rejects.toThrow(
        'Invalid input: expected a string value'
      )
    })
  })

  describe('listBans', () => {
    it('should list all bans when no type filter is provided', async () => {
      const mockBans = [
        { type: 'domain', value: 'https://a.com', bannedAt: new Date() },
        { type: 'outpoint', value: 'tx.0', bannedAt: new Date() }
      ]
      mockCollection.find.mockReturnValue({
        sort: jest.fn<(...args: any[]) => any>().mockReturnValue({
          toArray: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockBans)
        })
      })

      const result = await banService.listBans()

      expect(result).toEqual(mockBans)
      expect(mockCollection.find).toHaveBeenCalledWith({})
    })

    it('should filter by type when provided', async () => {
      mockCollection.find.mockReturnValue({
        sort: jest.fn<(...args: any[]) => any>().mockReturnValue({
          toArray: jest.fn<(...args: any[]) => any>().mockResolvedValue([])
        })
      })

      await banService.listBans('domain')

      expect(mockCollection.find).toHaveBeenCalledWith({ type: 'domain' })
    })

    it('should filter by outpoint type', async () => {
      mockCollection.find.mockReturnValue({
        sort: jest.fn<(...args: any[]) => any>().mockReturnValue({
          toArray: jest.fn<(...args: any[]) => any>().mockResolvedValue([])
        })
      })

      await banService.listBans('outpoint')

      expect(mockCollection.find).toHaveBeenCalledWith({ type: 'outpoint' })
    })

    it('should apply bounded pagination to MongoDB', async () => {
      const toArray = jest.fn<(...args: any[]) => any>().mockResolvedValue([])
      const limit = jest.fn<(...args: any[]) => any>().mockReturnValue({ toArray, limit: jest.fn(), skip: jest.fn() })
      const skip = jest.fn<(...args: any[]) => any>().mockReturnValue({ limit, toArray, skip: jest.fn() })
      mockCollection.find.mockReturnValue({
        sort: jest.fn<(...args: any[]) => any>().mockReturnValue({ skip, limit, toArray })
      })

      await banService.listBans('domain', 25, 50)

      expect(skip).toHaveBeenCalledWith(50)
      expect(limit).toHaveBeenCalledWith(25)
      expect(toArray).toHaveBeenCalled()
    })

    it.each([
      [0, 0],
      [1.5, 0],
      [10, -1],
      [10, 1.5]
    ])('rejects invalid pagination limit=%s skip=%s', async (limit, skip) => {
      await expect(banService.listBans(undefined, limit, skip)).rejects.toThrow(TypeError)
    })
  })

  describe('removeBan', () => {
    it('should delete a ban by type and value', async () => {
      await banService.removeBan('domain', 'https://remove-me.com')

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({
        type: 'domain',
        value: 'https://remove-me.com'
      })
    })

    it('should delete an outpoint ban', async () => {
      await banService.removeBan('outpoint', `${TXID_A}.0`)

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({
        type: 'outpoint',
        value: `${TXID_A}.0`
      })
    })

    it('should reject non-string type (NoSQL injection prevention)', async () => {
      await expect(banService.removeBan({ $ne: '' } as any, 'value')).rejects.toThrow(
        'Invalid ban type'
      )
    })

    it('should reject non-string value (NoSQL injection prevention)', async () => {
      await expect(banService.removeBan('domain', { $ne: '' } as any)).rejects.toThrow(
        'Invalid input: expected a string value'
      )
    })
  })

  describe('getStats', () => {
    it('should return ban counts', async () => {
      mockCollection.countDocuments
        .mockResolvedValueOnce(5) // domain count
        .mockResolvedValueOnce(3) // outpoint count

      const stats = await banService.getStats()

      expect(stats).toEqual({
        domainBans: 5,
        outpointBans: 3,
        totalBans: 8
      })
      expect(mockCollection.countDocuments).toHaveBeenCalledWith({ type: 'domain' })
      expect(mockCollection.countDocuments).toHaveBeenCalledWith({ type: 'outpoint' })
    })

    it('should return zero counts when no bans exist', async () => {
      const stats = await banService.getStats()

      expect(stats).toEqual({
        domainBans: 0,
        outpointBans: 0,
        totalBans: 0
      })
    })
  })
})
