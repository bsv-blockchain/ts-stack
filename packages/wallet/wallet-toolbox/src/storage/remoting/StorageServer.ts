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
import { Wallet } from '../../Wallet'
import { StorageProvider } from '../StorageProvider'
import { WERR_UNAUTHORIZED } from '../../sdk/WERR_errors'
import { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { EntityTimeStamp } from '../../sdk/types'
import { WalletError } from '../../sdk/WalletError'
import { logWalletError } from '../../WalletLogger'

export interface WalletStorageServerOptions {
  port: number
  wallet: Wallet
  monetize: boolean
  calculateRequestPrice?: (req: Request) => number | Promise<number>
  adminIdentityKeys?: string[]
  makeLogger?: MakeWalletLogger
}

export class StorageServer {
  private app = express()
  private port: number
  private storage: StorageProvider
  private wallet: Wallet
  private monetize: boolean
  private calculateRequestPrice?: (req: Request) => number | Promise<number>
  private adminIdentityKeys?: string[]
  private makeLogger?: MakeWalletLogger

  constructor(storage: StorageProvider, options: WalletStorageServerOptions) {
    this.storage = storage
    this.port = options.port
    this.wallet = options.wallet
    this.monetize = options.monetize
    this.calculateRequestPrice = options.calculateRequestPrice
    this.adminIdentityKeys = options.adminIdentityKeys
    this.makeLogger = options.makeLogger

    if (options['logShortReqs']) {
      this.setupShortReqLogging()
    }

    this.setupRoutes()
  }

  private setupShortReqLogging(): void {
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
        if (traceContext)
          logObj['logging.googleapis.com/trace'] = `projects/computing-with-integrity/traces/${traceContext}`

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

  private setupRoutes(): void {
    this.app.use(express.json({ limit: '30mb' }))

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

    this.app.get(`/robots.txt`, (req: Request, res: Response) => {
      res.type('text/plain')
      res.send(`User-agent: *\nDisallow: /`)
    })

    this.app.get(`/`, (req: Request, res: Response) => {
      res.type('text/plain')
      res.send(`BRC-100 ${this.wallet.chain}Net Storage Provider.`)
    })

    const options: AuthMiddlewareOptions = {
      wallet: this.wallet as WalletInterface
    }
    this.app.use(createAuthMiddleware(options))
    if (this.monetize) {
      this.app.use(
        createPaymentMiddleware({
          wallet: this.wallet,
          calculateRequestPrice: this.calculateRequestPrice || (() => 100)
        })
      )
    }

    // A single POST endpoint for JSON-RPC:
    this.app.post('/', async (req: Request, res: Response) => {
      let { jsonrpc, method, params, id } = req.body
      // Basic JSON-RPC protocol checks:
      if (jsonrpc !== '2.0' || !method || typeof method !== 'string') {
        return res.status(400).json({ error: { code: -32600, message: 'Invalid Request' } })
      }

      const logObj = {
        source: `StorageServer POST handler`,
        method,
        id,
        user: req.auth.identityKey,
        params: JSON.stringify(params || '').slice(0, 256)
      }
      const traceContext = (req.headers['X-Cloud-Trace-Context'] || req.headers['x-cloud-trace-context'])?.split('/')[0]
      if (traceContext)
        logObj['logging.googleapis.com/trace'] = `projects/computing-with-integrity/traces/${traceContext}`

      console.log(JSON.stringify(logObj))

      try {
        // Dispatch the method call:
        if (typeof (this as any)[method] === 'function') {
          // if you wanted to handle certain methods on the server class itself
          // e.g. this['someServerMethod'](params)
          throw new Error('Server method dispatch not used in this approach.')
        } else if (typeof (this.storage as any)[method] === 'function') {
          // method is on the walletStorage:
          // Find user
          switch (method) {
            case 'destroy': {
              logObj['result'] = undefined
              logObj['comment'] = 'IGNORED'
              console.log(JSON.stringify(logObj))
              return res.json({ jsonrpc: '2.0', result: undefined, id })
            }
            case 'getSettings':
              {
                /** */
              }
              break
            case 'findOrInsertUser':
              {
                if (params[0] !== req.auth.identityKey)
                  throw new WERR_UNAUTHORIZED('function may only access authenticated user.')
              }
              break
            case 'adminStats':
              {
                // TODO: add check for admin user
                if (params[0] !== req.auth.identityKey)
                  throw new WERR_UNAUTHORIZED('function may only access authenticated admin user.')
                if (!this.adminIdentityKeys || !this.adminIdentityKeys.includes(req.auth.identityKey))
                  throw new WERR_UNAUTHORIZED('function may only be accessed by admin user.')
              }
              break
            case 'processSyncChunk':
              {
                await this.validateParam0(params, req)
                //const args: RequestSyncChunkArgs = params[0]
                const r: SyncChunk = params[1]
                if (r.certificateFields) r.certificateFields = this.validateEntities(r.certificateFields)
                if (r.certificates) r.certificates = this.validateEntities(r.certificates)
                if (r.commissions) r.commissions = this.validateEntities(r.commissions)
                if (r.outputBaskets) r.outputBaskets = this.validateEntities(r.outputBaskets)
                if (r.outputTagMaps) r.outputTagMaps = this.validateEntities(r.outputTagMaps)
                if (r.outputTags) r.outputTags = this.validateEntities(r.outputTags)
                if (r.outputs) r.outputs = this.validateEntities(r.outputs)
                if (r.provenTxReqs) r.provenTxReqs = this.validateEntities(r.provenTxReqs)
                if (r.provenTxs) r.provenTxs = this.validateEntities(r.provenTxs)
                if (r.transactions) r.transactions = this.validateEntities(r.transactions)
                if (r.txLabelMaps) r.txLabelMaps = this.validateEntities(r.txLabelMaps)
                if (r.txLabels) r.txLabels = this.validateEntities(r.txLabels)
                if (r.user) r.user = this.validateEntity(r.user)
              }
              break
            default:
              {
                await this.validateParam0(params, req)
              }
              break
          }

          // If makeLogger is valid, setup and potentially initialize to return data
          let logger: WalletLoggerInterface | undefined
          if (this.makeLogger && typeof params[1] === 'object') {
            logger = this.makeLogger(params[1]['logger'])
            params[1]['logger'] = logger
            logger.group(`StorageSever ${method}`)
            const userId = params[0]?.['userId']
            const identityKey = params[0]?.['identityKey']
            if (userId) logger.log(`userId: ${userId}`)
            if (identityKey) logger.log(`identityKey: ${identityKey}`)
          }

          try {
            const result = await (this.storage as any)[method](...(params || []))

            if (logger) {
              logger.groupEnd()
              logger.flush?.()
              if (logger.isOrigin) {
                // Potentially only flush if isOrigin...
              } else if (logger.logs && typeof result === 'object') {
                // If not the start of logging, return logged data with result.
                result['log'] = { logs: logger.logs }
              }
            }

            return res.json({ jsonrpc: '2.0', result, id })
          } catch (eu: unknown) {
            logWalletError(eu, logger, 'error executing requested method')
            logger?.flush?.()
            throw eu
          }
        } else {
          // Unknown method
          return res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${method}` },
            id
          })
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
        return res.status(200).json({
          jsonrpc: '2.0',
          error: JSON.parse(json),
          id
        })
      }
    })
  }

  private async validateParam0(params: any, req: Request): Promise<void> {
    if (typeof params[0] !== 'object' || !params[0]) {
      params = [{}]
    }
    if (params[0]['identityKey'] && params[0]['identityKey'] !== req.auth.identityKey)
      throw new WERR_UNAUTHORIZED('identityKey does not match authentiation')
    // console.log('looking up user with identityKey:', req.auth.identityKey)
    const { user, isNew } = await this.storage.findOrInsertUser(req.auth.identityKey)
    params[0].reqAuthUserId = user.userId
    if (params[0]['identityKey']) params[0].userId = user.userId
  }

  server: any

  public start(): void {
    this.server = this.app.listen(this.port, () => {
      console.log(`WalletStorageServer listening at http://localhost:${this.port}`)
    })
  }

  public async close(): Promise<void> {
    if (this.server) {
      await this.server.close(() => {
        // console.log('WalletStorageServer closed')
      })
    }
  }

  validateDate(date: Date | string | number): Date {
    let r: Date
    if (date instanceof Date) r = date
    else r = new Date(date)
    return r
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all individual records with time stamps retreived from database.
   */
  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T {
    entity.created_at = this.validateDate(entity.created_at)
    entity.updated_at = this.validateDate(entity.updated_at)
    if (dateFields) {
      for (const df of dateFields) {
        if (entity[df]) entity[df] = this.validateDate(entity[df])
      }
    }
    for (const key of Object.keys(entity)) {
      const val = entity[key]
      if (val === null) {
        entity[key] = undefined
      } else if (Buffer.isBuffer(val)) {
        entity[key] = Array.from(val)
      }
    }
    return entity
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all arrays of records with time stamps retreived from database.
   * @returns input `entities` array with contained values validated.
   */
  validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[] {
    for (let i = 0; i < entities.length; i++) {
      entities[i] = this.validateEntity(entities[i], dateFields)
    }
    return entities
  }
}
