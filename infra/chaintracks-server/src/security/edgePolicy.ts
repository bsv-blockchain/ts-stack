// Synchronized by scripts/sync-service-edge-policy.mjs. Edit
// infra/wab/src/security/edgePolicy.ts, then run the sync command.
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Server } from 'node:http'

const MAX_BODY_BYTES = 512 * 1024 * 1024
const MAX_CONCURRENT_REQUESTS = 100_000
const MAX_REQUEST_TIMEOUT_MS = 60 * 60 * 1000

const DEFAULT_ALLOWED_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'If-None-Match',
  'X-BSV-Action-Batch-Encoding',
  'X-BSV-Auth-Identity-Key',
  'X-BSV-Auth-Message-Type',
  'X-BSV-Auth-Nonce',
  'X-BSV-Auth-Request-ID',
  'X-BSV-Auth-Requested-Certificates',
  'X-BSV-Auth-Signature',
  'X-BSV-Auth-Version',
  'X-BSV-Auth-Your-Nonce',
  'X-BSV-Binary-Encoding',
  'X-BSV-Binary-Request-Encoding',
  'X-BSV-Payment',
  'X-BSV-Topic',
  'X-Aggregation',
  'X-Callback-Token',
  'X-Includes-Off-Chain-Values',
  'X-Topics'
]

const DEFAULT_EXPOSED_HEADERS = [
  'ETag',
  'RateLimit',
  'RateLimit-Policy',
  'Retry-After',
  'X-BSV-Auth-Identity-Key',
  'X-BSV-Auth-Message-Type',
  'X-BSV-Auth-Nonce',
  'X-BSV-Auth-Request-ID',
  'X-BSV-Auth-Requested-Certificates',
  'X-BSV-Auth-Signature',
  'X-BSV-Auth-Version',
  'X-BSV-Auth-Your-Nonce',
  'X-BSV-Binary-Encoding',
  'X-BSV-Payment-Derivation-Prefix',
  'X-BSV-Payment-Satoshis-Paid',
  'X-BSV-Payment-Satoshis-Required',
  'X-BSV-Payment-Version'
]

export interface CorsPolicyOptions {
  environmentPrefix: string
  methods: string[]
  allowedOrigins?: string[]
  defaultMode?: CorsMode
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  allowCredentials?: boolean
  maxAgeSeconds?: number
}

export type CorsMode = 'public' | 'allowlist' | 'disabled'

export interface SecurityHeadersOptions {
  environmentPrefix?: string
  contentSecurityPolicy?: string | false
  crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin' | false
  crossOriginOpenerPolicy?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  permissionsPolicy?: string | false
  strictTransportSecurity?: boolean
}

export interface HttpServerPolicyDefaults {
  requestTimeoutMs: number
  headersTimeoutMs: number
  keepAliveTimeoutMs: number
  socketTimeoutMs: number
  maxRequestsPerSocket: number
  /** Open TCP/WebSocket connections retained by one process. Default: 1,000. */
  maxConnections?: number
}

export type ResourceProfileName = 'small' | 'standard' | 'high-throughput'

export interface ResourceProfileValues {
  small: number
  standard: number
  highThroughput: number
}

function readPositiveInteger(name: string, fallback: number, maximum: number): number {
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}`)
  }
  return parsed
}

/**
 * Reads an operator resource limit. `-1` and `unlimited` are explicit opt-outs;
 * omitting the setting always retains the service's tested safe default.
 */
export function readResourceLimit(
  environmentPrefix: string,
  suffix: string,
  fallback: number,
  maximum: number = Number.MAX_SAFE_INTEGER
): number {
  const name = `${environmentPrefix}_${suffix}`
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === '-1' || normalized === 'unlimited') return -1
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be -1, unlimited, or a positive integer`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}`)
  }
  return parsed
}

export function readResourceProfile(
  environmentPrefix: string,
  fallback: ResourceProfileName = 'standard'
): ResourceProfileName {
  const prefixed = process.env[`${environmentPrefix}_RESOURCE_PROFILE`]
  const value =
    (prefixed == null || prefixed.trim() === '' ? process.env.RESOURCE_PROFILE : prefixed)
      ?.trim()
      .toLowerCase() ?? fallback
  if (!['small', 'standard', 'high-throughput'].includes(value)) {
    throw new Error(
      `${environmentPrefix}_RESOURCE_PROFILE must be small, standard, or high-throughput`
    )
  }
  return value as ResourceProfileName
}

export function profileValue(profile: ResourceProfileName, values: ResourceProfileValues): number {
  if (profile === 'small') return values.small
  if (profile === 'high-throughput') return values.highThroughput
  return values.standard
}

function readCsv(name: string, fallback: string[] = []): string[] {
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  const values = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (values.includes('*')) {
    throw new Error(`${name} must contain explicit values; wildcard "*" is not allowed`)
  }
  return [...new Set(values)]
}

function normalizeOrigin(origin: string, name: string): string {
  if (origin === 'null') throw new Error(`${name} must not contain the opaque "null" origin`)
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`${name} contains an invalid origin: ${origin}`)
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `${name} must contain HTTP(S) origins without paths, credentials, queries, or fragments`
    )
  }
  return parsed.origin
}

export function readAllowedOrigins(environmentPrefix: string): string[] {
  const originVariable = `${environmentPrefix}_CORS_ALLOWED_ORIGINS`
  const prefixedValue = process.env[originVariable]
  const sourceVariable =
    prefixedValue != null && prefixedValue.trim() !== '' ? originVariable : 'CORS_ALLOWED_ORIGINS'
  return readCsv(sourceVariable).map(origin => normalizeOrigin(origin, sourceVariable))
}

function resolveCorsPolicy(
  environmentPrefix: string,
  configuredOrigins: string[] | undefined,
  defaultMode: CorsMode
): { mode: CorsMode; origins: string[] } {
  const originVariable = `${environmentPrefix}_CORS_ALLOWED_ORIGINS`
  if (configuredOrigins !== undefined) {
    const origins = configuredOrigins.map(origin => normalizeOrigin(origin, originVariable))
    return {
      mode: origins.length > 0 ? 'allowlist' : 'disabled',
      origins
    }
  }

  const origins = readAllowedOrigins(environmentPrefix)
  const prefixedMode = process.env[`${environmentPrefix}_CORS_MODE`]?.trim()
  const rawMode = (
    prefixedMode !== undefined && prefixedMode !== '' ? prefixedMode : (process.env.CORS_MODE ?? '')
  )
    .trim()
    .toLowerCase()
  let mode: string = rawMode
  if (mode === '') {
    mode = origins.length > 0 ? 'allowlist' : defaultMode
  }
  if (!['public', 'allowlist', 'disabled'].includes(mode)) {
    throw new Error(`${environmentPrefix}_CORS_MODE must be public, allowlist, or disabled`)
  }
  if (mode === 'allowlist' && origins.length === 0) {
    throw new Error(`${originVariable} must list at least one exact origin in allowlist mode`)
  }
  if ((mode === 'public' || mode === 'disabled') && origins.length > 0) {
    throw new Error(`${originVariable} must be empty when CORS mode is ${mode}`)
  }
  return { mode: mode as CorsMode, origins }
}

/**
 * Socket.IO and similar transports can consume the same public/allowlist/
 * disabled policy as the HTTP middleware.
 */
export function readCorsOriginSetting(
  environmentPrefix: string,
  defaultMode: CorsMode = 'public'
): '*' | string[] {
  const policy = resolveCorsPolicy(environmentPrefix, undefined, defaultMode)
  if (policy.mode === 'public') return '*'
  if (policy.mode === 'disabled') return []
  return policy.origins
}

function appendVary(res: Response, value: string): void {
  const current = res.getHeader('Vary')
  const values = new Set(
    (Array.isArray(current) ? current.join(',') : String(current ?? ''))
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  )
  values.add(value)
  res.setHeader('Vary', [...values].join(', '))
}

/**
 * Public protocol services accept browser origins by default and return
 * Access-Control-Allow-Origin: * without cookie credentials. Operators can
 * opt into an exact allowlist or disable cross-origin browser calls with
 * <PREFIX>_CORS_MODE.
 */
export function corsPolicy(options: CorsPolicyOptions): RequestHandler {
  const policy = resolveCorsPolicy(
    options.environmentPrefix,
    options.allowedOrigins,
    options.defaultMode ?? 'public'
  )
  if (policy.mode === 'public' && options.allowCredentials === true) {
    throw new Error('Public CORS mode cannot be combined with cookie credentials')
  }
  const allowedHeaders = readCsv(
    `${options.environmentPrefix}_CORS_ALLOWED_HEADERS`,
    options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS
  )
  const exposedHeaders = readCsv(
    `${options.environmentPrefix}_CORS_EXPOSED_HEADERS`,
    options.exposedHeaders ?? DEFAULT_EXPOSED_HEADERS
  )
  const methods = [...new Set(options.methods.map(method => method.toUpperCase()))]
  const maxAgeSeconds = options.maxAgeSeconds ?? 600

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin')
    if (origin == null || origin === '') {
      next()
      return
    }

    // Public mode never reflects the caller-controlled origin and therefore
    // does not need to parse it. This deliberately preserves browser access
    // from opaque origins such as sandboxed documents, file-based apps, and
    // mobile webviews, which send `Origin: null` and are covered by `*`.
    if (policy.mode === 'public') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '))
      res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(', '))
      res.setHeader('Access-Control-Max-Age', String(maxAgeSeconds))
      if (req.method === 'OPTIONS') {
        res.sendStatus(204)
        return
      }
      next()
      return
    }

    let normalizedOrigin: string
    try {
      normalizedOrigin = normalizeOrigin(origin, 'Origin')
    } catch {
      res.status(403).json({
        status: 'error',
        code: 'ERR_ORIGIN_NOT_ALLOWED',
        description: 'The request origin is not allowed.'
      })
      return
    }

    // Select the response value from trusted configuration, never from the
    // request header. The normalized request origin is only a lookup key.
    const configuredOrigin = policy.origins.find(
      allowedOrigin => allowedOrigin === normalizedOrigin
    )
    if (policy.mode === 'disabled' || configuredOrigin == null) {
      res.status(403).json({
        status: 'error',
        code: 'ERR_ORIGIN_NOT_ALLOWED',
        description: 'The request origin is not allowed.'
      })
      return
    }

    appendVary(res, 'Origin')
    res.setHeader('Access-Control-Allow-Origin', configuredOrigin)
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '))
    res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(', '))
    res.setHeader('Access-Control-Max-Age', String(maxAgeSeconds))
    if (options.allowCredentials === true) {
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  }
}

function readHeaderSetting(
  environmentPrefix: string | undefined,
  suffix: string
): string | undefined {
  if (environmentPrefix == null || environmentPrefix === '') return undefined
  const name = `${environmentPrefix}_${suffix}`
  const value = process.env[name]
  if (value == null || value.trim() === '') return undefined
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single-line header value`)
  return value.trim()
}

function readOptionalHeader(
  environmentPrefix: string | undefined,
  suffix: string,
  allowedValues?: string[]
): string | false | undefined {
  const value = readHeaderSetting(environmentPrefix, suffix)
  if (value == null) return undefined
  if (value.toLowerCase() === 'disabled') return false
  if (allowedValues != null && !allowedValues.includes(value)) {
    throw new Error(
      `${environmentPrefix ?? 'SERVICE'}_${suffix} must be ${allowedValues.join(', ')}, or disabled`
    )
  }
  return value
}

function readOptionalBoolean(
  environmentPrefix: string | undefined,
  suffix: string
): boolean | undefined {
  const value = readHeaderSetting(environmentPrefix, suffix)
  if (value == null) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${environmentPrefix ?? 'SERVICE'}_${suffix} must be true or false`)
}

export function securityHeaders(options: SecurityHeadersOptions = {}): RequestHandler {
  const contentSecurityPolicy =
    readOptionalHeader(options.environmentPrefix, 'CONTENT_SECURITY_POLICY') ??
    options.contentSecurityPolicy ??
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  const crossOriginResourcePolicy =
    readOptionalHeader(options.environmentPrefix, 'CROSS_ORIGIN_RESOURCE_POLICY', [
      'same-origin',
      'same-site',
      'cross-origin'
    ]) ??
    options.crossOriginResourcePolicy ??
    'cross-origin'
  const crossOriginOpenerPolicy =
    readOptionalHeader(options.environmentPrefix, 'CROSS_ORIGIN_OPENER_POLICY', [
      'same-origin',
      'same-origin-allow-popups',
      'unsafe-none'
    ]) ??
    options.crossOriginOpenerPolicy ??
    'same-origin'
  const frameOptions =
    readOptionalHeader(options.environmentPrefix, 'FRAME_OPTIONS', ['DENY', 'SAMEORIGIN']) ??
    options.frameOptions ??
    'DENY'
  const permissionsPolicy =
    readOptionalHeader(options.environmentPrefix, 'PERMISSIONS_POLICY') ??
    options.permissionsPolicy ??
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()'
  const strictTransportSecurity =
    readOptionalBoolean(options.environmentPrefix, 'STRICT_TRANSPORT_SECURITY') ??
    options.strictTransportSecurity ??
    true

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (frameOptions !== false) {
      res.setHeader('X-Frame-Options', frameOptions)
    }
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (permissionsPolicy !== false) {
      res.setHeader('Permissions-Policy', permissionsPolicy)
    }
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')
    if (crossOriginOpenerPolicy !== false) {
      res.setHeader('Cross-Origin-Opener-Policy', crossOriginOpenerPolicy)
    }
    if (crossOriginResourcePolicy !== false) {
      res.setHeader('Cross-Origin-Resource-Policy', crossOriginResourcePolicy)
    }
    if (contentSecurityPolicy !== false) {
      res.setHeader('Content-Security-Policy', contentSecurityPolicy)
    }
    if (strictTransportSecurity && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    next()
  }
}

export function readBodyLimitBytes(
  environmentPrefix: string,
  fallback: number,
  maximum: number = MAX_BODY_BYTES
): number {
  const limit = readResourceLimit(environmentPrefix, 'MAX_BODY_BYTES', fallback, maximum)
  // raw-body/body-parser interpret negative numbers as a zero-ish ceiling.
  // A deliberately unlimited operator setting therefore maps to the largest
  // exactly representable byte count accepted by those APIs.
  return limit === -1 ? Number.MAX_SAFE_INTEGER : limit
}

/**
 * Preserve compatibility with clients that accidentally emit two or more
 * initial slashes. Only the initial slash run is normalized; the remainder of
 * the path and query string is unchanged.
 */
export function initialDoubleSlashCompatibility(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (req.url.startsWith('//')) req.url = req.url.replace(/^\/{2,}/, '/')
  next()
}

/**
 * Bounds materialized JSON/text/binary Express responses before downstream
 * authentication middleware signs or serializes them again. Streaming
 * endpoints must enforce their own byte budget while producing chunks.
 */
export function responseSizeLimit(
  environmentPrefix: string,
  fallback: number,
  maximum: number = MAX_BODY_BYTES
): RequestHandler {
  const limit = readResourceLimit(environmentPrefix, 'MAX_RESPONSE_BYTES', fallback, maximum)
  if (limit === -1) return (_req, _res, next) => next()

  return (_req: Request, res: Response, next: NextFunction): void => {
    const originalStatus = res.status.bind(res)
    const originalJson = res.json.bind(res)
    const originalSend = res.send.bind(res)
    const originalEnd = res.end.bind(res)
    let rejected = false
    let rejecting = false

    const tooLarge = (byteLength: number): boolean => byteLength > limit
    const reject = (): Response => {
      if (rejected) return res
      rejected = true
      rejecting = true
      originalStatus(413)
      const response = originalJson({
        status: 'error',
        code: 'ERR_RESPONSE_TOO_LARGE',
        description: 'The requested response exceeds the configured service limit.'
      })
      rejecting = false
      return response
    }

    res.json = ((value: unknown): Response => {
      if (rejecting) return originalJson(value)
      if (rejected) return res
      const serialized = JSON.stringify(value) ?? ''
      if (tooLarge(Buffer.byteLength(serialized, 'utf8'))) return reject()
      return originalJson(value)
    }) as Response['json']

    res.send = ((value: unknown): Response => {
      if (rejecting) return originalSend(value as never)
      if (rejected) return res
      let byteLength: number
      if (typeof value === 'string') byteLength = Buffer.byteLength(value, 'utf8')
      else if (Buffer.isBuffer(value) || value instanceof Uint8Array) byteLength = value.byteLength
      else byteLength = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
      if (tooLarge(byteLength)) return reject()
      return originalSend(value as never)
    }) as Response['send']

    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown): Response => {
      if (rejecting) {
        return originalEnd(
          chunk as never,
          encoding as never,
          callback as never
        ) as unknown as Response
      }
      if (rejected) return res
      if (chunk != null) {
        const byteLength =
          typeof chunk === 'string'
            ? Buffer.byteLength(
                chunk,
                typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
              )
            : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
              ? chunk.byteLength
              : Buffer.byteLength(String(chunk), 'utf8')
        if (tooLarge(byteLength)) return reject()
      }
      return originalEnd(
        chunk as never,
        encoding as never,
        callback as never
      ) as unknown as Response
    }) as Response['end']

    next()
  }
}

/**
 * Convert body-parser/Express parser failures into stable, non-sensitive
 * protocol errors. Install immediately after all body parsers.
 */
export function bodyParserErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  const parserError = error as {
    status?: number
    statusCode?: number
    type?: string
  }
  if (
    parserError?.type === 'entity.too.large' ||
    parserError?.status === 413 ||
    parserError?.statusCode === 413
  ) {
    res.status(413).json({
      status: 'error',
      code: 'ERR_BODY_TOO_LARGE',
      description: 'The request body exceeds the endpoint limit.'
    })
    return
  }
  if (
    parserError?.type === 'entity.parse.failed' ||
    parserError?.status === 400 ||
    parserError?.statusCode === 400
  ) {
    res.status(400).json({
      status: 'error',
      code: 'ERR_INVALID_BODY',
      description: 'The request body is invalid.'
    })
    return
  }
  next(error)
}

/**
 * A local concurrency ceiling prevents a single process from accepting
 * unbounded in-flight application work. Distributed/global quotas remain the
 * responsibility of the deployment's shared rate-limit store or gateway.
 */
export function concurrencyLimit(environmentPrefix: string, fallback: number): RequestHandler {
  const maximum = readResourceLimit(
    environmentPrefix,
    'MAX_CONCURRENT_REQUESTS',
    fallback,
    MAX_CONCURRENT_REQUESTS
  )
  if (maximum === -1) return (_req, _res, next) => next()
  let active = 0

  return (_req: Request, res: Response, next: NextFunction): void => {
    if (active >= maximum) {
      res.setHeader('Retry-After', '1')
      res.status(503).json({
        status: 'error',
        code: 'ERR_SERVER_BUSY',
        description: 'The service is temporarily at capacity.'
      })
      return
    }

    active += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      active -= 1
    }
    res.once('finish', release)
    res.once('close', release)
    next()
  }
}

export function configureHttpServer(
  server: Server,
  environmentPrefix: string,
  defaults: HttpServerPolicyDefaults
): void {
  const requestTimeoutMs = readPositiveInteger(
    `${environmentPrefix}_REQUEST_TIMEOUT_MS`,
    defaults.requestTimeoutMs,
    MAX_REQUEST_TIMEOUT_MS
  )
  const headersTimeoutMs = readPositiveInteger(
    `${environmentPrefix}_HEADERS_TIMEOUT_MS`,
    defaults.headersTimeoutMs,
    requestTimeoutMs
  )
  const keepAliveTimeoutMs = readPositiveInteger(
    `${environmentPrefix}_KEEP_ALIVE_TIMEOUT_MS`,
    defaults.keepAliveTimeoutMs,
    requestTimeoutMs
  )
  const socketTimeoutMs = readPositiveInteger(
    `${environmentPrefix}_SOCKET_TIMEOUT_MS`,
    defaults.socketTimeoutMs,
    MAX_REQUEST_TIMEOUT_MS
  )

  server.requestTimeout = requestTimeoutMs
  server.headersTimeout = headersTimeoutMs
  server.keepAliveTimeout = keepAliveTimeoutMs
  server.maxRequestsPerSocket = readPositiveInteger(
    `${environmentPrefix}_MAX_REQUESTS_PER_SOCKET`,
    defaults.maxRequestsPerSocket,
    1_000_000
  )
  const maxConnections = readResourceLimit(
    environmentPrefix,
    'MAX_CONNECTIONS',
    defaults.maxConnections ?? 1_000,
    1_000_000
  )
  server.maxConnections = maxConnections === -1 ? Number.MAX_SAFE_INTEGER : maxConnections
  if (typeof server.setTimeout === 'function') {
    server.setTimeout(socketTimeoutMs)
  }
}
