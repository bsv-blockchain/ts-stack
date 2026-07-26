import { HttpClient, HttpClientResponse } from './HttpClient.js'
import { NodejsHttpClient } from './NodejsHttpClient.js'
import { FetchHttpClient } from './FetchHttpClient.js'

/**
 * Returns a default HttpClient implementation based on the environment that it is run on.
 * This method will attempt to use `window.fetch` if available (in browser environments),
 * then `globalThis.fetch` (service workers, Deno, Node 18+), then the Node `https` module.
 */
export function defaultHttpClient(): HttpClient {
  const noHttpClient: HttpClient = {
    async request(..._): Promise<HttpClientResponse> {
      throw new Error('No method available to perform HTTP request')
    }
  }

  if (globalThis.window !== undefined && typeof globalThis.window.fetch === 'function') {
    // Browser tab/page context
    return new FetchHttpClient(globalThis.window.fetch.bind(globalThis.window))
  } else if (typeof globalThis.fetch === 'function') {
    // Service workers, Deno, Node 18+ (any environment with global fetch)
    return new FetchHttpClient(globalThis.fetch.bind(globalThis))
  }

  const nodeRequire = typeof require === 'function' ? require : undefined
  if (nodeRequire === undefined) {
    return noHttpClient
  }

  // Older Node.js — use https without exposing a static server-only import to
  // browser bundlers.
  try {
    const https = nodeRequire(['node', 'https'].join(':'))
    return new NodejsHttpClient(https)
  } catch {
    // node:https not available in this runtime; fall through to noHttpClient
    return noHttpClient
  }
}
