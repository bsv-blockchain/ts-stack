import { HttpClient, HttpClientRequestOptions, HttpClientResponse } from './HttpClient.js'
import { HttpsModuleLike, executeNodejsRequest } from './NodejsHttpRequestUtils.js'
import {
  type HttpClientLimits,
  normalizeHttpClientLimits,
  readFetchResponseText,
  timedRequestSignal
} from './HttpClientResponseUtils.js'

/** Node Https module interface limited to options needed by ts-sdk */
export interface BinaryHttpsNodejs {
  request: (
    url: string,
    options: HttpClientRequestOptions,
    callback: (res: any) => void
  ) => BinaryNodejsHttpClientRequest
}

/** Nodejs result of the Node https.request call limited to options needed by ts-sdk */
export interface BinaryNodejsHttpClientRequest {
  write: (chunk: Buffer) => void

  on: (event: string, callback: (data: any) => void) => void

  end: () => void
}

/**
 * Adapter for Node Https module to be used as HttpClient
 */
export class BinaryNodejsHttpClient implements HttpClient {
  constructor(private readonly https: BinaryHttpsNodejs) {}

  async request(
    url: string,
    requestOptions: HttpClientRequestOptions
  ): Promise<HttpClientResponse> {
    return await executeNodejsRequest(
      this.https as unknown as HttpsModuleLike,
      url,
      requestOptions,
      data => Buffer.from(data)
    )
  }
}

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
  body?: Buffer | Uint8Array | Blob | null
  redirect?: 'error'
  signal?: AbortSignal
}

/**
 * Adapter for Node Https module to be used as HttpClient
 */
export class BinaryFetchClient implements HttpClient {
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
      body: options.data,
      redirect: 'error',
      signal: timed.signal
    }
    try {
      const res = await this.fetch(url, fetchOptions)
      const data = await readFetchResponseText(res, this.limits.maxResponseBytes)

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

export function binaryHttpClient(): HttpClient {
  const noHttpClient: HttpClient = {
    async request(): Promise<HttpClientResponse> {
      throw new Error('No method available to perform HTTP request')
    }
  }

  if (globalThis.window !== undefined && typeof globalThis.window.fetch === 'function') {
    // Browser tab/page context
    return new BinaryFetchClient(
      globalThis.window.fetch.bind(globalThis.window) as unknown as Fetch
    )
  } else if (typeof globalThis.fetch === 'function') {
    // Service workers, Deno, Node 18+ (any environment with global fetch)
    return new BinaryFetchClient(globalThis.fetch.bind(globalThis) as unknown as Fetch)
  }

  const nodeRequire = typeof require === 'function' ? require : undefined
  if (nodeRequire === undefined) {
    return noHttpClient
  }

  // Older Node.js — use https without exposing a static server-only import to
  // browser bundlers.
  try {
    const https = nodeRequire(['node', 'https'].join(':'))
    return new BinaryNodejsHttpClient(https)
  } catch {
    // node:https not available in this runtime; fall through to noHttpClient
    return noHttpClient
  }
}
