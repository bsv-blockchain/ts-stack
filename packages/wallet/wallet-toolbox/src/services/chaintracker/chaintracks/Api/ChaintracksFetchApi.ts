import type { HttpClient } from '@bsv/sdk'

/** @public */
export interface ChaintracksDownloadOptions {
  /** Called immediately before each retry after the initial request. */
  beforeRetry?: (attempt: number) => void | Promise<void>
}

/**
 * Provides a simplified interface based on the @bsv/sdk `HttpClient` class
 * with just the methods necesary for most Chaintracks operations.
 *
 * The primary purpose is to isolate and centralize external package dependency.
 *
 * Specific ingestors are free to use other means for access.
 *
 * The `ChaintracksFetch` class implements this interface.
 */
export interface ChaintracksFetchApi {
  httpClient: HttpClient
  download(url: string, maxResponseBytes?: number, options?: ChaintracksDownloadOptions): Promise<Uint8Array>
  fetchJson<R>(url: string): Promise<R>
  pathJoin(baseUrl: string, subpath: string): string
}
