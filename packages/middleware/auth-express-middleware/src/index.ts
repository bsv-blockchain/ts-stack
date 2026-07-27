import fs from 'node:fs'
import mime from 'mime-types'
import {
  Utils,
  Peer,
  SessionManager,
  PublicKey,
  type AsyncSessionManager,
  type AuthMessage,
  type PubKeyHex,
  type RequestedCertificateSet,
  type Transport,
  type VerifiableCertificate,
  type WalletInterface
} from '@bsv/sdk'
import type { NextFunction, Request, Response } from 'express'
import {
  LogLevel,
  isLogLevelEnabled,
  getLogMethod,
  writeUrlToWriter,
  writeRequestHeadersToWriter,
  writeHeaderPair,
  writeBodyToWriter,
  convertValueToArray,
  makeDebugLogger
} from './authMiddlewareHelpers.js'

export type { LogLevel } from './authMiddlewareHelpers.js'
export { isLogLevelEnabled, getLogMethod } from './authMiddlewareHelpers.js'
export { writeBodyToWriter } from './authMiddlewareHelpers.js'

const WELL_KNOWN_AUTH_PATH = '/.well-known/auth'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_PENDING_REQUESTS = 1_000
const MAX_AUTH_HEADER_LENGTH = 4_096

interface PendingHandle {
  res: Response
  next: NextFunction
  timeout: ReturnType<typeof setTimeout>
}

interface ActiveGeneralRequest {
  listenerId: number
  timeout: ReturnType<typeof setTimeout>
}

interface ActiveCertificateRequest {
  listenerId: number
  timeout: ReturnType<typeof setTimeout>
}

export interface AuthTransportLimits {
  requestTimeoutMs: number
  maxPendingRequests: number
}

export interface AuthRequest extends Request {
  auth?: {
    identityKey: PubKeyHex
  }
}

// Developers may optionally provide a handler for incoming certificates.
export interface AuthMiddlewareOptions {
  wallet: WalletInterface
  // Optional session store. Default is in-process synchronous `SessionManager`.
  // Pass an `AsyncSessionManager` (Redis/SQL-backed, etc.) to share state
  // across load-balanced instances; Peer awaits internally so both work.
  sessionManager?: SessionManager | AsyncSessionManager
  allowUnauthenticated?: boolean
  certificatesToRequest?: RequestedCertificateSet
  onCertificatesReceived?: (
    senderPublicKey: string,
    certs: VerifiableCertificate[],
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => void | Promise<void>

  /**
   * Optional logger (e.g., console). If not provided, logging is disabled.
   */
  logger?: typeof console

  /**
   * Optional logging level. Defaults to no logging if not provided.
   * 'debug' | 'info' | 'warn' | 'error'
   *
   * - debug: Logs detailed lifecycle metadata without secret-bearing payloads.
   * - info: Logs general informational messages about normal operation.
   * - warn: Logs potential issues but not necessarily errors.
   * - error: Logs only critical issues and errors.
   */
  logLevel?: LogLevel

  /**
   * Bounds unauthenticated work and pending protocol state. Defaults to a
   * 30-second timeout and 1,000 concurrent request records per process.
   */
  transportLimits?: Partial<AuthTransportLimits>
}

class AuthProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthProtocolError'
  }
}

function singleHeader(req: Request, name: string, required = true): string | undefined {
  const value = req.headers[name]
  if (value === undefined && !required) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_AUTH_HEADER_LENGTH ||
    containsUnsafeHeaderCharacter(value)
  ) {
    throw new AuthProtocolError(`Invalid ${name} header.`)
  }
  return value
}

function containsUnsafeHeaderCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code === 0 || code === 10 || code === 13) return true
  }
  return false
}

function isCanonicalBase64(value: string, decodedLength?: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false
  }
  try {
    const decoded = Utils.toArray(value, 'base64')
    return (
      (decodedLength === undefined || decoded.length === decodedLength) &&
      Utils.toBase64(decoded) === value
    )
  } catch {
    return false
  }
}

function isCompressedPublicKey(value: string): value is PubKeyHex {
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(value)) return false
  try {
    return PublicKey.fromString(value).toString() === value.toLowerCase()
  } catch {
    return false
  }
}

function validateGeneralAuthRequest(req: Request): string {
  const requestId = singleHeader(req, 'x-bsv-auth-request-id')!
  const version = singleHeader(req, 'x-bsv-auth-version')!
  const identityKey = singleHeader(req, 'x-bsv-auth-identity-key')!
  const nonce = singleHeader(req, 'x-bsv-auth-nonce')!
  const yourNonce = singleHeader(req, 'x-bsv-auth-your-nonce')!
  const signature = singleHeader(req, 'x-bsv-auth-signature')!
  if (!isCanonicalBase64(requestId, 32)) {
    throw new AuthProtocolError('Invalid x-bsv-auth-request-id header.')
  }
  if (version.length > 32 || !isCompressedPublicKey(identityKey)) {
    throw new AuthProtocolError('Invalid authentication identity or version.')
  }
  if (
    !isCanonicalBase64(nonce) ||
    !isCanonicalBase64(yourNonce) ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(signature)
  ) {
    throw new AuthProtocolError('Invalid authentication nonce or signature.')
  }
  return requestId
}

function validateHandshakeMessage(req: Request): {
  message: AuthMessage
  requestId: string
} {
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new AuthProtocolError('The BRC-104 handshake body must be an object.')
  }
  const message = req.body as Partial<AuthMessage>
  if (
    typeof message.messageType !== 'string' ||
    message.messageType.length === 0 ||
    message.messageType.length > 64 ||
    typeof message.version !== 'string' ||
    message.version.length === 0 ||
    message.version.length > 32 ||
    typeof message.identityKey !== 'string' ||
    !isCompressedPublicKey(message.identityKey)
  ) {
    throw new AuthProtocolError('The BRC-104 handshake message is malformed.')
  }
  const requestIdHeader = singleHeader(req, 'x-bsv-auth-request-id', false)
  const requestId = requestIdHeader ?? message.initialNonce
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > MAX_AUTH_HEADER_LENGTH ||
    !isCanonicalBase64(requestId)
  ) {
    throw new AuthProtocolError('The BRC-104 handshake request identifier is invalid.')
  }
  return { message: message as AuthMessage, requestId }
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { errorName: error.name } : { errorType: typeof error }
}

/**
 * ResponseWriterWrapper buffers response data until signing is complete.
 * This pattern matches the Go implementation for cleaner response handling.
 */
class ResponseWriterWrapper {
  private statusCode: number = 200
  private headers: Record<string, string> = {}
  private body: number[] = []

  status(code: number): this {
    this.statusCode = code
    return this
  }

  set(key: string | Record<string, string>, value?: string): this {
    if (typeof key === 'object' && key !== null) {
      for (const [k, v] of Object.entries(key)) {
        this.headers[k.toLowerCase()] = String(v)
      }
    } else if (typeof key === 'string' && value !== undefined) {
      this.headers[key.toLowerCase()] = String(value)
    }
    return this
  }

  send(data: any): this {
    this.body = convertValueToArray(data, this.headers)
    return this
  }

  json(data: any): this {
    if (!this.headers['content-type']) {
      this.headers['content-type'] = 'application/json'
    }
    this.body = Utils.toArray(JSON.stringify(data), 'utf8')
    return this
  }

  text(data: string): this {
    if (!this.headers['content-type']) {
      this.headers['content-type'] = 'text/plain'
    }
    this.body = Utils.toArray(data, 'utf8')
    return this
  }

  end(): this {
    // No-op for buffering, actual end happens on flush
    return this
  }

  getStatusCode(): number {
    return this.statusCode
  }

  getHeaders(): Record<string, string> {
    return this.headers
  }

  getBody(): number[] {
    return this.body
  }
}

/**
 * Transport implementation for Express.
 */
export class ExpressTransport implements Transport {
  peer?: Peer
  allowUnauthenticated: boolean
  openNonGeneralHandles = new Map<string, PendingHandle[]>()
  openGeneralHandles = new Map<string, { next: Function; res: Response }>()
  openNextHandlers = new Map<string, NextFunction>()
  openNextHandlerTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activeGeneralRequests = new Map<string, ActiveGeneralRequest>()
  private readonly activeCertificateRequests = new Map<string, ActiveCertificateRequest>()
  private readonly openGeneralHandleTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

  private messageCallback?: (message: AuthMessage) => Promise<void>
  private readonly logger: typeof console | undefined
  private readonly logLevel: LogLevel
  private readonly limits: AuthTransportLimits

  /**
   * Constructs a new ExpressTransport instance.
   *
   * @param {boolean} [allowUnauthenticated=false] - Whether to allow unauthenticated requests passed the auth middleware.
   *   If `true`, requests without authentication will be permitted, and `req.auth.identityKey`
   *   will be set to `"unknown"`. If `false`, unauthenticated requests will result in a `401 Unauthorized` response.
   * @param {typeof console} [logger] - Logger to use (e.g., console). If omitted, logging is disabled.
   * @param {'debug' | 'info' | 'warn' | 'error'} [logLevel] - Log level. If omitted, no logs are output.
   */
  constructor(
    allowUnauthenticated: boolean = false,
    logger?: typeof console,
    logLevel?: LogLevel,
    limits: Partial<AuthTransportLimits> = {}
  ) {
    if (
      logger !== undefined &&
      (logger === null || typeof logger !== 'object' || typeof logger.log !== 'function')
    ) {
      throw new TypeError('logger must provide a log method.')
    }
    const requestTimeoutMs = limits.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const maxPendingRequests = limits.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new RangeError('requestTimeoutMs must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1) {
      throw new RangeError('maxPendingRequests must be a positive safe integer.')
    }
    this.allowUnauthenticated = allowUnauthenticated
    this.logger = logger
    this.logLevel = logLevel || 'error' // Default to 'error' if not provided
    this.limits = { requestTimeoutMs, maxPendingRequests }
  }

  /**
   * @deprecated Use `allowUnauthenticated`. This compatibility alias will be
   * removed in the next major release.
   */
  get allowAuthenticated(): boolean {
    return this.allowUnauthenticated
  }

  set allowAuthenticated(value: boolean) {
    this.allowUnauthenticated = value
  }

  /**
   * Internal logging method, only logs if logger is defined and log level is appropriate.
   *
   * @param level - The log level for this message
   * @param message - The message to log
   * @param data - Optional additional data to log
   */
  private log(level: LogLevel, message: string, data?: any): void {
    if (typeof this.logger !== 'object') return // Logging disabled
    if (isLogLevelEnabled(this.logLevel, level)) {
      const logMethod = getLogMethod(this.logger, level)
      if (data !== undefined) {
        logMethod(`[ExpressTransport] [${level.toUpperCase()}] ${message}`, data)
      } else {
        logMethod(`[ExpressTransport] [${level.toUpperCase()}] ${message}`)
      }
    }
  }

  setPeer(peer: Peer): void {
    this.peer = peer
    this.log('debug', 'Peer set in ExpressTransport')
  }

  private pendingRequestCount(): number {
    let nonGeneral = 0
    for (const handles of this.openNonGeneralHandles.values()) {
      nonGeneral += handles.length
    }
    return (
      nonGeneral +
      this.activeGeneralRequests.size +
      this.activeCertificateRequests.size +
      this.openGeneralHandles.size +
      this.openNextHandlers.size
    )
  }

  private assertPendingCapacity(): void {
    if (this.pendingRequestCount() >= this.limits.maxPendingRequests) {
      throw new AuthProtocolError('Authentication middleware is at pending-request capacity.')
    }
  }

  private addNonGeneralHandle(requestId: string, res: Response, next: NextFunction): void {
    this.assertPendingCapacity()
    const handle = {} as PendingHandle
    handle.res = res
    handle.next = next
    handle.timeout = setTimeout(() => {
      this.removeNonGeneralHandle(requestId, handle)
      this.clearActiveCertificateRequest(requestId)
      if (!res.headersSent) {
        res.status(408).json({
          status: 'error',
          code: 'ERR_AUTH_TIMEOUT',
          description: 'Authentication handshake timed out.'
        })
      }
    }, this.limits.requestTimeoutMs)
    handle.timeout.unref?.()
    const handles = this.openNonGeneralHandles.get(requestId)
    if (handles === undefined) {
      this.openNonGeneralHandles.set(requestId, [handle])
    } else {
      handles.push(handle)
    }
  }

  private removeNonGeneralHandle(
    requestId: string,
    expected?: PendingHandle
  ): PendingHandle | undefined {
    const handles = this.openNonGeneralHandles.get(requestId)
    if (handles === undefined) return undefined
    const index = expected === undefined ? 0 : handles.indexOf(expected)
    if (index < 0) return undefined
    const [handle] = handles.splice(index, 1)
    if (handle !== undefined) clearTimeout(handle.timeout)
    if (handles.length === 0) this.openNonGeneralHandles.delete(requestId)
    return handle
  }

  private clearActiveGeneralRequest(requestId: string): void {
    const active = this.activeGeneralRequests.get(requestId)
    if (active === undefined) return
    clearTimeout(active.timeout)
    this.peer?.stopListeningForGeneralMessages(active.listenerId)
    this.activeGeneralRequests.delete(requestId)
  }

  private clearActiveCertificateRequest(requestId: string): void {
    const active = this.activeCertificateRequests.get(requestId)
    if (active === undefined) return
    clearTimeout(active.timeout)
    this.peer?.stopListeningForCertificatesReceived(active.listenerId)
    this.activeCertificateRequests.delete(requestId)
  }

  private clearOpenGeneralHandle(requestId: string): void {
    const timeout = this.openGeneralHandleTimeouts.get(requestId)
    if (timeout !== undefined) clearTimeout(timeout)
    this.openGeneralHandleTimeouts.delete(requestId)
    this.openGeneralHandles.delete(requestId)
  }

  private respondWithProtocolError(res: Response, error: AuthProtocolError): void {
    if (res.headersSent) return
    const capacity = error.message.includes('capacity')
    res.status(capacity ? 503 : 400).json({
      status: 'error',
      code: capacity ? 'ERR_AUTH_CAPACITY' : 'ERR_AUTH_MALFORMED',
      description: capacity
        ? 'Authentication is temporarily at capacity.'
        : 'The authentication request is malformed.'
    })
  }

  /**
   * Sends an AuthMessage to the connected Peer.
   * This method uses an Express response object to deliver the message to the specified Peer.
   *
   * ### Parameters:
   * @param {AuthMessage} message - The authenticated message to send.
   *
   * ### Returns:
   * @returns {Promise<void>} A promise that resolves once the message has been sent successfully.
   */
  async send(message: AuthMessage): Promise<void> {
    this.log('debug', 'Attempting to send AuthMessage', {
      messageType: message.messageType,
      payloadLength: message.payload?.length ?? 0
    })
    if (message.messageType === 'general') {
      await this.sendGeneralMessage(message)
    } else {
      await this.sendNonGeneralMessage(message)
    }
  }

  /**
   * Handles a general (authenticated application) AuthMessage response.
   */
  private async sendGeneralMessage(message: AuthMessage): Promise<void> {
    const reader = new Utils.Reader(message.payload)
    const requestId = Utils.toBase64(reader.read(32))

    const handle = this.openGeneralHandles.get(requestId)
    if (handle === undefined) {
      this.log('warn', 'No response handle for this requestId')
      throw new Error('No response handle for this requestId!')
    }
    let { res, next } = handle
    this.clearOpenGeneralHandle(requestId)

    const statusCode = reader.readVarIntNum()
    ;(res as any).__status(statusCode)

    const responseHeaders = this.readResponseHeaders(reader)
    responseHeaders['x-bsv-auth-version'] = message.version
    responseHeaders['x-bsv-auth-identity-key'] = message.identityKey
    responseHeaders['x-bsv-auth-nonce'] = message.nonce!
    responseHeaders['x-bsv-auth-your-nonce'] = message.yourNonce!
    responseHeaders['x-bsv-auth-signature'] = Utils.toHex(message.signature!)
    responseHeaders['x-bsv-auth-request-id'] = requestId

    if (message.requestedCertificates) {
      responseHeaders['x-bsv-auth-requested-certificates'] = JSON.stringify(
        message.requestedCertificates
      )
    }

    for (const [k, v] of Object.entries(responseHeaders)) {
      ;(res as any).__set(k, v)
    }

    let responseBody: number[] | undefined
    const responseBodyBytes = reader.readVarIntNum()
    if (responseBodyBytes > 0) {
      responseBody = reader.read(responseBodyBytes)
    }

    res = this.resetRes(res, next)
    this.log('info', 'Sending general AuthMessage response', {
      status: statusCode,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseBodyLength: responseBody ? responseBody.length : 0
    })
    if (responseBody) {
      res.send(Buffer.from(new Uint8Array(responseBody)))
    } else {
      res.end()
    }
  }

  /**
   * Reads response headers from a binary reader.
   */
  private readResponseHeaders(reader: Utils.Reader): Record<string, string> {
    const responseHeaders: Record<string, string> = {}
    const nHeaders = reader.readVarIntNum()
    for (let i = 0; i < nHeaders; i++) {
      const nHeaderKeyBytes = reader.readVarIntNum()
      const headerKeyBytes = reader.read(nHeaderKeyBytes)
      const headerKey = Utils.toUTF8(headerKeyBytes)
      const nHeaderValueBytes = reader.readVarIntNum()
      const headerValueBytes = reader.read(nHeaderValueBytes)
      const headerValue = Utils.toUTF8(headerValueBytes)
      responseHeaders[headerKey] = headerValue
    }
    return responseHeaders
  }

  /**
   * Handles a non-general (handshake) AuthMessage response.
   */
  private async sendNonGeneralMessage(message: AuthMessage): Promise<void> {
    const handles = this.openNonGeneralHandles.get(message.yourNonce!)
    if (!Array.isArray(handles) || handles.length === 0) {
      this.log('warn', 'No open handles to peer for nonce')
      throw new Error('No open handles to this peer!')
    }

    // Since this is an initial response, we can assume there's only one handle per identity
    const handle = handles[0]
    if (handle === undefined) {
      throw new Error('No open handles to this peer!')
    }
    const { res, next } = handle
    const responseHeaders: Record<string, string> = {
      'x-bsv-auth-version': message.version,
      'x-bsv-auth-message-type': message.messageType,
      'x-bsv-auth-identity-key': message.identityKey,
      'x-bsv-auth-nonce': message.nonce!,
      'x-bsv-auth-your-nonce': message.yourNonce!,
      'x-bsv-auth-signature': Utils.toHex(message.signature!)
    }

    if (typeof message.requestedCertificates === 'object') {
      responseHeaders['x-bsv-auth-requested-certificates'] = JSON.stringify(
        message.requestedCertificates
      )
    }
    if ((res as any).__set !== undefined) {
      this.resetRes(res, next)
    }
    for (const [k, v] of Object.entries(responseHeaders)) {
      res.set(k, v)
    }

    this.log('info', 'Sending non-general AuthMessage response', {
      status: 200,
      responseHeaderCount: Object.keys(responseHeaders).length,
      messageType: message.messageType
    })
    res.send(message)
    this.removeNonGeneralHandle(message.yourNonce!, handle)
  }

  /**
   * Stores the callback bound by a Peer
   * @param callback
   */
  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.log('debug', 'onData callback set')
    this.messageCallback = callback
  }

  /**
   * Handles an incoming request for the Express server.
   *
   * This method processes both general and non-general message types,
   * manages peer-to-peer certificate handling, and modifies the response object
   * to enable custom behaviors like certificate requests and tailored responses.
   *
   * ### Behavior:
   * - For `/.well-known/auth`:
   *   - Handles non-general messages and listens for certificates.
   *   - Calls the `onCertificatesReceived` callback (if provided) when certificates are received.
   * - For general messages:
   *   - Sets up a listener for peer-to-peer general messages.
   *   - Overrides response methods (`send`, `json`, etc.) for custom handling.
   * - Returns a 401 error if mutual authentication fails.
   *
   * ### Parameters:
   * @param {AuthRequest} req - The incoming HTTP request.
   * @param {Response} res - The HTTP response.
   * @param {NextFunction} next - The Express `next` middleware function.
   * @param {Function} [onCertificatesReceived] - Optional callback invoked when certificates are received.
   */
  public async handleIncomingRequest(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    onCertificatesReceived?: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      req: AuthRequest,
      res: Response,
      next: NextFunction
    ) => void | Promise<void>
  ): Promise<void> {
    this.log('debug', 'Handling incoming request', {
      pathLength: req.path.length,
      method: req.method,
      hasAuthRequestId: typeof req.headers['x-bsv-auth-request-id'] === 'string'
    })
    try {
      if (!this.peer) {
        this.log('error', 'No Peer set in ExpressTransport! Cannot handle request.')
        throw new Error('You must set a Peer before you can handle incoming requests!')
      }
      // BRC-104 authentication begins on this intentionally public handshake
      // endpoint, before a session can exist. This is protocol dispatch, not a
      // protected-route authorization check. Every other request still takes
      // the signed general-message path or the explicit unauthenticated policy.
      if (req.path === WELL_KNOWN_AUTH_PATH) {
        await this.handleWellKnownAuth(req, res, next, onCertificatesReceived)
      } else if (req.headers['x-bsv-auth-request-id'] !== undefined) {
        this.handleGeneralMessage(req, res, next)
      } else {
        this.handleUnauthenticated(req, res, next)
      }
    } catch (error) {
      this.log('error', 'Caught error in handleIncomingRequest', safeErrorDetails(error))
      if (error instanceof AuthProtocolError) {
        this.respondWithProtocolError(res, error)
      } else {
        next(error)
      }
    }
  }

  /**
   * Handles a request to /.well-known/auth (non-general / handshake messages).
   */
  private async handleWellKnownAuth(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    onCertificatesReceived?: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      req: AuthRequest,
      res: Response,
      next: NextFunction
    ) => void | Promise<void>
  ): Promise<void> {
    const { message, requestId } = validateHandshakeMessage(req)
    // A later handshake phase can legitimately reuse the initial request ID
    // while its certificate listener is still active. Only a simultaneously
    // open HTTP response handle represents a duplicate request.
    if (this.openNonGeneralHandles.has(requestId)) {
      throw new AuthProtocolError('Duplicate authentication request identifier.')
    }
    this.log('debug', 'Received non-general message at /.well-known/auth', {
      messageType: message.messageType
    })
    this.addNonGeneralHandle(requestId, res, next)

    try {
      if (!(await this.peer!.sessionManager.hasSession(message.identityKey))) {
        this.registerCertificateListener(req, res, next, requestId, message, onCertificatesReceived)
      }
    } catch (error) {
      this.removeNonGeneralHandle(requestId)
      this.clearActiveCertificateRequest(requestId)
      throw error
    }

    if (this.messageCallback) {
      this.log('debug', 'Invoking stored messageCallback for non-general message')
      this.messageCallback(message).catch(err => {
        this.log('error', 'Error in messageCallback', safeErrorDetails(err))
        this.removeNonGeneralHandle(requestId)
        this.clearActiveCertificateRequest(requestId)
        return res.status(500).json({
          status: 'error',
          code: 'ERR_INTERNAL_SERVER_ERROR',
          description: 'Authentication processing failed.'
        })
      })
    }
  }

  /**
   * Registers a certificate-received listener for a non-general message.
   */
  private registerCertificateListener(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    requestId: string,
    message: AuthMessage,
    onCertificatesReceived?: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      req: AuthRequest,
      res: Response,
      next: NextFunction
    ) => void | Promise<void>
  ): void {
    let listenerId = -1
    listenerId = this.peer!.listenForCertificatesReceived(
      (senderPublicKey: string, certs: VerifiableCertificate[]) => {
        if (senderPublicKey !== message.identityKey) return
        this.clearActiveCertificateRequest(requestId)
        this.log('debug', 'Certificates received event triggered', {
          certCount: certs?.length
        })
        void this.handleCertificatesForPeer(
          senderPublicKey,
          certs,
          req,
          res,
          next,
          message,
          onCertificatesReceived
        )
          .catch(error => {
            this.log('error', 'Error in certificate listener callback', safeErrorDetails(error))
            if (!res.headersSent) {
              res.status(500).json({
                status: 'error',
                code: 'ERR_CERTIFICATE_HANDLER',
                description: 'Certificate processing failed.'
              })
            }
          })
          .finally(() => {
            this.removeNonGeneralHandle(requestId)
          })
      }
    )
    const timeout = setTimeout(() => {
      this.clearActiveCertificateRequest(requestId)
    }, this.limits.requestTimeoutMs)
    timeout.unref?.()
    this.activeCertificateRequests.set(requestId, { listenerId, timeout })
    this.log('debug', 'listenForCertificatesReceived registered', { listenerId })
  }

  /**
   * Processes certificates received from a peer during the handshake.
   */
  private async handleCertificatesForPeer(
    senderPublicKey: string,
    certs: VerifiableCertificate[],
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    message: AuthMessage,
    onCertificatesReceived?: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      req: AuthRequest,
      res: Response,
      next: NextFunction
    ) => void | Promise<void>
  ): Promise<void> {
    if (!Array.isArray(certs) || certs.length === 0) {
      this.log('warn', 'No certificates provided by peer')
      const headerRequestId = req.headers['x-bsv-auth-request-id']
      const requestId = typeof headerRequestId === 'string' ? headerRequestId : message.initialNonce
      const handle =
        typeof requestId === 'string' ? this.openNonGeneralHandles.get(requestId)?.[0] : undefined
      if (handle !== undefined) {
        handle.res.status(400).json({
          status: 'error',
          code: 'ERR_CERTIFICATES_REQUIRED',
          description: 'No certificates were provided.'
        })
      }
      return
    }

    this.log('info', 'Certificates successfully received from peer', { certCount: certs.length })
    let continued = false
    const continueOnce = ((argument?: unknown) => {
      if (continued) return
      continued = true
      if (argument === 'route' || argument === 'router') {
        next(argument)
      } else if (argument !== undefined) {
        next(argument)
      } else {
        next()
      }
    }) as NextFunction
    if (typeof onCertificatesReceived === 'function') {
      await onCertificatesReceived(senderPublicKey, certs, req, res, continueOnce)
    }

    const identityKey = message.identityKey
    if (typeof identityKey === 'string') {
      const nextFn = this.openNextHandlers.get(identityKey)
      if (typeof nextFn !== 'function') return
      const timeoutHandle = this.openNextHandlerTimeouts.get(identityKey)
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle)
        this.openNextHandlerTimeouts.delete(identityKey)
      }
      if (!continued) nextFn()
      this.openNextHandlers.delete(identityKey)
    }
  }

  /**
   * Handles an authenticated general message (has x-bsv-auth-request-id header).
   */
  private handleGeneralMessage(req: AuthRequest, res: Response, next: NextFunction): void {
    const expectedRequestId = validateGeneralAuthRequest(req)
    this.assertPendingCapacity()
    if (this.activeGeneralRequests.has(expectedRequestId)) {
      throw new AuthProtocolError('Duplicate authentication request identifier.')
    }
    const message = buildAuthMessageFromRequest(req, this.logger, this.logLevel)
    this.log('debug', 'Received general message with x-bsv-auth-request-id')

    const listenerId = this.peer!.listenForGeneralMessages(
      (senderPublicKey: string, payload: number[]) => {
        try {
          if (senderPublicKey !== message.identityKey) return
          const requestId = Utils.toBase64(new Utils.Reader(payload).read(32))
          if (requestId === expectedRequestId) {
            this.clearActiveGeneralRequest(expectedRequestId)
            this.setupAuthenticatedResponse(req, res, next, senderPublicKey, requestId)
          }
        } catch (error) {
          this.clearActiveGeneralRequest(expectedRequestId)
          this.log('error', 'Error in listenForGeneralMessages callback', safeErrorDetails(error))
          next(error)
        }
      }
    )
    const timeout = setTimeout(() => {
      this.clearActiveGeneralRequest(expectedRequestId)
      if (!res.headersSent) {
        res.status(408).json({
          status: 'error',
          code: 'ERR_AUTH_TIMEOUT',
          description: 'Authentication verification timed out.'
        })
      }
    }, this.limits.requestTimeoutMs)
    timeout.unref?.()
    this.activeGeneralRequests.set(expectedRequestId, { listenerId, timeout })

    this.log('debug', 'listenForGeneralMessages registered', { listenerId })

    if (this.messageCallback) {
      this.log('debug', 'Invoking stored messageCallback for general message')
      this.messageCallback(message).catch(err => {
        this.clearActiveGeneralRequest(expectedRequestId)
        const msg = err instanceof Error ? err.message : String(err)
        const isAuthError = /nonce|signature|session|auth version/i.test(msg)
        this.log('error', 'Error in messageCallback (general message)', {
          ...safeErrorDetails(err),
          isAuthError
        })
        const statusCode = isAuthError ? 401 : 500
        const code = isAuthError ? 'ERR_AUTH_FAILED' : 'ERR_INTERNAL_SERVER_ERROR'
        const description = isAuthError
          ? 'Authentication failed.'
          : 'Authentication processing failed.'
        return res.status(statusCode).json({ status: 'error', code, description })
      })
    }
  }

  /**
   * Sets up the intercepted response for an authenticated general message.
   */
  private setupAuthenticatedResponse(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    senderPublicKey: string,
    requestId: string
  ): void {
    this.log('debug', 'General message from the correct identity key')
    req.auth = { identityKey: senderPublicKey }
    // Validated as canonical base64 by `validateGeneralAuthRequest` before any
    // general message reaches this point.
    const sessionNonce = singleHeader(req, 'x-bsv-auth-your-nonce') as string

    const wrapper = new ResponseWriterWrapper()
    let responseSent = false

    const buildAndSendResponse = async (): Promise<void> => {
      if (responseSent) return
      responseSent = true
      try {
        const responsePayload = buildResponsePayload(
          requestId,
          wrapper.getStatusCode(),
          wrapper.getHeaders(),
          wrapper.getBody(),
          this.logger,
          this.logLevel
        )
        this.openGeneralHandles.set(requestId, { res, next })
        const responseTimeout = setTimeout(() => {
          this.clearOpenGeneralHandle(requestId)
          this.log('warn', 'Authenticated response signing timed out')
        }, this.limits.requestTimeoutMs)
        responseTimeout.unref?.()
        this.openGeneralHandleTimeouts.set(requestId, responseTimeout)
        this.log('debug', 'Sending general message response', {
          responseStatus: wrapper.getStatusCode(),
          responseHeaderCount: Object.keys(wrapper.getHeaders()).length,
          responseBodyLength: wrapper.getBody().length
        })
        if (this.peer === undefined) throw new Error('Authentication peer is unavailable.')
        // Reply on the session that carried the request, identified by the
        // session nonce the client echoed in `x-bsv-auth-your-nonce`. Resolving
        // by identity key instead would return the client's most recently
        // updated session, which for a client holding concurrent sessions can
        // be a different one — stamping the response with a `yourNonce` the
        // requesting session cannot verify.
        await this.peer.toSession(responsePayload, sessionNonce)
      } catch (err) {
        this.clearOpenGeneralHandle(requestId)
        this.log('error', 'Failed to build and send authenticated response', safeErrorDetails(err))
        try {
          const restored = this.resetRes(res, next)
          restored.status(500).json({
            status: 'error',
            code: 'ERR_RESPONSE_SIGNING_FAILED',
            description: 'Failed to sign the authenticated response.'
          })
        } catch (responseError) {
          this.log(
            'error',
            'Unable to report response-signing failure',
            safeErrorDetails(responseError)
          )
        }
      }
    }

    this.hijackResponse(res, next, wrapper, buildAndSendResponse)
    void this.scheduleNextOrCertificateWait(
      next,
      senderPublicKey,
      wrapper,
      buildAndSendResponse
    ).catch(next)
  }

  /**
   * Overrides the response methods to intercept and buffer the response for signing.
   */
  private hijackResponse(
    res: Response,
    next: NextFunction,
    wrapper: ResponseWriterWrapper,
    buildAndSendResponse: () => Promise<void>
  ): void {
    // Override methods to capture response data
    this.checkRes(res, 'needs to be clear', next)
    ;(res as any).__status = res.status
    res.status = n => {
      wrapper.status(n)
      return res
    }

    ;(res as any).__set = res.set
    ;(res as any).set = (keyOrHeaders: string | Record<string, string>, value?: string) => {
      wrapper.set(keyOrHeaders, value)
      return res
    }

    ;(res as any).__send = res.send
    ;(res as any).send = (val: any) => {
      if (typeof val === 'object' && val !== null && !wrapper.getHeaders()['content-type']) {
        wrapper.set('content-type', 'application/json')
      }
      wrapper.send(val)
      buildAndSendResponse()
      return res
    }

    ;(res as any).__json = res.json
    ;(res as any).json = (obj: any) => {
      wrapper.json(obj)
      buildAndSendResponse()
      return res
    }

    ;(res as any).__text = (res as any).text
    ;(res as any).text = (str: string) => {
      wrapper.text(str)
      buildAndSendResponse()
      return res
    }

    ;(res as any).__end = res.end
    ;(res as any).end = () => {
      buildAndSendResponse()
      return res
    }

    ;(res as any).__sendFile = res.sendFile
    ;(res as any).sendFile = (path: string, options?: any, callback?: Function) => {
      fs.readFile(path, (err, data) => {
        if (err) {
          this.log('error', 'Error reading file in sendFile', { errorName: err.name })
          if (callback) return callback(err)
          wrapper.status(500)
          buildAndSendResponse()
          return
        }

        const mimeType = mime.lookup(path) || 'application/octet-stream'
        wrapper.set('Content-Type', mimeType)
        wrapper.send(Array.from(data))
        buildAndSendResponse()
      })
    }
  }

  /**
   * Either calls next() immediately or stores it pending certificate arrival.
   */
  private async scheduleNextOrCertificateWait(
    next: NextFunction,
    senderPublicKey: string,
    wrapper: ResponseWriterWrapper,
    buildAndSendResponse: () => Promise<void>
  ): Promise<void> {
    const hasSession = await (this.peer?.sessionManager.hasSession(senderPublicKey) ?? false)
    const needsCertificates = this.peer?.certificatesToRequest?.certifiers?.length
    this.log('debug', 'Checking if we need to wait for certificates', {
      hasSession,
      needsCertificates
    })

    if (!needsCertificates || hasSession) {
      this.log('debug', 'Calling next() immediately - no certificate wait needed', {
        hasSession
      })
      next()
      return
    }

    this.log('debug', 'Storing next handler to wait for certificates')
    const existingTimeout = this.openNextHandlerTimeouts.get(senderPublicKey)
    if (existingTimeout != null) {
      clearTimeout(existingTimeout)
      this.openNextHandlerTimeouts.delete(senderPublicKey)
    }
    this.openNextHandlers.set(senderPublicKey, next)

    const timeoutHandle = setTimeout(() => {
      if (this.openNextHandlers.has(senderPublicKey)) {
        this.log('warn', 'Certificate request timed out')
        this.openNextHandlers.delete(senderPublicKey)
        this.openNextHandlerTimeouts.delete(senderPublicKey)
        wrapper.status(408).json({
          status: 'error',
          code: 'CERTIFICATE_TIMEOUT',
          message: 'Certificate request timed out'
        })
        buildAndSendResponse()
      }
    }, this.limits.requestTimeoutMs)
    timeoutHandle.unref?.()
    this.openNextHandlerTimeouts.set(senderPublicKey, timeoutHandle)
  }

  /**
   * Handles a request with no auth headers.
   */
  private handleUnauthenticated(req: AuthRequest, res: Response, next: NextFunction): void {
    this.log('warn', 'No Auth headers found on request. Checking allowUnauthenticated setting.', {
      allowUnauthenticated: this.allowUnauthenticated
    })
    if (this.allowUnauthenticated) {
      req.auth = { identityKey: 'unknown' }
      next()
    } else {
      this.log('warn', 'Mutual-authentication failed. Returning 401.')
      res.status(401).json({
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Mutual-authentication failed!'
      })
    }
  }

  private checkRes(
    res: any,
    test?: 'needs to be clear' | 'needs to be hijacked',
    next?: Function
  ): void {
    if (test === 'needs to be clear') {
      if (
        typeof res.__status === 'function' ||
        typeof res.__set === 'function' ||
        typeof res.__json === 'function' ||
        typeof res.__text === 'function' ||
        typeof res.__send === 'function' ||
        typeof res.__end === 'function' ||
        typeof res.__sendFile === 'function'
      ) {
        const e = new Error(
          'Unable to install Auth midddleware on the response object as it is not clear. Are two middleware instances installed?'
        )
        if (typeof next === 'function') {
          next(e)
        }
        throw e
      }
    } else if (
      typeof res.__status !== 'function' ||
      typeof res.__set !== 'function' ||
      typeof res.__json !== 'function' ||
      typeof res.__send !== 'function' ||
      typeof res.__end !== 'function' ||
      typeof res.__sendFile !== 'function'
    ) {
      const e = new Error(
        'Unable to restore response object. Did you tamper with hijacked properties (res.__status, __set, __json, __text, __send, __end, __sendFile) ?'
      )
      if (typeof next === 'function') {
        next(e)
      }
      throw e
    }
  }

  private resetRes(res: Response, next?: Function): Response {
    this.checkRes(res, 'needs to be hijacked', next)
    res.status = (res as any).__status
    res.set = (res as any).__set
    res.json = (res as any).__json
    ;(res as any).text = (res as any).__text
    res.send = (res as any).__send
    res.end = (res as any).__end
    res.sendFile = (res as any).__sendFile
    return res
  }
}

/**
 * Helper: Build AuthMessage from Request
 */
function buildAuthMessageFromRequest(
  req: Request,
  logger?: typeof console,
  logLevel?: LogLevel
): AuthMessage {
  const debugLog = makeDebugLogger(logger, logLevel)
  debugLog('[buildAuthMessageFromRequest] Building message from request...', {
    pathLength: req.path.length,
    method: req.method
  })

  const writer = new Utils.Writer()
  const requestNonce = singleHeader(req, 'x-bsv-auth-request-id')!
  const requestNonceBytes = Utils.toArray(requestNonce, 'base64')
  writer.write(requestNonceBytes)
  writer.writeVarIntNum(req.method.length)
  writer.write(Utils.toArray(req.method))

  const protocol = req.protocol
  const host = req.get('host')
  if (
    (protocol !== 'http' && protocol !== 'https') ||
    typeof host !== 'string' ||
    host.length === 0 ||
    host.length > 512 ||
    containsUnsafeHeaderCharacter(host) ||
    typeof req.originalUrl !== 'string' ||
    !req.originalUrl.startsWith('/') ||
    req.originalUrl.length > 8_192
  ) {
    throw new AuthProtocolError('The authenticated request URL is invalid.')
  }
  const parsedUrl = new URL(`${protocol}://${host}${req.originalUrl}`)

  writeUrlToWriter(parsedUrl, writer)
  writeRequestHeadersToWriter(req, writer)
  writeBodyToWriter(req, writer, logger, logLevel)

  const authMessage = {
    messageType: 'general' as const,
    version: singleHeader(req, 'x-bsv-auth-version')!,
    identityKey: singleHeader(req, 'x-bsv-auth-identity-key')!,
    nonce: singleHeader(req, 'x-bsv-auth-nonce')!,
    yourNonce: singleHeader(req, 'x-bsv-auth-your-nonce')!,
    payload: writer.toArray(),
    signature: Utils.toArray(singleHeader(req, 'x-bsv-auth-signature')!, 'hex')
  }

  debugLog('[buildAuthMessageFromRequest] AuthMessage built', {
    payloadLength: authMessage.payload.length
  })

  return authMessage
}

/**
 * Helper: Build response payload for sending back to peer
 */
function buildResponsePayload(
  requestId: string,
  responseStatus: number,
  responseHeaders: Record<string, any>,
  responseBody: number[],
  logger?: typeof console,
  logLevel?: LogLevel
): number[] {
  const debugLog = makeDebugLogger(logger, logLevel)
  debugLog('[buildResponsePayload] Building response payload', {
    responseStatus,
    responseHeaderCount: Object.keys(responseHeaders).length,
    responseBodyLength: responseBody.length
  })

  const writer = new Utils.Writer()
  writer.write(Utils.toArray(requestId, 'base64'))
  writer.writeVarIntNum(responseStatus)

  // Filter out headers that should NOT be signed:
  // - Include custom headers prefixed with x-bsv (excluding those starting with x-bsv-auth)
  // - Include the authorization header
  const includedHeaders: Array<[string, string]> = []
  Object.entries(responseHeaders).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase()
    if (
      (lowerKey.startsWith('x-bsv-') || lowerKey === 'authorization') &&
      !lowerKey.startsWith('x-bsv-auth')
    ) {
      includedHeaders.push([lowerKey, String(value)])
    }
  })

  // Sort the headers by key to ensure a consistent order for signing and verification.
  includedHeaders.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))

  writer.writeVarIntNum(includedHeaders.length)
  for (const [headerKey, headerValue] of includedHeaders) {
    writeHeaderPair(writer, headerKey, headerValue)
  }

  if (responseBody.length > 0) {
    writer.writeVarIntNum(responseBody.length)
    writer.write(responseBody)
  } else {
    writer.writeVarIntNum(-1)
  }

  return writer.toArray()
}

/**
 * Creates an Express middleware that handles authentication via BSV-SDK.
 *
 * @param {AuthMiddlewareOptions} options
 * @returns {(req: Request, res: Response, next: NextFunction) => void} Express middleware
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions
): (req: AuthRequest, res: Response, next: NextFunction) => void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Auth middleware options are required.')
  }
  const {
    wallet,
    sessionManager,
    allowUnauthenticated,
    certificatesToRequest,
    onCertificatesReceived,
    logger,
    logLevel,
    transportLimits
  } = options

  if (wallet === null || typeof wallet !== 'object') {
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'error')) {
      getLogMethod(
        logger,
        'error'
      )('[createAuthMiddleware] No wallet provided in AuthMiddlewareOptions.')
    }
    throw new TypeError('You must configure the auth middleware with a wallet.')
  }
  if (allowUnauthenticated !== undefined && typeof allowUnauthenticated !== 'boolean') {
    throw new TypeError('allowUnauthenticated must be a boolean.')
  }
  if (logLevel !== undefined && !(['debug', 'info', 'warn', 'error'] as const).includes(logLevel)) {
    throw new TypeError('logLevel must be debug, info, warn, or error.')
  }
  if (onCertificatesReceived !== undefined && typeof onCertificatesReceived !== 'function') {
    throw new TypeError('onCertificatesReceived must be a function.')
  }

  const transport = new ExpressTransport(
    allowUnauthenticated ?? false,
    logger,
    logLevel,
    transportLimits
  )

  const sessionMgr = sessionManager || new SessionManager()

  if (logger && logLevel && isLogLevelEnabled(logLevel, 'info')) {
    getLogMethod(
      logger,
      'info'
    )(
      `[createAuthMiddleware] Creating Peer with provided wallet & transport. Session Manager: ${
        sessionManager ? 'Custom' : 'Default'
      }`
    )
  }

  const peer = new Peer(wallet, transport, certificatesToRequest, sessionMgr)
  transport.setPeer(peer)

  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')('[createAuthMiddleware] Incoming request to auth middleware', {
        pathLength: req.path.length,
        method: req.method,
        hasAuthRequestId: typeof req.headers['x-bsv-auth-request-id'] === 'string'
      })
    }
    void transport.handleIncomingRequest(req, res, next, onCertificatesReceived).catch(next)
  }
}
