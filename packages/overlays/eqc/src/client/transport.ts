import { AuthFetch, type WalletInterface } from '@bsv/sdk'

import { parseHostParams, type HostParams } from '../protocol/params.js'
import { ECONOMIC_PATHS } from '../protocol/query.js'

export interface TransportResponse {
  status: number
  /** Parsed JSON, or `undefined` when the body was not JSON. */
  body: unknown
  /** The BRC-103 session identity of the host that answered. */
  identityKey?: string
}

export interface HostTransport {
  getParams: (url: string, timeoutMs: number) => Promise<HostParams>
  post: (url: string, path: string, body: unknown, timeoutMs: number) => Promise<TransportResponse>
}

export class TransportTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`${url} did not answer within ${timeoutMs} ms`)
    this.name = 'TransportTimeoutError'
  }
}

const MAX_PARAMS_BYTES = 65_536
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const BLOCKED_METHODS = new Set<string | symbol>(['createAction', 'signAction'])

/**
 * `AuthFetch` pays any well-formed HTTP 402 with no cap. Hosts here are untrusted, so the wallet
 * it sees can authenticate but cannot spend. The EQC spends only through `settle`.
 */
export function nonPayingWallet(wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get(target, property, receiver) {
      if (BLOCKED_METHODS.has(property)) {
        return async () => {
          throw new Error('The EQC transport never pays an HTTP 402 challenge')
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

async function withDeadline<T>(url: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TransportTimeoutError(url, timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export class AuthFetchTransport implements HostTransport {
  private readonly authFetch: AuthFetch
  private readonly fetchImpl: typeof fetch
  private readonly maxResponseBytes: number

  constructor(
    wallet: WalletInterface,
    options: { originator?: string; fetch?: typeof fetch; maxResponseBytes?: number } = {}
  ) {
    this.authFetch = new AuthFetch(
      nonPayingWallet(wallet),
      undefined,
      undefined,
      options.originator
    )
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  }

  /** `/economic/params` is unauthenticated, so it is read with a plain, bounded fetch. */
  async getParams(url: string, timeoutMs: number): Promise<HostParams> {
    const controller = new AbortController()
    const work = (async () => {
      const response = await this.fetchImpl(`${url}${ECONOMIC_PATHS.params}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (response.status !== 200) {
        throw new Error(`${url} answered params with status ${response.status}`)
      }
      const text = await response.text()
      if (text.length > MAX_PARAMS_BYTES) throw new Error(`${url} params response is too large`)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new TypeError(`${url} params response is not JSON`)
      }
      return parseHostParams(parsed)
    })()
    try {
      return await withDeadline(url, timeoutMs, work)
    } finally {
      controller.abort()
    }
  }

  async post(
    url: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<TransportResponse> {
    const work = (async () => {
      const response = await this.authFetch.fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const text = await response.text()
      if (text.length > this.maxResponseBytes) throw new Error(`${url} response is too large`)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const result: TransportResponse = { status: response.status, body: parsed }
      const identityKey = response.headers.get('x-bsv-auth-identity-key')
      if (identityKey !== null) result.identityKey = identityKey
      return result
    })()
    return await withDeadline(url, timeoutMs, work)
  }
}
