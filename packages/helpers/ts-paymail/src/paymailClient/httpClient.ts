import { PaymailServerResponseError } from '../errors/index.js'
import fetch from 'cross-fetch'

type FetchOptions = RequestInit & { timeout?: number }

export default class HttpClient {
  private readonly defaultTimeout: number

  constructor (defaultTimeout = 30000) {
    this.defaultTimeout = defaultTimeout
  }

  async request (
    url: string,
    options: FetchOptions & { method: 'GET' | 'POST', body?: any } = {
      method: 'GET'
    }
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = options.timeout ?? this.defaultTimeout
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const requestOptions: FetchOptions = {
      ...options,
      signal: controller.signal
    }

    if (options.method === 'POST' && options.body) {
      requestOptions.body = JSON.stringify(options.body)
      requestOptions.headers = {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }

    try {
      const response = await fetch(url, requestOptions)
      if (!response.ok) {
        throw new PaymailServerResponseError(await response.text())
      }
      return response
    } catch (error) {
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
