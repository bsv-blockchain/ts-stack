import { defaultHttpClient, HttpClient } from '@bsv/sdk'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { wait } from '../../../../utility/utilityHelpers'

/**
 * This class implements the ChaintracksFetchApi
 * using the @bsv/sdk `defaultHttpClient`.
 */
export class ChaintracksFetch implements ChaintracksFetchApi {
  httpClient: HttpClient = defaultHttpClient()

  constructor() {}

  async download(url: string): Promise<Uint8Array> {
    for (let retry = 0; ; retry++) {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/octet-stream'
        }
      })

      if (!response.ok) {
        if (response.statusText === 'Too Many Requests' && retry < 3) {
          // WhatsOnChain rate limits requests, so backoff and retry
          await wait(1000 * (retry + 1))
          continue
        }
        throw new Error(`Failed to download from ${url}: ${response.statusText}`)
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
        if (response.statusText === 'Too Many Requests' && retry < 3) {
          await wait(1000 * (retry + 1))
          continue
        }
        throw new Error(`Failed to fetch JSON from ${url}: ${response.statusText}`)
      }
      json = (await response.json()) as R
      break
    }
    return json
  }

  pathJoin(baseUrl: string, subpath: string): string {
    // Ensure the subpath doesn't start with a slash to avoid issues
    const cleanSubpath = subpath.replace(/^\/+/, '')
    if (!baseUrl.endsWith('/')) baseUrl += '/'
    // Create a new URL object and append the subpath
    const url = new URL(cleanSubpath, baseUrl)
    return url.toString()
  }
}
