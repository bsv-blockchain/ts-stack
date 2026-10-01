import {
  guardOutputLookupResponse,
  lookupResponseControl,
  lookupResponseControlHeaders,
  type OutputLookupDisclosure
} from './OutputLookupResponseGuard.js'
import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import {
  canonicalOutputBase,
  canonicalOutputJSON,
  OUTPUT_LOOKUP_PROFILE,
  outputHex32,
  outputIdentity,
  outputU64,
  OutputProtocolError,
  parseOutputCapabilities,
  parseOutputJSON,
  verifyOutputPacket
} from '@bsv/sdk'
import {
  lookupCORS,
  lookupOrigins,
  lookupPrivateHeaders,
  sendLookupHTTPError
} from './OutputLookupHTTPPolicy.js'

/** Structural companion port: no ESM-only runtime dependency in this dual-format package. */
export interface OutputLookupCompanion {
  open(
    input: unknown,
    caller: OutputLookupCaller,
    signal?: AbortSignal
  ): Promise<OutputLookupHTTPResponse>
  read(
    input: unknown,
    caller: OutputLookupCaller,
    signal?: AbortSignal
  ): Promise<OutputLookupHTTPResponse>
  close(
    input: unknown,
    caller: OutputLookupCaller,
    signal?: AbortSignal
  ): Promise<OutputLookupHTTPResponse>
}
export interface OutputLookupCaller {
  principal: string | null
  capabilityDigest: string
}
export interface OutputLookupHTTPResponse {
  body: string
  headers: { 'x-bsv-overlay-capability': string; 'x-bsv-overlay-profile': string }
}
export interface OutputLookupRouteOptions {
  companion: OutputLookupCompanion
  /** Optional post-signing native session/access gate. Requires BRC-103 authentication. */
  disclosure?: OutputLookupDisclosure
  /** One service binding per concrete base path. Separate paths may host other companions. */
  service: string
  baseURL: string
  identity: string
  chain: { network: string; genesisHash: string }
  authentication: 'none' | 'brc103'
  /** The same middleware instance must handle the root handshake and these signed requests. */
  authenticate?: RequestHandler
  /** Include the root handshake route only once per HTTP origin. Defaults to true. */
  handleHandshake?: boolean
  manifest(): unknown
  now(): string
  allowedOrigins: readonly string[]
  allowLocalHTTP?: boolean
  maximumRequests?: number
  maximumRequestBytes?: number
  maximumResponseBytes?: number
}

function checkHeaders(req: Request): void {
  let bytes = 0
  const names = new Set<string>()
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase(),
      value = req.rawHeaders[index + 1]
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (bytes > 16384) throw new OutputProtocolError('limited', 'Lookup HTTP header bound')
    if (names.has(name)) throw new OutputProtocolError('invalid', 'Duplicate lookup HTTP header')
    names.add(name)
  }
  const encoding = req.headers['content-encoding']
  if (encoding !== undefined && encoding !== 'identity')
    throw new OutputProtocolError('unsupported', 'Lookup requires identity encoding')
}

function selection(req: Request): OutputLookupCaller {
  const capabilityDigest = outputHex32(req.headers['x-bsv-overlay-capability'])
  if (req.headers['x-bsv-overlay-profile'] !== OUTPUT_LOOKUP_PROFILE)
    throw new OutputProtocolError('unsupported', 'Required lookup profile was not selected')
  if (req.headers['cache-control'] !== 'no-store')
    throw new OutputProtocolError('invalid', 'Lookup requires no-store requests')
  return { principal: null, capabilityDigest }
}

type LookupOperation = 'open' | 'read' | 'close'
type LookupRoute = LookupOperation | 'capabilities' | 'handshake' | 'unknown'

class LookupHTTPHandler {
  private readonly options: OutputLookupRouteOptions
  private readonly baseURL: string
  private readonly identity: string
  private readonly origins: ReadonlySet<string>
  private readonly maximum: number
  private readonly requestBytes: number
  private readonly responseBytes: number
  private readonly prefix: string
  private readonly paths: ReadonlyMap<string, LookupRoute>
  private readonly raw: RequestHandler
  private active = 0

  constructor(input: OutputLookupRouteOptions) {
    if (input.disclosure !== undefined && input.authentication !== 'brc103')
      throw new TypeError('Lookup native disclosure requires authenticated transport')
    this.options = { ...input, chain: { ...input.chain } }
    this.baseURL = canonicalOutputBase(input.baseURL, input.allowLocalHTTP)
    this.identity = outputIdentity(input.identity)
    this.origins = lookupOrigins(input.allowedOrigins)
    this.maximum = input.maximumRequests ?? 64
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 4096)
      throw new TypeError('Invalid lookup HTTP request capacity')
    this.requestBytes = input.maximumRequestBytes ?? 1048576
    this.responseBytes = input.maximumResponseBytes ?? 4194304
    for (const [value, minimum, maximum] of [
      [this.requestBytes, 1, 1048576],
      [this.responseBytes, 65536, 4194304]
    ])
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new TypeError('Invalid lookup HTTP byte capacity')
    this.raw = express.raw({ type: () => true, limit: this.requestBytes, inflate: false })
    if (
      !['none', 'brc103'].includes(input.authentication) ||
      (input.authentication === 'brc103' && !input.authenticate)
    )
      throw new TypeError('Authenticated lookup requires its actual authentication middleware')
    this.prefix = new URL(this.baseURL).pathname.replace(/\/$/, '') + '/overlay/v1'
    const paths = new Map<string, LookupRoute>([
      [this.prefix + '/capabilities', 'capabilities'],
      [this.prefix + '/lookup/open', 'open'],
      [this.prefix + '/lookup/read', 'read'],
      [this.prefix + '/lookup/close', 'close']
    ])
    if (input.authentication === 'brc103' && input.handleHandshake !== false)
      paths.set('/.well-known/auth', 'handshake')
    this.paths = paths
  }

  private route(path: string): LookupRoute | undefined {
    const exact = this.paths.get(path)
    if (exact) return exact
    const lower = path.toLowerCase()
    if (
      lower.startsWith((this.prefix + '/lookup').toLowerCase()) ||
      lower === (this.prefix + '/capabilities').toLowerCase()
    )
      return 'unknown'
    return undefined
  }

  readonly handle: RequestHandler = (req, res, next) => {
    const route = this.route(req.path)
    if (!route) {
      next()
      return
    }
    lookupPrivateHeaders(res)
    try {
      if (!this.admit(req, res, route)) return
      this.track(res)
      if (route === 'capabilities') {
        res.status(200).set('content-type', 'application/json').end(this.capabilities())
        return
      }
      this.raw(req, res, error => this.parsed(req, res, route, error))
    } catch (error) {
      sendLookupHTTPError(res, error)
    }
  }

  private admit(
    req: Request,
    res: Response,
    route: LookupRoute
  ): route is Exclude<LookupRoute, 'unknown'> {
    checkHeaders(req)
    if (!lookupCORS(req, res, this.origins)) return false
    if (route === 'unknown')
      throw new OutputProtocolError('not-found', 'Unknown lookup protocol endpoint')
    if (this.active >= this.maximum)
      throw new OutputProtocolError('limited', 'Lookup HTTP capacity is full', true)
    if (req.method !== (route === 'capabilities' ? 'GET' : 'POST'))
      throw new OutputProtocolError('invalid', 'Invalid lookup HTTP method')
    if (
      route !== 'capabilities' &&
      req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
    )
      throw new OutputProtocolError('invalid', 'Lookup requires a JSON request')
    if (req.body !== undefined)
      throw new OutputProtocolError(
        'unsupported',
        'Lookup routes must precede generic body parsers'
      )
    return true
  }

  private track(res: Response): void {
    this.active++
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.active--
      res.removeListener('finish', release)
      res.removeListener('close', release)
    }
    res.once('finish', release)
    res.once('close', release)
  }

  private capabilities(): string {
    const manifest = parseOutputCapabilities(this.options.manifest(), this.options.allowLocalHTTP)
    if (
      manifest.body.identity !== this.identity ||
      manifest.body.baseURL !== this.baseURL ||
      canonicalOutputJSON(manifest.body.chain) !== canonicalOutputJSON(this.options.chain) ||
      !verifyOutputPacket('capabilities', manifest, this.identity)
    )
      throw new OutputProtocolError(
        'unauthorized',
        'Lookup manifest differs from configured provider'
      )
    if (outputU64(this.options.now()) >= outputU64(manifest.body.expiresAt))
      throw new OutputProtocolError('expired', 'Lookup capability expired')
    const services = manifest.body.services
    if (
      services.length !== 1 ||
      services[0].name !== this.options.service ||
      services[0].profiles.length !== 1 ||
      services[0].profiles[0].id !== OUTPUT_LOOKUP_PROFILE ||
      services[0].profiles[0].authentication !== this.options.authentication
    )
      throw new OutputProtocolError('unsupported', 'Manifest advertises unbound lookup services')
    if (
      services[0].profiles[0].maxRequestBytes > this.requestBytes ||
      Math.min(4194304, services[0].profiles[0].maxResponseBytes) > this.responseBytes
    )
      throw new OutputProtocolError('unsupported', 'Manifest exceeds lookup HTTP byte capacity')
    return canonicalOutputJSON(manifest, { bytes: 262144 })
  }

  private parsed(
    req: Request,
    res: Response,
    route: LookupOperation | 'handshake',
    error?: unknown
  ): void {
    try {
      if (error) {
        const tooLarge =
          error instanceof Error &&
          Object.getOwnPropertyDescriptor(error, 'type')?.value === 'entity.too.large'
        throw new OutputProtocolError(
          tooLarge ? 'limited' : 'invalid',
          'Invalid bounded lookup body'
        )
      }
      if (route === 'handshake') {
        req.body = parseOutputJSON(req.body, { bytes: this.requestBytes })
        this.options.authenticate!(req, res, error =>
          sendLookupHTTPError(
            res,
            error ?? new OutputProtocolError('unsupported', 'Handshake was not handled')
          )
        )
      } else {
        this.authenticated(req, res, route)
      }
    } catch (error) {
      sendLookupHTTPError(res, error)
    }
  }

  private authenticated(req: Request, res: Response, operation: LookupOperation): void {
    const execute = () => {
      void this.execute(req, res, operation).catch(error => sendLookupHTTPError(res, error))
    }
    if (this.options.authentication === 'brc103')
      this.options.authenticate!(req, res, error => {
        if (error) sendLookupHTTPError(res, error)
        else execute()
      })
    else execute()
  }

  private async execute(req: Request, res: Response, operation: LookupOperation): Promise<void> {
    const who = selection(req)
    res.set({
      'x-bsv-overlay-capability': who.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
    })
    if (this.options.authentication === 'brc103') {
      const auth = (req as Request & { auth?: { identityKey?: string } }).auth
      if (auth?.identityKey === undefined || auth.identityKey === 'unknown')
        throw new OutputProtocolError('unauthorized', 'Lookup requires an authenticated principal')
      who.principal = outputIdentity(auth?.identityKey)
    }
    const controller = new AbortController(),
      cancel = () => controller.abort()
    req.once('aborted', cancel)
    res.once('close', cancel)
    let guarded = false
    try {
      if (req.aborted || res.destroyed) controller.abort()
      const input = parseOutputJSON(req.body, { bytes: this.requestBytes })
      const response = await this.options.companion[operation](input, who, controller.signal)
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return
      if (
        typeof response.body !== 'string' ||
        Buffer.byteLength(response.body) > this.responseBytes ||
        response.headers['x-bsv-overlay-capability'] !== who.capabilityDigest ||
        response.headers['x-bsv-overlay-profile'] !== OUTPUT_LOOKUP_PROFILE
      )
        throw new OutputProtocolError(
          'unavailable',
          'Lookup companion violated its response contract'
        )
      if (this.options.disclosure) {
        guardOutputLookupResponse(res, {
          disclosure: this.options.disclosure,
          caller: who,
          initial: { operation, body: response.body },
          controlHeaders: lookupResponseControlHeaders(res)
        })
        guarded = true
      }
      res.status(200).set('content-type', 'application/json').end(response.body)
    } catch (error) {
      if (!this.options.disclosure) throw error
      if (res.destroyed || res.writableEnded || req.aborted) return
      if (guarded) {
        res.destroy()
        return
      }
      try {
        guardOutputLookupResponse(res, {
          disclosure: this.options.disclosure,
          caller: who,
          initial: { error },
          controlHeaders: lookupResponseControlHeaders(res)
        })
      } catch {
        res.destroy()
        return
      }
      const control = lookupResponseControl(error)
      res
        .status(control.statusCode)
        .set('content-type', 'application/json')
        .end(Buffer.from(control.body))
    } finally {
      req.removeListener('aborted', cancel)
      res.removeListener('close', cancel)
    }
  }
}

/**
 * Mount at the application root BEFORE generic parsers, compression, caches and
 * payload logging. The exact configured paths and malformed lookup paths are
 * handled here. TLS termination, Node header/body deadlines and authentication
 * middleware capacity remain host responsibilities. No payment middleware runs.
 */
export function createOutputLookupRouter(options: OutputLookupRouteOptions): Router {
  const handler = new LookupHTTPHandler(options)
  return express.Router({ caseSensitive: true, strict: true }).use(handler.handle)
}

export type {
  OutputLookupDisclosure,
  OutputLookupResponseBinding
} from './OutputLookupResponseGuard.js'
