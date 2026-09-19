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

/**
 * A host answered, but with a status other than 200. `status` is what makes the answer worth
 * caching: a 4xx is the host stating it runs no market, while a 5xx is a passing failure.
 */
export class TransportStatusError extends Error {
  readonly status: number

  constructor(url: string, status: number) {
    super(`${url} answered params with status ${status}`)
    this.name = 'TransportStatusError'
    this.status = status
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

/**
 * Reads `response.body` one chunk at a time, counting bytes, and rejects as soon as `maxBytes` is
 * crossed instead of buffering the whole body first. On the cap being crossed the reader is
 * cancelled and `controller` is aborted so the underlying request stops. Falls back to
 * `response.arrayBuffer()` only when the runtime gives no readable stream for the body.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
  controller: AbortController
): Promise<Uint8Array> {
  if (response.body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw new Error(tooLargeMessage)
    return buffer
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      controller.abort()
      throw new Error(tooLargeMessage)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
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
        throw new TransportStatusError(url, response.status)
      }
      const tooLargeMessage = `${url} params response is too large`
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && Number(contentLength) > MAX_PARAMS_BYTES) {
        throw new Error(tooLargeMessage)
      }
      const bytes = await readBoundedBody(response, MAX_PARAMS_BYTES, tooLargeMessage, controller)
      const text = new TextDecoder().decode(bytes)
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
      // Residual limit: AuthFetch buffers the whole BRC-104 response itself and exposes no
      // AbortSignal on this call, so the allocation below the SDK boundary cannot be bounded or
      // cancelled from here. This only rejects the result after AuthFetch already read it fully.
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > this.maxResponseBytes) throw new Error(`${url} response is too large`)
      const text = new TextDecoder().decode(buffer)
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
