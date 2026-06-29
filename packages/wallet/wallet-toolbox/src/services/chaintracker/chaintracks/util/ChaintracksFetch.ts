import { defaultHttpClient, HttpClient } from '@bsv/sdk'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { wait } from '../../../../utility/utilityHelpers'

const MAX_RETRIES = 3
const DEFAULT_RETRY_MSECS = 1000

export class ChaintracksFetchError extends Error {
  constructor (
    message: string,
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly retryAfterMsecs?: number
  ) {
    super(message)
    this.name = 'ChaintracksFetchError'
  }

  get retryable (): boolean {
    return isRetryableHttpStatus(this.status)
  }
}

function isRetryableHttpStatus (status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function retryAfterMsecs (response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter == null || retryAfter === '') return undefined
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const dateMsecs = Date.parse(retryAfter)
  if (!Number.isFinite(dateMsecs)) return undefined
  return Math.max(0, dateMsecs - Date.now())
}

function retryWaitMsecs (retry: number, retryAfter?: number): number {
  return Math.min(retryAfter ?? DEFAULT_RETRY_MSECS * (retry + 1), 2 * 60 * 1000)
}

async function waitIfRetryable (response: Response, retry: number): Promise<boolean> {
  if (!isRetryableHttpStatus(response.status) || retry >= MAX_RETRIES) return false
  await wait(retryWaitMsecs(retry, retryAfterMsecs(response)))
  return true
}

function fetchError (url: string, response: Response, kind: string): ChaintracksFetchError {
  const retryAfter = retryAfterMsecs(response)
  return new ChaintracksFetchError(
    `Failed to ${kind} from ${url}: ${response.status} ${response.statusText}`,
    url,
    response.status,
    response.statusText,
    retryAfter
  )
}

/**
 * This class implements the ChaintracksFetchApi
 * using the @bsv/sdk `defaultHttpClient`.
 */
export class ChaintracksFetch implements ChaintracksFetchApi {
  httpClient: HttpClient = defaultHttpClient()

  async download (url: string): Promise<Uint8Array> {
    for (let retry = 0; ; retry++) {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/octet-stream'
        }
      })

      if (!response.ok) {
        if (await waitIfRetryable(response, retry)) continue
        throw fetchError(url, response, 'download')
      }

      const data = await response.arrayBuffer()

      return new Uint8Array(data)
    }
  }

  async fetchJson<R>(url: string): Promise<R> {
    const requestJsonOptions = {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    }
    let json: R
    for (let retry = 0; ; retry++) {
      const response = await fetch(url, requestJsonOptions)
      if (!response.ok) {
        if (await waitIfRetryable(response, retry)) continue
        throw fetchError(url, response, 'fetch JSON')
      }
      json = (await response.json()) as R
      break
    }
    return json
  }

  pathJoin (baseUrl: string, subpath: string): string {
    // Ensure the subpath doesn't start with a slash to avoid issues
    const cleanSubpath = subpath.replace(/^\/+/, '')
    if (!baseUrl.endsWith('/')) baseUrl += '/'
    // Create a new URL object and append the subpath
    const url = new URL(cleanSubpath, baseUrl)
    return url.toString()
  }
}
