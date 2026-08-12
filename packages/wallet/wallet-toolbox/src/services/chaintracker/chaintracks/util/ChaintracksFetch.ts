import { defaultHttpClient, HttpClient } from '@bsv/sdk'
import { ChaintracksDownloadOptions, ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { wait } from '../../../../utility/utilityHelpers'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_MSECS = 1000
const DEFAULT_MAX_RETRY_MSECS = 2 * 60 * 1000
const DEFAULT_TIMEOUT_MSECS = 30 * 1000
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export interface ChaintracksFetchOptions {
  /** Number of retries after the initial request. Defaults to three. */
  maxRetries?: number
  /** Deadline covering connection, headers, and response body. */
  timeoutMsecs?: number
  /** Maximum materialized response size for binary and JSON requests. */
  maxResponseBytes?: number
  retryMsecs?: number
  maxRetryMsecs?: number
  /** Testable jitter source in the inclusive range 0..1. */
  random?: () => number
}

export class ChaintracksFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly retryAfterMsecs?: number
  ) {
    super(message)
    this.name = 'ChaintracksFetchError'
  }

  get retryable(): boolean {
    return this.status === 0 || isRetryableHttpStatus(this.status)
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function retryAfterMsecs(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter == null || retryAfter === '') return undefined
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const dateMsecs = Date.parse(retryAfter)
  if (!Number.isFinite(dateMsecs)) return undefined
  return Math.max(0, dateMsecs - Date.now())
}

function fetchError(url: string, response: Response, kind: string): ChaintracksFetchError {
  const retryAfter = retryAfterMsecs(response)
  return new ChaintracksFetchError(
    `Failed to ${kind} from ${url}: ${response.status} ${response.statusText}`,
    url,
    response.status,
    response.statusText,
    retryAfter
  )
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return resolved
}

/**
 * Bounded fetch implementation shared by ChainTracks sources.
 *
 * Retry policy lives here so callers never multiply attempts. Every attempt
 * has a deadline that remains active while the response body is consumed, and
 * every materialized response has an explicit byte ceiling.
 */
export class ChaintracksFetch implements ChaintracksFetchApi {
  httpClient: HttpClient = defaultHttpClient()
  private readonly maxRetries: number
  private readonly timeoutMsecs: number
  private readonly maxResponseBytes: number
  private readonly retryMsecs: number
  private readonly maxRetryMsecs: number
  private readonly random: () => number

  constructor(options: ChaintracksFetchOptions = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new Error('maxRetries must be a non-negative safe integer')
    }
    this.maxRetries = maxRetries
    this.timeoutMsecs = positiveSafeInteger(options.timeoutMsecs, DEFAULT_TIMEOUT_MSECS, 'timeoutMsecs')
    this.maxResponseBytes = positiveSafeInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    this.retryMsecs = positiveSafeInteger(options.retryMsecs, DEFAULT_RETRY_MSECS, 'retryMsecs')
    this.maxRetryMsecs = positiveSafeInteger(options.maxRetryMsecs, DEFAULT_MAX_RETRY_MSECS, 'maxRetryMsecs')
    this.random = options.random ?? Math.random
  }

  async download(url: string, maxResponseBytes?: number, options?: ChaintracksDownloadOptions): Promise<Uint8Array> {
    const responseLimit =
      maxResponseBytes == null
        ? this.maxResponseBytes
        : Math.min(
            this.maxResponseBytes,
            positiveSafeInteger(maxResponseBytes, this.maxResponseBytes, 'maxResponseBytes')
          )
    return await this.requestBytes(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/octet-stream' }
      },
      'download',
      responseLimit,
      options
    )
  }

  async fetchJson<R>(url: string): Promise<R> {
    const bytes = await this.requestBytes(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' }
      },
      'fetch JSON',
      this.maxResponseBytes
    )
    return JSON.parse(new TextDecoder().decode(bytes)) as R
  }

  private async requestBytes(
    url: string,
    init: RequestInit,
    kind: string,
    maxResponseBytes: number,
    downloadOptions?: ChaintracksDownloadOptions
  ): Promise<Uint8Array> {
    for (let retry = 0; ; retry++) {
      if (retry > 0) await downloadOptions?.beforeRetry?.(retry + 1)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMsecs)
      try {
        return await this.requestAttempt(url, init, kind, maxResponseBytes, controller)
      } catch (error) {
        const timedOut = controller.signal.aborted
        let fetchFailure: ChaintracksFetchError
        if (error instanceof ChaintracksFetchError) fetchFailure = error
        else {
          fetchFailure = new ChaintracksFetchError(
            `Failed to ${kind} from ${url}: ${timedOut ? 'request timed out' : String(error)}`,
            url,
            0,
            timedOut ? 'Request Timeout' : 'Network Error'
          )
        }
        if (!fetchFailure.retryable || retry >= this.maxRetries) throw fetchFailure
        await wait(this.retryWaitMsecs(retry, fetchFailure.retryAfterMsecs))
      } finally {
        clearTimeout(timeout)
      }
    }
  }

  private async requestAttempt(
    url: string,
    init: RequestInit,
    kind: string,
    maxResponseBytes: number,
    controller: AbortController
  ): Promise<Uint8Array> {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw fetchError(url, response, kind)
    }
    return await this.readResponseBytes(url, response, kind, maxResponseBytes)
  }

  private async readResponseBytes(
    url: string,
    response: Response,
    kind: string,
    maxResponseBytes: number
  ): Promise<Uint8Array> {
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw this.responseTooLarge(url, response, kind, contentLength, maxResponseBytes)
    }

    if (response.body == null) return new Uint8Array()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > maxResponseBytes) {
          await reader.cancel().catch(() => undefined)
          throw this.responseTooLarge(url, response, kind, total, maxResponseBytes)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }

  private responseTooLarge(
    url: string,
    response: Response,
    kind: string,
    observedBytes: number,
    maxResponseBytes: number
  ): ChaintracksFetchError {
    return new ChaintracksFetchError(
      `Failed to ${kind} from ${url}: response exceeded ${maxResponseBytes} bytes ` +
        `(observed at least ${observedBytes})`,
      url,
      response.status,
      'Response Too Large'
    )
  }

  private retryWaitMsecs(retry: number, retryAfter?: number): number {
    if (retryAfter != null) return Math.min(retryAfter, this.maxRetryMsecs)
    const exponential = Math.min(this.retryMsecs * 2 ** retry, this.maxRetryMsecs)
    const jitter = 0.75 + Math.min(1, Math.max(0, this.random())) * 0.5
    return Math.min(Math.round(exponential * jitter), this.maxRetryMsecs)
  }

  pathJoin(baseUrl: string, subpath: string): string {
    const cleanSubpath = subpath.replace(/^\/+/, '')
    if (!baseUrl.endsWith('/')) baseUrl += '/'
    return new URL(cleanSubpath, baseUrl).toString()
  }
}
