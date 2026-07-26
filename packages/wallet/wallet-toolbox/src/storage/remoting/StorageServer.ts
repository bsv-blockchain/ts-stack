/**
 * StorageServer.ts
 *
 * A server-side class that "has a" local WalletStorage (like a StorageKnex instance),
 * and exposes it via a JSON-RPC POST endpoint using Express.
 */

import { MakeWalletLogger, WalletInterface, WalletLoggerInterface } from '@bsv/sdk'
import express, { Request, Response } from 'express'
import { AuthMiddlewareOptions, createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { Options as RateLimitOptions, rateLimit } from 'express-rate-limit'
import { Wallet } from '../../Wallet'
import { StorageProvider } from '../StorageProvider'
import { WERR_NOT_ACTIVE, WERR_UNAUTHORIZED } from '../../sdk/WERR_errors'
import { AuthId, SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { EntityTimeStamp } from '../../sdk/types'
import { validateDate, validateEntity, validateEntities, validateSyncChunkEntities } from './entityValidationHelpers'
import { WalletError } from '../../sdk/WalletError'
import { logWalletError } from '../../WalletLogger'
import { BINARY_ENCODING, BINARY_ENCODING_HEADER, BINARY_REQUEST_ENCODING_HEADER, decodeBinaryJsonValue, stringifyJsonRpc } from './BinaryJson'
import {
  authenticatedIdentityKey,
  configureTrustProxy,
  rateLimitOptions,
  TrustProxySetting
} from './RateLimitPolicy'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  readBodyLimitBytes,
  securityHeaders,
  type HttpServerPolicyDefaults,
  type SecurityHeadersOptions
} from './edgePolicy'
import {
  ACTION_BATCH_PACK_ENCODING_HEADER,
  decodeActionBatchPack,
  decompressActionBatchPack,
  supportedActionBatchPackEncodings
} from '../../utility/actionBatchPack'
import {
  ACTION_BATCH_MAX_PACK_BYTES,
  ACTION_BATCH_MAX_PACK_ITEMS
} from '../methods/actionBatchBlobs'

const storageRpcMethods = new Set([
  'abortAction',
  'abortActionBatch',
  'adminStats',
  'beginActionBatch',
  'commitActionBatch',
  'commitActionBatchByDigest',
  'createAction',
  'destroy',
  'extendActionBatch',
  'findCertificatesAuth',
  'findOrInsertSyncStateAuth',
  'findOrInsertUser',
  'findOutputBaskets',
  'findOutputBasketsAuth',
  'findOutputsAuth',
  'findProvenTxReqs',
  'getCapabilities',
  'getSettings',
  'getSyncChunk',
  'insertCertificateAuth',
  'internalizeAction',
  'listActions',
  'listCertificates',
  'listOutputs',
  'makeAvailable',
  'migrate',
  'prepareActionBatchCommit',
  'processAction',
  'processSyncChunk',
  'relinquishCertificate',
  'relinquishOutput',
  'renewActionBatch',
  'setActive',
  'updateProvenTxReqWithNewProvenTx'
])

const authIdRpcMethods = new Set([
  'abortAction',
  'abortActionBatch',
  'beginActionBatch',
  'commitActionBatch',
  'commitActionBatchByDigest',
  'createAction',
  'extendActionBatch',
  'findCertificatesAuth',
  'findOrInsertSyncStateAuth',
  'findOutputBaskets',
  'findOutputBasketsAuth',
  'findOutputsAuth',
  'insertCertificateAuth',
  'internalizeAction',
  'listActions',
  'listCertificates',
  'listOutputs',
  'prepareActionBatchCommit',
  'processAction',
  'relinquishCertificate',
  'relinquishOutput',
  'renewActionBatch',
  'setActive'
])

const actionBatchRpcMethods = new Set([
  'abortActionBatch',
  'beginActionBatch',
  'commitActionBatch',
  'commitActionBatchByDigest',
  'extendActionBatch',
  'prepareActionBatchCommit',
  'renewActionBatch'
])

interface RpcDispatchResult {
  found: boolean
  result?: unknown
}

export interface WalletStorageServerOptions {
  port: number
  wallet: Wallet
  monetize: boolean
  calculateRequestPrice?: (req: Request) => number | Promise<number>
  adminIdentityKeys?: string[]
  makeLogger?: MakeWalletLogger
  /**
   * Shared BRC-103 session storage for multi-process or multi-replica servers.
   * Defaults to the auth middleware's in-process SessionManager.
   */
  sessionManager?: AuthMiddlewareOptions['sessionManager']
  /**
   * Authenticated request rate limiting. Defaults to 1,000 requests per
   * identity key per minute. Override the store for shared enforcement across
   * multiple server processes or replicas.
   */
  rateLimit?: Partial<RateLimitOptions>
  /**
   * Pre-authentication IP rate limiting. Defaults to 300 requests per minute.
   * Use a shared store when multiple server processes or replicas must enforce
   * one aggregate limit.
   */
  preAuthRateLimit?: Partial<RateLimitOptions>
  /**
   * Explicit Express proxy trust policy. Omit for the secure direct-socket
   * default. Prefer a known hop count, subnet, or predicate; permissive
   * `true` is intentionally unsupported.
   */
  trustProxy?: TrustProxySetting
  /** Exact browser origins allowed to call this server. Omit for public CORS. */
  allowedOrigins?: string[]
  /** Per-process in-flight request ceiling. Defaults to 200. */
  maxConcurrentRequests?: number
  /** Node HTTP timeout/connection policy overrides. */
  http?: Partial<HttpServerPolicyDefaults>
  /** Security response-header and CSP overrides. */
  securityHeaders?: SecurityHeadersOptions
  /** Emit one JSON log record for each authenticated RPC. Default: true. */
  logRpcRequests?: boolean
}

export class StorageServer {
  private readonly app = express()
  private readonly port: number
  private readonly storage: StorageProvider
  private readonly wallet: Wallet
  private readonly monetize: boolean
  private readonly calculateRequestPrice?: (req: Request) => number | Promise<number>
  private readonly adminIdentityKeys?: string[]
  private readonly makeLogger?: MakeWalletLogger
  private readonly sessionManager?: AuthMiddlewareOptions['sessionManager']
  private readonly rateLimitOptions?: Partial<RateLimitOptions>
  private readonly preAuthRateLimitOptions?: Partial<RateLimitOptions>
  private readonly trustProxy?: TrustProxySetting
  private readonly allowedOrigins?: string[]
  private readonly maxConcurrentRequests: number
  private readonly httpPolicy: HttpServerPolicyDefaults
  private readonly securityHeadersPolicy: SecurityHeadersOptions
  private readonly logRpcRequests: boolean

  constructor (storage: StorageProvider, options: WalletStorageServerOptions) {
    this.storage = storage
    this.port = options.port
    this.wallet = options.wallet
    this.monetize = options.monetize
    this.calculateRequestPrice = options.calculateRequestPrice
    this.adminIdentityKeys = options.adminIdentityKeys
    this.makeLogger = options.makeLogger
    this.sessionManager = options.sessionManager
    this.rateLimitOptions = options.rateLimit
    this.preAuthRateLimitOptions = options.preAuthRateLimit
    this.trustProxy = options.trustProxy
    this.allowedOrigins = options.allowedOrigins
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? 200
    this.httpPolicy = {
      requestTimeoutMs: 2 * 60 * 1000,
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 2 * 60 * 1000,
      maxRequestsPerSocket: 1_000,
      ...options.http
    }
    this.securityHeadersPolicy = options.securityHeaders ?? {}
    this.logRpcRequests = options.logRpcRequests ?? true

    if (options['logShortReqs']) {
      this.setupShortReqLogging()
    }

    this.setupRoutes()
  }

  private setupShortReqLogging (): void {
    this.app.use((req: Request, res: Response, next: express.NextFunction) => {
      const contentLength = Number(req.headers['content-length'] || 0)

      if (contentLength > 0 && contentLength < 1000 && req.method === 'POST') {
        const logObj: any = {
          source: 'StorageServer short-request-log',
          contentLength,
          contentType: req.headers['content-type'] || '-',
          ts: new Date().toISOString(),
          url: req.originalUrl,
          ip: req.ip || req.socket.remoteAddress,
          ua: req.headers['user-agent'] || '-'
        }
        const traceContext = (req.headers['X-Cloud-Trace-Context'] || req.headers['x-cloud-trace-context'])?.split(
          '/'
        )[0]
        if (traceContext) { logObj['logging.googleapis.com/trace'] = `projects/computing-with-integrity/traces/${traceContext}` }

        // Request bodies and BSV auth/payment headers can contain sensitive
        // material. Short-request logging records metadata only.
        console.log(JSON.stringify(logObj))
      }

      next()
    })
  }

  private setupRoutes (): void {
    configureTrustProxy(this.app, this.trustProxy)
    this.app.disable('x-powered-by')
    this.app.use(securityHeaders({
      environmentPrefix: 'WALLET_STORAGE',
      ...this.securityHeadersPolicy
    }))
    this.app.use(corsPolicy({
      environmentPrefix: 'WALLET_STORAGE',
      allowedOrigins: this.allowedOrigins,
      methods: ['GET', 'PUT', 'POST', 'OPTIONS']
    }))
    this.app.use(concurrencyLimit(
      'WALLET_STORAGE',
      this.maxConcurrentRequests
    ))

    this.app.use(rateLimit(rateLimitOptions(
      { windowMs: 60_000, limit: 300 },
      {
        skip: (req: Request) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
        ...this.preAuthRateLimitOptions
      }
    )))

    // Escape HTML-significant characters in JSON responses. This preserves the
    // decoded JSON value while keeping user-controlled strings inert even if a
    // consumer embeds a response in an HTML context.
    this.app.set('json escape', true)
    this.app.use(express.json({
      limit: readBodyLimitBytes('WALLET_STORAGE_JSON', 30 * 1024 * 1024)
    }))
    // Authentication must see the exact binary body bytes, so parse octet
    // streams before the auth middleware just as JSON is parsed above.
    this.app.use(express.raw({
      type: 'application/octet-stream',
      limit: readBodyLimitBytes('WALLET_STORAGE_BINARY', 8 * 1024 * 1024)
    }))
    this.app.use(bodyParserErrorHandler)

    this.app.get('/robots.txt', (req: Request, res: Response) => {
      res.type('text/plain')
      res.send('User-agent: *\nDisallow: /')
    })

    this.app.get('/', (req: Request, res: Response) => {
      res.type('text/plain')
      res.send(`BRC-100 ${this.wallet.chain}Net Storage Provider.`)
    })

    const options: AuthMiddlewareOptions = {
      wallet: this.wallet as WalletInterface
    }
    if (this.sessionManager != null) options.sessionManager = this.sessionManager
    this.app.use(createAuthMiddleware(options))
    const authenticatedRateLimit = rateLimit(rateLimitOptions(
      { windowMs: 60_000, limit: 1_000 },
      {
        keyGenerator: authenticatedIdentityKey,
        ...this.rateLimitOptions
      }
    ))
    this.app.use(authenticatedRateLimit)
    if (this.monetize) {
      this.app.use(
        createPaymentMiddleware({
          wallet: this.wallet,
          calculateRequestPrice: this.calculateRequestPrice || (() => 100)
        })
      )
    }

    this.app.put(
      '/action-batch/:batchId/pack',
      async (req: Request, res: Response) => {
        try {
          const auth = await this.authenticatedAuth(req, true)
          const batchId = String(req.params.batchId)
          // Express types request bodies as `any`, and other body parsers can
          // produce strings, arrays, or objects. Keep the runtime narrowing
          // inline so both the transport and static data-flow analysis can see
          // that only a real byte view reaches the binary pack decoder.
          const rawBody: unknown = req.body
          if (
            typeof rawBody !== 'object' ||
            rawBody === null ||
            !(rawBody instanceof Uint8Array)
          ) {
            throw new TypeError('binary action batch body required')
          }
          // Re-wrap without copying. Besides normalizing Buffer subclasses,
          // this makes the decoder's runtime type independent of req.body.
          const body = new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
          const requestedEncoding = req.header(ACTION_BATCH_PACK_ENCODING_HEADER) ?? 'identity'
          const encoding = supportedActionBatchPackEncodings()
            .find(candidate => candidate === requestedEncoding)
          if (encoding == null) throw new TypeError(`unsupported action batch pack encoding ${requestedEncoding}`)
          const frame = await decompressActionBatchPack(body, encoding, ACTION_BATCH_MAX_PACK_BYTES)
          const items = decodeActionBatchPack(
            frame,
            ACTION_BATCH_MAX_PACK_BYTES,
            ACTION_BATCH_MAX_PACK_ITEMS
          )
          await this.storage.putActionBatchPack(auth, {
            batchId,
            items,
            maxPackBytes: ACTION_BATCH_MAX_PACK_BYTES,
            maxItems: ACTION_BATCH_MAX_PACK_ITEMS
          })
          res.status(200).json({ uploaded: true })
        } catch (error: unknown) {
          const json = WalletError.unknownToJson(error)
          res.status(400).json(JSON.parse(json))
        }
      }
    )

    this.app.put(
      '/action-batch/:batchId/blob/:digest',
      async (req: Request, res: Response) => {
        try {
          const auth = await this.authenticatedAuth(req, true)
          const batchId = String(req.params.batchId)
          const digest = String(req.params.digest)
          const body = req.body
          if (!(body instanceof Uint8Array)) throw new TypeError('binary action batch body required')
          await this.storage.putActionBatchBlob(auth, { batchId, digest, bytes: body })
          res.status(200).json({ uploaded: true })
        } catch (error: unknown) {
          const json = WalletError.unknownToJson(error)
          res.status(400).json(JSON.parse(json))
        }
      }
    )

    // A single POST endpoint for JSON-RPC:
    this.app.post('/', this.handleRpcRequest.bind(this))
  }

  private async handleRpcRequest (req: Request, res: Response): Promise<Response> {
    const useBinary = req.header(BINARY_ENCODING_HEADER) === BINARY_ENCODING
    const requestUsesBinary = req.header(BINARY_REQUEST_ENCODING_HEADER) === BINARY_ENCODING
    if (useBinary) res.set(BINARY_ENCODING_HEADER, BINARY_ENCODING)

    const { jsonrpc, method, id } = req.body
    const params = (requestUsesBinary ? decodeBinaryJsonValue(req.body.params) : req.body.params) as any[]
    if (jsonrpc !== '2.0' || !method || typeof method !== 'string') {
      return this.sendRpc(res, useBinary, { error: { code: -32600, message: 'Invalid Request' } }, 400)
    }

    const logObj = this.createRpcLog(req, method, id, params)
    try {
      const dispatch = await this.dispatchRpcCall(method, params, req, logObj)
      if (!dispatch.found) {
        return this.sendRpc(res, useBinary, {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id
        }, 400)
      }
      return this.sendRpc(res, useBinary, { jsonrpc: '2.0', result: dispatch.result, id })
    } catch (error: unknown) {
      return this.sendRpcError(res, useBinary, id, error)
    }
  }

  private sendRpc (res: Response, useBinary: boolean, payload: unknown, status: number = 200): Response {
    res.set('X-Content-Type-Options', 'nosniff')
    // Normalize with the negotiated binary replacer, then let Express emit
    // the JSON response through its escaping-aware JSON sink.
    return res.status(status).json(JSON.parse(stringifyJsonRpc(payload, useBinary)))
  }

  private sendRpcError (res: Response, useBinary: boolean, id: unknown, error: unknown): Response {
    /**
     * Convert errors to standard JSON object format that can be converted back
     * to WalletError derived objects on the client side and re-thrown.
     */
    const json = WalletError.unknownToJson(error)
    return this.sendRpc(res, useBinary, {
      jsonrpc: '2.0',
      error: JSON.parse(json),
      id
    })
  }

  private createRpcLog (
    req: Request,
    method: string,
    id: unknown,
    params: any[]
  ): Record<string, unknown> | undefined {
    if (!this.logRpcRequests) return undefined

    const logObj: Record<string, unknown> = {
      source: 'StorageServer POST handler',
      method,
      id,
      user: req.auth.identityKey,
      params: JSON.stringify(params || '').slice(0, 256)
    }
    const traceContext = (req.headers['X-Cloud-Trace-Context'] || req.headers['x-cloud-trace-context'])?.split('/')[0]
    if (traceContext) {
      logObj['logging.googleapis.com/trace'] = `projects/computing-with-integrity/traces/${traceContext}`
    }
    console.log(JSON.stringify(logObj))
    return logObj
  }

  private async dispatchRpcCall (
    method: string,
    params: any[],
    req: Request,
    logObj?: Record<string, unknown>
  ): Promise<RpcDispatchResult> {
    if (!storageRpcMethods.has(method)) return { found: false }

    const storageMethod = method === 'findOutputBaskets'
      ? 'findOutputBasketsAuth'
      : method
    const storageHandler = (this.storage as any)[storageMethod]
    if (typeof storageHandler !== 'function') return { found: false }

    const shouldInvoke = await this.authorizeRpcCall(method, params, req, logObj)
    if (!shouldInvoke) return { found: true, result: undefined }

    const logger = this.createRpcLogger(method, params)
    try {
      const result = await storageHandler.call(this.storage, ...params)
      this.finishRpcLogging(logger, result)
      return { found: true, result }
    } catch (error: unknown) {
      logWalletError(error, logger, 'error executing requested method')
      logger?.flush?.()
      throw error
    }
  }

  private async authorizeRpcCall (
    method: string,
    params: any[],
    req: Request,
    logObj?: Record<string, unknown>
  ): Promise<boolean> {
    switch (method) {
      case 'destroy':
        this.logIgnoredDestroy(logObj)
        return false
      case 'getSettings':
        return true
      case 'findOrInsertUser':
        if (params[0] !== req.auth.identityKey) {
          throw new WERR_UNAUTHORIZED('function may only access authenticated user.')
        }
        return true
      case 'adminStats':
        this.authorizeAdminStats(params, req)
        return true
      case 'processSyncChunk':
        await this.validateParam0(params, req)
        validateSyncChunkEntities(params[1] as SyncChunk)
        return true
      default:
        await this.authorizeStandardRpcCall(method, params, req)
        return true
    }
  }

  private logIgnoredDestroy (logObj?: Record<string, unknown>): void {
    if (logObj == null) return
    logObj.result = undefined
    logObj.comment = 'IGNORED'
    console.log(JSON.stringify(logObj))
  }

  private authorizeAdminStats (params: any[], req: Request): void {
    if (params[0] !== req.auth.identityKey) {
      throw new WERR_UNAUTHORIZED('function may only access authenticated admin user.')
    }
    if (!this.adminIdentityKeys?.includes(req.auth.identityKey)) {
      throw new WERR_UNAUTHORIZED('function may only be accessed by admin user.')
    }
  }

  private async authorizeStandardRpcCall (method: string, params: any[], req: Request): Promise<void> {
    if (authIdRpcMethods.has(method)) {
      await this.bindAuthenticatedAuth(params, req, actionBatchRpcMethods.has(method))
      return
    }
    await this.validateParam0(params, req)
  }

  private createRpcLogger (method: string, params: any[]): WalletLoggerInterface | undefined {
    if (this.makeLogger == null || params[1] == null || typeof params[1] !== 'object') return undefined

    const logger = this.makeLogger(params[1].logger)
    params[1].logger = logger
    logger.group(`StorageSever ${method}`)
    const userId = params[0]?.userId
    const identityKey = params[0]?.identityKey
    if (userId) logger.log(`userId: ${userId}`)
    if (identityKey) logger.log(`identityKey: ${identityKey}`)
    return logger
  }

  private finishRpcLogging (logger: WalletLoggerInterface | undefined, result: any): void {
    if (logger == null) return

    logger.groupEnd()
    logger.flush?.()
    if (!logger.isOrigin && logger.logs != null && result != null && typeof result === 'object') {
      // If this is not the start of logging, return logged data with the result.
      result.log = { logs: logger.logs }
    }
  }

  private async authenticatedAuth (req: Request, requireActive: boolean): Promise<AuthId> {
    const { user } = await this.storage.findOrInsertUser(req.auth.identityKey)
    const isActive = user.activeStorage === this.storage.getSettings().storageIdentityKey
    if (requireActive && !isActive) {
      throw new WERR_NOT_ACTIVE('action batch methods require the authenticated user\'s active storage provider')
    }
    return {
      identityKey: req.auth.identityKey,
      userId: user.userId,
      isActive
    }
  }

  private async bindAuthenticatedAuth (params: any[], req: Request, requireActive: boolean): Promise<void> {
    if (!Array.isArray(params)) throw new WERR_UNAUTHORIZED('authenticated RPC parameters are required')
    const claimed = typeof params[0] === 'object' && params[0] != null ? params[0] : {}
    if (claimed.identityKey != null && claimed.identityKey !== req.auth.identityKey) {
      throw new WERR_UNAUTHORIZED('identityKey does not match authentication')
    }
    const auth = await this.authenticatedAuth(req, requireActive)
    params[0] = {
      ...claimed,
      ...auth,
      reqAuthUserId: auth.userId
    }
  }

  private async validateParam0 (params: any[], req: Request): Promise<void> {
    if (!Array.isArray(params)) throw new WERR_UNAUTHORIZED('authenticated RPC parameters are required')
    if (typeof params[0] !== 'object' || !params[0]) {
      params[0] = {}
    }
    if (params[0].identityKey && params[0].identityKey !== req.auth.identityKey) { throw new WERR_UNAUTHORIZED('identityKey does not match authentication') }
    // console.log('looking up user with identityKey:', req.auth.identityKey)
    const { user } = await this.storage.findOrInsertUser(req.auth.identityKey)
    params[0].reqAuthUserId = user.userId
    if (params[0].identityKey || params[0].userId != null) params[0].userId = user.userId
  }

  server: any

  public start (): void {
    this.server = this.app.listen(this.port, () => {
      console.log(`WalletStorageServer listening at http://localhost:${this.port}`)
    })
    configureHttpServer(this.server, 'WALLET_STORAGE', this.httpPolicy)
  }

  public async close (): Promise<void> {
    if (this.server) {
      await this.server.close(() => {
        // console.log('WalletStorageServer closed')
      })
    }
  }

  /** @see {@link validateDate} */
  validateDate (date: Date | string | number): Date { return validateDate(date) }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all individual records with time stamps retreived from database.
   * @see {@link validateEntity}
   */
  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T {
    return validateEntity(entity, dateFields)
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all arrays of records with time stamps retreived from database.
   * @returns input `entities` array with contained values validated.
   * @see {@link validateEntities}
   */
  validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[] {
    return validateEntities(entities, dateFields)
  }
}
