import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import {
  canonicalOutputBase,
  OUTPUT_PROFILES,
  outputHex32,
  outputIdentity,
  OutputProtocolError,
  parseOutputJSON
} from '@bsv/sdk'
import {
  guardRootAdvertisementResponse,
  type RootAdvertisementSendJournal
} from './RootEvictionResponseGuard.js'
import {
  rootHTTPCORS,
  rootHTTPControlHeaders,
  rootHTTPOrigins,
  sendRootHTTPError
} from './RootEvictionHTTPPolicy.js'

export interface RootEvictionHTTPAccess {
  operation: 'submit' | 'status'
  principal: string
  requester: string
  requestId: string
}
export interface RootEvictionHTTPResponse {
  body: string
  headers: Record<string, string>
  head: { revision: string }
  access: RootEvictionHTTPAccess
}
/** Structural port preserves this package's ESM and CommonJS support. */
export interface RootEvictionHTTPCompanion {
  submit(
    text: string,
    caller: { principal: string; capabilityDigest: string },
    manifest: unknown,
    signal?: AbortSignal
  ): Promise<RootEvictionHTTPResponse>
  status(
    text: string,
    caller: { principal: string; capabilityDigest: string },
    signal?: AbortSignal
  ): Promise<RootEvictionHTTPResponse>
}
export interface RootEvictionRouteOptions {
  /** Share one bounded service instance across requests. */
  companion: RootEvictionHTTPCompanion
  /** The same durable journal and gate used by the companion and all serving paths. */
  journal: RootAdvertisementSendJournal
  baseURL: string
  /** Must be the same BRC-103/104 middleware instance used for this origin's handshake. */
  authenticate: RequestHandler
  /** Defaults to true; mount the origin's handshake exactly once. */
  handleHandshake?: boolean
  /** Synchronous local snapshot only. Return undefined during discovery unavailability. */
  manifest(): unknown
  /**
   * Synchronous current authority at native enqueue, including current policy/context.
   * Undefined access requests permission for a sanitized control error only.
   * Coordinate authorization changes with the journal's decision/send gate.
   */
  authorize(identity: string, access: Readonly<RootEvictionHTTPAccess> | undefined): boolean
  /** Omit for public credential-free CORS. An explicit list opts into exact origins. */
  allowedOrigins?: readonly string[]
  maximumRequests?: number
  maximumRequestBytes?: number
  maximumResponseBytes?: number
}

type Operation = 'submit' | 'status'
type Route = Operation | 'handshake' | 'unknown'
function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError('Invalid root HTTP capacity')
  return value
}
function headers(req: Request): void {
  const names = new Set<string>()
  let bytes = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase()
    bytes += Buffer.byteLength(name) + Buffer.byteLength(req.rawHeaders[i + 1])
    if (bytes > 16384) throw new OutputProtocolError('limited', 'Root HTTP header bound')
    if (names.has(name)) throw new OutputProtocolError('invalid', 'Duplicate root HTTP header')
    names.add(name)
  }
  if (
    req.headers['content-encoding'] !== undefined &&
    req.headers['content-encoding'] !== 'identity'
  )
    throw new OutputProtocolError('unsupported', 'Root requests require identity encoding')
}

class RootHTTPHandler {
  private readonly options: RootEvictionRouteOptions
  private readonly prefix: string
  private readonly origins: ReadonlySet<string> | undefined
  private readonly maximum: number
  private readonly requestBytes: number
  private readonly responseBytes: number
  private readonly raw: RequestHandler
  private active = 0
  constructor(input: RootEvictionRouteOptions) {
    this.options = { ...input }
    this.prefix =
      new URL(canonicalOutputBase(input.baseURL)).pathname.replace(/\/$/, '') +
      '/overlay/v1/root-evictions'
    this.origins = rootHTTPOrigins(input.allowedOrigins)
    this.maximum = bounded(input.maximumRequests ?? 64, 4096)
    this.requestBytes = bounded(input.maximumRequestBytes ?? 1048576, 1048576)
    this.responseBytes = bounded(input.maximumResponseBytes ?? 1048576, 1048576)
    if (
      typeof input.authenticate !== 'function' ||
      typeof input.authorize !== 'function' ||
      input.authorize.constructor.name === 'AsyncFunction' ||
      typeof input.manifest !== 'function' ||
      input.manifest.constructor.name === 'AsyncFunction'
    )
      throw new TypeError(
        'Root routes require authentication and synchronous local policy/snapshot callbacks'
      )
    this.raw = express.raw({ type: () => true, limit: this.requestBytes, inflate: false })
  }
  private route(path: string): Route | undefined {
    if (path === this.prefix + '/request') return 'submit'
    if (path === this.prefix + '/status') return 'status'
    if (this.options.handleHandshake !== false && path === '/.well-known/auth') return 'handshake'
    if (path.toLowerCase().startsWith(this.prefix.toLowerCase())) return 'unknown'
    return undefined
  }
  readonly handle: RequestHandler = (req, res, next) => {
    const route = this.route(req.path)
    if (route === undefined) {
      next()
      return
    }
    try {
      if (!rootHTTPCORS(req, res, this.origins)) return
      headers(req)
      if (route === 'unknown') throw new OutputProtocolError('not-found', 'Unknown root endpoint')
      if (req.method !== 'POST' || req.url.includes('?'))
        throw new OutputProtocolError('invalid', 'Invalid root method or query')
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
        throw new OutputProtocolError('invalid', 'Root requests require JSON')
      if (req.body !== undefined)
        throw new OutputProtocolError('unsupported', 'Root routes must precede body parsers')
      if (this.active >= this.maximum)
        throw new OutputProtocolError('limited', 'Root HTTP capacity is full', true)
      this.track(res)
      this.raw(req, res, error => this.parsed(req, res, route, error))
    } catch (error) {
      sendRootHTTPError(res, error)
    }
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
  private parsed(
    req: Request,
    res: Response,
    route: Exclude<Route, 'unknown'>,
    error?: unknown
  ): void {
    try {
      if (error) {
        const large =
          error instanceof Error &&
          Object.getOwnPropertyDescriptor(error, 'type')?.value === 'entity.too.large'
        throw new OutputProtocolError(large ? 'limited' : 'invalid', 'Invalid bounded root body')
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new OutputProtocolError('invalid', 'Missing root body bytes')
      // Fatal decoding and byte preservation prevent replacement characters, BOM
      // removal or parsed/reserialized bodies from evading the selected byte limit.
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(req.body)
      } catch {
        throw new OutputProtocolError('invalid', 'Invalid root UTF-8')
      }
      if (route === 'handshake') req.body = parseOutputJSON(text, { bytes: this.requestBytes })
      this.options.authenticate(req, res, error => {
        if (error || route === 'handshake') {
          sendRootHTTPError(
            res,
            error ?? new OutputProtocolError('unsupported', 'Handshake was not handled')
          )
          return
        }
        void this.execute(req, res, route, text).catch(error => sendRootHTTPError(res, error))
      })
    } catch (error) {
      sendRootHTTPError(res, error)
    }
  }

  private async execute(
    req: Request,
    res: Response,
    operation: Operation,
    text: string
  ): Promise<void> {
    const capabilityDigest = outputHex32(req.headers['x-bsv-overlay-capability'])
    if (req.headers['x-bsv-overlay-profile'] !== OUTPUT_PROFILES.eviction)
      throw new OutputProtocolError('unsupported', 'Root profile was not selected')
    if (req.headers['cache-control'] !== 'no-store')
      throw new OutputProtocolError('invalid', 'Root requests require no-store')
    const auth = (req as Request & { auth?: { identityKey?: string } }).auth
    if (auth?.identityKey === undefined || auth.identityKey === 'unknown')
      throw new OutputProtocolError('unauthorized', 'Root requires authenticated identity')
    const principal = outputIdentity(auth.identityKey)
    res.set({
      'x-bsv-overlay-capability': capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_PROFILES.eviction
    })
    const controller = new AbortController(),
      cancel = () => controller.abort()
    req.once('aborted', cancel)
    res.once('close', cancel)
    try {
      if (req.aborted || res.destroyed) controller.abort()
      const who = { principal, capabilityDigest }
      const response =
        operation === 'submit'
          ? await this.options.companion.submit(
              text,
              who,
              this.options.manifest(),
              controller.signal
            )
          : await this.options.companion.status(text, who, controller.signal)
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return
      if (
        typeof response.body !== 'string' ||
        Buffer.byteLength(response.body) > this.responseBytes ||
        response.headers['x-bsv-overlay-capability'] !== capabilityDigest ||
        response.headers['x-bsv-overlay-profile'] !== OUTPUT_PROFILES.eviction ||
        response.access.operation !== operation ||
        response.access.principal !== principal
      )
        throw new OutputProtocolError('unavailable', 'Root companion violated response contract')
      const access = Object.freeze({ ...response.access })
      guardRootAdvertisementResponse(res, {
        journal: this.options.journal,
        revision: response.head.revision,
        // Coordination results report decisions; they do not serve advertisements.
        targets: [],
        authorize: (identity, kind) =>
          identity === principal &&
          this.options.authorize(identity, kind === 'data' ? access : undefined) === true,
        controlHeaders: rootHTTPControlHeaders(res)
      })
      res.status(200).set('content-type', 'application/json').end(response.body)
    } finally {
      req.removeListener('aborted', cancel)
      res.removeListener('close', cancel)
    }
  }
}

/**
 * Mount at the app root before body parsers, compression, caches and payload logs.
 * Provides exact request/status paths and optionally the shared handshake only.
 * Capability publication, TLS, pre-auth rate limits and server deadlines belong
 * to the host. Installing these routes alone does not enable the complete profile.
 */
export function createRootEvictionRouter(options: RootEvictionRouteOptions): Router {
  return express
    .Router({ caseSensitive: true, strict: true })
    .use(new RootHTTPHandler(options).handle)
}
