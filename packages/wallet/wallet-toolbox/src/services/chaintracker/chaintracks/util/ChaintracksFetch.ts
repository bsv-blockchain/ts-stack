import { createPublicHTTPSFetch, defaultHttpClient, HttpClient } from '@bsv/sdk'
import { ChaintracksDownloadOptions, ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { wait } from '../../../../utility/utilityHelpers'
import { WERR_INVALID_PARAMETER } from '../../../../sdk'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_MSECS = 1000
const DEFAULT_MAX_RETRY_MSECS = 2 * 60 * 1000
const DEFAULT_TIMEOUT_MSECS = 30 * 1000
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_RETRIES = 100
const MAX_TIMEOUT_MSECS = 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024

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
  /** Fetch implementation for operator-configured sources. */
  fetch?: typeof fetch
  /** Public-network fetch implementation; injectable for deterministic tests. */
  publicNetworkFetch?: typeof fetch
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

function boundedPositiveSafeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`)
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
  private readonly fetcher: typeof fetch
  private readonly publicNetworkFetch: typeof fetch

  constructor(options: ChaintracksFetchOptions = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES) {
      throw new Error(`maxRetries must be a non-negative safe integer no greater than ${MAX_RETRIES}`)
    }
    this.maxRetries = maxRetries
    this.timeoutMsecs = boundedPositiveSafeInteger(
      options.timeoutMsecs,
      DEFAULT_TIMEOUT_MSECS,
      MAX_TIMEOUT_MSECS,
      'timeoutMsecs'
    )
    this.maxResponseBytes = boundedPositiveSafeInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    this.retryMsecs = boundedPositiveSafeInteger(
      options.retryMsecs,
      DEFAULT_RETRY_MSECS,
      MAX_TIMEOUT_MSECS,
      'retryMsecs'
    )
    this.maxRetryMsecs = boundedPositiveSafeInteger(
      options.maxRetryMsecs,
      DEFAULT_MAX_RETRY_MSECS,
      MAX_TIMEOUT_MSECS,
      'maxRetryMsecs'
    )
    this.random = options.random ?? Math.random
    this.fetcher = options.fetch ?? fetch
    this.publicNetworkFetch = options.publicNetworkFetch ?? createPublicHTTPSFetch()
  }

  async download(url: string, maxResponseBytes?: number, options?: ChaintracksDownloadOptions): Promise<Uint8Array> {
    const responseLimit =
      maxResponseBytes == null
        ? this.maxResponseBytes
        : Math.min(
            this.maxResponseBytes,
            boundedPositiveSafeInteger(maxResponseBytes, this.maxResponseBytes, MAX_RESPONSE_BYTES, 'maxResponseBytes')
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as R
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
        return await this.requestAttempt(
          url,
          init,
          kind,
          maxResponseBytes,
          controller,
          downloadOptions?.publicNetworkOnly === true
        )
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
    controller: AbortController,
    publicNetworkOnly: boolean
  ): Promise<Uint8Array> {
    const fetcher = publicNetworkOnly ? this.publicNetworkFetch : this.fetcher
    const response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw fetchError(url, response, kind)
    }
    return await this.readResponseBytes(url, response, kind, maxResponseBytes, controller.signal)
  }

  private async readResponseBytes(
    url: string,
    response: Response,
    kind: string,
    maxResponseBytes: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const contentLengthHeader = response.headers.get('content-length')
    if (contentLengthHeader != null) {
      if (!/^(0|[1-9]\d*)$/.test(contentLengthHeader)) {
        await response.body?.cancel().catch(() => undefined)
        throw new ChaintracksFetchError(
          `Failed to ${kind} from ${url}: invalid Content-Length`,
          url,
          response.status,
          'Invalid Content-Length'
        )
      }
      const contentLength = Number(contentLengthHeader)
      if (!Number.isSafeInteger(contentLength) || contentLength > maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw this.responseTooLarge(url, response, kind, contentLength, maxResponseBytes)
      }
    }

    if (response.body == null) return new Uint8Array()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await this.readStreamChunk(reader, signal)
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

  private async readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      let settled = false
      const finish = (
        callback: (value: never) => void,
        value: ReadableStreamReadResult<Uint8Array> | unknown
      ): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        callback(value as never)
      }
      const onAbort = () => {
        void reader.cancel().catch(() => undefined)
        finish(reject, new DOMException('aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      reader.read().then(
        value => finish(resolve, value),
        error => finish(reject, error)
      )
    })
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
    if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > 2048) {
      throw new WERR_INVALID_PARAMETER('baseUrl', 'a URL no longer than 2048 characters')
    }
    if (typeof subpath !== 'string' || subpath.length === 0 || subpath.length > 2048) {
      throw new WERR_INVALID_PARAMETER('subpath', 'a non-empty relative URL path no longer than 2048 characters')
    }
    if (subpath.startsWith('//')) {
      throw new WERR_INVALID_PARAMETER('subpath', 'a relative URL path rather than a network-path reference')
    }
    const cleanSubpath = subpath.replace(/^\/+/, '')
    if (
      !/^[A-Za-z0-9._~%/-]+$/.test(cleanSubpath) ||
      cleanSubpath.split('/').some(segment => {
        if (segment.length === 0) return true
        try {
          const decoded = decodeURIComponent(segment)
          return decoded === '.' || decoded === '..' || /[\\/?#]/.test(decoded)
        } catch {
          return true
        }
      })
    ) {
      throw new WERR_INVALID_PARAMETER('subpath', 'a canonical relative URL path without traversal or delimiters')
    }
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    const joined = new URL(cleanSubpath, base)
    if (joined.origin !== base.origin || !joined.pathname.startsWith(base.pathname)) {
      throw new WERR_INVALID_PARAMETER('subpath', 'contained by the configured base URL')
    }
    return joined.toString()
  }
}
