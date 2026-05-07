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
  } else if (typeof require === 'undefined') {
    return noHttpClient
  } else {
    // Older Node.js — use https module
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const https = require('node:https')
      return new NodejsHttpClient(https)
    } catch (_httpsModuleUnavailable) {
      // node:https not available in this runtime; fall through to noHttpClient
      return noHttpClient
    }
  }
}
