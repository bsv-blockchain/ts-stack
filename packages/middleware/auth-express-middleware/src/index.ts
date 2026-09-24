import { RawRequestBodyReader, RawRequestBodyError } from './rawRequestBody.js'
import { isMultipartPaymentType } from '@bsv/sdk/auth/utils/paymentTransport'
import { decodePaymentPayload } from '@bsv/sdk/auth/utils/decodePaymentPayload'
import { Reader, Writer, toArray, toBase64, toHex, toUTF8 } from '@bsv/sdk/primitives/utils'
import fs from 'node:fs'
import path from 'node:path'
import mime from 'mime-types'
import {
  Peer,
  SessionManager,
  PublicKey,
  Telemetry,
  normalizeBRC100ByteFields,
  snapshotAuthMessage,
  stringifyBRC100,
  type AsyncSessionManager,
  type AuthMessage,
  type PubKeyHex,
  type RequestedCertificateSet,
  type TelemetryConfig,
  type Transport,
  type VerifiableCertificate,
  type WalletInterface
} from '@bsv/sdk'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
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
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_AUTH_HEADER_LENGTH = 4_096
const MAX_SIGNED_RESPONSE_HEADERS = 128
const MAX_SIGNED_RESPONSE_HEADER_KEY_BYTES = 256
const MAX_SIGNED_RESPONSE_HEADER_VALUE_BYTES = 8_192
const MAX_SIGNED_RESPONSE_HEADER_BYTES = 64 * 1_024
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i

function parseTraceparent(
  value: unknown
): { traceId: string; spanId: string; traceFlags: number } | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined
  const match = TRACEPARENT_PATTERN.exec(value.trim())
  if (match == null || /^0{32}$/.test(match[1]) || /^0{16}$/.test(match[2])) {
    return undefined
  }
  return {
    traceId: match[1].toLowerCase(),
    spanId: match[2].toLowerCase(),
    traceFlags: Number.parseInt(match[3], 16)
  }
}

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
  /** Maximum bounded plain-data and encoded bytes accepted per auth request. */
  maxRequestBytes: number
  /**
   * Maximum encoded application-response bytes retained for BRC-104 signing.
   * Set to `-1` only when the embedding service enforces an equivalent bound
   * before this middleware. Defaults to 8 MiB.
   */
  maxResponseBytes: number
}

export interface AuthRequest extends Request {
  auth?: {
    identityKey: PubKeyHex
    /** Raw-byte receiver support; set only after successful mutual authentication. */
    supportsMultipart?: boolean
  }
  /** Exact authenticated application body. Payment middleware replaces this with the inner body. */
  rawBody?: Uint8Array
}

export interface CertificateApprovalStore {
  /** Persist application approval for one exact authenticated session. */
  approve: (sessionNonce: string, identityKey: PubKeyHex) => void | Promise<void>
  /** Return exact boolean true only when that session/identity pair was approved. */
  isApproved: (sessionNonce: string, identityKey: PubKeyHex) => boolean | Promise<boolean>
}

/**
 * Bounded process-local certificate approval state. Multi-instance services
 * using `onCertificatesReceived` must inject a shared store instead.
 */
export class InMemoryCertificateApprovalStore implements CertificateApprovalStore {
  private readonly approvals = new Map<string, PubKeyHex>()

  constructor(private readonly maxApprovals: number = 10_000) {
    if (!Number.isSafeInteger(maxApprovals) || maxApprovals < 1) {
      throw new RangeError('maxApprovals must be a positive safe integer.')
    }
  }

  approve(sessionNonce: string, identityKey: PubKeyHex): void {
    if (this.approvals.has(sessionNonce)) this.approvals.delete(sessionNonce)
    while (this.approvals.size >= this.maxApprovals) {
      const oldest = this.approvals.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.approvals.delete(oldest)
    }
    this.approvals.set(sessionNonce, identityKey)
  }

  isApproved(sessionNonce: string, identityKey: PubKeyHex): boolean {
    return this.approvals.get(sessionNonce) === identityKey
  }
}

// Developers may optionally provide a handler for incoming certificates.
export interface AuthMiddlewareOptions {
  wallet: WalletInterface
  /** Collect bounded raw bytes before auth. Install before any body parser. Required for BRC-118. */
  captureRawBody?: boolean
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
   * Application certificate approvals are session-bound. Required for
   * horizontally scaled services when `onCertificatesReceived` is configured;
   * the default store is bounded and process-local.
   */
  certificateApprovalStore?: CertificateApprovalStore

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

  /**
   * Optional provider-neutral authentication timing. Header values, signatures,
   * certificate contents, wallet data, and peer identities are never emitted.
   */
  telemetry?: TelemetryConfig
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

function isBoundRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase()
  return (
    normalized.startsWith('x-bsv-') ||
    normalized === 'content-type' ||
    normalized === 'authorization'
  )
}

function assertNoDuplicateBoundRequestHeaders(req: Request): void {
  const rawHeaders: unknown = req.rawHeaders
  if (!Array.isArray(rawHeaders)) return
  const seen = new Set<string>()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new AuthProtocolError('The authentication request headers are malformed.')
    }
    const normalized = name.toLowerCase()
    if (!isBoundRequestHeader(normalized)) continue
    if (seen.has(normalized)) {
      throw new AuthProtocolError('Duplicate signed authentication request header.')
    }
    seen.add(normalized)
  }
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
    const decoded = toArray(value, 'base64')
    return (
      (decodedLength === undefined || decoded.length === decodedLength) &&
      toBase64(decoded) === value
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

function assertBoundedRequestValue(value: unknown, maxBytes: number): void {
  if (maxBytes === -1) return
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0
  let bytes = 0

  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > 100_000 || current.depth > 64) {
      throw new AuthProtocolError('The authentication request exceeds structural limits.')
    }
    const candidate = current.value
    if (candidate === null || (candidate === undefined && current.depth === 0)) {
      bytes += 4
    } else if (typeof candidate === 'string') {
      bytes += Buffer.byteLength(candidate, 'utf8')
    } else if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new AuthProtocolError('The authentication request contains an ambiguous number.')
      }
      bytes += 16
    } else if (typeof candidate === 'boolean') {
      bytes += 16
    } else if (candidate instanceof Uint8Array) {
      bytes += candidate.byteLength
    } else if (typeof candidate === 'object') {
      if (seen.has(candidate)) {
        throw new AuthProtocolError('The authentication request must not contain cycles.')
      }
      seen.add(candidate)
      const prototype = Object.getPrototypeOf(candidate)
      if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
        throw new AuthProtocolError('The authentication request must contain plain data.')
      }
      if (Array.isArray(candidate) && candidate.length > 100_000) {
        throw new AuthProtocolError('The authentication request exceeds structural limits.')
      }
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, index)
          if (
            descriptor === undefined ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          ) {
            throw new AuthProtocolError(
              'The authentication request must not contain sparse arrays.'
            )
          }
        }
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        throw new AuthProtocolError('The authentication request must contain JSON-compatible data.')
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(candidate) && key === 'length') continue
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new AuthProtocolError('The authentication request must contain plain data.')
        }
        if (descriptor.enumerable !== true) {
          throw new AuthProtocolError(
            'The authentication request must contain JSON-compatible data.'
          )
        }
        if (Array.isArray(candidate) && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
          throw new AuthProtocolError(
            'The authentication request must contain JSON-compatible data.'
          )
        }
        bytes += Buffer.byteLength(key, 'utf8')
        pending.push({ value: descriptor.value, depth: current.depth + 1 })
      }
    } else {
      throw new AuthProtocolError('The authentication request must contain plain data.')
    }
    if (bytes > maxBytes) {
      throw new AuthProtocolError('The authentication request exceeds the byte limit.')
    }
  }
}

function validateGeneralAuthRequest(req: Request): string {
  assertNoDuplicateBoundRequestHeaders(req)
  const requestId = singleHeader(req, 'x-bsv-auth-request-id')!
  const version = singleHeader(req, 'x-bsv-auth-version')!
  const identityKey = singleHeader(req, 'x-bsv-auth-identity-key')!
  const nonce = singleHeader(req, 'x-bsv-auth-nonce')!
  const yourNonce = singleHeader(req, 'x-bsv-auth-your-nonce')!
  const signature = singleHeader(req, 'x-bsv-auth-signature')!
  if (!isCanonicalBase64(requestId, 32)) {
    throw new AuthProtocolError('Invalid x-bsv-auth-request-id header.')
  }
  if (version !== '0.1' || !isCompressedPublicKey(identityKey)) {
    throw new AuthProtocolError('Invalid authentication identity or version.')
  }
  if (
    !isCanonicalBase64(nonce, 32) ||
    !isCanonicalBase64(yourNonce, 48) ||
    signature.length > 2_048 ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(signature)
  ) {
    throw new AuthProtocolError('Invalid authentication nonce or signature.')
  }
  return requestId
}

function validateHandshakeMessage(
  req: Request,
  maxRequestBytes: number
): {
  message: AuthMessage
  requestId: string
} {
  assertNoDuplicateBoundRequestHeaders(req)
  const contentType = singleHeader(req, 'content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (req.method !== 'POST' || contentType !== 'application/json') {
    throw new AuthProtocolError('The BRC-104 handshake requires a JSON POST request.')
  }
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new AuthProtocolError('The BRC-104 handshake body must be an object.')
  }
  assertBoundedRequestValue(req.body, maxRequestBytes)
  const serialized = stringifyBRC100(req.body)
  if (maxRequestBytes !== -1 && Buffer.byteLength(serialized, 'utf8') > maxRequestBytes) {
    throw new AuthProtocolError('The BRC-104 handshake exceeds the byte limit.')
  }
  let message: AuthMessage
  try {
    message = snapshotAuthMessage(
      normalizeBRC100ByteFields(JSON.parse(serialized), ['payload', 'signature'])
    )
  } catch {
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
  return { message, requestId }
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  return { errorType: error instanceof Error ? 'error' : typeof error }
}

function safeOwnErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error.slice(0, 256)
  if (!(error instanceof Error)) return ''
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
    return descriptor !== undefined && typeof descriptor.value === 'string' ? descriptor.value : ''
  } catch {
    return ''
  }
}

function canWriteResponse(res: Response): boolean {
  return !res.headersSent && !res.writableEnded && !res.destroyed
}

class ResponseFileTooLargeError extends Error {
  constructor() {
    super('The response file exceeds the configured service limit.')
    this.name = 'ResponseFileTooLargeError'
  }
}

type BoundedFileReadResult = { ok: true; data: Buffer } | { ok: false; error: Error }

interface BoundedFileReadOptions {
  root?: string
  dotfiles?: 'allow' | 'deny' | 'ignore'
  start?: number
  end?: number
}

function fileAccessError(message: string, code: 'EACCES' | 'ENOENT'): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function containsDotfileSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .some(segment => segment.length > 1 && segment.startsWith('.') && segment !== '..')
}

function readFileWithinLimit(
  filePath: string,
  maxBytes: number,
  options: BoundedFileReadOptions,
  callback: (result: BoundedFileReadResult) => void
): void {
  let finished = false
  const finish = (result: BoundedFileReadResult): void => {
    if (finished) return
    finished = true
    callback(result)
  }

  const root = options.root === undefined ? undefined : path.resolve(options.root)
  const candidate = root === undefined ? path.resolve(filePath) : path.resolve(root, filePath)
  if (root !== undefined && !isWithinRoot(root, candidate)) {
    finish({
      ok: false,
      error: fileAccessError('The response file is outside the configured root.', 'EACCES')
    })
    return
  }

  const relativeForDotfileCheck = root === undefined ? filePath : path.relative(root, candidate)
  if (options.dotfiles !== 'allow' && containsDotfileSegment(relativeForDotfileCheck)) {
    const denied = options.dotfiles === 'deny'
    finish({
      ok: false,
      error: fileAccessError(
        denied ? 'Access to the response dotfile is denied.' : 'The response file was not found.',
        denied ? 'EACCES' : 'ENOENT'
      )
    })
    return
  }

  const streamResolvedFile = (resolvedCandidate: string): void => {
    const stream = fs.createReadStream(resolvedCandidate, {
      ...(options.start === undefined ? {} : { start: options.start }),
      ...(options.end === undefined ? {} : { end: options.end })
    })
    const chunks: Buffer[] = []
    let totalBytes = 0

    stream.on('data', (buffer: Buffer) => {
      if (maxBytes !== -1 && totalBytes + buffer.length > maxBytes) {
        stream.destroy()
        finish({ ok: false, error: new ResponseFileTooLargeError() })
        return
      }
      totalBytes += buffer.length
      chunks.push(buffer)
    })
    stream.once('error', error => finish({ ok: false, error }))
    stream.once('end', () => finish({ ok: true, data: Buffer.concat(chunks, totalBytes) }))
  }

  if (root === undefined) {
    streamResolvedFile(candidate)
    return
  }

  // Express's `root` option is a filesystem confinement boundary. Resolve both
  // sides before reading so a symlink inside the root cannot silently select a
  // file outside it.
  fs.realpath(root, (rootError, resolvedRoot) => {
    if (rootError != null) {
      finish({ ok: false, error: rootError })
      return
    }
    fs.realpath(candidate, (candidateError, resolvedCandidate) => {
      if (candidateError != null) {
        finish({ ok: false, error: candidateError })
        return
      }
      if (!isWithinRoot(resolvedRoot, resolvedCandidate)) {
        finish({
          ok: false,
          error: fileAccessError(
            'The response file resolves outside the configured root.',
            'EACCES'
          )
        })
        return
      }
      const resolvedRelative = path.relative(resolvedRoot, resolvedCandidate)
      if (options.dotfiles !== 'allow' && containsDotfileSegment(resolvedRelative)) {
        const denied = options.dotfiles === 'deny'
        finish({
          ok: false,
          error: fileAccessError(
            denied
              ? 'Access to the response dotfile is denied.'
              : 'The response file was not found.',
            denied ? 'EACCES' : 'ENOENT'
          )
        })
        return
      }
      streamResolvedFile(resolvedCandidate)
    })
  })
}

/**
 * ResponseWriterWrapper buffers response data until signing is complete.
 * This pattern matches the Go implementation for cleaner response handling.
 */
class ResponseWriterWrapper {
  private statusCode: number = 200
  private headers: Record<string, string> = Object.create(null) as Record<string, string>
  private body: number[] = []
  private rejected = false

  constructor(private readonly maxResponseBytes: number) {}

  status(code: number): this {
    if (this.rejected) return this
    this.statusCode = code
    return this
  }

  set(key: string | Record<string, string>, value?: string): this {
    if (this.rejected) return this
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
    this.setBody(convertValueToArray(data, this.headers))
    return this
  }

  json(data: any): this {
    if (!this.headers['content-type']) {
      this.headers['content-type'] = 'application/json'
    }
    this.setBody(toArray(stringifyBRC100(data), 'utf8'))
    return this
  }

  text(data: string): this {
    if (!this.headers['content-type']) {
      this.headers['content-type'] = 'text/plain'
    }
    this.setBody(toArray(data, 'utf8'))
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

  exceedsLimit(byteLength: number): boolean {
    return this.maxResponseBytes !== -1 && byteLength > this.maxResponseBytes
  }

  rejectTooLarge(): void {
    this.setTooLargeError()
  }

  append(body: number[]): void {
    if (this.rejected) return
    if (this.exceedsLimit(this.body.length + body.length)) {
      this.setTooLargeError()
      return
    }
    this.body = this.body.concat(body)
  }

  private setBody(body: number[]): void {
    if (this.rejected) return
    if (!this.exceedsLimit(body.length)) {
      this.body = body
      return
    }

    this.setTooLargeError()
  }

  private setTooLargeError(): void {
    if (this.rejected) return
    this.rejected = true
    this.statusCode = 413
    this.headers['content-type'] = 'application/json'
    this.body = toArray(
      JSON.stringify({
        status: 'error',
        code: 'ERR_RESPONSE_TOO_LARGE',
        description: 'The requested response exceeds the configured service limit.'
      }),
      'utf8'
    )
  }
}

function responseChunkToBytes(chunk: unknown, encoding?: unknown): number[] {
  if (typeof chunk === 'string') {
    const selectedEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
    if (!Buffer.isEncoding(selectedEncoding)) {
      throw new TypeError('The authenticated response chunk encoding is invalid.')
    }
    return Array.from(Buffer.from(chunk, selectedEncoding))
  }
  if (chunk instanceof Uint8Array) return Array.from(chunk)
  throw new TypeError('Authenticated response chunks must be strings or byte arrays.')
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
  private readonly certificateWaitKeysBySession = new Map<string, Set<string>>()

  private messageCallback?: (message: AuthMessage) => Promise<void>
  private readonly logger: typeof console | undefined
  private readonly logLevel: LogLevel
  private readonly limits: AuthTransportLimits
  private readonly certificateApprovalStore: CertificateApprovalStore
  private requireApplicationCertificateApproval = false

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
    limits: Partial<AuthTransportLimits> = {},
    certificateApprovalStore: CertificateApprovalStore = new InMemoryCertificateApprovalStore()
  ) {
    if (
      logger !== undefined &&
      (logger === null || typeof logger !== 'object' || typeof logger.log !== 'function')
    ) {
      throw new TypeError('logger must provide a log method.')
    }
    const requestTimeoutMs = limits.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const maxPendingRequests = limits.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS
    const maxRequestBytes = limits.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    const maxResponseBytes = limits.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new RangeError('requestTimeoutMs must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1) {
      throw new RangeError('maxPendingRequests must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(maxRequestBytes) || (maxRequestBytes !== -1 && maxRequestBytes < 1)) {
      throw new RangeError('maxRequestBytes must be -1 or a positive safe integer.')
    }
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      (maxResponseBytes !== -1 && maxResponseBytes < 1)
    ) {
      throw new RangeError('maxResponseBytes must be -1 or a positive safe integer.')
    }
    this.allowUnauthenticated = allowUnauthenticated
    this.logger = logger
    this.logLevel = logLevel || 'error' // Default to 'error' if not provided
    this.limits = { requestTimeoutMs, maxPendingRequests, maxRequestBytes, maxResponseBytes }
    if (
      certificateApprovalStore === null ||
      typeof certificateApprovalStore !== 'object' ||
      typeof certificateApprovalStore.approve !== 'function' ||
      typeof certificateApprovalStore.isApproved !== 'function'
    ) {
      throw new TypeError('certificateApprovalStore must provide approve and isApproved methods.')
    }
    this.certificateApprovalStore = certificateApprovalStore
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
      if (canWriteResponse(res)) {
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
    if (!canWriteResponse(res)) return
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
    const reader = new Reader(message.payload)
    const requestId = toBase64(reader.read(32))

    const handle = this.openGeneralHandles.get(requestId)
    if (handle === undefined) {
      this.log('warn', 'No response handle for this requestId')
      throw new Error('No response handle for this requestId!')
    }
    let { res, next } = handle
    this.clearOpenGeneralHandle(requestId)

    const statusCode = reader.readVarIntNumStrict(false)
    ;(res as any).__status(statusCode)

    const responseHeaders = this.readResponseHeaders(reader)
    responseHeaders['x-bsv-auth-version'] = message.version
    responseHeaders['x-bsv-auth-identity-key'] = message.identityKey
    responseHeaders['x-bsv-auth-nonce'] = message.nonce!
    responseHeaders['x-bsv-auth-your-nonce'] = message.yourNonce!
    responseHeaders['x-bsv-auth-signature'] = toHex(message.signature!)
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
    const responseBodyBytes = reader.readVarIntNumStrict()
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
  private readResponseHeaders(reader: Reader): Record<string, string> {
    const responseHeaders: Record<string, string> = {}
    const nHeaders = reader.readVarIntNumStrict(false)
    for (let i = 0; i < nHeaders; i++) {
      const nHeaderKeyBytes = reader.readVarIntNumStrict(false)
      const headerKeyBytes = reader.read(nHeaderKeyBytes)
      const headerKey = toUTF8(headerKeyBytes)
      const nHeaderValueBytes = reader.readVarIntNumStrict(false)
      const headerValueBytes = reader.read(nHeaderValueBytes)
      const headerValue = toUTF8(headerValueBytes)
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
      'x-bsv-auth-signature': toHex(message.signature!)
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
    res.send(JSON.parse(stringifyBRC100(message)))
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
    if (typeof onCertificatesReceived === 'function') {
      this.requireApplicationCertificateApproval = true
    }
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
      } else if (
        Object.keys(req.headers).some(name => name.toLowerCase().startsWith('x-bsv-auth-'))
      ) {
        throw new AuthProtocolError('Partial authentication headers are not accepted.')
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
    const { message, requestId } = validateHandshakeMessage(req, this.limits.maxRequestBytes)
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

    if (message.messageType === 'initialRequest') {
      try {
        this.registerCertificateListener(req, res, next, requestId, message, onCertificatesReceived)
      } catch (error) {
        this.removeNonGeneralHandle(requestId)
        this.clearActiveCertificateRequest(requestId)
        throw error
      }
    }

    if (this.messageCallback) {
      this.log('debug', 'Invoking stored messageCallback for non-general message')
      const messageCallback = this.messageCallback
      void Promise.resolve()
        .then(async () => await messageCallback(message))
        .catch(err => {
          this.log('error', 'Error in messageCallback', safeErrorDetails(err))
          this.removeNonGeneralHandle(requestId)
          this.clearActiveCertificateRequest(requestId)
          if (canWriteResponse(res)) {
            res.status(500).json({
              status: 'error',
              code: 'ERR_INTERNAL_SERVER_ERROR',
              description: 'Authentication processing failed.'
            })
          }
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
      async (
        senderPublicKey: string,
        certs: VerifiableCertificate[],
        sessionNonce?: string,
        peerNonce?: string
      ) => {
        if (senderPublicKey !== message.identityKey) return
        if (peerNonce !== undefined && peerNonce !== message.initialNonce) return
        this.clearActiveCertificateRequest(requestId)
        this.log('debug', 'Certificates received event triggered', {
          certCount: certs?.length
        })
        await this.handleCertificatesForPeer(
          senderPublicKey,
          certs,
          req,
          res,
          next,
          message,
          onCertificatesReceived,
          sessionNonce
        )
          .catch(error => {
            this.log('error', 'Error in certificate listener callback', safeErrorDetails(error))
            if (canWriteResponse(res)) {
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
    _next: NextFunction,
    message: AuthMessage,
    onCertificatesReceived?: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      req: AuthRequest,
      res: Response,
      next: NextFunction
    ) => void | Promise<void>,
    sessionNonce?: string
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
    const approvalScope = sessionNonce ?? message.initialNonce ?? message.identityKey
    let continued = false
    let continuationArgument: unknown
    const continueOnce = ((argument?: unknown) => {
      if (continued) return
      continued = true
      continuationArgument = argument
    }) as NextFunction
    if (typeof onCertificatesReceived === 'function') {
      await onCertificatesReceived(senderPublicKey, certs, req, res, continueOnce)
    } else {
      continueOnce()
    }
    if (!continued) return
    if (continuationArgument !== undefined) {
      this.continueCertificateWaits(approvalScope, continuationArgument)
      return
    }
    await this.certificateApprovalStore.approve(approvalScope, senderPublicKey as PubKeyHex)
    if (
      (await this.certificateApprovalStore.isApproved(
        approvalScope,
        senderPublicKey as PubKeyHex
      )) !== true
    ) {
      throw new Error('Certificate approval store did not retain the application approval.')
    }
    this.continueCertificateWaits(approvalScope)
  }

  private removeCertificateWait(sessionNonce: string, waitKey: string): void {
    const timeoutHandle = this.openNextHandlerTimeouts.get(waitKey)
    if (timeoutHandle != null) clearTimeout(timeoutHandle)
    this.openNextHandlerTimeouts.delete(waitKey)
    this.openNextHandlers.delete(waitKey)
    const waitKeys = this.certificateWaitKeysBySession.get(sessionNonce)
    waitKeys?.delete(waitKey)
    if (waitKeys?.size === 0) this.certificateWaitKeysBySession.delete(sessionNonce)
  }

  private continueCertificateWaits(sessionNonce: string, argument?: unknown): void {
    const tracked = this.certificateWaitKeysBySession.get(sessionNonce)
    // Preserve compatibility for callers that directly populated the public
    // map while middleware-created waits use unique request IDs.
    const waitKeys = tracked === undefined ? [sessionNonce] : [...tracked]
    for (const waitKey of waitKeys) {
      const nextFn = this.openNextHandlers.get(waitKey)
      this.removeCertificateWait(sessionNonce, waitKey)
      if (typeof nextFn !== 'function') continue
      if (argument === undefined) nextFn()
      else nextFn(argument)
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
    const message = buildAuthMessageFromRequest(
      req,
      this.logger,
      this.logLevel,
      this.limits.maxRequestBytes
    )
    this.log('debug', 'Received general message with x-bsv-auth-request-id')

    const listenerId = this.peer!.listenForGeneralMessages(
      (senderPublicKey: string, payload: number[]) => {
        try {
          if (senderPublicKey !== message.identityKey) return
          const requestId = toBase64(new Reader(payload).read(32))
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
      if (canWriteResponse(res)) {
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
      const messageCallback = this.messageCallback
      void Promise.resolve()
        .then(async () => await messageCallback(message))
        .catch(err => {
          this.clearActiveGeneralRequest(expectedRequestId)
          const msg = safeOwnErrorMessage(err)
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
          if (canWriteResponse(res)) {
            res.status(statusCode).json({ status: 'error', code, description })
          }
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
    const sessionNonce = singleHeader(req, 'x-bsv-auth-your-nonce') as string

    const wrapper = new ResponseWriterWrapper(this.limits.maxResponseBytes)
    let responseSent = false

    const buildAndSendResponse = async (): Promise<void> => {
      if (responseSent) return
      responseSent = true
      try {
        this.captureNativeResponseState(res, wrapper)
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
        // Resolve the session by the nonce the client echoed, not by identity
        // key: `getSession` returns a peer's most recently updated session for
        // an identity key, which need not be the session this request arrived
        // on.
        await this.peer.toPeer(responsePayload, sessionNonce)
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
      buildAndSendResponse,
      requestId,
      sessionNonce
    ).catch(next)
  }

  private captureNativeResponseState(res: Response, wrapper: ResponseWriterWrapper): void {
    if (Number.isSafeInteger(res.statusCode) && res.statusCode >= 200 && res.statusCode <= 599) {
      wrapper.status(res.statusCode)
    }
    const getHeaders: unknown = (res as unknown as { getHeaders?: unknown }).getHeaders
    if (typeof getHeaders !== 'function') return
    const headers: unknown = Reflect.apply(getHeaders, res, [])
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      wrapper.set(name, Array.isArray(value) ? value.join(', ') : String(value))
    }
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
      ;(res as any).__status.call(res, n)
      wrapper.status(n)
      return res
    }

    ;(res as any).__set = res.set
    ;(res as any).set = (keyOrHeaders: string | Record<string, string>, value?: string) => {
      // Express distinguishes set(object) from set(name, value) by argument
      // count. Passing an explicit undefined breaks the object overload.
      if (typeof keyOrHeaders === 'string') (res as any).__set.call(res, keyOrHeaders, value)
      else (res as any).__set.call(res, keyOrHeaders)
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
    ;(res as any).end = (chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      let selectedEncoding = encodingOrCallback
      let selectedCallback = callback
      if (typeof chunk === 'function') {
        selectedCallback = chunk
        chunk = undefined
        selectedEncoding = undefined
      } else if (typeof encodingOrCallback === 'function') {
        selectedCallback = encodingOrCallback
        selectedEncoding = undefined
      }
      if (chunk !== undefined && chunk !== null) {
        wrapper.append(responseChunkToBytes(chunk, selectedEncoding))
      }
      void buildAndSendResponse().then(() => {
        if (typeof selectedCallback === 'function') selectedCallback()
      })
      return res
    }

    ;(res as any).__write = res.write
    ;(res as any).write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      const selectedEncoding =
        typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
      const selectedCallback =
        typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      wrapper.append(responseChunkToBytes(chunk, selectedEncoding))
      if (typeof selectedCallback === 'function') selectedCallback()
      return true
    }

    ;(res as any).__writeHead = res.writeHead
    ;(res as any).writeHead = (
      statusCode: number,
      statusMessageOrHeaders?: unknown,
      possibleHeaders?: unknown
    ) => {
      res.status(statusCode)
      const headers =
        statusMessageOrHeaders !== null && typeof statusMessageOrHeaders === 'object'
          ? statusMessageOrHeaders
          : possibleHeaders
      if (Array.isArray(headers)) {
        for (let index = 0; index < headers.length; index += 2) {
          const name = headers[index]
          const value = headers[index + 1]
          if (typeof name !== 'string' || value === undefined) {
            throw new TypeError('Authenticated response writeHead headers are malformed.')
          }
          res.set(name, String(value))
        }
      } else if (headers !== null && typeof headers === 'object') {
        for (const [name, value] of Object.entries(headers)) {
          if (value !== undefined)
            res.set(name, Array.isArray(value) ? value.join(', ') : String(value))
        }
      }
      return res
    }

    ;(res as any).__flushHeaders = res.flushHeaders
    ;(res as any).flushHeaders = () => undefined

    ;(res as any).__sendFile = res.sendFile
    ;(res as any).sendFile = (
      filePath: string,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void
    ) => {
      const errorCallback =
        typeof optionsOrCallback === 'function'
          ? (optionsOrCallback as (error?: Error) => void)
          : callback
      const rawOptions =
        optionsOrCallback !== null && typeof optionsOrCallback === 'object'
          ? (optionsOrCallback as Record<string, unknown>)
          : {}

      try {
        if (typeof filePath !== 'string' || filePath.length === 0) {
          throw new TypeError('path argument is required to res.sendFile')
        }
        if (rawOptions.root === undefined && !path.isAbsolute(filePath)) {
          throw new TypeError('path must be absolute or specify root to res.sendFile')
        }
        if (rawOptions.root !== undefined && typeof rawOptions.root !== 'string') {
          throw new TypeError('sendFile root must be a string')
        }
        if (
          rawOptions.dotfiles !== undefined &&
          rawOptions.dotfiles !== 'allow' &&
          rawOptions.dotfiles !== 'deny' &&
          rawOptions.dotfiles !== 'ignore'
        ) {
          throw new TypeError('sendFile dotfiles must be allow, deny, or ignore')
        }
        for (const rangeName of ['start', 'end'] as const) {
          const value = rawOptions[rangeName]
          if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
            throw new RangeError(`sendFile ${rangeName} must be a non-negative safe integer`)
          }
        }
        if (
          typeof rawOptions.start === 'number' &&
          typeof rawOptions.end === 'number' &&
          rawOptions.end < rawOptions.start
        ) {
          throw new RangeError('sendFile end must not be before start')
        }
        if (rawOptions.headers !== undefined) {
          if (
            rawOptions.headers === null ||
            typeof rawOptions.headers !== 'object' ||
            Array.isArray(rawOptions.headers)
          ) {
            throw new TypeError('sendFile headers must be an object')
          }
          for (const [name, value] of Object.entries(rawOptions.headers)) {
            if (value !== undefined) wrapper.set(name, String(value))
          }
        }
      } catch (error) {
        const reported = error instanceof Error ? error : new Error('Invalid sendFile options.')
        if (errorCallback != null) errorCallback(reported)
        else next(reported)
        return res
      }

      readFileWithinLimit(
        filePath,
        this.limits.maxResponseBytes,
        {
          ...(typeof rawOptions.root === 'string' ? { root: rawOptions.root } : {}),
          ...(rawOptions.dotfiles === 'allow' ||
          rawOptions.dotfiles === 'deny' ||
          rawOptions.dotfiles === 'ignore'
            ? { dotfiles: rawOptions.dotfiles }
            : {}),
          ...(typeof rawOptions.start === 'number' ? { start: rawOptions.start } : {}),
          ...(typeof rawOptions.end === 'number' ? { end: rawOptions.end } : {})
        },
        result => {
          if (!result.ok) {
            if (result.error instanceof ResponseFileTooLargeError) {
              wrapper.rejectTooLarge()
              void buildAndSendResponse().then(() => errorCallback?.())
              return
            }
            this.log('error', 'Error reading file in sendFile', safeErrorDetails(result.error))
            if (errorCallback != null) errorCallback(result.error)
            else {
              wrapper.status(500)
              void buildAndSendResponse()
            }
            return
          }

          const mimeType = mime.lookup(filePath) || 'application/octet-stream'
          wrapper.set('Content-Type', mimeType)
          wrapper.send(result.data)
          void buildAndSendResponse().then(() => errorCallback?.())
        }
      )
      return res
    }
  }

  /**
   * Either calls next() immediately or stores it pending certificate arrival.
   */
  private async scheduleNextOrCertificateWait(
    next: NextFunction,
    senderPublicKey: string,
    wrapper: ResponseWriterWrapper,
    buildAndSendResponse: () => Promise<void>,
    requestId: string = senderPublicKey,
    sessionNonce: string = senderPublicKey
  ): Promise<void> {
    const needsCertificates = this.peer?.certificatesToRequest?.certifiers?.length
    this.log('debug', 'Checking if we need to wait for certificates', {
      needsCertificates,
      requiresApplicationApproval: this.requireApplicationCertificateApproval
    })

    if (!needsCertificates || !this.requireApplicationCertificateApproval) {
      this.log('debug', 'Calling next() immediately - no application certificate wait needed')
      next()
      return
    }

    if (
      (await this.certificateApprovalStore.isApproved(
        sessionNonce,
        senderPublicKey as PubKeyHex
      )) === true
    ) {
      next()
      return
    }

    this.log('debug', 'Storing next handler to wait for certificates')
    const waitKey = requestId
    const existingTimeout = this.openNextHandlerTimeouts.get(waitKey)
    if (existingTimeout != null) {
      clearTimeout(existingTimeout)
      this.openNextHandlerTimeouts.delete(waitKey)
    }
    this.openNextHandlers.set(waitKey, next)
    let waitKeys = this.certificateWaitKeysBySession.get(sessionNonce)
    if (waitKeys === undefined) {
      waitKeys = new Set()
      this.certificateWaitKeysBySession.set(sessionNonce, waitKeys)
    }
    waitKeys.add(waitKey)

    const timeoutHandle = setTimeout(() => {
      if (this.openNextHandlers.has(waitKey)) {
        this.log('warn', 'Certificate request timed out')
        this.removeCertificateWait(sessionNonce, waitKey)
        wrapper.status(408).json({
          status: 'error',
          code: 'CERTIFICATE_TIMEOUT',
          message: 'Certificate request timed out'
        })
        buildAndSendResponse()
      }
    }, this.limits.requestTimeoutMs)
    timeoutHandle.unref?.()
    this.openNextHandlerTimeouts.set(waitKey, timeoutHandle)
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
        typeof res.__write === 'function' ||
        typeof res.__writeHead === 'function' ||
        typeof res.__flushHeaders === 'function' ||
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
      typeof res.__write !== 'function' ||
      typeof res.__writeHead !== 'function' ||
      typeof res.__flushHeaders !== 'function' ||
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
    res.write = (res as any).__write
    res.writeHead = (res as any).__writeHead
    res.flushHeaders = (res as any).__flushHeaders
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
  logLevel?: LogLevel,
  maxRequestBytes: number = DEFAULT_MAX_REQUEST_BYTES
): AuthMessage {
  const debugLog = makeDebugLogger(logger, logLevel)
  debugLog('[buildAuthMessageFromRequest] Building message from request...', {
    pathLength: req.path.length,
    method: req.method
  })

  if (!/^[A-Z!#$%&'*+.^_`|~-]{1,32}$/u.test(req.method)) {
    throw new AuthProtocolError('The authenticated request method is invalid.')
  }
  assertBoundedRequestValue(req.body, maxRequestBytes)

  const writer = new Writer()
  const requestNonce = singleHeader(req, 'x-bsv-auth-request-id')!
  const requestNonceBytes = toArray(requestNonce, 'base64')
  writer.write(requestNonceBytes)
  writer.writeVarIntNum(req.method.length)
  writer.write(toArray(req.method))

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

  try {
    writeUrlToWriter(parsedUrl, writer)
    writeRequestHeadersToWriter(req, writer)
    writeBodyToWriter(req, writer, logger, logLevel)
  } catch {
    throw new AuthProtocolError('The authenticated request cannot be represented canonically.')
  }

  const authMessage = {
    messageType: 'general' as const,
    version: singleHeader(req, 'x-bsv-auth-version')!,
    identityKey: singleHeader(req, 'x-bsv-auth-identity-key')!,
    nonce: singleHeader(req, 'x-bsv-auth-nonce')!,
    yourNonce: singleHeader(req, 'x-bsv-auth-your-nonce')!,
    payload: writer.toArray(),
    signature: toArray(singleHeader(req, 'x-bsv-auth-signature')!, 'hex')
  }

  if (maxRequestBytes !== -1 && authMessage.payload.length > maxRequestBytes) {
    throw new AuthProtocolError('The authenticated request exceeds the byte limit.')
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

  const writer = new Writer()
  writer.write(toArray(requestId, 'base64'))
  writer.writeVarIntNum(responseStatus)

  // Filter out headers that should NOT be signed:
  // - Include custom headers prefixed with x-bsv (excluding those starting with x-bsv-auth)
  // - Include the authorization header
  const includedHeaders: Array<[string, string]> = []
  let includedHeaderBytes = 0
  Object.entries(responseHeaders).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase()
    if (
      (lowerKey.startsWith('x-bsv-') || lowerKey === 'authorization') &&
      !lowerKey.startsWith('x-bsv-auth')
    ) {
      const headerValue = String(value)
      const keyBytes = toArray(lowerKey, 'utf8').length
      const valueBytes = toArray(headerValue, 'utf8').length
      includedHeaderBytes += keyBytes + valueBytes
      if (
        keyBytes < 1 ||
        keyBytes > MAX_SIGNED_RESPONSE_HEADER_KEY_BYTES ||
        valueBytes > MAX_SIGNED_RESPONSE_HEADER_VALUE_BYTES ||
        includedHeaders.length >= MAX_SIGNED_RESPONSE_HEADERS ||
        includedHeaderBytes > MAX_SIGNED_RESPONSE_HEADER_BYTES ||
        containsUnsafeHeaderCharacter(headerValue)
      ) {
        throw new AuthProtocolError('The authenticated response headers exceed their limits.')
      }
      includedHeaders.push([lowerKey, headerValue])
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

function validateAuthMiddlewareSettings(options: AuthMiddlewareOptions): void {
  const { allowUnauthenticated, logLevel, onCertificatesReceived } = options
  if (allowUnauthenticated !== undefined && typeof allowUnauthenticated !== 'boolean') {
    throw new TypeError('allowUnauthenticated must be a boolean.')
  }
  if (options.captureRawBody !== undefined && typeof options.captureRawBody !== 'boolean') {
    throw new TypeError('captureRawBody must be a boolean.')
  }
  if (logLevel !== undefined && !(['debug', 'info', 'warn', 'error'] as const).includes(logLevel)) {
    throw new TypeError('logLevel must be debug, info, warn, or error.')
  }
  if (onCertificatesReceived !== undefined && typeof onCertificatesReceived !== 'function') {
    throw new TypeError('onCertificatesReceived must be a function.')
  }
}

/**
 * Creates an Express middleware that handles authentication via BSV-SDK.
 *
 * @param {AuthMiddlewareOptions} options
 * @returns {(req: Request, res: Response, next: NextFunction) => void} Express middleware
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): RequestHandler {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Auth middleware options are required.')
  }
  const {
    wallet,
    sessionManager,
    allowUnauthenticated,
    certificatesToRequest,
    onCertificatesReceived,
    certificateApprovalStore,
    logger,
    logLevel,
    transportLimits,
    telemetry: telemetryConfig
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
  validateAuthMiddlewareSettings(options)

  const transport = new ExpressTransport(
    allowUnauthenticated ?? false,
    logger,
    logLevel,
    transportLimits,
    certificateApprovalStore
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
  const telemetry = new Telemetry(telemetryConfig)

  const rawReader =
    options.captureRawBody === true
      ? new RawRequestBodyReader(
          transportLimits?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
          transportLimits?.requestTimeoutMs ?? 30_000,
          transportLimits?.maxPendingRequests ?? 1_000
        )
      : undefined
  const dispatch = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (rawReader !== undefined) {
        await rawReader.capture(req, res)
        if (req.path === WELL_KNOWN_AUTH_PATH) {
          req.body = decodePaymentPayload(req.body, 'application/json')
        }
      }
      const verifiedNext: NextFunction = (error?: unknown): void => {
        if (error !== undefined) {
          next(error)
          return
        }
        if (rawReader?.hasCaptured(req) === true && req.path !== WELL_KNOWN_AUTH_PATH) {
          if (req.auth !== undefined && req.auth.identityKey !== 'unknown')
            req.auth.supportsMultipart = true
          req.rawBody = req.body
          const contentType = req.headers['content-type']
          if (typeof contentType !== 'string' || !isMultipartPaymentType(contentType)) {
            try {
              req.body = decodePaymentPayload(req.rawBody, contentType)
            } catch {
              res.status(400).json({
                status: 'error',
                code: 'ERR_AUTH_MALFORMED',
                description: 'Invalid authenticated application body.'
              })
              return
            }
          }
        }
        next()
      }
      await transport.handleIncomingRequest(req, res, verifiedNext, onCertificatesReceived)
    } catch (error) {
      if (error instanceof RawRequestBodyError && !res.headersSent && !res.destroyed) {
        res.setHeader('Connection', 'close')
        res.status(error.status).json({
          status: 'error',
          code: 'ERR_AUTH_BODY',
          description: 'The request body could not be accepted.'
        })
      } else throw error
    }
  }

  return (req, res, next) => {
    if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
      getLogMethod(logger, 'debug')('[createAuthMiddleware] Incoming request to auth middleware', {
        pathLength: req.path.length,
        method: req.method,
        hasAuthRequestId: typeof req.headers['x-bsv-auth-request-id'] === 'string'
      })
    }
    if (!telemetry.enabled) {
      void dispatch(req, res, next).catch(next)
      return
    }

    const parent = telemetry.contextFor(req) ?? parseTraceparent(req.headers.traceparent)
    const span = telemetry.startSpan('wallet.auth.middleware', {
      component: 'auth-express-middleware',
      kind: 'server',
      parent,
      carrier: req,
      attributes: {
        'http.request.method': req.method,
        'auth.handshake': req.path === WELL_KNOWN_AUTH_PATH,
        'auth.signed_request': typeof req.headers['x-bsv-auth-request-id'] === 'string'
      }
    })
    span.bind(req)
    let ended = false
    const end = (
      status: 'ok' | 'error' | 'cancelled',
      error?: unknown,
      disposition?: string
    ): void => {
      if (ended) return
      ended = true
      span.end({
        status,
        error,
        attributes: {
          ...(disposition == null ? {} : { 'auth.disposition': disposition }),
          ...(res.statusCode > 0 ? { 'http.response.status_code': res.statusCode } : {})
        }
      })
    }
    const tracedNext = ((argument?: unknown) => {
      end(argument instanceof Error ? 'error' : 'ok', argument, 'continued')
      if (argument === undefined) next()
      else next(argument)
    }) as NextFunction

    res.once('finish', () => {
      end(res.statusCode >= 500 ? 'error' : 'ok', undefined, 'responded')
    })
    res.once('close', () => {
      end(res.writableEnded ? 'ok' : 'cancelled', undefined, 'connection_closed')
    })

    void dispatch(req, res, tracedNext).catch(error => {
      end('error', error, 'middleware_error')
      next(error)
    })
  }
}
