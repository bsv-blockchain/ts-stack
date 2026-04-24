import { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import mime from 'mime-types'
import {
  Utils,
  VerifiableCertificate,
  Peer,
  AuthMessage,
  RequestedCertificateSet,
  Transport,
  SessionManager,
  WalletInterface,
  PubKeyHex
} from '@bsv/sdk'

export interface AuthRequest extends Request {
  auth?: {
    identityKey: PubKeyHex | 'unknown'
  }
}
// Developers may optionally provide a handler for incoming certificates.
export interface AuthMiddlewareOptions {
  wallet: WalletInterface
  sessionManager?: SessionManager // Optional if dev wants custom SessionManager
  allowUnauthenticated?: boolean
  certificatesToRequest?: RequestedCertificateSet
  onCertificatesReceived?: (
    senderPublicKey: string,
    certs: VerifiableCertificate[],
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => void

  /**
   * Optional logger (e.g., console). If not provided, logging is disabled.
   */
  logger?: typeof console

  /**
   * Optional logging level. Defaults to no logging if not provided.
   * 'debug' | 'info' | 'warn' | 'error'
   *
   * - debug: Logs *everything*, including low-level details of the auth process.
   * - info: Logs general informational messages about normal operation.
   * - warn: Logs potential issues but not necessarily errors.
   * - error: Logs only critical issues and errors.
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Helper to determine if a given message-level log should be output
 * based on the configured log level.
 */
function isLogLevelEnabled(
  configuredLevel: 'debug' | 'info' | 'warn' | 'error',
  messageLevel: 'debug' | 'info' | 'warn' | 'error'
): boolean {
  const levels: Array<'debug' | 'info' | 'warn' | 'error'> = ['debug', 'info', 'warn', 'error']
  const configuredIndex = levels.indexOf(configuredLevel)
  const messageIndex = levels.indexOf(messageLevel)
  return messageIndex >= configuredIndex
}

/**
 * Retrieves the appropriate logging method from the logger,
 * falling back to `log` if not found.
 */
function getLogMethod(
  logger: typeof console,
  level: 'debug' | 'info' | 'warn' | 'error'
): (...args: any[]) => void {
  switch (level) {
    case 'debug':
      return typeof logger.debug === 'function' ? logger.debug.bind(logger) : logger.log.bind(logger)
    case 'info':
      // We'll map 'info' to console.info if available
      return typeof logger.info === 'function' ? logger.info.bind(logger) : logger.log.bind(logger)
    case 'warn':
      return typeof logger.warn === 'function' ? logger.warn.bind(logger) : logger.log.bind(logger)
    case 'error':
      return typeof logger.error === 'function' ? logger.error.bind(logger) : logger.log.bind(logger)
    default:
      return logger.log.bind(logger)
  }
}

/**
 * ResponseWriterWrapper buffers response data until signing is complete.
 * This pattern matches the Go implementation for cleaner response handling.
 */
class ResponseWriterWrapper {
  private statusCode: number = 200
  private headers: Record<string, string> = {}
  private body: number[] = []
  private originalRes: Response
  private flushed: boolean = false

  constructor(res: Response) {
    this.originalRes = res
  }

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

  getOriginalRes(): Response {
    return this.originalRes
  }

  // Called after peer signs the response
  flush(): void {
    if (this.flushed) return
    this.flushed = true

    this.originalRes.status(this.statusCode)
    for (const [key, value] of Object.entries(this.headers)) {
      this.originalRes.set(key, value)
    }
    if (this.body.length > 0) {
      this.originalRes.send(Buffer.from(new Uint8Array(this.body)))
    } else {
      this.originalRes.end()
    }
  }
}

/**
 * Transport implementation for Express.
 */
export class ExpressTransport implements Transport {
  peer?: Peer
  allowAuthenticated: boolean
  openNonGeneralHandles: Record<string, Array<{ res: Response, next: Function }>> = {}
  openGeneralHandles: Record<string, { next: Function, res: Response }> = {}
  openNextHandlers: Record<string, NextFunction> = {}
  openNextHandlerTimeouts: Record<string, ReturnType<typeof setTimeout>> = {}

  private messageCallback?: (message: AuthMessage) => Promise<void>
  private readonly logger: typeof console | undefined
  private readonly logLevel: 'debug' | 'info' | 'warn' | 'error'

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
    logLevel?: 'debug' | 'info' | 'warn' | 'error'
  ) {
    this.allowAuthenticated = allowUnauthenticated
    this.logger = logger
    this.logLevel = logLevel || 'error' // Default to 'error' if not provided
  }

  /**
   * Internal logging method, only logs if logger is defined and log level is appropriate.
   * 
   * @param level - The log level for this message
   * @param message - The message to log
   * @param data - Optional additional data to log
   */
  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: any
  ): void {
    if (typeof this.logger !== 'object') return // Logging disabled
    if (!isLogLevelEnabled(this.logLevel, level)) return

    const logMethod = getLogMethod(this.logger, level)
    if (data !== undefined) {
      logMethod(`[ExpressTransport] [${level.toUpperCase()}] ${message}`, data)
    } else {
      logMethod(`[ExpressTransport] [${level.toUpperCase()}] ${message}`)
    }
  }

  setPeer(peer: Peer): void {
    this.peer = peer
    this.log('debug', 'Peer set in ExpressTransport', { peer })
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
    this.log('debug', `Attempting to send AuthMessage`, { message })
    if (message.messageType !== 'general') {
      const handles = this.openNonGeneralHandles[message.yourNonce!]
      if (!Array.isArray(handles) || handles.length === 0) {
        this.log('warn', `No open handles to peer for nonce`, { yourNonce: message.yourNonce })
        throw new Error('No open handles to this peer!')
      } else {
        // Since this is an initial response, we can assume there's only one handle per identity
        const { res, next } = handles[0]
        const responseHeaders: Record<string, string> = {}
        responseHeaders['x-bsv-auth-version'] = message.version
        responseHeaders['x-bsv-auth-message-type'] = message.messageType
        responseHeaders['x-bsv-auth-identity-key'] = message.identityKey
        responseHeaders['x-bsv-auth-nonce'] = message.nonce!
        responseHeaders['x-bsv-auth-your-nonce'] = message.yourNonce!
        responseHeaders['x-bsv-auth-signature'] = Utils.toHex(message.signature!)

        if (typeof message.requestedCertificates === 'object') {
          responseHeaders['x-bsv-auth-requested-certificates'] = JSON.stringify(message.requestedCertificates)
        }
        if ((res as any).__set !== undefined) {
          this.resetRes(res, next)
        }
        for (const [k, v] of Object.entries(responseHeaders)) {
          res.set(k, v)
        }

        this.log('info', 'Sending non-general AuthMessage response', {
          status: 200,
          responseHeaders,
          messagePayload: message
        })
        res.send(message)
        handles.shift()
      }
    } else {
      // General message
      const reader = new Utils.Reader(message.payload)
      const requestId = Utils.toBase64(reader.read(32))

      if (typeof this.openGeneralHandles[requestId] !== 'object') {
        this.log('warn', `No response handle for this requestId`, { requestId })
        throw new Error('No response handle for this requestId!')
      }
      let { res, next } = this.openGeneralHandles[requestId]
      delete this.openGeneralHandles[requestId]

      const statusCode = reader.readVarIntNum()
        ; (res as any).__status(statusCode)

      const responseHeaders: Record<string, string> = {}
      const nHeaders = reader.readVarIntNum()
      if (nHeaders > 0) {
        for (let i = 0; i < nHeaders; i++) {
          const nHeaderKeyBytes = reader.readVarIntNum()
          const headerKeyBytes = reader.read(nHeaderKeyBytes)
          const headerKey = Utils.toUTF8(headerKeyBytes)
          const nHeaderValueBytes = reader.readVarIntNum()
          const headerValueBytes = reader.read(nHeaderValueBytes)
          const headerValue = Utils.toUTF8(headerValueBytes)
          responseHeaders[headerKey] = headerValue
        }
      }

      responseHeaders['x-bsv-auth-version'] = message.version
      responseHeaders['x-bsv-auth-identity-key'] = message.identityKey
      responseHeaders['x-bsv-auth-nonce'] = message.nonce!
      responseHeaders['x-bsv-auth-your-nonce'] = message.yourNonce!
      responseHeaders['x-bsv-auth-signature'] = Utils.toHex(message.signature!)
      responseHeaders['x-bsv-auth-request-id'] = requestId

      if (message.requestedCertificates) {
        responseHeaders['x-bsv-auth-requested-certificates'] = JSON.stringify(message.requestedCertificates)
      }

      for (const [k, v] of Object.entries(responseHeaders)) {
        ; (res as any).__set(k, v)
      }

      let responseBody
      const responseBodyBytes = reader.readVarIntNum()
      if (responseBodyBytes > 0) {
        responseBody = reader.read(responseBodyBytes)
      }

      res = this.resetRes(res, next)
      this.log('info', `Sending general AuthMessage response`, {
        status: statusCode,
        responseHeaders,
        responseBodyLength: responseBody ? responseBody.length : 0,
        requestId
      })
      if (responseBody) {
        res.send(Buffer.from(new Uint8Array(responseBody)))
      } else {
        res.end()
      }
    }
  }

  /**
   * Stores the callback bound by a Peer
   * @param callback
   */
  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.log('debug', `onData callback set`)
    // Just store the callback
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
  public handleIncomingRequest(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    onCertificatesReceived?: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      req: AuthRequest,
      res: Response,
      next: NextFunction
    ) => void
  ): void {
    this.log('debug', `Handling incoming request`, {
      path: req.path,
      headers: req.headers,
      method: req.method,
      body: req.body
    })
    try {
      if (!this.peer) {
        this.log('error', `No Peer set in ExpressTransport! Cannot handle request.`)
        throw new Error('You must set a Peer before you can handle incoming requests!')
      }
      if (req.path === '/.well-known/auth') {
        // Non-general message
        const message = req.body as AuthMessage
        this.log('debug', `Received non-general message at /.well-known/auth`, { message })

        // Get a the request id
        let requestId = req.headers['x-bsv-auth-request-id'] as string
        if (!requestId) {
          requestId = message.initialNonce!
        }

        if (Array.isArray(this.openNonGeneralHandles[requestId])) {
          this.openNonGeneralHandles[requestId].push({ res, next })
        } else {
          this.openNonGeneralHandles[requestId] = [{ res, next }]
        }
        if (!this.peer.sessionManager.hasSession(message.identityKey)) {
          // Capture requestId in closure for consistent key usage
          const handleKey = requestId
          const listenerId = this.peer.listenForCertificatesReceived(
            (senderPublicKey: string, certs: VerifiableCertificate[]) => {
              try {
                this.log('debug', 'Certificates received event triggered', {
                  senderPublicKey,
                  certCount: certs?.length,
                  handleKey
                })
                if (senderPublicKey !== req.body.identityKey) {
                  return
                }
                if (!Array.isArray(certs) || certs.length === 0) {
                  this.log('warn', 'No certificates provided by peer', { senderPublicKey })
                  const handles = this.openNonGeneralHandles[handleKey]
                  if (handles && handles.length > 0) {
                    handles[0].res.status(400).json({ status: 'No certificates provided' })
                  }
                } else {
                  this.log('info', 'Certificates successfully received from peer', {
                    senderPublicKey,
                    certs
                  })
                  if (typeof onCertificatesReceived === 'function') {
                    onCertificatesReceived(senderPublicKey, certs, req, res, next)
                  }

                  const nextFn = this.openNextHandlers[message.identityKey]
                  if (typeof nextFn === 'function') {
                    const timeoutHandle = this.openNextHandlerTimeouts[message.identityKey]
                    if (timeoutHandle != null) {
                      clearTimeout(timeoutHandle)
                      delete this.openNextHandlerTimeouts[message.identityKey]
                    }
                    nextFn()
                    delete this.openNextHandlers[message.identityKey]
                  }
                }
              } catch (error) {
                this.log('error', 'Error in certificate listener callback', { error })
              } finally {
                // Always clean up - use consistent key
                const handles = this.openNonGeneralHandles[handleKey]
                if (handles && handles.length > 0) {
                  handles.shift()
                  if (handles.length === 0) {
                    delete this.openNonGeneralHandles[handleKey]
                  }
                }
                this.peer?.stopListeningForCertificatesReceived(listenerId)
              }
            })
          this.log('debug', 'listenForCertificatesReceived registered', { listenerId, handleKey })
        }

        if (this.messageCallback) {
          this.log('debug', `Invoking stored messageCallback for non-general message`)
          this.messageCallback(message).catch((err) => {
            this.log('error', `Error in messageCallback`, { error: err.message, err })
            return res.status(500).json({
              status: 'error',
              code: 'ERR_INTERNAL_SERVER_ERROR',
              description: err.message || 'An unknown error occurred.'
            })
          })
        }
      } else {
        // Possibly general message
        if (req.headers['x-bsv-auth-request-id']) {
          const message = buildAuthMessageFromRequest(req, this.logger, this.logLevel)
          this.log('debug', `Received general message with x-bsv-auth-request-id`, { message })

          // Setup general message listener
          const listenerId = this.peer.listenForGeneralMessages((senderPublicKey: string, payload: number[]) => {
            try {
              if (senderPublicKey !== req.headers['x-bsv-auth-identity-key']) return
              const requestId = Utils.toBase64(new Utils.Reader(payload).read(32))
              if (requestId === req.headers['x-bsv-auth-request-id']) {
                this.log('debug', `General message from the correct identity key`, {
                  requestId,
                  senderPublicKey
                })
                this.peer?.stopListeningForGeneralMessages(listenerId)
                req.auth = { identityKey: senderPublicKey }

                // Use ResponseWriterWrapper for cleaner state management
                const wrapper = new ResponseWriterWrapper(res)

                // Track if response has been built and sent
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
                      req,
                      this.logger,
                      this.logLevel
                    )
                    this.openGeneralHandles[requestId] = { res, next }
                    this.log('debug', `Sending general message response`, {
                      requestId,
                      responseStatus: wrapper.getStatusCode(),
                      responseHeaders: wrapper.getHeaders(),
                      responseBodyLength: wrapper.getBody().length
                    })
                    await this.peer?.toPeer(responsePayload, req.headers['x-bsv-auth-identity-key'] as string)
                  } catch (err) {
                    delete this.openGeneralHandles[requestId]
                    this.log('error', `Failed to build and send authenticated response`, { error: err })
                    try {
                      const restored = this.resetRes(res, next)
                      restored.status(500).json({
                        status: 'error',
                        code: 'ERR_RESPONSE_SIGNING_FAILED',
                        description: err instanceof Error ? err.message : 'Failed to sign response'
                      })
                    } catch (_) {
                      // Response may already be partially sent
                    }
                  }
                }

                // Override methods to capture response data
                this.checkRes(res, 'needs to be clear', next)
                  ; (res as any).__status = res.status
                res.status = (n) => {
                  wrapper.status(n)
                  return res
                }

                  ; (res as any).__set = res.set
                  ; (res as any).set = (keyOrHeaders: string | Record<string, string>, value?: string) => {
                    wrapper.set(keyOrHeaders, value)
                    return res
                  }

                  ; (res as any).__send = res.send
                  ; (res as any).send = (val: any) => {
                    if (typeof val === 'object' && val !== null && !wrapper.getHeaders()['content-type']) {
                      wrapper.set('content-type', 'application/json')
                    }
                    wrapper.send(val)
                    buildAndSendResponse()
                    return res
                  }

                  ; (res as any).__json = res.json
                  ; (res as any).json = (obj: any) => {
                    wrapper.json(obj)
                    buildAndSendResponse()
                    return res
                  }

                  ; (res as any).__text = (res as any).text
                  ; (res as any).text = (str: string) => {
                    wrapper.text(str)
                    buildAndSendResponse()
                    return res
                  }

                  ; (res as any).__end = res.end
                  ; (res as any).end = () => {
                    buildAndSendResponse()
                    return res
                  }

                  ; (res as any).__sendFile = res.sendFile
                  ; (res as any).sendFile = (path: string, options?: any, callback?: Function) => {
                    fs.readFile(path, (err, data) => {
                      if (err) {
                        this.log('error', `Error reading file in sendFile`, { error: err.message })
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

                // Check if we need certificates AND don't already have a session with validated certificates
                const hasSession = this.peer?.sessionManager.hasSession(senderPublicKey) ?? false
                const needsCertificates = this.peer?.certificatesToRequest?.certifiers?.length
                this.log('debug', 'Checking if we need to wait for certificates', {
                  senderPublicKey,
                  hasSession,
                  needsCertificates,
                  openNextHandlersKeys: Object.keys(this.openNextHandlers)
                })

                if (needsCertificates && !hasSession) {
                  // Store next to be called when certificates arrive
                  this.log('debug', 'Storing next handler to wait for certificates', { senderPublicKey })
                  const existingTimeout = this.openNextHandlerTimeouts[senderPublicKey]
                  if (existingTimeout != null) {
                    clearTimeout(existingTimeout)
                    delete this.openNextHandlerTimeouts[senderPublicKey]
                  }
                  this.openNextHandlers[senderPublicKey] = next

                  // Add timeout to prevent indefinite hanging
                  const CERTIFICATE_TIMEOUT_MS = 30000
                  const timeoutHandle = setTimeout(() => {
                    if (this.openNextHandlers[senderPublicKey]) {
                      this.log('warn', 'Certificate request timed out', { senderPublicKey })
                      delete this.openNextHandlers[senderPublicKey]
                      delete this.openNextHandlerTimeouts[senderPublicKey]
                      wrapper.status(408).json({
                        status: 'error',
                        code: 'CERTIFICATE_TIMEOUT',
                        message: 'Certificate request timed out'
                      })
                      buildAndSendResponse()
                    }
                  }, CERTIFICATE_TIMEOUT_MS)
                  this.openNextHandlerTimeouts[senderPublicKey] = timeoutHandle
                } else {
                  this.log('debug', 'Calling next() immediately - no certificate wait needed', { senderPublicKey, hasSession })
                  next()
                }
              }
            } catch (error) {
              this.log('error', `Error in listenForGeneralMessages callback`, { error })
              next(error)
            }
          })

          this.log('debug', `listenForGeneralMessages registered`, { listenerId })

          if (this.messageCallback) {
            // Note: The requester may want more detailed error handling
            this.log('debug', `Invoking stored messageCallback for general message`)
            this.messageCallback(message).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err)
              const isAuthError = /nonce|signature|session|auth version/i.test(msg)
              this.log('error', `Error in messageCallback (general message)`, { error: msg, isAuthError })
              const statusCode = isAuthError ? 401 : 500
              const code = isAuthError ? 'ERR_AUTH_FAILED' : 'ERR_INTERNAL_SERVER_ERROR'
              const description = isAuthError
                ? (msg || 'Authentication failed.')
                : (msg || 'An unexpected error occurred.')
              return res.status(statusCode).json({ status: 'error', code, description })
            })
          }
        } else {
          // No auth headers
          this.log(
            'warn',
            `No Auth headers found on request. Checking allowUnauthenticated setting.`,
            { allowAuthenticated: this.allowAuthenticated }
          )
          if (this.allowAuthenticated) {
            req.auth = { identityKey: 'unknown' }
            next()
          } else {
            this.log('warn', `Mutual-authentication failed. Returning 401.`)
            res.status(401).json({
              status: 'error',
              code: 'UNAUTHORIZED',
              message: 'Mutual-authentication failed!'
            })
          }
        }
      }
    } catch (error) {
      this.log('error', `Caught error in handleIncomingRequest`, { error })
      next(error)
    }
  }

  private checkRes(res: any, test?: 'needs to be clear' | 'needs to be hijacked', next?: Function): void {
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
        const e = new Error('Unable to install Auth midddleware on the response object as it is not clear. Are two middleware instances installed?')
        if (typeof next === 'function') {
          next(e)
        }
        throw e
      }
    } else {
      if (
        typeof res.__status !== 'function' ||
        typeof res.__set !== 'function' ||
        typeof res.__json !== 'function' ||
        typeof res.__send !== 'function' ||
        typeof res.__end !== 'function' ||
        typeof res.__sendFile !== 'function'
      ) {
        const e = new Error('Unable to restore response object. Did you tamper with hijacked properties (res.__status, __set, __json, __text, __send, __end, __sendFile) ?')
        if (typeof next === 'function') {
          next(e)
        }
        throw e
      }
    }
  }

  private resetRes(res: Response, next?: Function): Response {
    this.checkRes(res, 'needs to be hijacked', next)
    res.status = (res as any).__status
    res.set = (res as any).__set
    res.json = (res as any).__json
      ; (res as any).text = (res as any).__text
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
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
): AuthMessage {
  // Possibly log raw request details at debug level
  if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
    getLogMethod(logger, 'debug')(
      `[buildAuthMessageFromRequest] Building message from request...`,
      {
        path: req.path,
        headers: req.headers,
        method: req.method,
        body: req.body
      }
    )
  }

  const writer = new Utils.Writer()
  const requestNonce = req.headers['x-bsv-auth-request-id']
  const requestNonceBytes = requestNonce ? Utils.toArray(requestNonce, 'base64') : []
  writer.write(requestNonceBytes)
  writer.writeVarIntNum(req.method.length)
  writer.write(Utils.toArray(req.method))

  // Dynamically determine the base URL
  const protocol = req.protocol // Ex. 'http' or 'https'
  const host = req.get('host') // Ex. 'example.com:3000'
  const baseUrl = `${protocol}://${host}`
  const parsedUrl = new URL(`${baseUrl}${req.originalUrl}`)

  // Pathname
  if (parsedUrl.pathname.length > 0) {
    const pathnameAsArray = Utils.toArray(parsedUrl.pathname)
    writer.writeVarIntNum(pathnameAsArray.length)
    writer.write(pathnameAsArray)
  } else {
    writer.writeVarIntNum(-1)
  }

  // Search
  if (parsedUrl.search.length > 0) {
    const searchAsArray = Utils.toArray(parsedUrl.search)
    writer.writeVarIntNum(searchAsArray.length)
    writer.write(searchAsArray)
  } else {
    writer.writeVarIntNum(-1)
  }

  // Parse request headers from client and include only the signed headers:
  // - Include custom headers prefixed with x-bsv (excluding those starting with x-bsv-auth)
  // - Include a normalized version of the content-type header
  // - Include the authorization header

  // Headers
  const includedHeaders: Array<[string, string]> = []
  for (let [k, v] of Object.entries(req.headers)) {
    k = k.toLowerCase()
    // Normalize the Content-Type header by removing any parameters.
    if (k === 'content-type') {
      v = (v as string).split(';')[0].trim()
    }
    if ((k.startsWith('x-bsv-') || k === 'content-type' || k === 'authorization') && !k.startsWith('x-bsv-auth')) {
      includedHeaders.push([k, v as string])
    }
  }

  includedHeaders.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))

  writer.writeVarIntNum(includedHeaders.length)
  for (let i = 0; i < includedHeaders.length; i++) {
    const headerKeyAsArray = Utils.toArray(includedHeaders[i][0], 'utf8')
    writer.writeVarIntNum(headerKeyAsArray.length)
    writer.write(headerKeyAsArray)

    const headerValueAsArray = Utils.toArray(includedHeaders[i][1], 'utf8')
    writer.writeVarIntNum(headerValueAsArray.length)
    writer.write(headerValueAsArray)
  }

  // Body
  writeBodyToWriter(req, writer, logger, logLevel)

  const authMessage = {
    messageType: 'general' as 'general',
    version: req.headers['x-bsv-auth-version'] as string,
    identityKey: req.headers['x-bsv-auth-identity-key'] as string,
    nonce: req.headers['x-bsv-auth-nonce'] as string,
    yourNonce: req.headers['x-bsv-auth-your-nonce'] as string,
    payload: writer.toArray(),
    signature: req.headers['x-bsv-auth-signature']
      ? Utils.toArray(req.headers['x-bsv-auth-signature'], 'hex')
      : []
  }

  if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
    getLogMethod(logger, 'debug')(
      `[buildAuthMessageFromRequest] AuthMessage built`,
      { authMessage }
    )
  }

  return authMessage
}

/**
 * Helper: Write body to writer
 */
function writeBodyToWriter(
  req: Request,
  writer: Utils.Writer,
  logger?: typeof console,
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
) {
  const { body, headers } = req

  if (Array.isArray(body) && body.every((item) => typeof item === 'number')) {
    // If the body is already a number[]
    writer.writeVarIntNum(body.length)
    writer.write(body)
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')(`[writeBodyToWriter] Body recognized as number[]`, { length: body.length })
    }
  } else if (body instanceof Uint8Array) {
    // If the body is a Uint8Array
    writer.writeVarIntNum(body.length)
    writer.write(Array.from(body)) // Convert Uint8Array to number[]
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')(
        `[writeBodyToWriter] Body recognized as Uint8Array`,
        { length: body.length }
      )
    }
  } else if (
    headers['content-type'] === 'application/json' &&
    typeof body === 'object'
  ) {
    // If the body is JSON
    const bodyAsArray = Utils.toArray(JSON.stringify(body), 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')(`[writeBodyToWriter] Body recognized as JSON`, { body })
    }
  } else if (
    headers['content-type'] === 'application/x-www-form-urlencoded' &&
    body &&
    Object.keys(body).length > 0
  ) {
    // If the body is URL-encoded
    const parsedBody = new URLSearchParams(body).toString()
    const bodyAsArray = Utils.toArray(parsedBody, 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')(
        `[writeBodyToWriter] Body recognized as x-www-form-urlencoded`,
        { parsedBody }
      )
    }
  } else if (
    headers['content-type'] === 'text/plain' &&
    typeof body === 'string' &&
    body.length > 0
  ) {
    // If the body is plain text
    const bodyAsArray = Utils.toArray(body, 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')(
        `[writeBodyToWriter] Body recognized as text/plain`,
        { body }
      )
    }
  } else {
    // No valid body
    writer.writeVarIntNum(-1)
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')(`[writeBodyToWriter] No valid body to write`)
    }
  }
}

/**
 * Helper: Build response payload for sending back to peer
 */
function buildResponsePayload(
  requestId: string,
  responseStatus: number,
  responseHeaders: Record<string, any>,
  responseBody: number[],
  req: Request,
  logger?: typeof console,
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
): number[] {
  if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
    getLogMethod(logger, 'debug')(`[buildResponsePayload] Building response payload`, {
      requestId,
      responseStatus,
      responseHeaders,
      responseBodyLength: responseBody.length
    })
  }

  const writer = new Utils.Writer()
  writer.write(Utils.toArray(requestId, 'base64'))
  writer.writeVarIntNum(responseStatus)

  // Filter out headers that should NOT be signed:
  // - Include custom headers prefixed with x-bsv (excluding those starting with x-bsv-auth)
  // - Include the authorization header
  const includedHeaders: Array<[string, string]> = []
  Object.entries(responseHeaders).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase()
    if ((lowerKey.startsWith('x-bsv-') || lowerKey === 'authorization') && !lowerKey.startsWith('x-bsv-auth')) {
      includedHeaders.push([lowerKey, value])
    }
  })

  // Sort the headers by key to ensure a consistent order for signing and verification.
  includedHeaders.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))

  writer.writeVarIntNum(includedHeaders.length)
  for (let i = 0; i < includedHeaders.length; i++) {
    const headerKeyAsArray = Utils.toArray(includedHeaders[i][0], 'utf8')
    writer.writeVarIntNum(headerKeyAsArray.length)
    writer.write(headerKeyAsArray)

    const headerValueAsArray = Utils.toArray(includedHeaders[i][1], 'utf8')
    writer.writeVarIntNum(headerValueAsArray.length)
    writer.write(headerValueAsArray)
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
 * Helper: Convert values passed to res.send(...) into byte arrays
 */
function convertValueToArray(val: any, responseHeaders: Record<string, any>): number[] {
  if (typeof val === 'string') {
    return Utils.toArray(val, 'utf8')
  } else if (val instanceof Buffer) {
    return Array.from(val)
  } else if (typeof val === 'object') {
    if (val !== null) {
      if (!responseHeaders['content-type']) {
        responseHeaders['content-type'] = 'application/json'
      }
      return Utils.toArray(JSON.stringify(val), 'utf8')
    }
  } else if (typeof val === 'number') {
    return Utils.toArray(val.toString(), 'utf8')
  } else {
    return Utils.toArray(String(val), 'utf8')
  }
  return []
}

/**
 * Creates an Express middleware that handles authentication via BSV-SDK.
 *
 * @param {AuthMiddlewareOptions} options
 * @returns {(req: Request, res: Response, next: NextFunction) => void} Express middleware
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): (req: AuthRequest, res: Response, next: NextFunction) => void {
  const {
    wallet,
    sessionManager,
    allowUnauthenticated,
    certificatesToRequest,
    onCertificatesReceived,
    logger,
    logLevel
  } = options

  if (!wallet) {
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'error')) {
      getLogMethod(logger, 'error')(
        `[createAuthMiddleware] No wallet provided in AuthMiddlewareOptions.`
      )
    }
    throw new Error('You must configure the auth middleware with a wallet.')
  }

  // Construct transport with logging
  const transport = new ExpressTransport(allowUnauthenticated ?? false, logger, logLevel)

  const sessionMgr = sessionManager || new SessionManager()

  if (logger && logLevel && isLogLevelEnabled(logLevel, 'info')) {
    getLogMethod(logger, 'info')(
      `[createAuthMiddleware] Creating Peer with provided wallet & transport. Session Manager: ${sessionManager ? 'Custom' : 'Default'
      }`
    )
  }

  const peer = new Peer(wallet, transport, certificatesToRequest, sessionMgr)
  transport.setPeer(peer)

  // Return the express middleware
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')(`[createAuthMiddleware] Incoming request to auth middleware`, {
        path: req.path,
        headers: req.headers,
        method: req.method
      })
    }
    transport.handleIncomingRequest(req, res, next, onCertificatesReceived)
  }
}
