import { PaymailServerResponseError } from '../errors/index.js'
import fetch from 'cross-fetch'

type FetchOptions = RequestInit & { timeout?: number }
export type RequestOptions = Omit<FetchOptions, 'body' | 'method'> & {
  method?: 'GET' | 'POST'
  body?: unknown
}

const defaultRequestOptions: RequestOptions = { method: 'GET' }

export default class HttpClient {
  private readonly defaultTimeout: number

  constructor(defaultTimeout = 30000) {
    this.defaultTimeout = defaultTimeout
  }

  async request(url: string, options: RequestOptions = defaultRequestOptions): Promise<Response> {
    const controller = new AbortController()
    const { body, timeout: requestedTimeout, ...fetchOptions } = options
    const timeout = requestedTimeout ?? this.defaultTimeout
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const requestOptions: RequestInit = {
      ...fetchOptions,
      signal: controller.signal
    }

    if (options.method === 'POST' && body !== undefined) {
      requestOptions.body = JSON.stringify(body)
      const headers = new Headers(options.headers)
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      requestOptions.headers = headers
    }

    try {
      const response = await fetch(url, requestOptions)
      if (!response.ok) {
        throw new PaymailServerResponseError(await response.text())
      }
      return response
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
