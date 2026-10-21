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
  proposalHTTPCORS,
  proposalHTTPOrigins,
  proposalHTTPControlHeaders,
  proposalHTTPError,
  sendProposalHTTPError
} from './ProposalHTTPPolicy.js'
import { guardProposalResponse } from './ProposalResponseGuard.js'
import type {
  ProposalHTTPCaller,
  ProposalHTTPOperation,
  ProposalRouteOptions
} from './ProposalHTTPPorts.js'
export type * from './ProposalHTTPPorts.js'

type Route = ProposalHTTPOperation | 'handshake' | 'unknown'
function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError('Invalid proposal HTTP capacity')
  return value
}
function headers(req: Request): void {
  let bytes = 0
  const names = new Set<string>()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase()
    bytes += Buffer.byteLength(name) + Buffer.byteLength(req.rawHeaders[i + 1])
    if (bytes > 16384) throw new OutputProtocolError('limited', 'Proposal HTTP header bound')
    if (names.has(name)) throw new OutputProtocolError('invalid', 'Duplicate proposal HTTP header')
    names.add(name)
  }
  if (
    req.headers['content-encoding'] !== undefined &&
    req.headers['content-encoding'] !== 'identity'
  )
    throw new OutputProtocolError('unsupported', 'Proposal requests require identity encoding')
}

class ProposalHTTPHandler<Entry> {
  private readonly options: ProposalRouteOptions<Entry>
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

  constructor(input: ProposalRouteOptions<Entry>) {
    this.options = { ...input }
    this.prefix =
      new URL(canonicalOutputBase(input.baseURL)).pathname.replace(/\/$/, '') +
      '/overlay/v1/proposals'
    this.origins = proposalHTTPOrigins(input.allowedOrigins)
    this.maximum = bounded(input.maximumRequests ?? 64, 4096)
    this.maximumWork = bounded(input.maximumWork ?? 64, 4096)
    this.perPrincipal = bounded(
      input.maximumWorkPerPrincipal ?? Math.min(4, this.maximumWork),
      this.maximumWork
    )
    this.timeoutMs = bounded(input.requestTimeoutMs ?? 30000, 30000)
    this.requestBytes = bounded(input.maximumRequestBytes ?? 1048576, 1048576)
    this.responseBytes = bounded(input.maximumResponseBytes ?? 4194304, 4194304)
    if (
      typeof input.authenticate !== 'function' ||
      typeof input.authorizeControl !== 'function' ||
      input.authorizeControl.constructor.name === 'AsyncFunction'
    )
      throw new TypeError(
        'Proposal routes require authentication and synchronous control authorization'
      )
    if (input.journal.responseEnqueue !== 'proposal-journal-send/1')
      throw new TypeError('Proposal routes require a durable native-enqueue journal')
    this.raw = express.raw({ type: () => true, limit: this.requestBytes, inflate: false })
  }

  private route(path: string): Route | undefined {
    for (const operation of ['put', 'get', 'finalize'] as const)
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
      if (!proposalHTTPCORS(req, res, this.origins)) return
      headers(req)
      if (route === 'unknown')
        throw new OutputProtocolError('not-found', 'Unknown proposal endpoint')
      if (req.method !== 'POST' || req.url.includes('?'))
        throw new OutputProtocolError('invalid', 'Invalid proposal method or query')
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
        throw new OutputProtocolError('invalid', 'Proposal requests require JSON')
      if (req.body !== undefined)
        throw new OutputProtocolError('unsupported', 'Proposal routes must precede body parsers')
      if (this.activeRequests >= this.maximum)
        throw new OutputProtocolError('limited', 'Proposal HTTP capacity is full', true)
      this.track(res)
      this.raw(req, res, error => this.parsed(req, res, route, error))
    } catch (error) {
      sendProposalHTTPError(res, error)
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
          'Invalid bounded proposal body'
        )
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new OutputProtocolError('invalid', 'Missing proposal body bytes')
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(req.body)
      } catch {
        throw new OutputProtocolError('invalid', 'Invalid proposal UTF-8')
      }
      if (route === 'handshake') req.body = parseOutputJSON(text, { bytes: this.requestBytes })
      this.options.authenticate(req, res, error => {
        if (res.destroyed || req.aborted || res.writableEnded) return
        if (error || route === 'handshake') {
          sendProposalHTTPError(
            res,
            error ?? new OutputProtocolError('unsupported', 'Handshake was not handled')
          )
          return
        }
        void this.execute(req, res, route, text).catch(error => sendProposalHTTPError(res, error))
      })
    } catch (error) {
      sendProposalHTTPError(res, error)
    }
  }

  private acquire(identity: string): () => void {
    const count = this.principals.get(identity) ?? 0
    if (this.activeWork >= this.maximumWork || count >= this.perPrincipal)
      throw new OutputProtocolError('limited', 'Proposal service work capacity is full', true)
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
    operation: ProposalHTTPOperation,
    text: string
  ): Promise<void> {
    const capabilityDigest = outputHex32(req.headers['x-bsv-overlay-capability'])
    if (req.headers['x-bsv-overlay-profile'] !== OUTPUT_PROFILES.proposal)
      throw new OutputProtocolError('unsupported', 'Proposal profile was not selected')
    if (req.headers['cache-control'] !== 'no-store')
      throw new OutputProtocolError('invalid', 'Proposal requests require no-store')
    const identity = (req as Request & { auth?: { identityKey?: string } }).auth?.identityKey
    if (identity === undefined || identity === 'unknown')
      throw new OutputProtocolError('unauthorized', 'Proposal requires authenticated identity')
    const caller: ProposalHTTPCaller = Object.freeze({
      caller: outputIdentity(identity),
      capabilityDigest
    })
    res.set({
      'x-bsv-overlay-capability': capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_PROFILES.proposal
    })
    let release: (() => void) | undefined
    let installed = false
    try {
      if (req.aborted || res.destroyed) return
      release = this.acquire(caller.caller)
      const value = await this.options.service[operation](text, caller)
      if (req.aborted || res.destroyed || res.writableEnded) return
      const binding = this.options.disclosure.bind(operation, text, value, caller)
      if (typeof binding.body !== 'string' || Buffer.byteLength(binding.body) > this.responseBytes)
        throw new OutputProtocolError('limited', 'Proposal response exceeds HTTP capacity')
      guardProposalResponse(res, {
        journal: this.options.journal,
        caller,
        initial: { binding },
        authorizeControl: this.options.authorizeControl,
        controlHeaders: proposalHTTPControlHeaders(res)
      })
      installed = true
      res.status(200).set('content-type', 'application/json').end(binding.body)
    } catch (error) {
      if (res.destroyed || res.writableEnded || req.aborted) return
      if (installed) {
        res.destroy()
        return
      }
      guardProposalResponse(res, {
        journal: this.options.journal,
        caller,
        initial: { error },
        authorizeControl: this.options.authorizeControl,
        controlHeaders: proposalHTTPControlHeaders(res)
      })
      const control = proposalHTTPError(error)
      res
        .status(control.statusCode)
        .set('content-type', 'application/json')
        .end(Buffer.from(control.body))
    } finally {
      // Disconnects/deadlines do not release capacity while service work still runs.
      // A committed operation is recovered by its original identity, never undone here.
      release?.()
    }
  }
}

/**
 * Optional BRC-194 endpoints; mount before parsers, compression, caches or body logs.
 * Hosts own TLS, pre-authentication rate limits, bounded authentication/signing,
 * capability publication and expiry workers. Recording never invokes a wallet.
 */
export function createProposalRouter<Entry>(options: ProposalRouteOptions<Entry>): Router {
  return express.Router().use(new ProposalHTTPHandler(options).handle)
}
