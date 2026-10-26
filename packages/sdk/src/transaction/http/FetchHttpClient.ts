import { HttpClient, HttpClientRequestOptions, HttpClientResponse } from './HttpClient.js'
import {
  type HttpClientLimits,
  normalizeHttpClientLimits,
  readFetchResponseText,
  timedRequestSignal
} from './HttpClientResponseUtils.js'
import { utf8ByteLength } from '../../primitives/UTF8.js'

/** fetch function interface limited to options needed by ts-sdk */
/**
 * Makes a request to the server.
 * @param url The URL to make the request to.
 * @param options The request configuration.
 */
export type Fetch = (url: string, options: FetchOptions) => Promise<Response>

/**
 * An interface for configuration of the request to be passed to the fetch method
 * limited to options needed by ts-sdk.
 */
export interface FetchOptions {
  /** A string to set request's method. */
  method?: string
  /** An object literal set request's headers. */
  headers?: Record<string, string>
  /** An object or null to set request's body. */
  body?: string | null
  /** Redirects are prohibited so credentials cannot escape the configured endpoint. */
  redirect?: 'error'
  /** Cancels both the request and response-body read. */
  signal?: AbortSignal
}

/**
 * Adapter for Node Https module to be used as HttpClient
 */
export class FetchHttpClient implements HttpClient {
  private readonly limits: Required<HttpClientLimits>

  constructor(
    private readonly fetch: Fetch,
    limits: HttpClientLimits = {}
  ) {
    this.limits = normalizeHttpClientLimits(limits)
  }

  async request<D>(url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<D>> {
    const timed = timedRequestSignal(options.signal, this.limits.timeoutMs)
    const fetchOptions: FetchOptions = {
      method: options.method,
      headers: options.headers,
      body: options.data === undefined ? null : JSON.stringify(options.data),
      redirect: 'error',
      signal: timed.signal
    }
    try {
      const res = await this.fetch(url, fetchOptions)
      const legacyResponse = res as unknown as {
        body?: ReadableStream<Uint8Array> | null
        headers?: { get?: (name: string) => string | null | undefined }
        json?: () => Promise<unknown>
      }
      const mediaType = legacyResponse.headers?.get?.('Content-Type')
      let data: unknown
      if (
        !('body' in legacyResponse) &&
        typeof legacyResponse.json === 'function' &&
        (mediaType == null || mediaType.startsWith('application/json'))
      ) {
        data = await legacyResponse.json()
        if (utf8ByteLength(JSON.stringify(data)) > this.limits.maxResponseBytes) {
          throw new Error('HTTP response exceeds the configured size limit')
        }
      } else {
        const text = await readFetchResponseText(res, this.limits.maxResponseBytes)
        data =
          text !== '' && (mediaType?.startsWith('application/json') ?? false)
            ? JSON.parse(text)
            : text
      }

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        data: data as D
      }
    } finally {
      timed.dispose()
    }
  }
}
