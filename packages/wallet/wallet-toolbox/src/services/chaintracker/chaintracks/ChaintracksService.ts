import { Chaintracks } from './Chaintracks'

import { IncomingMessage, Server, ServerResponse } from 'node:http'
import express, { NextFunction, Request, RequestHandler, Response } from 'express'
import bodyParser from 'body-parser'
import { Chain } from '../../../sdk/types'
import { createDefaultNoDbChaintracksOptions } from './createDefaultNoDbChaintracksOptions'
import { Services } from '../../Services'
import { FiatExchangeRates, WERR_INVALID_PARAMETER } from '../../../sdk'
import { ChaintracksInfoApi } from './Api/ChaintracksClientApi'
import { wait } from '../../../utility/utilityHelpers'
import { BaseBlockHeader, BlockHeader } from './Api/BlockHeaderApi'
import { validateBaseBlockHeaderFormat } from './util/blockHeaderUtilities'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  readBodyLimitBytes,
  securityHeaders,
  type HttpServerPolicyDefaults
} from '../../../storage/remoting/edgePolicy'

export interface ChaintracksServiceOptions {
  chain: Chain
  /**
   * prepended to the path of each registered service endpoint
   */
  routingPrefix: string
  /**
   * Defaults to default configured Chaintracks instance with NoDb storage.
   */
  chaintracks?: Chaintracks
  services?: Services
  port?: number
  /** Exact browser origins allowed to use the service. Omit for public CORS. */
  allowedOrigins?: string[]
  maxConcurrentRequests?: number
  http?: Partial<HttpServerPolicyDefaults>
  /** Request starts allowed per client address per minute. Defaults to 3,000. */
  maxRequestsPerMinute?: number
  /** Header submissions allowed per client address per minute. Defaults to 120. */
  maxHeaderSubmissionsPerMinute?: number
  /** Express trusted-proxy policy used to derive the client address. Disabled by default. */
  trustProxy?: boolean | number | string | string[]
  /** Maximum header count returned by one request. Defaults to 10,000; hard maximum 100,000. */
  maxHeadersPerRequest?: number
  /** Maximum supported getInfo diagnostic wait. Defaults to 1 second; hard maximum 30 seconds. */
  maxWaitMsecs?: number
  /** Opt in to per-request path logging. Response bodies and query values are never logged. */
  logRequests?: boolean
}

function boundedPositiveOption(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new WERR_INVALID_PARAMETER(name, `a positive safe integer no greater than ${maximum}`)
  }
  return resolved
}

function normalizeRoutingPrefix(value: string): string {
  if (value === '') return value
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9._~-]+)(?:\/[A-Za-z0-9._~-]+)*$/.test(value)) {
    throw new WERR_INVALID_PARAMETER(
      'routingPrefix',
      'empty or an absolute path of unreserved segments without a trailing slash'
    )
  }
  return value
}

function fixedWindowRateLimit(maximum: number, code: string): RequestHandler {
  const clients = new Map<string, { windowStarted: number; count: number }>()
  const maximumClients = 10_000
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now()
    const client = req.ip || req.socket.remoteAddress || 'unknown'
    let state = clients.get(client)
    if (state == null || now - state.windowStarted >= 60_000) {
      state = { windowStarted: now, count: 0 }
      clients.delete(client)
      clients.set(client, state)
    }
    if (clients.size > maximumClients) {
      for (const [key, candidate] of clients) {
        if (now - candidate.windowStarted >= 60_000 || clients.size > maximumClients) {
          clients.delete(key)
        }
        if (clients.size <= maximumClients) break
      }
    }
    if (state.count >= maximum) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((60_000 - (now - state.windowStarted)) / 1000))))
      res.status(429).json({ status: 'error', code, description: 'The request rate limit has been exceeded.' })
      return
    }
    state.count++
    next()
  }
}

function parseUnsignedQuery(value: unknown, name: string, maximum: number, minimum = 0): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new WERR_INVALID_PARAMETER(name, `an integer from ${minimum} through ${maximum}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WERR_INVALID_PARAMETER(name, `an integer from ${minimum} through ${maximum}`)
  }
  return parsed
}

function parseHashQuery(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new WERR_INVALID_PARAMETER('hash', 'exactly 32 hexadecimal bytes')
  }
  return value.toLowerCase()
}

export class ChaintracksService {
  static createChaintracksServiceOptions(chain: Chain): ChaintracksServiceOptions {
    const options: ChaintracksServiceOptions = {
      chain,
      routingPrefix: ''
    }
    return options
  }

  chain: Chain
  options: ChaintracksServiceOptions
  port?: number
  chaintracks: Chaintracks
  services: Services
  server?: Server<typeof IncomingMessage, typeof ServerResponse>
  private readonly maxRequestsPerMinute: number
  private readonly maxHeaderSubmissionsPerMinute: number
  private readonly maxHeadersPerRequest: number
  private readonly maxWaitMsecs: number

  constructor(options: ChaintracksServiceOptions) {
    this.options = { ...options, routingPrefix: normalizeRoutingPrefix(options.routingPrefix) }
    this.port = options.port
    this.chain = options.chain
    this.maxRequestsPerMinute = boundedPositiveOption(
      options.maxRequestsPerMinute,
      3000,
      1_000_000,
      'maxRequestsPerMinute'
    )
    this.maxHeaderSubmissionsPerMinute = boundedPositiveOption(
      options.maxHeaderSubmissionsPerMinute,
      120,
      100_000,
      'maxHeaderSubmissionsPerMinute'
    )
    this.maxHeadersPerRequest = boundedPositiveOption(
      options.maxHeadersPerRequest,
      10_000,
      100_000,
      'maxHeadersPerRequest'
    )
    this.maxWaitMsecs = boundedPositiveOption(options.maxWaitMsecs, 1_000, 30_000, 'maxWaitMsecs')
    this.chaintracks = options.chaintracks || new Chaintracks(createDefaultNoDbChaintracksOptions(this.chain))
    this.services = options.services || new Services(this.chain)
    // Prevent recursion...
    this.services.updateFiatExchangeRateServices.remove('ChaintracksService')
    if (this.chaintracks.chain !== this.chain || this.services.chain !== this.chain) {
      throw new WERR_INVALID_PARAMETER(
        'chain',
        `All components (chaintracks and services) must be on chain ${this.chain}`
      )
    }
  }

  async stopJsonRpcServer(): Promise<void> {
    if (this.server != null) {
      const server = this.server
      this.server = undefined
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error == null ? resolve() : reject(error)))
        server.closeIdleConnections()
      })
    }
    await this.chaintracks?.destroy()
  }

  async startJsonRpcServer(port?: number): Promise<void> {
    port ??= this.port ?? 3011
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      throw new WERR_INVALID_PARAMETER('port', 'an integer from 0 through 65535')
    }
    if (this.server != null) {
      throw new WERR_INVALID_PARAMETER('server', 'stopped before it is started again')
    }
    this.port = port
    await this.chaintracks.makeAvailable()

    const app = express()
    app.disable('x-powered-by')
    if (this.options.trustProxy !== undefined) app.set('trust proxy', this.options.trustProxy)
    app.use(securityHeaders({ environmentPrefix: 'CHAINTRACKS' }))
    app.use(
      corsPolicy({
        environmentPrefix: 'CHAINTRACKS',
        allowedOrigins: this.options.allowedOrigins,
        methods: ['GET', 'POST', 'OPTIONS']
      })
    )
    app.use(fixedWindowRateLimit(this.maxRequestsPerMinute, 'ERR_RATE_LIMIT'))
    app.use(concurrencyLimit('CHAINTRACKS', this.options.maxConcurrentRequests ?? 200))
    app.use(
      bodyParser.json({
        limit: readBodyLimitBytes('CHAINTRACKS', 256 * 1024)
      })
    )
    app.use(bodyParserErrorHandler)

    app.get('/robots.txt', (req: Request, res: Response) => {
      res.type('text/plain')
      res.send('User-agent: *\nDisallow: /')
    })

    app.get('/', (req: Request, res: Response) => {
      res.type('text/plain')
      res.send(`Chaintracks ${this.chain}Net Block Header Service`)
    })

    const handleErr = (err: unknown, res: Response) => {
      const code = (err as { code?: unknown })?.code
      const badRequest =
        code === 'WERR_INVALID_PARAMETER' ||
        code === 'WERR_BAD_REQUEST' ||
        code === 'ERR_INVALID_PARAMETER' ||
        code === 'ERR_BAD_REQUEST'
      if (this.options.logRequests === true) {
        console.error(`Chaintracks request failed (${badRequest ? 'invalid request' : 'internal error'})`)
      }
      res
        .status(badRequest ? 400 : 500)
        .json(
          badRequest
            ? { status: 'error', code: 'ERR_INVALID_PARAMETER', description: 'The request parameters are invalid.' }
            : { status: 'error', code: 'ERR_INTERNAL', description: 'An internal error has occurred.' }
        )
    }

    const appGet = <T>(path: string, action: (q: any) => Promise<T>, noCache = false) => {
      app.get(this.options.routingPrefix + path, async (req, res) => {
        if (noCache) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
          res.setHeader('Pragma', 'no-cache')
          res.setHeader('Expires', '0')
        }
        try {
          const r = await action(req.query)
          if (this.options.logRequests === true) console.log('Chaintracks request', path)
          res.status(200).json({ status: 'success', value: r })
        } catch (err) {
          if (this.options.logRequests === true) console.log(`Chaintracks request ${path} failed`)
          handleErr(err, res)
        }
      })
    }

    const appPostVoid = <T>(path: string, middleware: RequestHandler, action: (p: T) => Promise<void>) => {
      app.post(this.options.routingPrefix + path, middleware, async (req, res) => {
        try {
          if (this.options.logRequests === true) console.log('Chaintracks request', path)
          await action(req.body as T)
          res.status(200).json({ status: 'success' })
        } catch (err) {
          handleErr(err, res)
        }
      })
    }

    appGet<Chain>('/getChain', async () => await this.chaintracks.getChain())
    appGet<ChaintracksInfoApi>(
      '/getInfo',
      async q => {
        const waitMsecs = q.wait == null ? undefined : parseUnsignedQuery(q.wait, 'wait', this.maxWaitMsecs)
        if (waitMsecs != null) await wait(waitMsecs)
        const r = await this.chaintracks.getInfo()
        if (waitMsecs != null) (r as ChaintracksInfoApi & { wait?: string }).wait = String(waitMsecs)
        return r
      },
      true
    )

    appGet<FiatExchangeRates>(
      '/getFiatExchangeRates',
      async () => {
        // update if needed
        await this.services.getFiatExchangeRate('GBP')
        // return current values
        return this.services.options.fiatExchangeRates
      },
      true
    )

    appPostVoid(
      '/addHeaderHex',
      fixedWindowRateLimit(this.maxHeaderSubmissionsPerMinute, 'ERR_HEADER_SUBMISSION_RATE_LIMIT'),
      async (header: BaseBlockHeader) => {
        try {
          validateBaseBlockHeaderFormat(header)
        } catch {
          throw new WERR_INVALID_PARAMETER('header', 'a canonical 80-byte block-header data object')
        }
        await this.chaintracks.addHeader(header)
      }
    )

    appGet<number>('/getPresentHeight', async () => await this.chaintracks.getPresentHeight(), true)
    appGet<string>('/findChainTipHashHex', async () => (await this.chaintracks.findChainTipHash()) || '', true)
    appGet<BlockHeader>('/findChainTipHeaderHex', async () => await this.chaintracks.findChainTipHeader(), true)

    appGet<BlockHeader | undefined>('/findHeaderHexForHeight', async q => {
      return await this.chaintracks.findHeaderForHeight(parseUnsignedQuery(q.height, 'height', 0x7fffffff))
    })
    appGet<BlockHeader | undefined>('/findHeaderHexForBlockHash', async q => {
      return await this.chaintracks.findLiveHeaderForBlockHash(parseHashQuery(q.hash))
    })

    appGet<string>('/getHeaders', async q => {
      const height = parseUnsignedQuery(q.height, 'height', 0x7fffffff)
      const count = parseUnsignedQuery(q.count, 'count', this.maxHeadersPerRequest, 1)
      if (height + count - 1 > 0x7fffffff) {
        throw new WERR_INVALID_PARAMETER('count', 'a range within the supported block heights')
      }
      return await this.chaintracks.getHeaders(height, count)
    })

    const server = app.listen(this.port)
    this.server = server
    configureHttpServer(server, 'CHAINTRACKS', {
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 30_000,
      maxRequestsPerSocket: 1_000,
      ...this.options.http
    })
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        this.server = undefined
        reject(error)
      }
      server.once('listening', onListening)
      server.once('error', onError)
    })
    const address = server.address()
    if (typeof address === 'object' && address != null) this.port = address.port
    if (this.options.logRequests === true) console.log(`ChaintracksService listening on port ${this.port}`)
  }
}
