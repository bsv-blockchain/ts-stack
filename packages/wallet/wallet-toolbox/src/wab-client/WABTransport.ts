import { normalizeBRC100WalletByteFields, stringifyBRC100, Telemetry, TelemetryConfig } from '@bsv/sdk'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CONFIGURED_TIMEOUT_MS = 120_000
const MAX_CONFIGURED_REQUEST_BYTES = 10 * 1024 * 1024
const MAX_CONFIGURED_RESPONSE_BYTES = 10 * 1024 * 1024
const WAB_COMPONENT = 'wallet-toolbox.wab-transport'
const WAB_REQUEST_EVENT = 'wallet-toolbox.wab.request.'

const defaultFetch: typeof fetch | undefined =
  typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined

export type WABClientErrorCode =
  | 'WAB_INVALID_CONFIGURATION'
  | 'WAB_INVALID_REQUEST'
  | 'WAB_NETWORK_ERROR'
  | 'WAB_TIMEOUT'
  | 'WAB_HTTP_ERROR'
  | 'WAB_ENDPOINT_MISMATCH'
  | 'WAB_REQUEST_TOO_LARGE'
  | 'WAB_RESPONSE_TOO_LARGE'
  | 'WAB_INVALID_RESPONSE'

export interface WABClientErrorOptions {
  cause?: unknown
  correlationId?: string
  operation?: string
  route?: string
  endpointMarkerPresent?: boolean
  responseCorrelationMatched?: boolean
}

/**
 * A privacy-safe WAB transport failure. Response bodies and request payloads
 * are deliberately excluded from the error.
 */
export class WABClientError extends Error {
  constructor(
    public readonly code: WABClientErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    options: WABClientErrorOptions = {}
  ) {
    super(message, options)
    this.name = 'WABClientError'
    this.correlationId = options.correlationId
    this.operation = options.operation
    this.route = options.route
    this.endpointMarkerPresent = options.endpointMarkerPresent
    this.responseCorrelationMatched = options.responseCorrelationMatched
  }

  public readonly correlationId?: string
  public readonly operation?: string
  public readonly route?: string
  public readonly endpointMarkerPresent?: boolean
  public readonly responseCorrelationMatched?: boolean
}

export interface WABTransportOptions {
  /** Injectable fetch implementation for React Native, tests, and custom runtimes. */
  fetch?: typeof fetch
  /** Hard wall-clock request timeout. Defaults to 10 seconds. */
  timeoutMs?: number
  /** Maximum encoded JSON request size. Defaults to 1 MiB. */
  maxRequestBytes?: number
  /** Maximum accepted JSON response size. Defaults to 1 MiB. */
  maxResponseBytes?: number
  /** Optional privacy-bounded telemetry integration. */
  telemetry?: TelemetryConfig
}

export interface WABRequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  operation: string
  correlationId?: string
}

interface WABRequestMetadata {
  method: 'GET' | 'POST'
  path: string
  operation: string
  correlationId: string
  startedAt: number
  errorContext: WABClientErrorOptions
}

interface WABRequestTimeout {
  controller: AbortController
  promise: Promise<never>
  timer?: ReturnType<typeof setTimeout>
  timedOut: boolean
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  )
}

interface NormalizedServerUrl {
  baseUrl: string
  origin: string
}

function normalizeServerUrl(serverUrl: string): NormalizedServerUrl {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    throw new WABClientError('WAB_INVALID_CONFIGURATION', 'WAB server URL must be an absolute URL.', false)
  }

  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new WABClientError(
      'WAB_INVALID_CONFIGURATION',
      'WAB URL cannot include credentials, query, or fragment.',
      false
    )
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHostname(parsed.hostname))) {
    throw new WABClientError('WAB_INVALID_CONFIGURATION', 'WAB URL requires HTTPS except on localhost.', false)
  }

  let pathname = parsed.pathname
  while (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1)
  }
  return {
    baseUrl: `${parsed.origin}${pathname}`,
    origin: parsed.origin
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new WABClientError('WAB_INVALID_CONFIGURATION', `${name} must be an integer from 1 to ${maximum}.`, false)
  }
  return resolved
}

function assertSafePath(path: string): void {
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.includes('..')) {
    throw new WABClientError('WAB_INVALID_REQUEST', 'Invalid WAB endpoint path.', false)
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function isSafeCorrelationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isWabResponse(response: Response): boolean {
  return response.headers.get('X-WAB-Service')?.toLowerCase() === 'wab-server'
}

/**
 * Centralized, bounded transport used by every WAB client operation.
 *
 * Only fixed endpoint metadata is reported. Request bodies and response bodies
 * never cross the telemetry boundary.
 */
export class WABTransport {
  readonly serverUrl: string
  readonly serverOrigin: string
  readonly telemetry: Telemetry

  private readonly fetcher: typeof fetch
  private readonly timeout: number
  private readonly requestLimit: number
  private readonly responseLimit: number

  constructor(serverUrl: string, options: WABTransportOptions = {}) {
    const normalized = normalizeServerUrl(serverUrl)
    this.serverUrl = normalized.baseUrl
    this.serverOrigin = normalized.origin
    const fetcher = options.fetch ?? defaultFetch
    if (typeof fetcher !== 'function') {
      throw new WABClientError('WAB_INVALID_CONFIGURATION', 'WABClient requires a fetch implementation.', false)
    }
    this.fetcher = fetcher
    this.timeout = normalizePositiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      'timeoutMs'
    )
    this.requestLimit = normalizePositiveInteger(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      MAX_CONFIGURED_REQUEST_BYTES,
      'maxRequestBytes'
    )
    this.responseLimit = normalizePositiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_CONFIGURED_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    this.telemetry = new Telemetry(options.telemetry)
  }

  createCorrelationId(): string {
    const correlationId = this.telemetry.createCorrelationId()
    return isSafeCorrelationId(correlationId) ? correlationId : new Telemetry().createCorrelationId()
  }

  async request<T>(path: string, options: WABRequestOptions): Promise<T> {
    assertSafePath(path)
    const correlationId =
      options.correlationId != null && isSafeCorrelationId(options.correlationId)
        ? options.correlationId
        : this.createCorrelationId()
    const metadata: WABRequestMetadata = {
      method: options.method ?? 'POST',
      path,
      operation: options.operation,
      correlationId,
      startedAt: Date.now(),
      errorContext: { correlationId, operation: options.operation, route: path }
    }
    this.telemetry.capture({
      name: `${WAB_REQUEST_EVENT}started`,
      component: WAB_COMPONENT,
      severity: 'debug',
      correlationId,
      attributes: {
        operation: metadata.operation,
        method: metadata.method,
        route: path,
        serverOrigin: this.serverOrigin
      }
    })
    const body = this.bodyFor(options, metadata)
    const timeout = this.startTimer(metadata.errorContext)
    const response = await this.fetch(metadata, body, timeout)
    const responseContext: WABClientErrorOptions = {
      ...metadata.errorContext,
      endpointMarkerPresent: isWabResponse(response),
      responseCorrelationMatched: response.headers.get('X-Correlation-ID') === correlationId
    }
    this.checkResponse(response, responseContext, metadata, timeout)
    const responseText = await this.readText(response, responseContext, metadata, timeout)

    const parsed = this.parse<T>(responseText, response, responseContext, metadata)

    this.telemetry.capture({
      name: `${WAB_REQUEST_EVENT}completed`,
      component: WAB_COMPONENT,
      severity: 'info',
      correlationId: metadata.correlationId,
      attributes: {
        operation: metadata.operation,
        method: metadata.method,
        route: metadata.path,
        serverOrigin: this.serverOrigin,
        status: response.status,
        endpointMarkerPresent: responseContext.endpointMarkerPresent,
        responseCorrelationMatched: responseContext.responseCorrelationMatched,
        responseBytes: new TextEncoder().encode(responseText).byteLength,
        durationMs: Date.now() - metadata.startedAt
      }
    })
    return parsed
  }

  private bodyFor(options: WABRequestOptions, metadata: WABRequestMetadata): string | undefined {
    let body: string | undefined
    try {
      body = options.body === undefined ? undefined : stringifyBRC100(options.body)
    } catch (cause) {
      const error = new WABClientError('WAB_INVALID_REQUEST', 'WAB request encoding failed.', false, undefined, {
        ...metadata.errorContext,
        cause
      })
      this.report(metadata, error)
      throw error
    }
    if (options.body !== undefined && body === undefined) {
      const error = new WABClientError(
        'WAB_INVALID_REQUEST',
        'WAB request is not JSON-serializable.',
        false,
        undefined,
        metadata.errorContext
      )
      this.report(metadata, error)
      throw error
    }
    if (body != null && new TextEncoder().encode(body).byteLength > this.requestLimit) {
      const error = new WABClientError(
        'WAB_REQUEST_TOO_LARGE',
        'WAB request exceeds its size limit.',
        false,
        undefined,
        metadata.errorContext
      )
      this.report(metadata, error)
      throw error
    }
    return body
  }

  private startTimer(errorContext: WABClientErrorOptions): WABRequestTimeout {
    const timeout = {
      controller: new AbortController(),
      timedOut: false
    } as WABRequestTimeout
    timeout.promise = new Promise<never>((_resolve, reject) => {
      timeout.timer = setTimeout(() => {
        timeout.timedOut = true
        timeout.controller.abort()
        reject(new WABClientError('WAB_TIMEOUT', 'WAB request timed out.', true, undefined, errorContext))
      }, this.timeout)
    })
    return timeout
  }

  private async fetch(
    metadata: WABRequestMetadata,
    body: string | undefined,
    timeout: WABRequestTimeout
  ): Promise<Response> {
    const requestPromise = Promise.resolve().then(() =>
      this.fetcher(`${this.serverUrl}${metadata.path}`, {
        method: metadata.method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'X-Correlation-ID': metadata.correlationId
        },
        ...(body !== undefined ? { body } : {}),
        signal: timeout.controller.signal,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      })
    )
    requestPromise.catch(() => {
      /* timeout may settle the public request first */
    })
    try {
      return await Promise.race([requestPromise, timeout.promise])
    } catch (cause) {
      if (timeout.timer !== undefined) clearTimeout(timeout.timer)
      let error: WABClientError
      if (cause instanceof WABClientError) {
        error = cause
      } else if (timeout.timedOut) {
        error = new WABClientError('WAB_TIMEOUT', 'WAB request timed out.', true, undefined, {
          ...metadata.errorContext,
          cause
        })
      } else {
        error = new WABClientError('WAB_NETWORK_ERROR', 'WAB request failed before response.', true, undefined, {
          ...metadata.errorContext,
          cause
        })
      }
      this.report(metadata, error)
      throw error
    }
  }

  private checkResponse(
    response: Response,
    responseContext: WABClientErrorOptions,
    metadata: WABRequestMetadata,
    timeout: WABRequestTimeout
  ): void {
    if (response.ok) return
    if (timeout.timer !== undefined) clearTimeout(timeout.timer)
    const endpointMismatch = response.status === 404 && responseContext.endpointMarkerPresent !== true
    const error = new WABClientError(
      endpointMismatch ? 'WAB_ENDPOINT_MISMATCH' : 'WAB_HTTP_ERROR',
      endpointMismatch ? 'WAB endpoint is incompatible.' : `WAB request failed with HTTP status ${response.status}.`,
      isRetryableStatus(response.status),
      response.status,
      responseContext
    )
    this.report(metadata, error)
    void response.body?.cancel().catch(() => {
      /* best effort only */
    })
    throw error
  }

  private async readText(
    response: Response,
    responseContext: WABClientErrorOptions,
    metadata: WABRequestMetadata,
    timeout: WABRequestTimeout
  ): Promise<string> {
    try {
      return await Promise.race([this.read(response, responseContext), timeout.promise])
    } catch (cause) {
      let error: WABClientError
      if (cause instanceof WABClientError) {
        error = cause
      } else if (timeout.timedOut) {
        error = new WABClientError('WAB_TIMEOUT', 'WAB request timed out.', true, response.status, {
          ...responseContext,
          cause
        })
      } else {
        error = new WABClientError('WAB_INVALID_RESPONSE', 'WAB response read failed.', true, response.status, {
          ...responseContext,
          cause
        })
      }
      this.report(metadata, error)
      throw error
    } finally {
      if (timeout.timer !== undefined) clearTimeout(timeout.timer)
    }
  }

  private parse<T>(
    responseText: string,
    response: Response,
    responseContext: WABClientErrorOptions,
    metadata: WABRequestMetadata
  ): T {
    let parsed: unknown
    try {
      parsed = normalizeBRC100WalletByteFields(JSON.parse(responseText))
    } catch (cause) {
      const error = new WABClientError(
        'WAB_INVALID_RESPONSE',
        'WAB response was not valid JSON.',
        true,
        response.status,
        { ...responseContext, cause }
      )
      this.report(metadata, error)
      throw error
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new WABClientError(
        'WAB_INVALID_RESPONSE',
        'WAB response must be a JSON object.',
        true,
        response.status,
        responseContext
      )
      this.report(metadata, error)
      throw error
    }
    return parsed as T
  }

  private async read(response: Response, responseContext: WABClientErrorOptions): Promise<string> {
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > this.responseLimit) {
      await this.stopBody(response)
      throw this.sizeError(response, responseContext)
    }

    const reader = response.body?.getReader()
    if (reader == null) {
      return this.readBuffer(response, responseContext)
    }

    return this.readStream(reader, response, responseContext)
  }

  private async readBuffer(response: Response, responseContext: WABClientErrorOptions): Promise<string> {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > this.responseLimit) {
      throw this.sizeError(response, responseContext)
    }
    return new TextDecoder().decode(bytes)
  }

  private async readStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    response: Response,
    responseContext: WABClientErrorOptions
  ): Promise<string> {
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value == null) continue
      total += value.byteLength
      if (total > this.responseLimit) {
        await this.stopReader(reader)
        throw this.sizeError(response, responseContext)
      }
      chunks.push(value)
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  }

  private sizeError(response: Response, responseContext: WABClientErrorOptions): WABClientError {
    return new WABClientError(
      'WAB_RESPONSE_TOO_LARGE',
      'WAB response exceeds its size limit.',
      false,
      response.status,
      responseContext
    )
  }

  private async stopBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel()
    } catch {
      // Best effort only.
    }
  }

  private async stopReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      await reader.cancel()
    } catch {
      // Best effort only.
    }
  }

  private report(metadata: WABRequestMetadata, error: WABClientError): void {
    this.telemetry.capture({
      name: `${WAB_REQUEST_EVENT}failed`,
      component: WAB_COMPONENT,
      severity: error.retryable ? 'warn' : 'error',
      correlationId: metadata.correlationId,
      attributes: {
        operation: metadata.operation,
        method: metadata.method,
        route: metadata.path,
        serverOrigin: this.serverOrigin,
        retryable: error.retryable,
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.endpointMarkerPresent !== undefined ? { endpointMarkerPresent: error.endpointMarkerPresent } : {}),
        ...(error.responseCorrelationMatched !== undefined
          ? { responseCorrelationMatched: error.responseCorrelationMatched }
          : {}),
        durationMs: Date.now() - metadata.startedAt
      },
      error
    })
  }
}
