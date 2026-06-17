import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { BanService } from '../BanService.js'
import { BanAwareSHIPStorage, BanAwareSLAPStorage } from '../BanAwareDiscoveryStorage.js'

describe('BanAwareDiscoveryStorage', () => {
  let mockBanService: jest.Mocked<BanService>
  let mockLogger: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockBanService = {
      isOutpointBanned: jest.fn<any>().mockResolvedValue(false),
      isDomainBanned: jest.fn<any>().mockResolvedValue(false)
    } as any
    mockLogger = {
      log: jest.fn()
    }
  })

  describe('BanAwareSHIPStorage', () => {
    it('should block banned outpoints', async () => {
      const wrapped = {
        storeSHIPRecord: jest.fn<any>().mockResolvedValue(undefined)
      }
      mockBanService.isOutpointBanned.mockResolvedValue(true)
      const storage = new BanAwareSHIPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.storeSHIPRecord('txid', 1, 'identity', 'https://good.example', 'tm_users')

      expect(wrapped.storeSHIPRecord).not.toHaveBeenCalled()
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('banned outpoint'))
    })

    it('should block banned domains', async () => {
      const wrapped = {
        storeSHIPRecord: jest.fn<any>().mockResolvedValue(undefined)
      }
      mockBanService.isDomainBanned.mockResolvedValue(true)
      const storage = new BanAwareSHIPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.storeSHIPRecord('txid', 1, 'identity', 'https://banned.example', 'tm_users')

      expect(wrapped.storeSHIPRecord).not.toHaveBeenCalled()
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('banned domain'))
    })

    it('should delegate when not banned', async () => {
      const wrapped = {
        storeSHIPRecord: jest.fn<any>().mockResolvedValue(undefined)
      }
      const storage = new BanAwareSHIPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.storeSHIPRecord('txid', 1, 'identity', 'https://good.example', 'tm_users')

      expect(wrapped.storeSHIPRecord).toHaveBeenCalledWith('txid', 1, 'identity', 'https://good.example', 'tm_users')
    })

    it('should delegate read and delete methods', async () => {
      const wrapped = {
        ensureIndexes: jest.fn<any>().mockResolvedValue(undefined),
        hasDuplicateRecord: jest.fn<any>().mockResolvedValue(true),
        deleteSHIPRecord: jest.fn<any>().mockResolvedValue(undefined),
        findRecord: jest.fn<any>().mockResolvedValue([{ txid: 'a', outputIndex: 1 }]),
        findAll: jest.fn<any>().mockResolvedValue([{ txid: 'b', outputIndex: 2 }])
      }
      const storage = new BanAwareSHIPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.ensureIndexes()
      await expect(storage.hasDuplicateRecord('identity', 'https://good.example', 'tm_users')).resolves.toBe(true)
      await storage.deleteSHIPRecord('txid', 1)
      await expect(storage.findRecord({ domain: 'https://good.example' })).resolves.toEqual([{ txid: 'a', outputIndex: 1 }])
      await expect(storage.findAll(10, 0, 'desc')).resolves.toEqual([{ txid: 'b', outputIndex: 2 }])
    })
  })

  describe('BanAwareSLAPStorage', () => {
    it('should block banned outpoints', async () => {
      const wrapped = {
        storeSLAPRecord: jest.fn<any>().mockResolvedValue(undefined)
      }
      mockBanService.isOutpointBanned.mockResolvedValue(true)
      const storage = new BanAwareSLAPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.storeSLAPRecord('txid', 1, 'identity', 'https://good.example', 'ls_users')

      expect(wrapped.storeSLAPRecord).not.toHaveBeenCalled()
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('banned outpoint'))
    })

    it('should block banned domains', async () => {
      const wrapped = {
        storeSLAPRecord: jest.fn<any>().mockResolvedValue(undefined)
      }
      mockBanService.isDomainBanned.mockResolvedValue(true)
      const storage = new BanAwareSLAPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.storeSLAPRecord('txid', 1, 'identity', 'https://banned.example', 'ls_users')

      expect(wrapped.storeSLAPRecord).not.toHaveBeenCalled()
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('banned domain'))
    })

    it('should delegate when not banned', async () => {
      const wrapped = {
        storeSLAPRecord: jest.fn<any>().mockResolvedValue(undefined)
      }
      const storage = new BanAwareSLAPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.storeSLAPRecord('txid', 1, 'identity', 'https://good.example', 'ls_users')

      expect(wrapped.storeSLAPRecord).toHaveBeenCalledWith('txid', 1, 'identity', 'https://good.example', 'ls_users')
    })

    it('should delegate read and delete methods', async () => {
      const wrapped = {
        ensureIndexes: jest.fn<any>().mockResolvedValue(undefined),
        hasDuplicateRecord: jest.fn<any>().mockResolvedValue(true),
        deleteSLAPRecord: jest.fn<any>().mockResolvedValue(undefined),
        findRecord: jest.fn<any>().mockResolvedValue([{ txid: 'a', outputIndex: 1 }]),
        findAll: jest.fn<any>().mockResolvedValue([{ txid: 'b', outputIndex: 2 }])
      }
      const storage = new BanAwareSLAPStorage(wrapped as any, mockBanService, mockLogger)

      await storage.ensureIndexes()
      await expect(storage.hasDuplicateRecord('identity', 'https://good.example', 'ls_users')).resolves.toBe(true)
      await storage.deleteSLAPRecord('txid', 1)
      await expect(storage.findRecord({ domain: 'https://good.example' })).resolves.toEqual([{ txid: 'a', outputIndex: 1 }])
      await expect(storage.findAll(10, 0, 'desc')).resolves.toEqual([{ txid: 'b', outputIndex: 2 }])
    })
  })
})
