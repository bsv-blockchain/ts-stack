import { Telemetry, TelemetryConfig } from '@bsv/sdk'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CONFIGURED_TIMEOUT_MS = 120_000
const MAX_CONFIGURED_REQUEST_BYTES = 10 * 1024 * 1024
const MAX_CONFIGURED_RESPONSE_BYTES = 10 * 1024 * 1024

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
  | 'WAB_REQUEST_TOO_LARGE'
  | 'WAB_RESPONSE_TOO_LARGE'
  | 'WAB_INVALID_RESPONSE'

/**
 * A privacy-safe WAB transport failure. Response bodies and request payloads
 * are deliberately excluded from the error.
 */
export class WABClientError extends Error {
  constructor (
    public readonly code: WABClientErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'WABClientError'
  }
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

function isLocalHostname (hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
}

function normalizeServerUrl (serverUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    throw new WABClientError(
      'WAB_INVALID_CONFIGURATION',
      'WAB server URL must be an absolute URL.',
      false
    )
  }

  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new WABClientError(
      'WAB_INVALID_CONFIGURATION',
      'WAB server URL must not contain credentials, a query, or a fragment.',
      false
    )
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHostname(parsed.hostname))) {
    throw new WABClientError(
      'WAB_INVALID_CONFIGURATION',
      'WAB server URL must use HTTPS. Plain HTTP is allowed only for localhost development.',
      false
    )
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed
}

function normalizePositiveInteger (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new WABClientError(
      'WAB_INVALID_CONFIGURATION',
      `${name} must be a positive integer no greater than ${maximum}.`,
      false
    )
  }
  return resolved
}

function assertSafePath (path: string): void {
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.includes('..')) {
    throw new WABClientError('WAB_INVALID_REQUEST', 'Invalid WAB endpoint path.', false)
  }
}

function isRetryableStatus (status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
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

  private readonly fetchClient: typeof fetch
  private readonly timeoutMs: number
  private readonly maxRequestBytes: number
  private readonly maxResponseBytes: number

  constructor (serverUrl: string, options: WABTransportOptions = {}) {
    const parsed = normalizeServerUrl(serverUrl)
    this.serverUrl = `${parsed.origin}${parsed.pathname}`
    this.serverOrigin = parsed.origin
    const fetchClient = options.fetch ?? defaultFetch
    if (typeof fetchClient !== 'function') {
      throw new WABClientError(
        'WAB_INVALID_CONFIGURATION',
        'WABClient requires a fetch implementation.',
        false
      )
    }
    this.fetchClient = fetchClient
    this.timeoutMs = normalizePositiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      'timeoutMs'
    )
    this.maxRequestBytes = normalizePositiveInteger(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      MAX_CONFIGURED_REQUEST_BYTES,
      'maxRequestBytes'
    )
    this.maxResponseBytes = normalizePositiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_CONFIGURED_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    this.telemetry = new Telemetry(options.telemetry)
  }

  createCorrelationId (): string | undefined {
    return this.telemetry.enabled ? this.telemetry.createCorrelationId() : undefined
  }

  async request<T>(path: string, options: WABRequestOptions): Promise<T> {
    assertSafePath(path)
    const method = options.method ?? 'POST'
    const correlationId = options.correlationId ?? this.createCorrelationId()
    const startedAt = Date.now()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false

    this.telemetry.capture({
      name: 'wallet-toolbox.wab.request.started',
      component: 'wallet-toolbox.wab-transport',
      severity: 'debug',
      correlationId,
      attributes: {
        operation: options.operation,
        method,
        route: path,
        serverOrigin: this.serverOrigin
      }
    })

    let body: string | undefined
    try {
      body = options.body === undefined ? undefined : JSON.stringify(options.body)
    } catch (error) {
      const normalized = new WABClientError(
        'WAB_INVALID_REQUEST',
        'WAB request payload could not be encoded.',
        false,
        undefined,
        { cause: error }
      )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, normalized)
      throw normalized
    }
    if (options.body !== undefined && body === undefined) {
      const error = new WABClientError(
        'WAB_INVALID_REQUEST',
        'WAB request payload must be JSON-serializable.',
        false
      )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, error)
      throw error
    }
    if (body !== undefined && new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      const error = new WABClientError(
        'WAB_REQUEST_TOO_LARGE',
        'WAB request exceeded the configured size limit.',
        false
      )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, error)
      throw error
    }

    const requestPromise = new Promise<Response>((resolve) => {
      resolve(this.fetchClient(`${this.serverUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(correlationId !== undefined ? { 'X-Correlation-ID': correlationId } : {})
        },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      }))
    })
    requestPromise.catch(() => { /* timeout may settle the public request first */ })

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new WABClientError('WAB_TIMEOUT', 'WAB request timed out.', true))
      }, this.timeoutMs)
    })

    let response: Response
    try {
      response = await Promise.race([requestPromise, timeoutPromise])
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer)
      const normalized = error instanceof WABClientError
        ? error
        : new WABClientError(
          timedOut ? 'WAB_TIMEOUT' : 'WAB_NETWORK_ERROR',
          timedOut ? 'WAB request timed out.' : 'WAB request failed before receiving a response.',
          true,
          undefined,
          { cause: error }
        )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, normalized)
      throw normalized
    }

    if (!response.ok) {
      if (timer !== undefined) clearTimeout(timer)
      const error = new WABClientError(
        'WAB_HTTP_ERROR',
        `WAB request failed with HTTP status ${response.status}.`,
        isRetryableStatus(response.status),
        response.status
      )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, error)
      void response.body?.cancel().catch(() => { /* best effort only */ })
      throw error
    }

    let responseText: string
    try {
      responseText = await Promise.race([
        this.readBoundedResponse(response),
        timeoutPromise
      ])
    } catch (error) {
      const normalized = error instanceof WABClientError
        ? error
        : new WABClientError(
          timedOut ? 'WAB_TIMEOUT' : 'WAB_INVALID_RESPONSE',
          timedOut ? 'WAB request timed out.' : 'WAB response could not be read.',
          true,
          response.status,
          { cause: error }
        )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, normalized)
      throw normalized
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(responseText)
    } catch (error) {
      const normalized = new WABClientError(
        'WAB_INVALID_RESPONSE',
        'WAB response was not valid JSON.',
        true,
        response.status,
        { cause: error }
      )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, normalized)
      throw normalized
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new WABClientError(
        'WAB_INVALID_RESPONSE',
        'WAB response must be a JSON object.',
        true,
        response.status
      )
      this.captureFailure(options.operation, method, path, correlationId, startedAt, error)
      throw error
    }

    this.telemetry.capture({
      name: 'wallet-toolbox.wab.request.completed',
      component: 'wallet-toolbox.wab-transport',
      severity: 'info',
      correlationId,
      attributes: {
        operation: options.operation,
        method,
        route: path,
        serverOrigin: this.serverOrigin,
        status: response.status,
        responseBytes: new TextEncoder().encode(responseText).byteLength,
        durationMs: Date.now() - startedAt
      }
    })
    return parsed as T
  }

  private async readBoundedResponse (response: Response): Promise<string> {
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      try {
        await response.body?.cancel()
      } catch {
        // Best effort only.
      }
      throw new WABClientError(
        'WAB_RESPONSE_TOO_LARGE',
        'WAB response exceeded the configured size limit.',
        false,
        response.status
      )
    }

    const reader = response.body?.getReader()
    if (reader == null) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > this.maxResponseBytes) {
        throw new WABClientError(
          'WAB_RESPONSE_TOO_LARGE',
          'WAB response exceeded the configured size limit.',
          false,
          response.status
        )
      }
      return new TextDecoder().decode(bytes)
    }

    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value == null) continue
      total += value.byteLength
      if (total > this.maxResponseBytes) {
        try {
          await reader.cancel()
        } catch {
          // Best effort only.
        }
        throw new WABClientError(
          'WAB_RESPONSE_TOO_LARGE',
          'WAB response exceeded the configured size limit.',
          false,
          response.status
        )
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

  private captureFailure (
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    correlationId: string | undefined,
    startedAt: number,
    error: WABClientError
  ): void {
    this.telemetry.capture({
      name: 'wallet-toolbox.wab.request.failed',
      component: 'wallet-toolbox.wab-transport',
      severity: error.retryable ? 'warn' : 'error',
      correlationId,
      attributes: {
        operation,
        method,
        route: path,
        serverOrigin: this.serverOrigin,
        retryable: error.retryable,
        ...(error.status !== undefined ? { status: error.status } : {}),
        durationMs: Date.now() - startedAt
      },
      error
    })
  }
}
