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

const storageRpcMethods = new Set([
  'abortAction',
  'abortActionBatch',
  'adminStats',
  'beginActionBatch',
  'commitActionBatch',
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
  'extendActionBatch',
  'prepareActionBatchCommit',
  'renewActionBatch'
])

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
          ua: req.headers['user-agent'] || '-',
          headers: { ...req.headers } // shallow copy
        }
        const traceContext = (req.headers['X-Cloud-Trace-Context'] || req.headers['x-cloud-trace-context'])?.split(
          '/'
        )[0]
        if (traceContext) { logObj['logging.googleapis.com/trace'] = `projects/computing-with-integrity/traces/${traceContext}` }

        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.from(chunk)))

        req.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks)

          try {
            logObj.body = bodyBuffer.toString('utf8')
          } catch {
            logObj.body = bodyBuffer.toString('hex')
            logObj.bodyEncoding = 'hex'
          }

          console.log(JSON.stringify(logObj))
        })
      }

      next()
    })
  }

  private setupRoutes (): void {
    // Escape HTML-significant characters in JSON responses. This preserves the
    // decoded JSON value while keeping user-controlled strings inert even if a
    // consumer embeds a response in an HTML context.
    this.app.set('json escape', true)
    this.app.use(express.json({ limit: '30mb' }))
    // Authentication must see the exact binary body bytes, so parse octet
    // streams before the auth middleware just as JSON is parsed above.
    this.app.use(express.raw({ type: 'application/octet-stream', limit: '8mb' }))

    // This allows the API to be used everywhere when CORS is enforced
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Headers', '*')
      res.header('Access-Control-Allow-Methods', '*')
      res.header('Access-Control-Expose-Headers', '*')
      res.header('Access-Control-Allow-Private-Network', 'true')
      if (req.method === 'OPTIONS') {
        // Handle CORS preflight requests to allow cross-origin POST/PUT requests
        res.sendStatus(200)
      } else {
        next()
      }
    })

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
    const authenticatedRateLimit = rateLimit({
      windowMs: 60_000,
      limit: 1_000,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req: Request) => req.auth.identityKey,
      ...this.rateLimitOptions
    })
    if (this.monetize) {
      this.app.use(
        createPaymentMiddleware({
          wallet: this.wallet,
          calculateRequestPrice: this.calculateRequestPrice || (() => 100)
        })
      )
    }

    this.app.put(
      '/action-batch/:batchId/blob/:digest',
      authenticatedRateLimit,
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
    this.app.post('/', authenticatedRateLimit, async (req: Request, res: Response) => {
      const useBinary = req.header(BINARY_ENCODING_HEADER) === BINARY_ENCODING
      const requestUsesBinary = req.header(BINARY_REQUEST_ENCODING_HEADER) === BINARY_ENCODING
      if (useBinary) res.set(BINARY_ENCODING_HEADER, BINARY_ENCODING)
      const { jsonrpc, method, id } = req.body
      const params = (requestUsesBinary ? decodeBinaryJsonValue(req.body.params) : req.body.params) as any[]
      const sendRpc = (payload: unknown, status: number = 200): Response => {
        res.set('X-Content-Type-Options', 'nosniff')
        // Normalize with the negotiated binary replacer, then let Express emit
        // the JSON response through its escaping-aware JSON sink.
        return res.status(status).json(JSON.parse(stringifyJsonRpc(payload, useBinary)))
      }
      // Basic JSON-RPC protocol checks:
      if (jsonrpc !== '2.0' || !method || typeof method !== 'string') {
        return sendRpc({ error: { code: -32600, message: 'Invalid Request' } }, 400)
      }

      let logObj: Record<string, unknown> | undefined
      if (this.logRpcRequests) {
        logObj = {
          source: 'StorageServer POST handler',
          method,
          id,
          user: req.auth.identityKey,
          params: JSON.stringify(params || '').slice(0, 256)
        }
        const traceContext = (req.headers['X-Cloud-Trace-Context'] || req.headers['x-cloud-trace-context'])?.split('/')[0]
        if (traceContext) { logObj['logging.googleapis.com/trace'] = `projects/computing-with-integrity/traces/${traceContext}` }
        console.log(JSON.stringify(logObj))
      }

      try {
        // Dispatch the method call:
        if (typeof (this as any)[method] === 'function') {
          // if you wanted to handle certain methods on the server class itself
          // e.g. this['someServerMethod'](params)
          throw new TypeError('Server method dispatch not used in this approach.')
        } else if (storageRpcMethods.has(method)) {
          const storageMethod = method === 'findOutputBaskets'
            ? 'findOutputBasketsAuth'
            : method
          if (typeof (this.storage as any)[storageMethod] !== 'function') {
            return sendRpc({
              jsonrpc: '2.0',
              error: { code: -32601, message: `Method not found: ${method}` },
              id
            }, 400)
          }
          // method is on the walletStorage:
          // Find user
          switch (method) {
            case 'destroy': {
              if (logObj != null) {
                logObj.result = undefined
                logObj.comment = 'IGNORED'
                console.log(JSON.stringify(logObj))
              }
              return sendRpc({ jsonrpc: '2.0', result: undefined, id })
            }
            case 'getSettings':
              /** */
              break
            case 'findOrInsertUser':
              if (params[0] !== req.auth.identityKey) { throw new WERR_UNAUTHORIZED('function may only access authenticated user.') }
              break
            case 'adminStats':
              // Add check for admin user
              if (params[0] !== req.auth.identityKey) { throw new WERR_UNAUTHORIZED('function may only access authenticated admin user.') }
              if (!this.adminIdentityKeys?.includes(req.auth.identityKey)) { throw new WERR_UNAUTHORIZED('function may only be accessed by admin user.') }
              break
            case 'processSyncChunk': {
              await this.validateParam0(params, req)
              // const args: RequestSyncChunkArgs = params[0]
              const r: SyncChunk = params[1]
              validateSyncChunkEntities(r)
              break
            }
            default:
              if (authIdRpcMethods.has(method)) {
                await this.bindAuthenticatedAuth(params, req, actionBatchRpcMethods.has(method))
              } else {
                await this.validateParam0(params, req)
              }
              break
          }

          // If makeLogger is valid, setup and potentially initialize to return data
          let logger: WalletLoggerInterface | undefined
          if ((this.makeLogger != null) && typeof params[1] === 'object') {
            logger = this.makeLogger(params[1].logger)
            params[1].logger = logger
            logger.group(`StorageSever ${method}`)
            const userId = params[0]?.userId
            const identityKey = params[0]?.identityKey
            if (userId) logger.log(`userId: ${userId}`)
            if (identityKey) logger.log(`identityKey: ${identityKey}`)
          }

          try {
            const result = await (this.storage as any)[storageMethod](...(params || []))

            if (logger != null) {
              logger.groupEnd()
              logger.flush?.()
              if (logger.isOrigin) {
                // Potentially only flush if isOrigin...
              } else if ((logger.logs != null) && typeof result === 'object') {
                // If not the start of logging, return logged data with result.
                result.log = { logs: logger.logs }
              }
            }

            return sendRpc({ jsonrpc: '2.0', result, id })
          } catch (error_: unknown) {
            logWalletError(error_, logger, 'error executing requested method')
            logger?.flush?.()
            throw error_
          }
        } else {
          // Unknown method
          return sendRpc({
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${method}` },
            id
          }, 400)
        }
      } catch (error: unknown) {
        /**
         * Catch any thrown errors from the local walletStorage method.
         *
         * Convert errors to standard JSON object format that can be converted
         * back to WalletError derived objects on the client side and re-thrown.
         *
         * Uses WalletError.fromJson(<error object>) on the client side to re-create
         * an error object of the right class and properties.
         */
        const json = WalletError.unknownToJson(error)
        return sendRpc({
          jsonrpc: '2.0',
          error: JSON.parse(json),
          id
        })
      }
    })
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
