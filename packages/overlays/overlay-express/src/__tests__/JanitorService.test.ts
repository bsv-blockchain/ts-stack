import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { JanitorService } from '../JanitorService.js'
import { Db } from 'mongodb'

// Mock fetch globally
global.fetch = jest.fn() as any

describe('JanitorService', () => {
  let mockDb: Db
  let mockCollection: any
  let mockLogger: any

  beforeEach(() => {
    jest.clearAllMocks()

    mockCollection = {
      find: jest.fn().mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([] as any)
      }),
      updateOne: jest.fn<any>().mockResolvedValue({} as any),
      deleteOne: jest.fn<any>().mockResolvedValue({} as any)
    }

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection)
    } as unknown as Db

    mockLogger = {
      log: jest.fn(),
      error: jest.fn()
    }
  })

  describe('constructor', () => {
    it('should create instance with required config', () => {
      const janitor = new JanitorService({
        mongoDb: mockDb
      })

      expect(janitor).toBeInstanceOf(JanitorService)
    })

    it('should use default values when not provided', () => {
      const janitor = new JanitorService({
        mongoDb: mockDb
      })

      expect(janitor).toBeDefined()
    })

    it('should use custom logger when provided', () => {
      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      expect(janitor).toBeDefined()
    })

    it('should use custom timeout and revoke score', () => {
      const janitor = new JanitorService({
        mongoDb: mockDb,
        requestTimeoutMs: 5000,
        hostDownRevokeScore: 5
      })

      expect(janitor).toBeDefined()
    })
  })

  describe('run', () => {
    it('should check both SHIP and SLAP collections', async () => {
      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockDb.collection).toHaveBeenCalledWith('shipRecords')
      expect(mockDb.collection).toHaveBeenCalledWith('slapRecords')
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Running janitor'))
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('completed'))
    })

    it('should handle errors during health checks', async () => {
      (mockDb as any).collection = jest.fn().mockImplementation(() => {
        throw new Error('Database error')
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('should process empty collections without errors', async () => {
      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('completed'))
    })
  })

  describe('output processing', () => {
    it('should process output with domain field', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).toHaveBeenCalled()
    })

    it('should process output with url field', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        url: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).toHaveBeenCalled()
    })

    it('should process output with serviceURL field', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        serviceURL: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).toHaveBeenCalled()
    })

    it('should process output with protocols array', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        protocols: ['https://example.com', 'http://other.com'],
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).toHaveBeenCalled()
    })

    it('should skip output without valid URL', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  describe('domain validation', () => {
    it('should accept valid domain', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://valid-domain.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).toHaveBeenCalled()
    })

    it('should reject invalid domain and increment down counter', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'invalid domain!@#',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: '123' },
        { $inc: { down: 1 } }
      )
    })

    it('should accept localhost', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'http://localhost:3000',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).toHaveBeenCalled()
    })

    it('should accept IP address', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'http://192.168.1.1',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(global.fetch).toHaveBeenCalled()
    })
  })

  describe('health check', () => {
    it('should mark output as healthy when health check passes', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 2
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: '123' },
        { $inc: { down: -1 } }
      )
    })

    it('should not decrement when already at 0', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockCollection.updateOne).not.toHaveBeenCalled()
    })

    it('should increment down counter when health check fails', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: false
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: '123' },
        { $inc: { down: 1 } }
      )
    })

    it('should delete output when down count reaches threshold', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 2
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: false
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger,
        hostDownRevokeScore: 3
      })

      await janitor.run()

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: '123' })
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Removing output'))
    })

    it('should handle fetch timeout', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      ;(global.fetch as jest.Mock<any>).mockRejectedValue(abortError)

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger,
        requestTimeoutMs: 1000
      })

      await janitor.run()

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: '123' },
        { $inc: { down: 1 } }
      )
    })

    it('should handle fetch errors', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockRejectedValue(new Error('Network error'))

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: '123' },
        { $inc: { down: 1 } }
      )
    })

    it('should handle invalid JSON response', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockRejectedValue(new Error('Invalid JSON'))
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: '123' },
        { $inc: { down: 1 } }
      )
    })

    it('should verify health endpoint returns status: ok', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 1
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: jest.fn<any>().mockResolvedValue({ status: 'error' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.run()

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: '123' },
        { $inc: { down: 1 } }
      )
    })
  })

  describe('checkHost', () => {
    it('should return healthy when health endpoint returns ok', async () => {
      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const result = await janitor.checkHost('https://example.com')

      expect(result.healthy).toBe(true)
      expect(result.statusCode).toBe(200)
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('should return unhealthy for invalid domain', async () => {
      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const result = await janitor.checkHost('invalid domain!@#')

      expect(result.healthy).toBe(false)
      expect(result.error).toBe('Invalid domain')
    })

    it('should return unhealthy when health endpoint returns non-ok status', async () => {
      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: false,
        status: 503
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const result = await janitor.checkHost('https://example.com')

      expect(result.healthy).toBe(false)
      expect(result.statusCode).toBe(503)
      expect(result.error).toBe('HTTP 503')
    })

    it('should return unhealthy when response does not have status ok', async () => {
      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn<any>().mockResolvedValue({ status: 'error' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const result = await janitor.checkHost('https://example.com')

      expect(result.healthy).toBe(false)
      expect(result.error).toBe('Unexpected response')
    })

    it('should handle timeout (AbortError)', async () => {
      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      ;(global.fetch as jest.Mock<any>).mockRejectedValue(abortError)

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger,
        requestTimeoutMs: 100
      })

      const result = await janitor.checkHost('https://example.com')

      expect(result.healthy).toBe(false)
      expect(result.error).toBe('Timeout')
    })

    it('should handle network errors', async () => {
      ;(global.fetch as jest.Mock<any>).mockRejectedValue(new Error('ECONNREFUSED'))

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const result = await janitor.checkHost('https://example.com')

      expect(result.healthy).toBe(false)
      expect(result.error).toBe('ECONNREFUSED')
    })

    it('should prepend https:// to domains without protocol', async () => {
      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      await janitor.checkHost('example.com')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/health',
        expect.any(Object)
      )
    })
  })

  describe('getHealthStatus', () => {
    it('should return health status for ship and slap records', async () => {
      const shipOutput = {
        txid: 'ship-tx',
        outputIndex: 0,
        domain: 'https://ship.example.com',
        topic: 'tm_ship',
        identityKey: 'key1',
        createdAt: new Date(),
        down: 1
      }
      const slapOutput = {
        txid: 'slap-tx',
        outputIndex: 1,
        domain: 'https://slap.example.com',
        service: 'ls_slap',
        identityKey: 'key2',
        createdAt: new Date(),
        down: 0
      }

      // First call returns ship records, second returns slap records
      let callCount = 0
      mockCollection.find.mockImplementation(() => ({
        toArray: jest.fn<any>().mockResolvedValue(callCount++ === 0 ? [shipOutput] : [slapOutput])
      }))

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const result = await janitor.getHealthStatus()

      expect(result.ship).toHaveLength(1)
      expect(result.ship[0].txid).toBe('ship-tx')
      expect(result.ship[0].downCount).toBe(1)
      expect(result.slap).toHaveLength(1)
      expect(result.slap[0].txid).toBe('slap-tx')
      expect(result.slap[0].downCount).toBe(0)
    })

    it('should return empty arrays when no records exist', async () => {
      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const result = await janitor.getHealthStatus()

      expect(result.ship).toEqual([])
      expect(result.slap).toEqual([])
    })
  })

  describe('ban service integration', () => {
    it('should auto-ban domain and outpoint when threshold is reached', async () => {
      const mockBanService = {
        banDomain: jest.fn<any>().mockResolvedValue(undefined),
        banOutpoint: jest.fn<any>().mockResolvedValue(undefined)
      }

      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://dead-host.com',
        down: 2
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({ ok: false })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger,
        hostDownRevokeScore: 3,
        banService: mockBanService as any
      })

      await janitor.run()

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: '123' })
      expect(mockBanService.banOutpoint).toHaveBeenCalledWith(
        'abc123',
        0,
        expect.stringContaining('Auto-banned'),
        'https://dead-host.com'
      )
      expect(mockBanService.banDomain).toHaveBeenCalledWith(
        'https://dead-host.com',
        expect.stringContaining('Auto-banned')
      )
    })

    it('should not auto-ban when autoBanOnRemoval is false', async () => {
      const mockBanService = {
        banDomain: jest.fn<any>().mockResolvedValue(undefined),
        banOutpoint: jest.fn<any>().mockResolvedValue(undefined)
      }

      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://dead-host.com',
        down: 2
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({ ok: false })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger,
        hostDownRevokeScore: 3,
        banService: mockBanService as any,
        autoBanOnRemoval: false
      })

      await janitor.run()

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: '123' })
      expect(mockBanService.banOutpoint).not.toHaveBeenCalled()
      expect(mockBanService.banDomain).not.toHaveBeenCalled()
    })

    it('should not ban domain when domain is unknown', async () => {
      const mockBanService = {
        banDomain: jest.fn<any>().mockResolvedValue(undefined),
        banOutpoint: jest.fn<any>().mockResolvedValue(undefined)
      }

      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        down: 2
        // no domain field
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({ ok: false })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger,
        hostDownRevokeScore: 3,
        banService: mockBanService as any
      })

      await janitor.run()

      expect(mockBanService.banOutpoint).toHaveBeenCalled()
      expect(mockBanService.banDomain).not.toHaveBeenCalled()
    })
  })

  describe('run report', () => {
    it('should return a JanitorReport with summary', async () => {
      const mockOutput = {
        _id: '123',
        txid: 'abc123',
        outputIndex: 0,
        domain: 'https://example.com',
        down: 0
      }

      mockCollection.find.mockReturnValue({
        toArray: jest.fn<any>().mockResolvedValue([mockOutput])
      })

      ;(global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn<any>().mockResolvedValue({ status: 'ok' })
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      const report = await janitor.run()

      expect(report.startedAt).toBeInstanceOf(Date)
      expect(report.completedAt).toBeInstanceOf(Date)
      expect(report.durationMs).toBeGreaterThanOrEqual(0)
      expect(report.summary.totalChecked).toBeGreaterThan(0)
      expect(report.summary.removed).toBe(0)
      expect(report.summary.banned).toBe(0)
    })

    it('should handle collection errors gracefully and return empty report', async () => {
      ;(mockDb as any).collection = jest.fn().mockImplementation(() => {
        throw new Error('Database error')
      })

      const janitor = new JanitorService({
        mongoDb: mockDb,
        logger: mockLogger
      })

      // checkTopicOutputs catches errors internally, so run() returns an empty report
      const report = await janitor.run()
      expect(report.summary.totalChecked).toBe(0)
      expect(report.shipResults).toEqual([])
      expect(report.slapResults).toEqual([])
      expect(mockLogger.error).toHaveBeenCalled()
    })
  })
})
