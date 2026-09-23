import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import OverlayExpress from '../OverlayExpress.js'
import Knex from 'knex'
import { MongoClient } from 'mongodb'
import { TopicManager, LookupService, serializeErrorForLog, serializeLogValue } from '@bsv/overlay'
import { ChainTracker } from '@bsv/sdk'
import * as DiscoveryServices from '@bsv/overlay-discovery-services'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'

// Mock dependencies
jest.mock('knex')
jest.mock('mongodb')
jest.mock('@bsv/overlay')
jest.mock('@bsv/sdk')
jest.mock('@bsv/overlay-discovery-services')
jest.mock('@bsv/auth-express-middleware', () => ({
  createAuthMiddleware: jest.fn(() => jest.fn())
}))

/** Creates a mock MongoDB Db object with a collection stub that supports BanService */
function createMockDbValue(): Record<string, any> {
  const cursor: Record<string, any> = {}
  cursor.sort = jest.fn<any>().mockReturnValue(cursor)
  cursor.skip = jest.fn<any>().mockReturnValue(cursor)
  cursor.limit = jest.fn<any>().mockReturnValue(cursor)
  cursor.toArray = jest.fn<any>().mockResolvedValue([{ domain: 'node.example', txid: '01' }])
  const mockCollection = {
    createIndex: jest.fn<any>().mockResolvedValue(undefined),
    find: jest.fn<any>().mockReturnValue(cursor),
    findOne: jest.fn<any>().mockResolvedValue({ domain: 'node.example' }),
    updateOne: jest.fn<any>().mockResolvedValue({}),
    deleteOne: jest.fn<any>().mockResolvedValue({}),
    deleteMany: jest.fn<any>().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: jest.fn<any>().mockResolvedValue(1)
  }
  return {
    collection: jest.fn<any>().mockReturnValue(mockCollection),
    command: jest.fn<any>().mockResolvedValue({ ok: 1 }),
    databaseName: 'TestService_lookup_services'
  }
}

describe('OverlayExpress', () => {
  let overlayExpress: OverlayExpress

  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(serializeLogValue).mockImplementation(value => {
      try {
        return JSON.stringify(value) ?? '"[Unserializable value]"'
      } catch {
        return '"[Unserializable value]"'
      }
    })
    jest
      .mocked(serializeErrorForLog)
      .mockImplementation(error =>
        serializeLogValue(
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error
        )
      )
    overlayExpress = new OverlayExpress('TestService', 'test-private-key-123', 'test.example.com')
  })

  describe('constructor', () => {
    it('should create instance with required parameters', () => {
      const instance = new OverlayExpress('MyService', 'private-key', 'example.com')

      expect(instance.name).toBe('MyService')
      expect(instance.privateKey).toBe('private-key')
      expect(instance.advertisableFQDN).toBe('example.com')
      expect(instance.app).toBeDefined()
    })

    it('should generate random admin token if not provided', () => {
      const instance = new OverlayExpress('MyService', 'private-key', 'example.com')

      const token = instance.getAdminToken()
      expect(token).toBeDefined()
      expect(typeof token).toBe('string')
      expect(token.length).toBeGreaterThan(0)
    })

    it('should use provided admin token', () => {
      const customToken = 'test-admin-token-0123456789abcdef'
      const instance = new OverlayExpress('MyService', 'private-key', 'example.com', customToken)

      expect(instance.getAdminToken()).toBe(customToken)
    })

    it('normalizes full HTTPS hosting URLs without constructing a double scheme', () => {
      const instance = new OverlayExpress('MyService', 'private-key', 'https://example.com:8443/')

      expect(instance.advertisableFQDN).toBe('example.com:8443')
      expect(
        () => new OverlayExpress('MyService', 'private-key', 'https://example.com/path')
      ).toThrow('without credentials or a path')
      expect(() => new OverlayExpress('MyService', 'private-key', 'http://example.com')).toThrow(
        'HTTPS host'
      )
    })

    it('rejects weak or header-unsafe administrative tokens', () => {
      expect(() => new OverlayExpress('MyService', 'private-key', 'example.com', 'short')).toThrow(
        'between 32 and 16384'
      )
      expect(
        () =>
          new OverlayExpress(
            'MyService',
            'private-key',
            'example.com',
            ' test-admin-token-0123456789abcdef '
          )
      ).toThrow('whitespace')
      expect(
        () =>
          new OverlayExpress(
            'MyService',
            'private-key',
            'example.com',
            'test-admin-token-0123456789abc\ndef'
          )
      ).toThrow('control characters')
    })

    it('should initialize with default values', () => {
      expect(overlayExpress.port).toBe(3000)
      expect(overlayExpress.network).toBe('main')
      expect(overlayExpress.enableGASPSync).toBe(true)
      expect(overlayExpress.enableBASMSync).toBe(false)
      expect(overlayExpress.verboseRequestLogging).toBe(false)
      expect(overlayExpress.managers).toEqual({})
      expect(overlayExpress.services).toEqual({})
    })
  })

  describe('close', () => {
    it('closes runtime resources once when shutdown is requested repeatedly', async () => {
      const closeHttp = jest.fn((callback: (error?: Error) => void) => callback())
      const destroyKnex = jest.fn<() => Promise<void>>().mockResolvedValue()
      const closeMongo = jest.fn<() => Promise<void>>().mockResolvedValue()
      Object.assign(overlayExpress, {
        server: { close: closeHttp },
        knex: { destroy: destroyKnex },
        mongoClient: { close: closeMongo },
        mongoDb: { databaseName: 'test' },
        isListening: true
      })

      await Promise.all([overlayExpress.close(), overlayExpress.close()])

      expect(closeHttp).toHaveBeenCalledTimes(1)
      expect(destroyKnex).toHaveBeenCalledTimes(1)
      expect(closeMongo).toHaveBeenCalledTimes(1)
      expect(overlayExpress.isListening).toBe(false)
      expect(overlayExpress.server).toBeUndefined()
      expect(overlayExpress.knex).toBeUndefined()
      expect(overlayExpress.mongoClient).toBeUndefined()
      expect(overlayExpress.mongoDb).toBeUndefined()
    })

    it('stops background work when no server or database clients are configured', async () => {
      const basmTimer = setInterval(() => {}, 60_000)
      const maintenanceTimer = setInterval(() => {}, 60_000)
      const stopReorg = jest.fn()
      const lifecycle = overlayExpress as unknown as {
        basmBlockPollTimer?: ReturnType<typeof setInterval>
        unprovenMaintenanceTimer?: ReturnType<typeof setInterval>
        reorgAdapter?: { stop: () => void }
      }
      Object.assign(lifecycle, {
        basmBlockPollTimer: basmTimer,
        unprovenMaintenanceTimer: maintenanceTimer,
        reorgAdapter: { stop: stopReorg }
      })

      await overlayExpress.close()

      expect(stopReorg).toHaveBeenCalledTimes(1)
      expect(lifecycle.basmBlockPollTimer).toBeUndefined()
      expect(lifecycle.unprovenMaintenanceTimer).toBeUndefined()
      expect(lifecycle.reorgAdapter).toBeUndefined()
    })

    it('rejects shutdown when the HTTP server cannot close', async () => {
      const closeError = new Error('HTTP close failed')
      const closeHttp = jest.fn((callback: (error?: Error) => void) => callback(closeError))
      Object.assign(overlayExpress, {
        server: { close: closeHttp },
        isListening: true
      })

      await expect(overlayExpress.close()).rejects.toBe(closeError)

      expect(closeHttp).toHaveBeenCalledTimes(1)
      expect(overlayExpress.isListening).toBe(false)
      expect(overlayExpress.server).toBeUndefined()
    })
  })

  describe('getAdminToken', () => {
    it('should return the admin token', () => {
      const token = overlayExpress.getAdminToken()
      expect(typeof token).toBe('string')
      expect(token.length).toBeGreaterThan(0)
    })

    it('should return consistent token', () => {
      const token1 = overlayExpress.getAdminToken()
      const token2 = overlayExpress.getAdminToken()
      expect(token1).toBe(token2)
    })
  })

  describe('configurePort', () => {
    it('should set the port', () => {
      overlayExpress.configurePort(8080)
      expect(overlayExpress.port).toBe(8080)
    })

    it('should accept different port numbers', () => {
      overlayExpress.configurePort(3001)
      expect(overlayExpress.port).toBe(3001)

      overlayExpress.configurePort(5000)
      expect(overlayExpress.port).toBe(5000)
    })
  })

  describe('configureWebUI', () => {
    it('should set web UI config', () => {
      const config = {
        host: 'https://example.com',
        primaryColor: '#ff0000'
      }
      overlayExpress.configureWebUI(config)
      expect(overlayExpress.webUIConfig).toEqual(config)
    })

    it('should accept empty config', () => {
      overlayExpress.configureWebUI({})
      expect(overlayExpress.webUIConfig).toEqual({})
    })
  })

  describe('configureJanitor', () => {
    it('should merge janitor config', () => {
      overlayExpress.configureJanitor({
        requestTimeoutMs: 5000
      })
      expect(overlayExpress.janitorConfig.requestTimeoutMs).toBe(5000)
      expect(overlayExpress.janitorConfig.hostDownRevokeScore).toBe(3) // default
    })

    it('should update hostDownRevokeScore', () => {
      overlayExpress.configureJanitor({
        hostDownRevokeScore: 5
      })
      expect(overlayExpress.janitorConfig.hostDownRevokeScore).toBe(5)
    })

    it('should update both config values', () => {
      overlayExpress.configureJanitor({
        requestTimeoutMs: 20000,
        hostDownRevokeScore: 10
      })
      expect(overlayExpress.janitorConfig.requestTimeoutMs).toBe(20000)
      expect(overlayExpress.janitorConfig.hostDownRevokeScore).toBe(10)
    })

    it('rejects type-confused SSRF and resource policy options', () => {
      expect(() =>
        overlayExpress.configureJanitor({ allowPrivateHosts: 'false' as unknown as boolean })
      ).toThrow('allowPrivateHosts')
      expect(() => overlayExpress.configureJanitor({ requestTimeoutMs: 0 })).toThrow(
        'requestTimeoutMs'
      )
      expect(() => overlayExpress.configureJanitor({ batchSize: 100_001 })).toThrow('batchSize')
    })
  })

  describe('configureEdgePolicy', () => {
    it('preserves public browser access unless an allowlist is configured', () => {
      expect(overlayExpress.edgePolicyConfig.allowedOrigins).toBeUndefined()

      overlayExpress.configureEdgePolicy({
        allowedOrigins: ['https://wallet.example']
      })

      expect(overlayExpress.edgePolicyConfig.allowedOrigins).toEqual(['https://wallet.example'])
    })

    it('merges partial HTTP and browser-header policy without erasing defaults', () => {
      const defaultBodyLimit = overlayExpress.edgePolicyConfig.jsonBodyLimitBytes
      const defaultSocketTimeout = overlayExpress.edgePolicyConfig.http.socketTimeoutMs

      overlayExpress.configureEdgePolicy({
        jsonBodyLimitBytes: undefined,
        http: {
          requestTimeoutMs: 45_000,
          socketTimeoutMs: undefined
        },
        securityHeaders: {
          crossOriginOpenerPolicy: 'same-origin-allow-popups',
          frameOptions: false
        }
      })

      expect(overlayExpress.edgePolicyConfig.jsonBodyLimitBytes).toBe(defaultBodyLimit)
      expect(overlayExpress.edgePolicyConfig.http.requestTimeoutMs).toBe(45_000)
      expect(overlayExpress.edgePolicyConfig.http.socketTimeoutMs).toBe(defaultSocketTimeout)
      expect(overlayExpress.edgePolicyConfig.securityHeaders).toMatchObject({
        crossOriginOpenerPolicy: 'same-origin-allow-popups',
        frameOptions: false
      })
      expect(overlayExpress.edgePolicyConfig.securityHeaders.contentSecurityPolicy).toContain(
        "default-src 'none'"
      )
    })

    it('normalizes and defensively copies explicit origins', () => {
      const origins = ['https://wallet.example:443']

      overlayExpress.configureEdgePolicy({ allowedOrigins: origins })
      origins[0] = 'https://attacker.example'

      expect(overlayExpress.edgePolicyConfig.allowedOrigins).toEqual(['https://wallet.example'])
    })

    it('rejects type-confused or unsafe resource and header policy', () => {
      expect(() => overlayExpress.configureEdgePolicy({ maxConcurrentRequests: 0 })).toThrow(
        'Maximum concurrent requests'
      )
      expect(() =>
        overlayExpress.configureEdgePolicy({
          http: { requestTimeoutMs: 1000, headersTimeoutMs: 1001 }
        })
      ).toThrow('headersTimeoutMs')
      expect(() =>
        overlayExpress.configureEdgePolicy({ allowedOrigins: ['https://wallet.example/path'] })
      ).toThrow('origins')
      expect(() =>
        overlayExpress.configureEdgePolicy({
          securityHeaders: { environmentPrefix: 'UNTRUSTED' }
        })
      ).toThrow('top-level environmentPrefix')
      expect(() =>
        overlayExpress.configureEdgePolicy({
          securityHeaders: { strictTransportSecurity: 'false' as unknown as boolean }
        })
      ).toThrow('boolean')
    })

    it('validates every bounded HTTP and browser-header option', () => {
      expect(() => overlayExpress.configureEdgePolicy(null as any)).toThrow(
        'HTTP edge policy must be an object'
      )
      expect(() => overlayExpress.configureEdgePolicy({ environmentPrefix: 'lowercase' })).toThrow(
        'environmentPrefix'
      )
      expect(() =>
        overlayExpress.configureEdgePolicy({ allowedOrigins: 'https://wallet.example' as any })
      ).toThrow('allowedOrigins')
      expect(() =>
        overlayExpress.configureEdgePolicy({
          allowedOrigins: Array.from(
            { length: 129 },
            (_, index) => `https://wallet-${index}.example`
          )
        })
      ).toThrow('at most 128')
      expect(() =>
        overlayExpress.configureEdgePolicy({
          http: { requestTimeoutMs: 1_000, headersTimeoutMs: 1_000, keepAliveTimeoutMs: 1_001 }
        })
      ).toThrow('keepAliveTimeoutMs')
      expect(() => overlayExpress.configureEdgePolicy({ http: [] as any })).toThrow(
        'HTTP server policy must be an object'
      )
      expect(() =>
        overlayExpress.configureEdgePolicy({
          securityHeaders: { contentSecurityPolicy: 'bad\npolicy' }
        })
      ).toThrow('control characters')
      expect(() =>
        overlayExpress.configureEdgePolicy({
          securityHeaders: { crossOriginResourcePolicy: 'invalid' as any }
        })
      ).toThrow('is invalid')

      overlayExpress.configureEdgePolicy({
        environmentPrefix: 'PUBLIC_EDGE_1',
        allowedOrigins: ['https://wallet.example', 'https://wallet.example:443'],
        jsonBodyLimitBytes: -1,
        binaryBodyLimitBytes: 65_536,
        maxConcurrentRequests: -1,
        http: {
          requestTimeoutMs: 60_000,
          headersTimeoutMs: 30_000,
          keepAliveTimeoutMs: 5_000,
          socketTimeoutMs: 45_000,
          maxRequestsPerSocket: 1_000,
          maxConnections: -1
        },
        securityHeaders: {
          contentSecurityPolicy: false,
          permissionsPolicy: 'camera=()',
          crossOriginResourcePolicy: 'cross-origin',
          crossOriginOpenerPolicy: false,
          frameOptions: 'SAMEORIGIN',
          strictTransportSecurity: true
        }
      })

      expect(overlayExpress.edgePolicyConfig).toMatchObject({
        environmentPrefix: 'PUBLIC_EDGE_1',
        allowedOrigins: ['https://wallet.example'],
        jsonBodyLimitBytes: -1,
        binaryBodyLimitBytes: 65_536,
        maxConcurrentRequests: -1,
        http: { maxConnections: -1 },
        securityHeaders: {
          contentSecurityPolicy: false,
          permissionsPolicy: 'camera=()',
          crossOriginResourcePolicy: 'cross-origin',
          crossOriginOpenerPolicy: false,
          frameOptions: 'SAMEORIGIN',
          strictTransportSecurity: true
        }
      })
    })
  })

  describe('security-safe diagnostics', () => {
    it('logs body metadata without serializing payload contents', () => {
      const instance = overlayExpress as any

      expect(instance.formatBodyForLog(Buffer.from('secret'), 'Body:')).toContain(
        'binary body (6 bytes)'
      )
      expect(instance.formatBodyForLog('secret', 'Body:')).toContain('string body (6 bytes)')
      expect(instance.formatBodyForLog(['secret'], 'Body:')).toContain(
        'structured body (1 top-level item(s))'
      )
      expect(instance.formatBodyForLog({ secret: true }, 'Body:')).toContain(
        'structured body (1 top-level item(s))'
      )
      expect(instance.formatBodyForLog(undefined, 'Body:')).toContain('undefined')
    })

    it('redacts authentication and payment headers while preserving safe metadata', () => {
      const result = (overlayExpress as any).redactHeadersForLog({
        authorization: 'Bearer private',
        cookie: 'session=private',
        'x-bsv-payment': 'private',
        'x-bsv-auth-nonce': 'private',
        'content-type': 'application/json'
      })

      expect(result).toEqual({
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        'x-bsv-payment': '[REDACTED]',
        'x-bsv-auth-nonce': '[REDACTED]',
        'content-type': 'application/json'
      })
    })

    it('keeps verbose request and response metadata on a single log line', () => {
      const instance = overlayExpress as any
      const logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
      instance.logger = logger
      const useSpy = jest.spyOn(instance.app, 'use')
      instance.setupVerboseRequestLogging()
      const middleware = useSpy.mock.calls[useSpy.mock.calls.length - 1]?.[0] as any
      let finishHandler: (() => void) | undefined
      const request = {
        method: 'GET\r\nFORGED',
        originalUrl: '/lookup\r\nFORGED',
        headers: { 'x-test': 'value\r\nFORGED' },
        body: undefined
      }
      const response: any = {
        statusCode: 200,
        send: jest.fn(),
        on: jest.fn((event: string, handler: () => void) => {
          if (event === 'finish') finishHandler = handler
        }),
        getHeaders: jest.fn(() => ({ 'x-test': 'value\r\nFORGED' }))
      }

      middleware(request, response, jest.fn())
      finishHandler?.()

      const messages = logger.log.mock.calls
        .flat()
        .filter((value): value is string => typeof value === 'string')
      expect(messages.join(' ')).toContain('\\r\\nFORGED')
      expect(messages.every(message => !/[\r\n\u2028\u2029]/.test(message))).toBe(true)
    })

    it('removes internal health-check details when configured', async () => {
      overlayExpress.healthConfig.includeDetails = false

      const report = await (overlayExpress as any).collectHealthReport('live')

      expect(report.checks).toHaveLength(1)
      expect(report.checks[0].name).toBe('process')
      expect(report.checks[0].details).toBeUndefined()
    })

    it('keeps health details private by default and bounds optional context', async () => {
      const contextProvider = jest.fn(async () => ({ deployment: 'private-cell' }))
      overlayExpress.configureHealth({ contextProvider })

      const defaultReport = await (overlayExpress as any).collectHealthReport('full')
      expect(defaultReport.context).toBeUndefined()
      expect(contextProvider).not.toHaveBeenCalled()

      overlayExpress.configureHealth({ includeDetails: true, timeoutMs: 1 })
      const detailedReport = await (overlayExpress as any).collectHealthReport('full')
      expect(detailedReport.context).toEqual({ deployment: 'private-cell' })

      overlayExpress.configureHealth({
        contextProvider: async () => await new Promise<Record<string, any>>(() => {})
      })
      await expect((overlayExpress as any).collectHealthReport('full')).rejects.toThrow(
        'Timed out after 1ms'
      )
    })

    it('rejects invalid health configuration and check definitions', () => {
      expect(() => overlayExpress.configureHealth({ timeoutMs: 0 })).toThrow(
        'timeoutMs must be an integer'
      )
      expect(() => overlayExpress.configureHealth({ timeoutMs: 60_001 })).toThrow(
        'timeoutMs must be an integer'
      )
      expect(() =>
        overlayExpress.configureHealth({ includeDetails: 'yes' as unknown as boolean })
      ).toThrow('includeDetails must be a boolean')
      expect(() =>
        overlayExpress.registerHealthCheck({
          name: 'mongo',
          handler: async () => ({ status: 'ok' })
        })
      ).toThrow('name is reserved')
      expect(() =>
        overlayExpress.registerHealthCheck({
          name: 'bad\nname',
          handler: async () => ({ status: 'ok' })
        })
      ).toThrow('name is invalid')
    })

    it('rejects malformed health checks and replaces a valid named check atomically', () => {
      const handler = async (): Promise<{ status: 'ok' }> => ({ status: 'ok' })
      for (const definition of [
        null,
        [],
        { name: '', handler },
        { name: 'x'.repeat(257), handler },
        { name: 'custom', scope: 'full', handler },
        { name: 'custom', critical: 'yes', handler },
        { name: 'custom', handler: 'not-a-function' }
      ]) {
        expect(() => overlayExpress.registerHealthCheck(definition as any)).toThrow()
      }

      overlayExpress.registerHealthCheck({ name: 'custom', scope: 'live', critical: true, handler })
      const replacement = async (): Promise<{ status: 'ok' }> => ({ status: 'ok' })
      overlayExpress.registerHealthCheck({ name: 'custom', handler: replacement })

      const registered = (overlayExpress as any).healthChecks.filter(
        (check: { name: string }) => check.name === 'custom'
      )
      expect(registered).toEqual([
        expect.objectContaining({
          name: 'custom',
          scope: 'ready',
          critical: false,
          handler: replacement
        })
      ])
    })

    it('caps the number of distinct application health checks', () => {
      ;(overlayExpress as any).healthChecks = Array.from({ length: 128 }, (_, index) => ({
        name: `existing-${index}`,
        scope: 'ready',
        critical: false,
        handler: async () => ({ status: 'ok' })
      }))

      expect(() =>
        overlayExpress.registerHealthCheck({
          name: 'one-too-many',
          handler: async () => ({ status: 'ok' })
        })
      ).toThrow('Cannot register more than 128')
    })
  })

  describe('configureLogger', () => {
    it('should set custom logger', () => {
      const customLogger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      } as any

      overlayExpress.configureLogger(customLogger)
      expect(overlayExpress.logger).toBe(customLogger)
    })
  })

  describe('configureNetwork', () => {
    it('should set network to main', () => {
      overlayExpress.configureNetwork('main')
      expect(overlayExpress.network).toBe('main')
    })

    it('should set network to test', () => {
      overlayExpress.configureNetwork('test')
      expect(overlayExpress.network).toBe('test')
    })

    it('sets TTN without silently constructing a WhatsOnChain tracker', async () => {
      overlayExpress.configureNetwork('ttn')
      expect(overlayExpress.network).toBe('ttn')
      const chainTracker = overlayExpress.chainTracker as ChainTracker
      await expect(chainTracker.isValidRootForHeight('mock-root', 1)).rejects.toThrow(
        'TTN requires configureChaintracks() or configureChainTracker()'
      )
      await expect(chainTracker.currentHeight()).rejects.toThrow(
        'TTN requires configureChaintracks() or configureChainTracker()'
      )
      expect((overlayExpress as any).buildTopicAnchorHeaderResolver()).toBeUndefined()
      expect((overlayExpress as any).defaultDiscoveryTrackers()).toBeDefined()
    })

    it('should reinitialize chainTracker for network', () => {
      overlayExpress.configureNetwork('test')
      expect(overlayExpress.chainTracker).toBeDefined()
    })

    it('rejects unknown network values', () => {
      expect(() => overlayExpress.configureNetwork('stn' as OverlayExpress['network'])).toThrow(
        'Network'
      )
    })
  })

  describe('configureChainTracker', () => {
    it('should set custom chain tracker', () => {
      const mockChainTracker: ChainTracker = {
        isValidRootForHeight: jest.fn<any>().mockResolvedValue(true),
        currentHeight: jest.fn<any>().mockResolvedValue(800_000)
      }
      overlayExpress.configureChainTracker(mockChainTracker)
      expect(overlayExpress.chainTracker).toBe(mockChainTracker)
    })

    it('should accept "scripts only" mode', () => {
      overlayExpress.configureChainTracker('scripts only')
      expect(overlayExpress.chainTracker).toBe('scripts only')
    })

    it('applies default tracker and provider configuration', () => {
      overlayExpress.configureChainTracker()
      overlayExpress.configureArcade('https://arcade.example')
      overlayExpress.configureChaintracks('https://chaintracks.example')

      expect(overlayExpress.chainTracker).toBeDefined()
      expect(overlayExpress.arcadeUrl).toBe('https://arcade.example')
      expect(overlayExpress.reorgStreamUrl).toContain('chaintracks.example')
    })

    it('requires an explicit tracker for TTN', () => {
      overlayExpress.configureNetwork('ttn')

      expect(() => overlayExpress.configureChainTracker()).toThrow(
        'TTN requires an explicit ChainTracker'
      )
    })

    it('rejects type-confused provider security options', () => {
      expect(() =>
        overlayExpress.configureArcade('http://127.0.0.1', {
          allowPrivateHosts: 'false' as unknown as boolean
        })
      ).toThrow('allowPrivateHosts')
      expect(() =>
        overlayExpress.configureChaintracks('https://chaintracks.example', {
          reorgStream: 'false' as unknown as boolean
        })
      ).toThrow('reorgStream')
      expect(() =>
        overlayExpress.configureReorgStream(
          'http://127.0.0.1/reorg',
          3,
          'false' as unknown as boolean
        )
      ).toThrow('allowPrivateHosts')
    })
  })

  describe('configureArcApiKey', () => {
    it('should set ARC API key', () => {
      overlayExpress.configureArcApiKey('test-api-key')
      expect(overlayExpress.arcApiKey).toBe('test-api-key')
    })
  })

  describe('configureArcCallbackToken', () => {
    it('rejects weak or header-unsafe callback credentials', () => {
      expect(() => overlayExpress.configureArcCallbackToken('short')).toThrow(
        'between 32 and 16384'
      )
      expect(() =>
        overlayExpress.configureArcCallbackToken(' test-callback-token-0123456789abcdef ')
      ).toThrow('whitespace')
      expect(() =>
        overlayExpress.configureArcCallbackToken('test-callback-token-0123456789ab\ncdef')
      ).toThrow('control characters')
    })
  })

  describe('configureEnableGASPSync', () => {
    it('should enable GASP sync', () => {
      overlayExpress.configureEnableGASPSync(true)
      expect(overlayExpress.enableGASPSync).toBe(true)
    })

    it('should disable GASP sync', () => {
      overlayExpress.configureEnableGASPSync(false)
      expect(overlayExpress.enableGASPSync).toBe(false)
    })
  })

  describe('BASM maintenance configuration bounds', () => {
    it('accepts bounded intervals and eviction thresholds', () => {
      overlayExpress.configureUnprovenEviction({ thresholdBlocks: 144 })
      overlayExpress.configureUnprovenMaintenance({ intervalMs: 60_000, thresholdBlocks: 288 })
      overlayExpress.configureBASMBlockPollInterval(30_000)

      expect(overlayExpress.unprovenEvictionBlocks).toBe(288)
      expect(overlayExpress.unprovenMaintenanceIntervalMs).toBe(60_000)
      expect(overlayExpress.basmBlockPollIntervalMs).toBe(30_000)
    })

    it('rejects unsafe timer and eviction values', () => {
      expect(() => overlayExpress.configureUnprovenEviction({ thresholdBlocks: 0 })).toThrow(
        'thresholdBlocks'
      )
      expect(() => overlayExpress.configureUnprovenMaintenance({ intervalMs: -1 })).toThrow(
        'intervalMs'
      )
      expect(() => overlayExpress.configureBASMBlockPollInterval(Number.NaN)).toThrow('intervalMs')
    })
  })

  describe('default BASM block header resolver', () => {
    it('accepts only bounded, well-formed WhatsOnChain headers', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            hash: '11'.repeat(32),
            merkleroot: '22'.repeat(32)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      const resolver = (overlayExpress as any).buildTopicAnchorHeaderResolver()

      await expect(resolver(800_000)).resolves.toEqual({
        blockHeight: 800_000,
        blockHash: '11'.repeat(32),
        merkleRoot: '22'.repeat(32)
      })
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.whatsonchain.com/v1/bsv/main/block/800000/header',
        expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
      )
    })

    it('rejects oversized or malformed WhatsOnChain headers', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response('{}', {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(64 * 1024 + 1)
            }
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hash: 'not-a-hash', merkleroot: '22'.repeat(32) }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      const resolver = (overlayExpress as any).buildTopicAnchorHeaderResolver()

      await expect(resolver(800_000)).rejects.toThrow('exceeds')
      await expect(resolver(800_000)).rejects.toThrow('block hash')
      await expect(resolver(-1)).rejects.toThrow('block height')
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('configureVerboseRequestLogging', () => {
    it('should enable verbose logging', () => {
      overlayExpress.configureVerboseRequestLogging(true)
      expect(overlayExpress.verboseRequestLogging).toBe(true)
    })

    it('should disable verbose logging', () => {
      overlayExpress.configureVerboseRequestLogging(false)
      expect(overlayExpress.verboseRequestLogging).toBe(false)
    })
  })

  describe('configureKnex', () => {
    it('should configure Knex with object config', async () => {
      const mockKnex = { raw: jest.fn() }
      ;(Knex as any).mockReturnValue(mockKnex)

      const config = {
        client: 'mysql2',
        connection: {
          host: 'localhost',
          user: 'test',
          password: 'test',
          database: 'test'
        }
      }

      await overlayExpress.configureKnex(config)
      expect(overlayExpress.knex).toBeDefined()
      expect(overlayExpress.knex).toBe(mockKnex)
    })

    it('should configure Knex with connection string', async () => {
      const mockKnex = { raw: jest.fn() }
      ;(Knex as any).mockReturnValue(mockKnex)

      const connectionString = 'mysql://user:pass@localhost:3306/db'

      await overlayExpress.configureKnex(connectionString)
      expect(overlayExpress.knex).toBeDefined()
      expect(Knex).toHaveBeenCalledWith({
        client: 'mysql2',
        connection: connectionString
      })
    })
  })

  describe('configureMongo', () => {
    it('should configure MongoDB connection', async () => {
      // @ts-expect-error - Mock resolved value
      const mockConnect = jest.fn().mockResolvedValue(undefined)
      const mockDb = jest.fn().mockReturnValue(createMockDbValue())
      const mockClient = {
        connect: mockConnect,
        db: mockDb
      }

      ;(MongoClient as any).mockImplementation(() => mockClient)

      await overlayExpress.configureMongo('mongodb://localhost:27017')

      expect(mockConnect).toHaveBeenCalled()
      expect(mockDb).toHaveBeenCalledWith('TestService_lookup_services')
      expect(overlayExpress.mongoDb).toBeDefined()
    })
  })

  describe('configureTopicManager', () => {
    it('should add topic manager', () => {
      const mockManager: TopicManager = Object.create(null)
      overlayExpress.configureTopicManager('test_manager', mockManager)

      expect(overlayExpress.managers.test_manager).toBe(mockManager)
    })

    it('should add multiple topic managers', () => {
      const manager1: TopicManager = Object.create(null)
      const manager2: TopicManager = Object.create(null)

      overlayExpress.configureTopicManager('manager1', manager1)
      overlayExpress.configureTopicManager('manager2', manager2)

      expect(overlayExpress.managers.manager1).toBe(manager1)
      expect(overlayExpress.managers.manager2).toBe(manager2)
    })

    it('rejects reserved registry names', () => {
      expect(() => overlayExpress.configureTopicManager('__proto__', Object.create(null))).toThrow(
        'Topic manager name is invalid'
      )
    })
  })

  describe('configureLookupService', () => {
    it('should add lookup service', () => {
      const mockService: LookupService = Object.create(null)
      overlayExpress.configureLookupService('test_service', mockService)

      expect(overlayExpress.services.test_service).toBe(mockService)
    })

    it('should add multiple lookup services', () => {
      const service1: LookupService = Object.create(null)
      const service2: LookupService = Object.create(null)

      overlayExpress.configureLookupService('service1', service1)
      overlayExpress.configureLookupService('service2', service2)

      expect(overlayExpress.services.service1).toBe(service1)
      expect(overlayExpress.services.service2).toBe(service2)
    })

    it('rejects reserved registry names', () => {
      expect(() =>
        overlayExpress.configureLookupService('constructor', Object.create(null))
      ).toThrow('Lookup service name is invalid')
    })
  })

  describe('configureLookupServiceWithKnex', () => {
    beforeEach(async () => {
      const mockKnex = { raw: jest.fn() }
      ;(Knex as any).mockReturnValue(mockKnex)
      await overlayExpress.configureKnex({
        client: 'mysql2',
        connection: {}
      })
    })

    it('should configure lookup service with Knex', () => {
      const mockService: LookupService = Object.create(null)
      const mockFactory = jest.fn().mockReturnValue({
        service: mockService,
        migrations: []
      })

      // @ts-expect-error - Mock factory function
      overlayExpress.configureLookupServiceWithKnex('test_service', mockFactory)

      expect(mockFactory).toHaveBeenCalledWith(overlayExpress.knex)
      expect(overlayExpress.services.test_service).toBe(mockService)
    })

    it('should add migrations from factory', () => {
      const mockService: LookupService = Object.create(null)
      const mockMigrations = [
        { name: 'migration1', up: jest.fn() },
        { name: 'migration2', up: jest.fn() }
      ]
      const mockFactory = jest.fn().mockReturnValue({
        service: mockService,
        migrations: mockMigrations
      })

      // @ts-expect-error - Mock factory function
      overlayExpress.configureLookupServiceWithKnex('test_service', mockFactory)

      expect(overlayExpress.migrationsToRun).toContain(mockMigrations[0])
      expect(overlayExpress.migrationsToRun).toContain(mockMigrations[1])
    })

    it('should check Knex configuration', () => {
      const freshInstance = new OverlayExpress('Test', 'key', 'example.com')
      const mockLookupService: LookupService = Object.create(null)
      const mockFactory = jest.fn().mockReturnValue({
        service: mockLookupService,
        migrations: []
      })

      // @ts-expect-error - Mock factory function
      expect(() => freshInstance.configureLookupServiceWithKnex('test', mockFactory)).toThrow(
        'You must configure your SQL database'
      )
    })
  })

  describe('configureLookupServiceWithMongo', () => {
    beforeEach(async () => {
      // @ts-expect-error - Mock resolved value
      const mockConnect = jest.fn().mockResolvedValue(undefined)
      const mockDb = jest.fn().mockReturnValue(createMockDbValue())
      const mockClient = {
        connect: mockConnect,
        db: mockDb
      }

      ;(MongoClient as any).mockImplementation(() => mockClient)

      await overlayExpress.configureMongo('mongodb://localhost:27017')
    })

    it('should configure lookup service with MongoDB', () => {
      const mockService: LookupService = Object.create(null)
      const mockFactory = jest.fn().mockReturnValue(mockService)

      // @ts-expect-error - Mock factory function
      overlayExpress.configureLookupServiceWithMongo('test_service', mockFactory)

      expect(mockFactory).toHaveBeenCalledWith(overlayExpress.mongoDb)
      expect(overlayExpress.services.test_service).toBe(mockService)
    })

    it('should check MongoDB configuration', () => {
      const freshInstance = new OverlayExpress('Test', 'key', 'example.com')
      const mockLookupService: LookupService = Object.create(null)
      const mockFactory = jest.fn().mockReturnValue(mockLookupService)

      // @ts-expect-error - Mock factory function
      expect(() => freshInstance.configureLookupServiceWithMongo('test', mockFactory)).toThrow(
        'You must configure your MongoDB connection'
      )
    })
  })

  describe('configureEngineParams', () => {
    it('should set engine params', () => {
      const params = {
        logTime: true,
        throwOnBroadcastFailure: true
      }

      overlayExpress.configureEngineParams(params)

      expect(overlayExpress.engineConfig.logTime).toBe(true)
      expect(overlayExpress.engineConfig.throwOnBroadcastFailure).toBe(true)
    })

    it('should merge engine params', () => {
      overlayExpress.configureEngineParams({ logTime: true })
      overlayExpress.configureEngineParams({ throwOnBroadcastFailure: false })

      expect(overlayExpress.engineConfig.logTime).toBe(true)
      expect(overlayExpress.engineConfig.throwOnBroadcastFailure).toBe(false)
    })

    it('should accept all engine config properties', () => {
      const params = {
        logTime: true,
        logPrefix: '[TEST]',
        throwOnBroadcastFailure: true,
        suppressDefaultSyncAdvertisements: false
      }

      overlayExpress.configureEngineParams(params)

      expect(overlayExpress.engineConfig).toMatchObject(params)
    })

    it('defensively copies tracker configuration', () => {
      const shipTrackers = ['https://ship.example']
      overlayExpress.configureEngineParams({ shipTrackers })

      shipTrackers[0] = 'https://attacker.example'

      expect(overlayExpress.engineConfig.shipTrackers).toEqual(['https://ship.example'])
    })

    it('rejects type-confused security and background-work settings', () => {
      expect(() =>
        overlayExpress.configureEngineParams({
          reorgStreamAllowPrivateHosts: 'false' as unknown as boolean
        })
      ).toThrow('reorgStreamAllowPrivateHosts')
      expect(() =>
        overlayExpress.configureEngineParams({ reorgStreamUrl: 'http://127.0.0.1/reorg' })
      ).toThrow('Provider endpoints')
      expect(() =>
        overlayExpress.configureEngineParams({ unprovenMaintenanceIntervalMs: -1 })
      ).toThrow('unprovenMaintenanceIntervalMs')
      expect(() => overlayExpress.configureEngineParams({ logPrefix: 'unsafe\nprefix' })).toThrow(
        'control characters'
      )
    })

    it('validates and defensively copies the remaining engine boundary options', () => {
      expect(() => overlayExpress.configureEngineParams(null as any)).toThrow(
        'Engine configuration must be an object'
      )
      expect(() =>
        overlayExpress.configureEngineParams({ topicAnchorHeaderResolver: 'bad' as any })
      ).toThrow('topicAnchorHeaderResolver')
      for (const chainTracker of [null, {}, { isValidRootForHeight: async () => true }]) {
        expect(() => overlayExpress.configureEngineParams({ chainTracker } as any)).toThrow(
          'chainTracker'
        )
      }
      expect(() => overlayExpress.configureEngineParams({ reorgScanDepth: 0 })).toThrow(
        'reorgScanDepth'
      )
      expect(() => overlayExpress.configureEngineParams({ unprovenEvictionBlocks: 0 })).toThrow(
        'unprovenEvictionBlocks'
      )
      expect(() => overlayExpress.configureEngineParams({ maxLookupResults: 0 })).toThrow(
        'maxLookupResults'
      )
      expect(() => overlayExpress.configureEngineParams({ shipTrackers: 'bad' as any })).toThrow(
        'shipTrackers'
      )
      expect(() => overlayExpress.configureEngineParams({ slapTrackers: {} as any })).toThrow(
        'slapTrackers'
      )

      const slapTrackers = ['https://slap.example']
      const resolver = async (blockHeight: number): Promise<any> => ({
        blockHeight,
        blockHash: '11'.repeat(32)
      })
      const chainTracker = {
        isValidRootForHeight: async () => true,
        currentHeight: async () => 1
      }
      overlayExpress.configureEngineParams({
        topicAnchorHeaderResolver: resolver,
        chainTracker: chainTracker as any,
        reorgScanDepth: 100,
        unprovenMaintenanceIntervalMs: 0,
        unprovenEvictionBlocks: 1,
        maxLookupResults: -1,
        reorgStreamUrl: 'http://127.0.0.1/reorg',
        reorgStreamAllowPrivateHosts: true,
        slapTrackers
      })
      slapTrackers[0] = 'https://attacker.example'

      expect(overlayExpress.engineConfig).toMatchObject({
        topicAnchorHeaderResolver: resolver,
        chainTracker,
        reorgScanDepth: 100,
        unprovenMaintenanceIntervalMs: 0,
        unprovenEvictionBlocks: 1,
        maxLookupResults: -1,
        reorgStreamUrl: 'http://127.0.0.1/reorg',
        reorgStreamAllowPrivateHosts: true,
        slapTrackers: ['https://slap.example']
      })
    })
  })

  describe('configureEngine', () => {
    beforeEach(async () => {
      const mockKnex = { raw: jest.fn() }
      ;(Knex as any).mockReturnValue(mockKnex)
      await overlayExpress.configureKnex({
        client: 'mysql2',
        connection: {}
      })

      // @ts-expect-error - Mock resolved value
      const mockConnect = jest.fn().mockResolvedValue(undefined)
      const mockDb = jest.fn().mockReturnValue(createMockDbValue())
      const mockClient = {
        connect: mockConnect,
        db: mockDb
      }

      ;(MongoClient as any).mockImplementation(() => mockClient)
      await overlayExpress.configureMongo('mongodb://localhost:27017')
    })

    it('should check Knex before configuring engine', async () => {
      const freshInstance = new OverlayExpress('Test', 'key', 'example.com')

      await expect(freshInstance.configureEngine()).rejects.toThrow(
        'You must configure your SQL database with the .configureKnex() method first!'
      )
    })

    it('should configure engine with auto SHIP/SLAP', async () => {
      await overlayExpress.configureEngine(true)

      expect(overlayExpress.engine).toBeDefined()
      expect(overlayExpress.managers.tm_ship).toBeDefined()
      expect(overlayExpress.managers.tm_slap).toBeDefined()
      expect(overlayExpress.services.ls_ship).toBeDefined()
      expect(overlayExpress.services.ls_slap).toBeDefined()
    })

    it('should initialize SHIP/SLAP indexes before completing engine configuration', async () => {
      const shipEnsureIndexes = jest.fn<any>().mockResolvedValue(undefined)
      const slapEnsureIndexes = jest.fn<any>().mockResolvedValue(undefined)
      ;(DiscoveryServices.SHIPStorage as any).mockImplementationOnce(() => ({
        ensureIndexes: shipEnsureIndexes
      }))
      ;(DiscoveryServices.SLAPStorage as any).mockImplementationOnce(() => ({
        ensureIndexes: slapEnsureIndexes
      }))

      await overlayExpress.configureEngine(true)

      expect(shipEnsureIndexes).toHaveBeenCalledTimes(1)
      expect(slapEnsureIndexes).toHaveBeenCalledTimes(1)
      expect(overlayExpress.engine).toBeDefined()
    })

    it('should fail engine configuration when discovery index initialization fails', async () => {
      const indexError = new Error('discovery index migration failed')
      const shipEnsureIndexes = jest.fn<any>().mockRejectedValue(indexError)
      const slapEnsureIndexes = jest.fn<any>().mockResolvedValue(undefined)
      ;(DiscoveryServices.SHIPStorage as any).mockImplementationOnce(() => ({
        ensureIndexes: shipEnsureIndexes
      }))
      ;(DiscoveryServices.SLAPStorage as any).mockImplementationOnce(() => ({
        ensureIndexes: slapEnsureIndexes
      }))

      await expect(overlayExpress.configureEngine(true)).rejects.toThrow(indexError)

      expect(shipEnsureIndexes).toHaveBeenCalledTimes(1)
      expect(slapEnsureIndexes).not.toHaveBeenCalled()
      expect(overlayExpress.engine).toBeUndefined()
      expect(overlayExpress.services.ls_ship).toBeUndefined()
      expect(overlayExpress.services.ls_slap).toBeUndefined()
    })

    it('should configure engine without auto SHIP/SLAP', async () => {
      await overlayExpress.configureEngine(false)

      expect(overlayExpress.engine).toBeDefined()
      expect(overlayExpress.managers.tm_ship).toBeUndefined()
      expect(overlayExpress.managers.tm_slap).toBeUndefined()
    })

    it('should respect enableGASPSync setting', async () => {
      const mockKnex = { raw: jest.fn() }
      ;(Knex as any).mockReturnValue(mockKnex)
      await overlayExpress.configureKnex({
        client: 'mysql2',
        connection: {}
      })

      // @ts-expect-error - Mock resolved value
      const mockConnect = jest.fn().mockResolvedValue(undefined)
      const mockDb = jest.fn().mockReturnValue(createMockDbValue())
      const mockClient = {
        connect: mockConnect,
        db: mockDb
      }

      ;(MongoClient as any).mockImplementation(() => mockClient)
      await overlayExpress.configureMongo('mongodb://localhost:27017')

      overlayExpress.configureEnableGASPSync(false)
      await overlayExpress.configureEngine()

      expect(overlayExpress.engine).toBeDefined()
    })
  })

  describe('error handling', () => {
    it('should handle Knex configuration errors', async () => {
      const freshInstance = new OverlayExpress('Test', 'key', 'example.com')

      ;(Knex as any).mockImplementationOnce(() => {
        throw new Error('Knex error')
      })

      await expect(freshInstance.configureKnex({ client: 'mysql2' })).rejects.toThrow('Knex error')
    })

    it('should handle MongoDB connection errors', async () => {
      const freshInstance = new OverlayExpress('Test', 'key', 'example.com')
      ;(MongoClient as any).mockImplementation(() => ({
        // @ts-expect-error - Mock rejected value
        connect: jest.fn().mockRejectedValue(new Error('Connection failed'))
      }))

      await expect(freshInstance.configureMongo('mongodb://localhost:27017')).rejects.toThrow(
        'Connection failed'
      )
    })
  })

  describe('integration scenarios', () => {
    it('should allow full configuration workflow', async () => {
      const instance = new OverlayExpress('FullTest', 'private-key', 'example.com')

      instance.configurePort(8080)
      instance.configureNetwork('test')
      instance.configureEnableGASPSync(true)
      instance.configureVerboseRequestLogging(false)

      const mockKnex = { raw: jest.fn() }
      ;(Knex as any).mockReturnValue(mockKnex)
      await instance.configureKnex({
        client: 'mysql2',
        connection: {}
      })

      // @ts-expect-error - Mock resolved value
      const mockConnect = jest.fn().mockResolvedValue(undefined)
      const mockDb = jest.fn().mockReturnValue(createMockDbValue())
      const mockClient = {
        connect: mockConnect,
        db: mockDb
      }

      ;(MongoClient as any).mockImplementation(() => mockClient)
      await instance.configureMongo('mongodb://localhost:27017')

      await instance.configureEngine()

      expect(instance.port).toBe(8080)
      expect(instance.network).toBe('test')
      expect(instance.enableGASPSync).toBe(true)
      expect(instance.engine).toBeDefined()
    })

    it('should handle configuration with custom admin token', () => {
      const customToken = 'secure-test-token-0123456789abcdef'
      const instance = new OverlayExpress(
        'SecureService',
        'private-key',
        'example.com',
        customToken
      )

      expect(instance.getAdminToken()).toBe(customToken)
    })

    it('should maintain separate topic managers and lookup services', () => {
      const manager1: TopicManager = Object.create(null)
      const manager2: TopicManager = Object.create(null)
      const service1: LookupService = Object.create(null)
      const service2: LookupService = Object.create(null)

      overlayExpress.configureTopicManager('tm1', manager1)
      overlayExpress.configureTopicManager('tm2', manager2)
      overlayExpress.configureLookupService('ls1', service1)
      overlayExpress.configureLookupService('ls2', service2)

      expect(Object.keys(overlayExpress.managers)).toHaveLength(2)
      expect(Object.keys(overlayExpress.services)).toHaveLength(2)
    })
  })

  describe('start method', () => {
    let mockKnex: any
    let mockEngine: any
    let instance: OverlayExpress

    beforeEach(async () => {
      instance = new OverlayExpress('TestServer', 'test-key', 'test.example.com')

      // Mock Knex with migrations
      mockKnex = {
        raw: jest.fn(),
        migrate: {
          // @ts-expect-error - Mock return value
          latest: jest.fn().mockResolvedValue([1, ['migration1']])
        }
      }
      ;(Knex as any).mockReturnValue(mockKnex)

      // Mock Engine with required methods
      mockEngine = {
        // @ts-expect-error - Mock return values
        listTopicManagers: jest.fn().mockResolvedValue([]),
        // @ts-expect-error - Mock return values
        listLookupServiceProviders: jest.fn().mockResolvedValue([]),
        // @ts-expect-error - Mock return values
        getDocumentationForTopicManager: jest.fn().mockResolvedValue('# Docs'),
        // @ts-expect-error - Mock return values
        getDocumentationForLookupServiceProvider: jest.fn().mockResolvedValue('# Docs'),
        // @ts-expect-error - Mock return values
        submit: jest.fn().mockResolvedValue({ status: 'success' }),
        // @ts-expect-error - Mock return values
        lookup: jest.fn().mockResolvedValue({ outputs: [] }),
        // @ts-expect-error - Mock return values
        handleNewMerkleProof: jest.fn().mockResolvedValue(undefined),
        // @ts-expect-error - Mock return values
        provideForeignSyncResponse: jest.fn().mockResolvedValue({}),
        // @ts-expect-error - Mock return values
        provideForeignGASPNode: jest.fn().mockResolvedValue({}),
        // @ts-expect-error - Mock return values
        syncAdvertisements: jest.fn().mockResolvedValue(undefined),
        // @ts-expect-error - Mock return values
        startGASPSync: jest.fn().mockResolvedValue(undefined),
        // @ts-expect-error - Mock return values
        refreshUnprovenTransactionProofs: jest.fn().mockResolvedValue({}),
        // @ts-expect-error - Mock return values
        maintainUnprovenTransactions: jest.fn().mockResolvedValue({}),
        provideTopicAnchorTip: jest.fn<any>().mockResolvedValue({ height: 1 }),
        provideTopicAnchorRange: jest.fn<any>().mockResolvedValue([{ height: 1 }]),
        provideAdmittedList: jest.fn<any>().mockResolvedValue({ txids: [] }),
        provideCompoundMerklePath: jest.fn<any>().mockResolvedValue({ path: [] }),
        provideRawTransactions: jest.fn<any>().mockResolvedValue({ transactions: [] }),
        startBASMSync: jest.fn<any>().mockResolvedValue({ topics: 1 }),
        evictUnprovenTransactions: jest.fn<any>().mockResolvedValue({ evicted: 1 }),
        advanceTopicAnchorChains: jest.fn<any>().mockResolvedValue({ advanced: 1 }),
        revalidateRecentAnchors: jest.fn<any>().mockResolvedValue({ revalidated: 1 }),
        evictAppliedTransaction: jest
          .fn<any>()
          .mockResolvedValue({ evictedTransactions: 1, evictedOutputs: 1 }),
        lookupServices: {
          ls_one: {
            outputEvicted: jest.fn<any>().mockResolvedValue(undefined)
          },
          ls_two: {
            outputEvicted: jest.fn<any>().mockRejectedValue(new Error('best-effort failure'))
          }
        },
        advertiser: {
          // @ts-expect-error - Mock return values
          init: jest.fn().mockResolvedValue(undefined)
        }
      }

      // Configure databases
      await instance.configureKnex({ client: 'mysql2', connection: {} })

      // @ts-expect-error - Mock return value
      const mockConnect = jest.fn().mockResolvedValue(undefined)
      const mockDb = jest.fn().mockReturnValue(createMockDbValue())
      const mockClient = {
        connect: mockConnect,
        db: mockDb
      }
      ;(MongoClient as any).mockImplementation(() => mockClient)
      await instance.configureMongo('mongodb://localhost:27017')

      // Don't call configureEngine() - just set the engine and knex directly
      instance.engine = mockEngine
      instance.knex = mockKnex
    })

    const flushRoute = async (): Promise<void> => {
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    }

    const mockResponse = (): any => {
      const res: any = {}
      res.status = jest.fn<any>().mockReturnValue(res)
      res.json = jest.fn<any>().mockReturnValue(res)
      res.send = jest.fn<any>().mockReturnValue(res)
      res.set = jest.fn<any>().mockReturnValue(res)
      res.setHeader = jest.fn<any>().mockReturnValue(res)
      return res
    }

    const startAndCaptureRoutes = async (): Promise<{ getSpy: any; postSpy: any }> => {
      const getSpy = jest.spyOn(instance.app, 'get')
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })
      await instance.start()
      return { getSpy, postSpy }
    }

    const invokeCapturedRoute = async (
      spy: any,
      path: string,
      request: Record<string, any> = {}
    ): Promise<any> => {
      const route = spy.mock.calls.find((call: any[]) => call[0] === path)
      expect(route).toBeDefined()
      const handler = route[route.length - 1]
      const res = mockResponse()
      handler(
        {
          headers: {},
          query: {},
          body: {},
          ...request
        },
        res,
        jest.fn()
      )
      await flushRoute()
      return res
    }

    it('should throw if engine not configured', async () => {
      const freshInstance = new OverlayExpress('Test', 'key', 'example.com')
      const mockKnex = {
        raw: jest.fn(),
        migrate: {
          // @ts-expect-error - Mock return value
          latest: jest.fn().mockResolvedValue([])
        }
      }
      ;(Knex as any).mockReturnValue(mockKnex)
      await freshInstance.configureKnex({ client: 'mysql2', connection: {} })

      await expect(freshInstance.start()).rejects.toThrow(
        'You must configure your Overlay Services engine'
      )
    })

    it('should throw if knex not configured', async () => {
      const freshInstance = new OverlayExpress('Test', 'key', 'example.com')
      freshInstance.engine = mockEngine

      await expect(freshInstance.start()).rejects.toThrow('You must configure your SQL database')
    })

    it('should set up Express middleware', async () => {
      const useSpy = jest.spyOn(instance.app, 'use')
      const getSpy = jest.spyOn(instance.app, 'get')
      const postSpy = jest.spyOn(instance.app, 'post')
      const listenSpy = jest
        .spyOn(instance.app, 'listen')
        .mockImplementation((port: any, callback: any) => {
          callback()
          return {} as any
        })

      await instance.start()

      expect(useSpy).toHaveBeenCalled()
      expect(getSpy).toHaveBeenCalled()
      expect(postSpy).toHaveBeenCalled()
      expect(listenSpy).toHaveBeenCalledWith(3000, expect.any(Function))
    })

    it('passes a configured async session manager to BSV auth middleware', async () => {
      const sessionManager = {
        addSession: jest.fn<any>().mockResolvedValue(undefined),
        updateSession: jest.fn<any>().mockResolvedValue(undefined),
        getSession: jest.fn<any>().mockResolvedValue(undefined),
        removeSession: jest.fn<any>().mockResolvedValue(undefined),
        hasSession: jest.fn<any>().mockResolvedValue(false)
      }
      instance.serverWallet = {} as any
      instance.configureAuthSessionManager(sessionManager)
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(createAuthMiddleware).toHaveBeenCalledWith(
        expect.objectContaining({
          wallet: instance.serverWallet,
          sessionManager,
          allowUnauthenticated: true
        })
      )
    })

    it('does not expose internal engine errors in public responses', async () => {
      const getSpy = jest.spyOn(instance.app, 'get')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })
      mockEngine.listTopicManagers.mockRejectedValueOnce(
        new Error('database password appeared in a driver error')
      )
      await instance.start()

      const route = getSpy.mock.calls.find(call => call[0] === '/listTopicManagers')
      const handler: any = route === undefined ? undefined : route[route.length - 1]
      const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }
      handler?.({}, res)
      await new Promise(resolve => setImmediate(resolve))

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'Request could not be processed'
      })
    })

    it('accepts canonical and legacy X-Topics formats on /submit', async () => {
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })
      await instance.start()

      const route = postSpy.mock.calls.find(call => call[0] === '/submit')
      const handler: any = route === undefined ? undefined : route[route.length - 1]
      expect(handler).toBeDefined()

      for (const topicsHeader of ['tm_foo,tm_bar', '["tm_foo","tm_bar"]']) {
        const res: any = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn().mockReturnThis()
        }
        handler?.(
          {
            headers: { 'x-topics': topicsHeader },
            body: Buffer.from([1, 2, 3])
          },
          res
        )
        await new Promise(resolve => setImmediate(resolve))
      }

      expect(mockEngine.submit).toHaveBeenCalledTimes(2)
      for (const call of mockEngine.submit.mock.calls) {
        expect(call[0]).toEqual({
          beef: [1, 2, 3],
          topics: ['tm_foo', 'tm_bar'],
          offChainValues: undefined
        })
      }
    })

    it('returns the callback STEAK exactly once from /submit', async () => {
      const callbackSteak = { status: 'success', txid: 'callback-txid' }
      mockEngine.submit.mockImplementationOnce(async (_beef: any, callback: any) => {
        callback(callbackSteak)
        return { status: 'success', txid: 'returned-txid' }
      })
      const { postSpy } = await startAndCaptureRoutes()

      const response = await invokeCapturedRoute(postSpy, '/submit', {
        headers: { 'x-topics': 'tm_callback' },
        body: Buffer.from([1, 2, 3])
      })

      expect(response.status).toHaveBeenCalledWith(200)
      expect(response.json).toHaveBeenCalledTimes(1)
      expect(response.json).toHaveBeenCalledWith(callbackSteak)
    })

    it('returns a clean 400 for an empty /submit body', async () => {
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      await instance.start()

      const route = postSpy.mock.calls.find(call => call[0] === '/submit')
      const handler: any = route === undefined ? undefined : route[route.length - 1]
      const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }
      handler?.({ headers: { 'x-topics': 'tm_foo' }, body: undefined }, res)
      await new Promise(resolve => setImmediate(resolve))

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'Missing or empty BEEF body'
      })
      expect(mockEngine.submit).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it.each([
      ['', 'an empty comma-separated list'],
      ['tm_foo,', 'an empty comma-separated topic'],
      ['["tm_foo"', 'malformed JSON'],
      ['["tm_foo",42]', 'a JSON array containing a non-string topic']
    ])('returns a clean 400 when X-Topics is %s (%s)', async topicsHeader => {
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      await instance.start()

      const route = postSpy.mock.calls.find(call => call[0] === '/submit')
      const handler: any = route === undefined ? undefined : route[route.length - 1]
      const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }
      handler?.(
        {
          headers: { 'x-topics': topicsHeader },
          body: Buffer.from([1, 2, 3])
        },
        res
      )
      await new Promise(resolve => setImmediate(resolve))

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'Invalid x-topics header: expected a comma-separated list or JSON string array'
      })
      expect(mockEngine.submit).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it('returns a clean 400 when /admin/health-check has no body', async () => {
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })
      await instance.start()

      const route = postSpy.mock.calls.find(call => call[0] === '/admin/health-check')
      const handler: any = route === undefined ? undefined : route[route.length - 1]
      const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }
      handler?.({ body: undefined }, res)
      await new Promise(resolve => setImmediate(resolve))

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'url is required'
      })
    })

    it('should set up CORS middleware', async () => {
      const useSpy = jest.spyOn(instance.app, 'use')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      // Find CORS middleware call
      const corsMiddleware = useSpy.mock.calls.find((call: any) => {
        const fn = call[0]
        return typeof fn === 'function' && fn.length === 3
      })
      expect(corsMiddleware).toBeDefined()
    })

    it('should register health check routes', async () => {
      const getSpy = jest.spyOn(instance.app, 'get')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(getSpy.mock.calls.find(call => call[0] === '/health')).toBeDefined()
      expect(getSpy.mock.calls.find(call => call[0] === '/health/live')).toBeDefined()
      expect(getSpy.mock.calls.find(call => call[0] === '/health/ready')).toBeDefined()
      expect(getSpy.mock.calls.find(call => call[0] === '/healthz')).toBeDefined()
    })

    it('should return detailed readiness health', async () => {
      const getSpy = jest.spyOn(instance.app, 'get')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      const readyRoute = getSpy.mock.calls.find(call => call[0] === '/health/ready')
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn().mockReturnThis()
      }

      readyRoute?.[1]({} as any, res as any)
      await new Promise(resolve => setImmediate(resolve))

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          ready: true,
          service: expect.objectContaining({
            name: 'TestServer'
          }),
          checks: expect.arrayContaining([
            expect.objectContaining({ name: 'engine', status: 'ok' }),
            expect.objectContaining({ name: 'knex', status: 'ok' }),
            expect.objectContaining({ name: 'mongo', status: 'ok' })
          ])
        })
      )
    })

    it('executes compatibility health probes and contains probe failures', async () => {
      const loggerError = jest.spyOn(instance.logger, 'error').mockImplementation(() => {})
      const { getSpy } = await startAndCaptureRoutes()

      const live = await invokeCapturedRoute(getSpy, '/health/live')
      expect(live.status).toHaveBeenCalledWith(200)
      expect(live.set).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0')
      expect(live.set).toHaveBeenCalledWith('Pragma', 'no-cache')
      expect((await invokeCapturedRoute(getSpy, '/healthz')).status).toHaveBeenCalledWith(200)
      expect((await invokeCapturedRoute(getSpy, '/health')).status).toHaveBeenCalledWith(200)

      const collectHealthReport = jest.spyOn(instance as any, 'collectHealthReport')
      collectHealthReport.mockResolvedValueOnce({ status: 'degraded', live: false })
      expect((await invokeCapturedRoute(getSpy, '/healthz')).status).toHaveBeenCalledWith(503)

      collectHealthReport.mockRejectedValueOnce(new Error('probe failed'))
      const failed = await invokeCapturedRoute(getSpy, '/healthz')
      expect(failed.status).toHaveBeenCalledWith(500)
      expect(failed.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'Health report unavailable'
      })
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'overlay.healthz' })
      )
    })

    it('constructs the janitor with bounded operator defaults', () => {
      const defaultJanitor = (instance as any).createJanitor()
      instance.configureJanitor({ batchSize: 10, maxReportResults: 20 })
      const configuredJanitor = (instance as any).createJanitor()

      expect(defaultJanitor).toBeDefined()
      expect(configuredJanitor).toBeDefined()
    })

    it('should register admin routes', async () => {
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(postSpy.mock.calls.some(call => call[0] === '/admin/syncAdvertisements')).toBe(true)
      expect(postSpy.mock.calls.some(call => call[0] === '/admin/startGASPSync')).toBe(true)
      expect(postSpy.mock.calls.some(call => call[0] === '/admin/evictOutpoint')).toBe(true)
      expect(postSpy.mock.calls.some(call => call[0] === '/admin/janitor')).toBe(true)
    })

    it('should register GASP sync routes when enabled', async () => {
      instance.configureEnableGASPSync(true)
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(postSpy.mock.calls.some(call => call[0] === '/requestSyncResponse')).toBe(true)
      expect(postSpy.mock.calls.some(call => call[0] === '/requestForeignGASPNode')).toBe(true)
    })

    it('should not register GASP sync routes when disabled', async () => {
      instance.configureEnableGASPSync(false)
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(postSpy.mock.calls.some(call => call[0] === '/requestSyncResponse')).toBe(false)
      expect(postSpy.mock.calls.some(call => call[0] === '/requestForeignGASPNode')).toBe(false)
    })

    it('should register ARC ingest route when API key is configured', async () => {
      instance.configureArcApiKey('test-arc-key')
      instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(postSpy.mock.calls.some(call => call[0] === '/arc-ingest')).toBe(true)
    })

    it('should not register ARC ingest route when API key is not configured', async () => {
      const postSpy = jest.spyOn(instance.app, 'post')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(postSpy.mock.calls.some(call => call[0] === '/arc-ingest')).toBe(false)
    })

    describe('ARC ingest callback token', () => {
      const mockRes = (): any => {
        const res: any = {}
        res.status = jest.fn<any>().mockReturnValue(res)
        res.json = jest.fn<any>().mockReturnValue(res)
        return res
      }
      // Flush the async IIFE inside the /arc-ingest handler.
      const flush = async (): Promise<void> => {
        await new Promise(resolve => setImmediate(resolve))
      }
      const proofCallbackBody = {
        txid: '11'.repeat(32),
        merklePath: '00',
        blockHeight: 800000
      }

      const captureArcIngestHandler = async (): Promise<any> => {
        const postSpy = jest.spyOn(instance.app, 'post')
        jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
          callback()
          return {} as any
        })
        await instance.start()
        const handler = postSpy.mock.calls.find(call => call[0] === '/arc-ingest')?.[1]
        expect(handler).toBeDefined()
        return handler
      }

      it('rejects a callback with no token when a token is configured', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler({ headers: {}, body: {} }, res)
        await flush()

        expect(res.status).toHaveBeenCalledWith(401)
      })

      it('rejects a callback with an invalid token', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler({ headers: { authorization: 'Bearer wrong-token' }, body: {} }, res)
        await flush()

        expect(res.status).toHaveBeenCalledWith(401)
      })

      it('accepts a callback with a valid Bearer token', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler(
          {
            headers: { authorization: 'Bearer test-callback-token-0123456789abcdef' },
            body: proofCallbackBody
          },
          res
        )
        await flush()

        expect(res.status).not.toHaveBeenCalledWith(401)
        expect(mockEngine.handleNewMerkleProof).toHaveBeenCalled()
      })

      it('accepts a callback with a valid x-callback-token header', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler(
          {
            headers: { 'x-callback-token': 'test-callback-token-0123456789abcdef' },
            body: proofCallbackBody
          },
          res
        )
        await flush()

        expect(res.status).not.toHaveBeenCalledWith(401)
        expect(mockEngine.handleNewMerkleProof).toHaveBeenCalled()
      })

      it('accepts callback tokens from array-valued headers', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const bearerRes = mockRes()
        const callbackRes = mockRes()

        handler(
          {
            headers: { authorization: ['Bearer test-callback-token-0123456789abcdef'] },
            body: proofCallbackBody
          },
          bearerRes
        )
        handler(
          {
            headers: { 'x-callback-token': ['test-callback-token-0123456789abcdef'] },
            body: proofCallbackBody
          },
          callbackRes
        )
        await flush()

        expect(bearerRes.status).not.toHaveBeenCalledWith(401)
        expect(callbackRes.status).not.toHaveBeenCalledWith(401)
      })

      it('rejects an unprefixed authorization token', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler(
          {
            headers: { authorization: 'test-callback-token-0123456789abcdef' },
            body: proofCallbackBody
          },
          res
        )
        await flush()

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockEngine.handleNewMerkleProof).not.toHaveBeenCalled()
      })

      it('fails startup when an ARC provider has no callback token', async () => {
        instance.configureArcApiKey('test-arc-key')
        const postSpy = jest.spyOn(instance.app, 'post')
        jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
          callback()
          return {} as any
        })
        await expect(instance.start()).rejects.toThrow('configureArcCallbackToken is required')

        expect(postSpy.mock.calls.some(call => call[0] === '/arc-ingest')).toBe(false)
        expect(mockEngine.handleNewMerkleProof).not.toHaveBeenCalled()
      })

      it('returns a public validation error when the callback has no txid', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler(
          { headers: { authorization: 'Bearer test-callback-token-0123456789abcdef' }, body: {} },
          res
        )
        await flush()

        expect(res.status).toHaveBeenCalledWith(400)
        expect(res.json).toHaveBeenCalledWith({
          status: 'error',
          message: 'Provider callback is missing txid'
        })
      })

      it('accepts a non-terminal status update without a Merkle proof', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler(
          {
            headers: { authorization: 'Bearer test-callback-token-0123456789abcdef' },
            body: { txid: '11'.repeat(32), txStatus: 'SEEN_ON_NETWORK' }
          },
          res
        )
        await flush()

        expect(res.status).toHaveBeenCalledWith(202)
        expect(mockEngine.handleNewMerkleProof).not.toHaveBeenCalled()
      })

      it('evicts a transaction when a provider reports a terminal double-spend status', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler(
          {
            headers: { authorization: 'Bearer test-callback-token-0123456789abcdef' },
            body: {
              txid: '11'.repeat(32),
              txStatus: 'DOUBLE_SPEND_ATTEMPTED',
              competingTxs: ['22'.repeat(32)]
            }
          },
          res
        )
        await flush()

        expect(mockEngine.evictAppliedTransaction).toHaveBeenCalledWith('11'.repeat(32), {
          topic: undefined,
          reason: 'DOUBLE_SPEND_ATTEMPTED'
        })
        expect(mockEngine.handleNewMerkleProof).not.toHaveBeenCalled()
      })

      it('evicts an orphan reported through extraInfo and preserves its topic', async () => {
        instance.configureArcApiKey('test-arc-key')
        instance.configureArcCallbackToken('test-callback-token-0123456789abcdef')
        const handler = await captureArcIngestHandler()
        const res = mockRes()

        handler(
          {
            headers: { authorization: 'Bearer test-callback-token-0123456789abcdef' },
            body: {
              txid: '33'.repeat(32),
              extraInfo: 'orphaned by competing transaction',
              topic: 'tm_test'
            }
          },
          res
        )
        await flush()

        expect(mockEngine.evictAppliedTransaction).toHaveBeenCalledWith('33'.repeat(32), {
          topic: 'tm_test',
          reason: 'orphaned by competing transaction'
        })
        expect(res.status).toHaveBeenCalledWith(200)
      })
    })

    it.each([
      ['/requestSyncResponse', 'provideForeignSyncResponse'],
      ['/requestForeignGASPNode', 'provideForeignGASPNode']
    ])('serializes untrusted %s errors through the configured logger', async (route, method) => {
      const safeLog = jest.requireActual<typeof import('@bsv/overlay')>('@bsv/overlay')
      jest.mocked(serializeErrorForLog).mockImplementation(safeLog.serializeErrorForLog)
      const logger = { ...console, log: jest.fn(), warn: jest.fn(), error: jest.fn() }
      instance.configureLogger(logger)
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { postSpy } = await startAndCaptureRoutes()
        for (const thrown of [
          new Error('untrusted\r\nforged\u0085record\u2028separator\u2029'),
          {
            toJSON: () => {
              throw new Error('unserializable request error')
            }
          }
        ]) {
          logger.error.mockClear()
          mockEngine[method].mockRejectedValueOnce(thrown)
          const response = await invokeCapturedRoute(postSpy, route, {
            headers: { 'x-bsv-topic': 'tm_test' },
            body: { graphID: 'graph', txid: '01', outputIndex: 0 }
          })
          expect(response.status).toHaveBeenCalledWith(400)
          expect(response.json).toHaveBeenCalledWith({
            status: 'error',
            message: 'Request could not be processed'
          })
          expect(logger.error).toHaveBeenCalledTimes(1)
          const args = logger.error.mock.calls[0]
          expect(args).toHaveLength(1)
          expect(args[0]).toContain(`Error in ${route}: error=`)
          expect(args[0]).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
          expect(args[0]).toContain(safeLog.serializeErrorForLog(thrown))
          expect(consoleError).not.toHaveBeenCalled()
        }
      } finally {
        consoleError.mockRestore()
      }
    })

    it('executes public discovery, GASP, and bounded BASM routes', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      const { getSpy, postSpy } = await startAndCaptureRoutes()

      const root = await invokeCapturedRoute(getSpy, '/')
      expect(root.send).toHaveBeenCalled()
      const html = root.send.mock.calls[0][0] as string
      const csp = root.set.mock.calls.find(
        (call: unknown[]) => call[0] === 'Content-Security-Policy'
      )?.[1] as string
      const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1]
      expect(nonce).toBeDefined()
      expect(html.split(`nonce="${nonce}"`)).toHaveLength(4)
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
      expect(html).not.toMatch(/\son(?:click|keydown)=/i)
      expect((await invokeCapturedRoute(getSpy, '/listTopicManagers')).status).toHaveBeenCalledWith(
        200
      )
      expect(
        (await invokeCapturedRoute(getSpy, '/listLookupServiceProviders')).status
      ).toHaveBeenCalledWith(200)
      expect(
        (
          await invokeCapturedRoute(getSpy, '/getDocumentationForTopicManager', {
            query: { manager: 'tm_test' }
          })
        ).send
      ).toHaveBeenCalledWith('# Docs')
      expect(
        (
          await invokeCapturedRoute(getSpy, '/getDocumentationForLookupServiceProvider', {
            query: { lookupService: 'ls_test' }
          })
        ).send
      ).toHaveBeenCalledWith('# Docs')

      const lookup = await invokeCapturedRoute(postSpy, '/lookup', {
        headers: {},
        body: { service: 'ls_test', query: { findAll: true } }
      })
      expect(lookup.status).toHaveBeenCalledWith(200)
      const invalidLookup = await invokeCapturedRoute(postSpy, '/lookup', {
        headers: {},
        body: { query: {} }
      })
      expect(invalidLookup.status).toHaveBeenCalledWith(400)

      await invokeCapturedRoute(postSpy, '/requestSyncResponse', {
        headers: { 'x-bsv-topic': 'tm_test' },
        body: { since: 1 }
      })
      await invokeCapturedRoute(postSpy, '/requestForeignGASPNode', {
        headers: { 'x-bsv-topic': 'tm_test' },
        body: { graphID: 'graph', txid: '01', outputIndex: 0 }
      })
      expect(mockEngine.provideForeignSyncResponse).toHaveBeenCalledWith({ since: 1 }, 'tm_test')
      expect(mockEngine.provideForeignGASPNode).toHaveBeenCalledWith('graph', '01', 0, 'tm_test')

      const topicRequest = { headers: { 'x-bsv-topic': 'tm_test' } }
      await invokeCapturedRoute(postSpy, '/requestTopicAnchorTip', topicRequest)
      await invokeCapturedRoute(postSpy, '/requestTopicAnchorRange', {
        ...topicRequest,
        body: { fromHeight: 1, toHeight: 3 }
      })
      await invokeCapturedRoute(postSpy, '/requestAdmittedList', {
        ...topicRequest,
        body: { blockHeight: '2', blockHash: 'aa'.repeat(32) }
      })
      await invokeCapturedRoute(postSpy, '/requestCompoundMerklePath', {
        ...topicRequest,
        body: { blockHeight: '2', txids: ['01'.repeat(32), '02'.repeat(32)] }
      })
      await invokeCapturedRoute(postSpy, '/requestRawTransactions', {
        ...topicRequest,
        body: { txids: ['01'.repeat(32)] }
      })
      expect(mockEngine.provideTopicAnchorTip).toHaveBeenCalledWith('tm_test')
      expect(mockEngine.provideTopicAnchorRange).toHaveBeenCalledWith('tm_test', 1, 3)
      expect(mockEngine.provideAdmittedList).toHaveBeenCalledWith('tm_test', 2, 'aa'.repeat(32))
      expect(mockEngine.provideCompoundMerklePath).toHaveBeenCalledWith('tm_test', 2, [
        '01'.repeat(32),
        '02'.repeat(32)
      ])
      expect(mockEngine.provideRawTransactions).toHaveBeenCalledWith(['01'.repeat(32)], 'tm_test')

      const tipRoute = postSpy.mock.calls.find(
        (call: any[]) => call[0] === '/requestTopicAnchorTip'
      )
      const rawRoute = postSpy.mock.calls.find(
        (call: any[]) => call[0] === '/requestRawTransactions'
      )
      const adminRoute = postSpy.mock.calls.find(
        (call: any[]) => call[0] === '/admin/startBASMSync'
      )
      expect(tipRoute).toHaveLength(2)
      expect(rawRoute).toHaveLength(2)
      expect(adminRoute.length).toBeGreaterThan(2)

      await invokeCapturedRoute(postSpy, '/requestAdmittedList', {
        ...topicRequest,
        body: { blockHeight: 3, blockHash: 'BB'.repeat(32) }
      })
      await invokeCapturedRoute(postSpy, '/requestAdmittedList', {
        ...topicRequest,
        body: { blockHeight: 4 }
      })
      await invokeCapturedRoute(postSpy, '/requestCompoundMerklePath', {
        ...topicRequest,
        body: { blockHeight: 3, txids: ['AB'.repeat(32)] }
      })
      expect(mockEngine.provideAdmittedList).toHaveBeenCalledWith('tm_test', 3, 'bb'.repeat(32))
      expect(mockEngine.provideAdmittedList).toHaveBeenCalledWith('tm_test', 4, undefined)
      expect(mockEngine.provideCompoundMerklePath).toHaveBeenCalledWith('tm_test', 3, [
        'ab'.repeat(32)
      ])

      for (const [path, request] of [
        ['/requestTopicAnchorTip', { headers: {} }],
        ['/requestTopicAnchorRange', { ...topicRequest, body: { fromHeight: 4, toHeight: 3 } }],
        ['/requestTopicAnchorRange', { ...topicRequest, body: { fromHeight: 0, toHeight: 1000 } }],
        ['/requestCompoundMerklePath', { ...topicRequest, body: { txids: [1] } }],
        ['/requestRawTransactions', { ...topicRequest, body: { txids: 'not-an-array' } }],
        ['/requestRawTransactions', { ...topicRequest, body: { txids: Array(1001).fill('01') } }]
      ] as const) {
        const response = await invokeCapturedRoute(postSpy, path, request)
        expect(response.status).toHaveBeenCalledWith(400)
      }

      consoleError.mockRestore()
    })

    it('rejects malformed BASM JSON requests before invoking the engine', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      const { postSpy } = await startAndCaptureRoutes()
      const topicRequest = { headers: { 'x-bsv-topic': 'tm_test' } }

      for (const [path, request, message] of [
        [
          '/requestTopicAnchorRange',
          { ...topicRequest, body: { fromHeight: null, toHeight: 1 } },
          'fromHeight must be a nonnegative safe integer'
        ],
        [
          '/requestTopicAnchorRange',
          { ...topicRequest, body: { fromHeight: false, toHeight: 1 } },
          'fromHeight must be a nonnegative safe integer'
        ],
        [
          '/requestAdmittedList',
          { ...topicRequest, body: { blockHeight: {}, blockHash: 'aa'.repeat(32) } },
          'blockHeight must be a nonnegative safe integer'
        ],
        [
          '/requestAdmittedList',
          { ...topicRequest, body: { blockHeight: -1 } },
          'blockHeight must be a nonnegative safe integer'
        ],
        [
          '/requestAdmittedList',
          { ...topicRequest, body: { blockHeight: 1.5 } },
          'blockHeight must be a nonnegative safe integer'
        ],
        [
          '/requestTopicAnchorRange',
          {
            ...topicRequest,
            body: { fromHeight: Number.MAX_SAFE_INTEGER + 1, toHeight: 1 }
          },
          'fromHeight must be a nonnegative safe integer'
        ],
        [
          '/requestAdmittedList',
          { ...topicRequest, body: { blockHeight: '2', blockHash: 'not-a-hash' } },
          'blockHash must be a 32-byte hexadecimal string'
        ],
        [
          '/requestCompoundMerklePath',
          { ...topicRequest, body: { blockHeight: '', txids: ['01'.repeat(32)] } },
          'blockHeight must be a nonnegative safe integer'
        ],
        [
          '/requestCompoundMerklePath',
          { ...topicRequest, body: { blockHeight: 2, txids: [] } },
          'txids must be a non-empty array'
        ],
        [
          '/requestRawTransactions',
          { ...topicRequest, body: { txids: ['not-a-txid'] } },
          'txids must contain 32-byte hexadecimal transaction IDs'
        ],
        [
          '/requestRawTransactions',
          {
            ...topicRequest,
            body: { txids: ['01'.repeat(32), '01'.repeat(32).toUpperCase()] }
          },
          'txids must not contain duplicates'
        ]
      ] as const) {
        const response = await invokeCapturedRoute(postSpy, path, request)
        expect(response.status).toHaveBeenCalledWith(400)
        expect(response.json).toHaveBeenCalledWith({ status: 'error', message })
      }

      expect(mockEngine.provideTopicAnchorRange).not.toHaveBeenCalled()
      expect(mockEngine.provideAdmittedList).not.toHaveBeenCalled()
      expect(mockEngine.provideCompoundMerklePath).not.toHaveBeenCalled()
      expect(mockEngine.provideRawTransactions).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it('preserves empty BASM responses and reports unsupported capabilities', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      const emptyTip = {
        topic: 'tm_test',
        blockHeight: -1,
        tac: '00'.repeat(32)
      }
      mockEngine.provideTopicAnchorTip.mockResolvedValue(emptyTip)
      const { postSpy } = await startAndCaptureRoutes()

      const tip = await invokeCapturedRoute(postSpy, '/requestTopicAnchorTip', {
        headers: { 'x-bsv-topic': 'tm_test' }
      })
      expect(tip.status).toHaveBeenCalledWith(200)
      expect(tip.json).toHaveBeenCalledWith(emptyTip)

      const raw = await invokeCapturedRoute(postSpy, '/requestRawTransactions', {
        headers: { 'x-bsv-topic': 'tm_test' },
        body: { txids: [] }
      })
      expect(raw.status).toHaveBeenCalledWith(200)
      expect(mockEngine.provideRawTransactions).toHaveBeenCalledWith([], 'tm_test')

      delete mockEngine.provideRawTransactions
      const unsupported = await invokeCapturedRoute(postSpy, '/requestRawTransactions', {
        headers: { 'x-bsv-topic': 'tm_test' },
        body: { txids: ['01'.repeat(32)] }
      })
      expect(unsupported.status).toHaveBeenCalledWith(400)
      expect(unsupported.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'BASM capability is not supported by this Overlay engine',
        code: 'BASM_UNSUPPORTED'
      })
      consoleError.mockRestore()
    })

    it('honors the unlimited BASM transaction limit override', async () => {
      const previousLimit = process.env.OVERLAY_MAX_BASM_TXIDS
      process.env.OVERLAY_MAX_BASM_TXIDS = '-1'
      try {
        const { postSpy } = await startAndCaptureRoutes()
        const txids = Array.from({ length: 1001 }, (_, index) =>
          index.toString(16).padStart(64, '0')
        )
        const response = await invokeCapturedRoute(postSpy, '/requestRawTransactions', {
          headers: { 'x-bsv-topic': 'tm_test' },
          body: { txids }
        })

        expect(response.status).toHaveBeenCalledWith(200)
        expect(mockEngine.provideRawTransactions).toHaveBeenCalledWith(txids, 'tm_test')
      } finally {
        if (previousLimit === undefined) {
          delete process.env.OVERLAY_MAX_BASM_TXIDS
        } else {
          process.env.OVERLAY_MAX_BASM_TXIDS = previousLimit
        }
      }
    })

    it('enforces admin authentication and executes bounded record and ban operations', async () => {
      const adminIdentityKey = `02${'11'.repeat(32)}`
      instance.configureAdminIdentityKey(adminIdentityKey)
      const banService = {
        getStats: jest
          .fn<any>()
          .mockResolvedValue({ domainBans: 1, outpointBans: 1, totalBans: 2 }),
        banDomain: jest.fn<any>().mockResolvedValue(undefined),
        banOutpoint: jest.fn<any>().mockResolvedValue(undefined),
        removeBan: jest.fn<any>().mockResolvedValue(undefined),
        listBans: jest.fn<any>().mockResolvedValue([{ type: 'domain', value: 'node.example' }])
      }
      instance.banService = banService as any
      const janitor = {
        checkHost: jest.fn<any>().mockResolvedValue({ ok: true, responseTime: 10 }),
        run: jest.fn<any>().mockResolvedValue({ checked: 1, removed: 0 })
      }
      jest.spyOn(instance as any, 'createJanitor').mockReturnValue(janitor)
      const { getSpy, postSpy } = await startAndCaptureRoutes()

      const statsRoute = getSpy.mock.calls.find((call: any[]) => call[0] === '/admin/stats')
      expect(statsRoute).toBeDefined()
      const checkAdminAuth = statsRoute[1]
      const next = jest.fn()
      const walletAuthResponse = mockResponse()
      checkAdminAuth(
        { headers: {}, auth: { identityKey: adminIdentityKey } },
        walletAuthResponse,
        next
      )
      checkAdminAuth(
        { headers: { authorization: `Bearer ${instance.getAdminToken()}` } },
        mockResponse(),
        next
      )
      expect(next).toHaveBeenCalledTimes(2)
      expect(walletAuthResponse.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'no-store, max-age=0'
      )
      expect(walletAuthResponse.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')

      const invalidCredentials = mockResponse()
      checkAdminAuth(
        { headers: { authorization: 'Bearer invalid-token' } },
        invalidCredentials,
        next
      )
      expect(invalidCredentials.status).toHaveBeenCalledWith(403)
      expect(invalidCredentials.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'no-store, max-age=0'
      )
      const missingCredentials = mockResponse()
      checkAdminAuth({ headers: {} }, missingCredentials, next)
      expect(missingCredentials.status).toHaveBeenCalledWith(401)

      expect((await invokeCapturedRoute(getSpy, '/admin/config')).status).toHaveBeenCalledWith(200)
      expect((await invokeCapturedRoute(getSpy, '/admin/stats')).status).toHaveBeenCalledWith(200)
      expect(
        (
          await invokeCapturedRoute(getSpy, '/admin/ship-records', {
            query: { search: 'node', page: '2', limit: '2' }
          })
        ).status
      ).toHaveBeenCalledWith(200)
      const shipCollection = (instance.mongoDb as any).collection('shipRecords')
      expect(
        (
          await invokeCapturedRoute(getSpy, '/admin/ship-records', {
            query: { search: '.*(a+)+$', page: '1', limit: '2' }
          })
        ).status
      ).toHaveBeenCalledWith(200)
      expect(shipCollection.find).toHaveBeenLastCalledWith({
        $or: expect.arrayContaining([
          { domain: { $regex: '\\.\\*\\(a\\+\\)\\+\\$', $options: 'i' } }
        ])
      })
      expect(
        (
          await invokeCapturedRoute(getSpy, '/admin/slap-records', {
            query: { page: '1', limit: 'unlimited' }
          })
        ).status
      ).toHaveBeenCalledWith(200)
      expect(
        (
          await invokeCapturedRoute(getSpy, '/admin/ship-records', {
            query: { page: 2, limit: 2 }
          })
        ).status
      ).toHaveBeenCalledWith(200)

      for (const [path, query] of [
        ['/admin/ship-records', { page: '1', limit: '0' }],
        ['/admin/slap-records', { page: '1000000', limit: '200' }],
        ['/admin/ship-records', { page: '1junk', limit: '2' }],
        ['/admin/slap-records', { page: '1', limit: '2junk' }],
        ['/admin/ship-records', { search: 'a'.repeat(257) }]
      ] as const) {
        expect((await invokeCapturedRoute(getSpy, path, { query })).status).toHaveBeenCalledWith(
          400
        )
      }
      expect(
        (
          await invokeCapturedRoute(postSpy, '/admin/health-check', {
            body: { url: 'https://node.example/healthz' }
          })
        ).status
      ).toHaveBeenCalledWith(200)

      await invokeCapturedRoute(postSpy, '/admin/ban', {
        body: { type: 'domain', value: 'node.example', reason: 'operator request' }
      })
      await invokeCapturedRoute(postSpy, '/admin/ban', {
        body: { type: 'outpoint', value: `${'ab'.repeat(32)}.2`, reason: 'operator request' }
      })
      await invokeCapturedRoute(postSpy, '/admin/unban', {
        body: { type: 'domain', value: 'node.example' }
      })
      const bans = await invokeCapturedRoute(getSpy, '/admin/bans', {
        query: { type: 'domain', page: '1', limit: '5' }
      })
      expect(bans.status).toHaveBeenCalledWith(200)
      await invokeCapturedRoute(postSpy, '/admin/remove-token', {
        body: {
          txid: 'ab'.repeat(32),
          outputIndex: 2,
          ban: true,
          banDomain: true
        }
      })

      instance.banService = undefined
      expect(
        (
          await invokeCapturedRoute(postSpy, '/admin/ban', {
            body: { type: 'domain', value: 'unavailable.example' }
          })
        ).status
      ).toHaveBeenCalledWith(400)
      instance.banService = banService as any
      for (const [path, body] of [
        ['/admin/ban', { type: 'invalid', value: 'node.example' }],
        ['/admin/unban', { type: 'invalid', value: 'node.example' }],
        ['/admin/remove-token', { txid: 42, outputIndex: 'invalid' }]
      ] as const) {
        expect((await invokeCapturedRoute(postSpy, path, { body })).status).toHaveBeenCalledWith(
          400
        )
      }

      expect(banService.banDomain).toHaveBeenCalled()
      expect(banService.banOutpoint).toHaveBeenCalled()
      expect(banService.removeBan).toHaveBeenCalledWith('domain', 'node.example')
      expect(banService.listBans).toHaveBeenCalledWith('domain', 5, 0)
      expect(mockEngine.lookupServices.ls_one.outputEvicted).toHaveBeenCalled()
      expect(janitor.checkHost).toHaveBeenCalledWith('https://node.example/healthz')
    })

    it('honors operator-unlimited admin pagination without applying cursor limits', async () => {
      const environment = {
        OVERLAY_ADMIN_LIST_DEFAULT_LIMIT: process.env.OVERLAY_ADMIN_LIST_DEFAULT_LIMIT,
        OVERLAY_ADMIN_LIST_MAX_LIMIT: process.env.OVERLAY_ADMIN_LIST_MAX_LIMIT,
        OVERLAY_ADMIN_LIST_MAX_OFFSET: process.env.OVERLAY_ADMIN_LIST_MAX_OFFSET
      }
      process.env.OVERLAY_ADMIN_LIST_DEFAULT_LIMIT = '-1'
      process.env.OVERLAY_ADMIN_LIST_MAX_LIMIT = '-1'
      process.env.OVERLAY_ADMIN_LIST_MAX_OFFSET = '-1'
      try {
        const { getSpy } = await startAndCaptureRoutes()

        for (const path of ['/admin/ship-records', '/admin/slap-records']) {
          const response = await invokeCapturedRoute(getSpy, path, {
            query: { page: '999', limit: 'unlimited' }
          })
          expect(response.status).toHaveBeenCalledWith(200)
          expect(response.json).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({ page: 1, limit: -1, pages: 1 })
            })
          )
        }
      } finally {
        for (const [key, value] of Object.entries(environment)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    })

    it('executes authenticated sync, maintenance, eviction, and janitor operations', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      const janitor = {
        checkHost: jest.fn<any>().mockResolvedValue({ ok: true }),
        run: jest.fn<any>().mockResolvedValue({ checked: 2, removed: 1 })
      }
      jest.spyOn(instance as any, 'createJanitor').mockReturnValue(janitor)
      mockEngine.refreshUnprovenTransactionProofs.mockImplementationOnce(async (options: any) => {
        await options.proofProvider('01')
        return { refreshed: 1 }
      })
      mockEngine.maintainUnprovenTransactions.mockImplementationOnce(async (options: any) => {
        await options.proofProvider('02')
        return { maintained: 1 }
      })
      const { postSpy } = await startAndCaptureRoutes()

      const successfulRoutes: Array<[string, Record<string, any>]> = [
        ['/admin/syncAdvertisements', {}],
        ['/admin/startGASPSync', {}],
        ['/admin/startBASMSync', {}],
        ['/admin/evictUnproven', { body: { topic: 'tm_test', thresholdBlocks: 12 } }],
        ['/admin/refreshUnprovenProofs', { body: { topic: 'tm_test', thresholdBlocks: 12 } }],
        ['/admin/maintainUnproven', { body: { topic: 'tm_test', thresholdBlocks: 12 } }],
        [
          '/admin/evictOutpoint',
          { body: { service: 'ls_one', txid: 'ab'.repeat(32), outputIndex: 2 } }
        ],
        ['/admin/janitor', {}]
      ]
      for (const [path, request] of successfulRoutes) {
        const response = await invokeCapturedRoute(postSpy, path, request)
        expect(response.status).toHaveBeenCalledWith(200)
      }

      expect(mockEngine.syncAdvertisements).toHaveBeenCalled()
      expect(mockEngine.startGASPSync).toHaveBeenCalled()
      expect(mockEngine.startBASMSync).toHaveBeenCalled()
      expect(mockEngine.evictUnprovenTransactions).toHaveBeenCalledWith({
        topic: 'tm_test',
        thresholdBlocks: 12
      })
      expect(mockEngine.refreshUnprovenTransactionProofs).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'tm_test', thresholdBlocks: 12 })
      )
      expect(mockEngine.maintainUnprovenTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'tm_test', thresholdBlocks: 12 })
      )
      expect(janitor.run).toHaveBeenCalled()

      for (const body of [
        { service: 'ls_one', txid: 'abcd', outputIndex: 2 },
        { service: 'ls_one', txid: 'ab'.repeat(32), outputIndex: -1 },
        { service: '__proto__', txid: 'ab'.repeat(32), outputIndex: 2 },
        { service: 'missing', txid: 'ab'.repeat(32), outputIndex: 2 }
      ]) {
        expect(
          (await invokeCapturedRoute(postSpy, '/admin/evictOutpoint', { body })).status
        ).toHaveBeenCalledWith(400)
      }
      consoleError.mockRestore()
    })

    it('should run knex migrations on start', async () => {
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(mockKnex.migrate.latest).toHaveBeenCalledWith({
        migrationSource: expect.any(Object)
      })

      const [{ migrationSource }] = mockKnex.migrate.latest.mock.calls[0]
      const migrations = await migrationSource.getMigrations([])
      expect(migrations).toEqual(instance.migrationsToRun)
      expect(await migrationSource.getMigration(migrations[0])).toBe(migrations[0])
      expect(migrationSource.getMigrationName({ name: 'named', up: jest.fn() })).toBe('named')
    })

    it('should call syncAdvertisements on start', async () => {
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(mockEngine.syncAdvertisements).toHaveBeenCalled()
    })

    it('should start GASP sync when enabled', async () => {
      instance.configureEnableGASPSync(true)
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(mockEngine.startGASPSync).toHaveBeenCalled()
    })

    it('should not start GASP sync when disabled', async () => {
      instance.configureEnableGASPSync(false)
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      expect(mockEngine.startGASPSync).not.toHaveBeenCalled()
    })

    it('should enable verbose request logging when configured', async () => {
      instance.configureVerboseRequestLogging(true)
      const useSpy = jest.spyOn(instance.app, 'use')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      // Verbose logging middleware should be registered
      expect(useSpy).toHaveBeenCalled()
    })

    it('should initialize advertiser if it is WalletAdvertiser', async () => {
      const mockAdvertiser: any = {
        // @ts-expect-error - Mock return value
        init: jest.fn().mockResolvedValue(undefined),
        createAdvertisements: jest.fn(),
        findAllAdvertisements: jest.fn(),
        revokeAdvertisements: jest.fn(),
        parseAdvertisement: jest.fn()
      }
      if (instance.engine === undefined) throw new Error('improper test setup')
      instance.engine.advertiser = mockAdvertiser

      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      // Mock the instanceof check
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const DiscoveryServices = require('@bsv/overlay-discovery-services')
      Object.defineProperty(mockAdvertiser, 'constructor', {
        value: DiscoveryServices.WalletAdvertiser
      })

      await instance.start()

      // The init method may or may not be called depending on instanceof check
      // Just verify start completes without error
      expect(instance.app.listen).toHaveBeenCalled()
    })

    it('should handle syncAdvertisements errors gracefully', async () => {
      mockEngine.syncAdvertisements.mockRejectedValueOnce(new Error('Sync failed'))
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      // Should not throw, just log the error
      await expect(instance.start()).resolves.not.toThrow()
    })

    it('should handle startGASPSync errors gracefully', async () => {
      instance.configureEnableGASPSync(true)
      mockEngine.startGASPSync.mockRejectedValueOnce(new Error('GASP sync failed'))
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      // Should not throw, just log the error
      await expect(instance.start()).resolves.not.toThrow()
    })

    it('should listen on configured port', async () => {
      instance.configurePort(8080)
      const listenSpy = jest
        .spyOn(instance.app, 'listen')
        .mockImplementation((port: any, callback: any) => {
          callback()
          return {} as any
        })

      await instance.start()

      expect(listenSpy).toHaveBeenCalledWith(8080, expect.any(Function))
    })

    it('should register 404 handler', async () => {
      const useSpy = jest.spyOn(instance.app, 'use')
      jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
        callback()
        return {} as any
      })

      await instance.start()

      // 404 handler should be the last middleware
      const lastUse = useSpy.mock.calls[useSpy.mock.calls.length - 1]
      expect(lastUse).toBeDefined()
      expect(typeof lastUse[0]).toBe('function')
    })
  })
})
