import { AuthFetch } from '../../auth/clients/AuthFetch.js'
import type { WalletInterface } from '../../wallet/Wallet.interfaces.js'
import type { OutputCapabilitySelection } from '../OutputCapabilities.js'
import { OutputProtocolError, outputAssert } from '../OutputProtocolError.js'
import {
  OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES,
  outputServiceErrorHTTPStatus,
  parseOutputServiceError,
  type OutputServiceError
} from '../OutputServiceError.js'
import { readLookupResponseBytes } from '../LookupResponseReader.js'
import { LookupResourceLimitError } from '../LookupResources.js'

export interface OutputFiniteHTTPMessages {
  fetch: string
  timeout: string
  headers: string
  responseEndpoint: string
  encoding: string
  cancelled: string
  active: string
  deadline: string
  contract: string
  payment: string
  status: string
  endpoint: string
  body: string
}
export interface OutputFiniteHTTPOptions {
  selection: OutputCapabilitySelection
  wallet?: WalletInterface
  fetch?: typeof fetch
  requestTimeoutMs?: number
  messages: Readonly<OutputFiniteHTTPMessages>
  serviceError(packet: OutputServiceError): Error
}

function checkHeaders(headers: Headers, messages: OutputFiniteHTTPMessages): void {
  let bytes = 0
  const encoder = new TextEncoder()
  headers.forEach((value, name) => {
    bytes += encoder.encode(name).length + encoder.encode(value).length
    outputAssert(bytes <= 16384, messages.headers, 'limited')
  })
}

function checkHTTPResponse(
  response: Response,
  url: string,
  messages: OutputFiniteHTTPMessages
): void {
  outputAssert(
    !response.redirected && (response.url === '' || response.url === url),
    messages.responseEndpoint,
    'unauthorized'
  )
  checkHeaders(response.headers, messages)
  const encoding = response.headers.get('content-encoding')
  outputAssert(encoding === null || encoding.toLowerCase() === 'identity', messages.encoding)
  // BRC-104 does not sign Content-Type, and existing authentication middleware
  // can send a signed JSON body as application/octet-stream. The strict JSON
  // decoder below checks actual UTF-8 bytes after authentication instead.
}

/** Internal finite exchange shared by opt-in protocol clients; no queue or persistence. */
export class OutputFiniteHTTP {
  private readonly selection: OutputCapabilitySelection
  private readonly wallet?: WalletInterface
  private readonly fetchClient: typeof fetch
  private readonly timeout: number
  private readonly messages: Readonly<OutputFiniteHTTPMessages>
  private readonly serviceError: (packet: OutputServiceError) => Error
  private active = false

  constructor(options: OutputFiniteHTTPOptions) {
    this.selection = options.selection
    this.wallet = options.wallet
    this.messages = Object.freeze({ ...options.messages })
    this.serviceError = options.serviceError
    const fetchClient = options.fetch ?? globalThis.fetch
    outputAssert(typeof fetchClient === 'function', this.messages.fetch)
    // Preserve the receiver required by browser Web IDL global fetch methods.
    this.fetchClient = fetchClient.bind(globalThis)
    this.timeout = options.requestTimeoutMs ?? 30000
    outputAssert(
      Number.isSafeInteger(this.timeout) && this.timeout > 0 && this.timeout <= 30000,
      this.messages.timeout
    )
  }

  async exchange(
    url: string,
    body: string,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    outputAssert(!signal?.aborted, this.messages.cancelled, 'cancelled')
    outputAssert(!this.active, this.messages.active, 'limited')
    this.active = true
    const controller = new AbortController()
    const stop = () =>
      controller.abort(new OutputProtocolError('cancelled', this.messages.cancelled))
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const timer = setTimeout(
      () => controller.abort(new OutputProtocolError('unavailable', this.messages.deadline, true)),
      this.timeout
    )
    let rejectAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
      if (controller.signal.aborted) rejectAbort()
    })
    const pending = this.request(url, body, maximumBytes, controller.signal)
    void pending.then(
      () => {
        this.active = false
      },
      () => {
        this.active = false
      }
    )
    try {
      return await Promise.race([pending, cancelled])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
      controller.abort()
    }
  }

  private async request(
    url: string,
    body: string,
    maximumBytes: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const headers = { 'content-type': 'application/json', ...this.selection.headers }
    const boundedFetch = this.boundedFetch(url, maximumBytes, signal)
    const response =
      this.selection.profile.authentication === 'brc103'
        ? await new AuthFetch(
            this.wallet!,
            undefined,
            undefined,
            undefined,
            {
              maxResponseBytes: Math.max(maximumBytes, OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES),
              requestTimeoutMs: this.timeout
            },
            boundedFetch
          ).fetch(url, {
            method: 'POST',
            headers,
            body,
            allowPayments: false,
            requireMutualAuth: true,
            expectedIdentityKey: this.selection.manifest.body.identity
          })
        : await boundedFetch(url, { method: 'POST', headers, body })
    signal.throwIfAborted()
    for (const [key, value] of Object.entries(this.selection.headers))
      outputAssert(response.headers.get(key) === value, this.messages.contract, 'context-changed')
    const bytes = await readLookupResponseBytes(response, {
      maxResponseBytes: response.status === 200 ? maximumBytes : OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES,
      signal
    })
    if (response.status === 200) return bytes
    outputAssert(response.status !== 402, this.messages.payment, 'unsupported')
    const packet = parseOutputServiceError(bytes)
    outputAssert(
      response.status === outputServiceErrorHTTPStatus(packet.error.code),
      this.messages.status
    )
    throw this.serviceError(packet)
  }

  /** Bound original bytes/headers before authentication or JSON parsing. */
  private boundedFetch(
    applicationURL: string,
    maximumBytes: number,
    signal: AbortSignal
  ): typeof fetch {
    const authURL = new URL(applicationURL).origin + '/.well-known/auth'
    return async (input, init) => {
      signal.throwIfAborted()
      let url: string
      if (typeof input === 'string') url = input
      else if (input instanceof URL) url = input.href
      else url = input.url
      outputAssert(
        url === applicationURL || url === authURL,
        this.messages.endpoint,
        'unauthorized'
      )
      const headers = new Headers(init?.headers)
      headers.set('cache-control', 'no-store')
      checkHeaders(headers, this.messages)
      const response = await this.fetchClient(input, {
        ...init,
        headers,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal
      })
      try {
        signal.throwIfAborted()
        checkHTTPResponse(response, url, this.messages)
        const applicationLimit =
          response.status === 200 ? maximumBytes : OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES
        const bytes = await readLookupResponseBytes(response, {
          maxResponseBytes: url === authURL ? 1048576 : applicationLimit,
          signal
        })
        return new Response(Uint8Array.from(bytes), {
          status: response.status,
          headers: response.headers
        })
      } catch (error) {
        void response.body?.cancel().catch(() => undefined)
        if (error instanceof LookupResourceLimitError)
          throw new OutputProtocolError('limited', this.messages.body)
        throw error
      }
    }
  }
}
