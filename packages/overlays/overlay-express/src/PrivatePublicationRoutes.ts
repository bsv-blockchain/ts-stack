import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import {
  canonicalOutputBase,
  OUTPUT_PROFILES,
  outputHex32,
  outputIdentity,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputPrivatePublicationResult
} from '@bsv/sdk'
import {
  privatePublicationHTTPCORS,
  privatePublicationHTTPOrigins,
  privatePublicationHTTPControlHeaders,
  privatePublicationHTTPError,
  sendPrivatePublicationHTTPError
} from './PrivatePublicationHTTPPolicy.js'
import { guardPrivatePublicationResponse } from './PrivatePublicationResponseGuard.js'
import type {
  PrivatePublicationHTTPCaller,
  PrivatePublicationHTTPOperation,
  PrivatePublicationRouteOptions
} from './PrivatePublicationHTTPPorts.js'
export type * from './PrivatePublicationHTTPPorts.js'

type Route = PrivatePublicationHTTPOperation | 'handshake' | 'unknown'
function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError('Invalid private publication HTTP capacity')
  return value
}
function headers(req: Request): void {
  let bytes = 0
  const names = new Set<string>()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase()
    bytes += Buffer.byteLength(name) + Buffer.byteLength(req.rawHeaders[i + 1])
    if (bytes > 16384)
      throw new OutputProtocolError('limited', 'Private publication HTTP header bound')
    if (names.has(name))
      throw new OutputProtocolError('invalid', 'Duplicate private publication HTTP header')
    names.add(name)
  }
  if (
    req.headers['content-encoding'] !== undefined &&
    req.headers['content-encoding'] !== 'identity'
  )
    throw new OutputProtocolError(
      'unsupported',
      'Private publication requests require identity encoding'
    )
}

class PrivatePublicationHTTPHandler {
  private readonly options: PrivatePublicationRouteOptions
  private readonly prefix: string
  private readonly origins: ReadonlySet<string> | undefined
  private readonly raw: RequestHandler
  private readonly maximum: number
  private readonly maximumWork: number
  private readonly perPrincipal: number
  private readonly timeoutMs: number
  private readonly requestBytes: number
  private readonly responseBytes: number
  private activeRequests = 0
  private activeWork = 0
  private readonly principals = new Map<string, number>()

  constructor(input: PrivatePublicationRouteOptions) {
    this.options = { ...input }
    this.prefix =
      new URL(canonicalOutputBase(input.baseURL)).pathname.replace(/\/$/, '') +
      '/overlay/v1/private'
    this.origins = privatePublicationHTTPOrigins(input.allowedOrigins)
    this.maximum = bounded(input.maximumRequests ?? 64, 4096)
    this.maximumWork = bounded(input.maximumWork ?? 64, 4096)
    this.perPrincipal = bounded(
      input.maximumWorkPerPrincipal ?? Math.min(4, this.maximumWork),
      this.maximumWork
    )
    this.timeoutMs = bounded(input.requestTimeoutMs ?? 30000, 30000)
    this.requestBytes = bounded(input.maximumRequestBytes ?? 4194304, 4194304)
    this.responseBytes = bounded(input.maximumResponseBytes ?? 4194304, 4194304)
    if (
      typeof input.authenticate !== 'function' ||
      typeof input.disclosure.prepare !== 'function' ||
      typeof input.disclosure.enqueueControl !== 'function'
    )
      throw new TypeError(
        'Private publication routes require authentication and a native disclosure owner'
      )
    this.raw = express.raw({ type: () => true, limit: this.requestBytes, inflate: false })
  }

  private route(path: string): Route | undefined {
    for (const operation of ['publish', 'status'] as const)
      if (path === this.prefix + '/' + operation) return operation
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
      if (!privatePublicationHTTPCORS(req, res, this.origins)) return
      headers(req)
      if (route === 'unknown')
        throw new OutputProtocolError('not-found', 'Unknown private publication endpoint')
      if (req.method !== 'POST' || req.url.includes('?'))
        throw new OutputProtocolError('invalid', 'Invalid private publication method or query')
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
        throw new OutputProtocolError('invalid', 'Private publication requests require JSON')
      if (req.body !== undefined)
        throw new OutputProtocolError(
          'unsupported',
          'Private publication routes must precede body parsers'
        )
      if (this.activeRequests >= this.maximum)
        throw new OutputProtocolError('limited', 'Private publication HTTP capacity is full', true)
      this.track(res)
      this.raw(req, res, error => this.parsed(req, res, route, error))
    } catch (error) {
      sendPrivatePublicationHTTPError(res, error)
    }
  }

  private track(res: Response): void {
    this.activeRequests++
    let released = false
    const timer = setTimeout(() => res.destroy(), this.timeoutMs)
    timer.unref?.()
    const release = () => {
      if (released) return
      released = true
      clearTimeout(timer)
      this.activeRequests--
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
      if (res.destroyed || req.aborted) return
      if (error) {
        const large =
          error instanceof Error &&
          Object.getOwnPropertyDescriptor(error, 'type')?.value === 'entity.too.large'
        throw new OutputProtocolError(
          large ? 'limited' : 'invalid',
          'Invalid bounded private publication body'
        )
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new OutputProtocolError('invalid', 'Missing private publication body bytes')
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(req.body)
      } catch {
        throw new OutputProtocolError('invalid', 'Invalid private publication UTF-8')
      }
      if (route === 'handshake') req.body = parseOutputJSON(text, { bytes: this.requestBytes })
      this.options.authenticate(req, res, error => {
        if (res.destroyed || req.aborted || res.writableEnded) return
        if (error || route === 'handshake') {
          sendPrivatePublicationHTTPError(
            res,
            error ?? new OutputProtocolError('unsupported', 'Handshake was not handled')
          )
          return
        }
        void this.execute(req, res, route, text).catch(error =>
          sendPrivatePublicationHTTPError(res, error)
        )
      })
    } catch (error) {
      sendPrivatePublicationHTTPError(res, error)
    }
  }

  private acquire(identity: string): () => void {
    const count = this.principals.get(identity) ?? 0
    if (this.activeWork >= this.maximumWork || count >= this.perPrincipal)
      throw new OutputProtocolError(
        'limited',
        'Private publication service work capacity is full',
        true
      )
    this.activeWork++
    this.principals.set(identity, count + 1)
    return () => {
      this.activeWork--
      const remaining = this.principals.get(identity)! - 1
      if (remaining === 0) this.principals.delete(identity)
      else this.principals.set(identity, remaining)
    }
  }

  private async execute(
    req: Request,
    res: Response,
    operation: PrivatePublicationHTTPOperation,
    text: string
  ): Promise<void> {
    const capabilityDigest = outputHex32(req.headers['x-bsv-overlay-capability'])
    if (req.headers['x-bsv-overlay-profile'] !== OUTPUT_PROFILES.publication)
      throw new OutputProtocolError('unsupported', 'Private publication profile was not selected')
    if (req.headers['cache-control'] !== 'no-store')
      throw new OutputProtocolError('invalid', 'Private publication requests require no-store')
    const identity = (req as Request & { auth?: { identityKey?: string } }).auth?.identityKey
    if (identity === undefined || identity === 'unknown')
      throw new OutputProtocolError(
        'unauthorized',
        'Private publication requires authenticated identity'
      )
    const authenticated = (req as Request & { auth?: { identityKey?: string } }).auth
    const controller = new AbortController()
    const cancel = () => controller.abort()
    res.once('close', cancel)
    req.once('aborted', cancel)
    const caller: PrivatePublicationHTTPCaller = Object.freeze({
      publisher: outputIdentity(identity),
      capability: capabilityDigest,
      profile: OUTPUT_PROFILES.publication,
      signal: controller.signal,
      current: () =>
        !req.aborted &&
        !res.destroyed &&
        !controller.signal.aborted &&
        (req as Request & { auth?: { identityKey?: string } }).auth === authenticated &&
        authenticated?.identityKey === identity
    })
    res.set({
      'x-bsv-overlay-capability': capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_PROFILES.publication
    })
    let release: (() => void) | undefined
    let installed = false
    try {
      if (req.aborted || res.destroyed) return
      release = this.acquire(caller.publisher)
      const value = await this.options.service[operation](
        parseOutputJSON(text, { bytes: this.requestBytes }),
        caller
      )
      if (req.aborted || res.destroyed || res.writableEnded) return
      const result = parseOutputPrivatePublicationResult(value)
      const prepared = this.options.disclosure.prepare(
        { version: 1, publicationId: result.publicationId },
        caller
      )
      if (
        typeof prepared.body !== 'string' ||
        Buffer.byteLength(prepared.body) > this.responseBytes
      )
        throw new OutputProtocolError(
          'limited',
          'Private publication response exceeds HTTP capacity'
        )
      guardPrivatePublicationResponse(res, {
        disclosure: this.options.disclosure,
        caller,
        initial: { prepared },
        controlHeaders: privatePublicationHTTPControlHeaders(res)
      })
      installed = true
      res.status(200).set('content-type', 'application/json').end(prepared.body)
    } catch (error) {
      if (res.destroyed || res.writableEnded || req.aborted) return
      if (installed) {
        res.destroy()
        return
      }
      guardPrivatePublicationResponse(res, {
        disclosure: this.options.disclosure,
        caller,
        initial: { error },
        controlHeaders: privatePublicationHTTPControlHeaders(res)
      })
      const control = privatePublicationHTTPError(error)
      res
        .status(control.statusCode)
        .set('content-type', 'application/json')
        .end(Buffer.from(control.body))
    } finally {
      // Disconnects/deadlines do not release capacity while service work still runs.
      // A committed operation is recovered by its original identity, never undone here.
      release?.()
      res.removeListener('close', cancel)
      req.removeListener('aborted', cancel)
    }
  }
}

/** Opt-in authenticated BRC-195 publication/status routes. Mount before body parsers. */
export function createPrivatePublicationRouter(options: PrivatePublicationRouteOptions): Router {
  const router = express.Router(),
    handler = new PrivatePublicationHTTPHandler(options)
  router.use(handler.handle)
  return router
}
