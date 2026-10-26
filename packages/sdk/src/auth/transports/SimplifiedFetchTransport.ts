// @ts-nocheck
// @ts-expect-error
import { AuthMessage, RequestedCertificateSet, Transport } from '../types.js'
import {
  Reader,
  Writer,
  toArray as UtilsToArray,
  toBase64,
  toHex,
  toSafeString,
  toUTF8,
  toUTF8Strict
} from '../../primitives/utils.js'
import { normalizeBRC100ByteFields, stringifyBRC100 } from '../../wallet/BRC100ByteEncoding.js'

const defaultFetch: typeof fetch =
  typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : fetch

export const DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
export const DEFAULT_SIMPLIFIED_FETCH_MAX_HANDSHAKE_RESPONSE_BYTES = 1024 * 1024
export const DEFAULT_SIMPLIFIED_FETCH_REQUEST_TIMEOUT_MS = 30_000
// Request and signed-response header capacity is bounded independently of bodies.
const MAX_SIGNED_RESPONSE_HEADERS = 512
const MAX_SIGNED_RESPONSE_HEADER_KEY_BYTES = 1024
const MAX_SIGNED_RESPONSE_HEADER_VALUE_BYTES = 32 * 1024
const MAX_SIGNED_RESPONSE_HEADER_BYTES = 256 * 1024
const MAX_AUTH_SIGNATURE_HEX_BYTES = 1024
const MAX_REQUESTED_CERTIFICATES_HEADER_BYTES = 256 * 1024
const MAX_REQUEST_METHOD_BYTES = 32
const MAX_REQUEST_TARGET_COMPONENT_BYTES = 8192
const MAX_AUTH_REQUEST_PAYLOAD_BYTES = 16 * 1024 * 1024

export interface SimplifiedFetchTransportOptions {
  /** Maximum buffered authenticated application-response body size. */
  maxResponseBytes?: number
  /** Maximum buffered `/.well-known/auth` response body size. */
  maxHandshakeResponseBytes?: number
  /** Wall-clock deadline covering fetch and response-body consumption. */
  requestTimeoutMs?: number
}

/**
 * Implements an HTTP-specific transport for handling Peer mutual authentication messages.
 * This class integrates with fetch to send and receive authenticated messages between peers.
 * It rejects redirects and applies fixed byte/count limits to buffered bodies,
 * signed headers, request framing, signatures, request IDs, and certificate
 * request headers before allocating or verifying attacker-controlled data.
 */
export class SimplifiedFetchTransport implements Transport {
  private onDataCallback?: (message: AuthMessage) => Promise<void>
  fetchClient: typeof fetch
  baseUrl: string
  private readonly maxResponseBytes: number
  readonly #maxHandshakeResponseBytes: number
  readonly #requestTimeoutMs: number

  /**
   * Constructs a new instance of SimplifiedFetchTransport.
   * @param baseUrl - The base URL for all HTTP requests made by this transport.
   * @param fetchClient - A fetch implementation to use for HTTP requests (default: global fetch).
   */
  constructor(
    baseUrl: string,
    fetchClient: typeof fetch = defaultFetch,
    options: SimplifiedFetchTransportOptions = {}
  ) {
    if (typeof fetchClient !== 'function') {
      throw new TypeError(
        'SimplifiedFetchTransport requires a fetch implementation. ' +
          'In environments without fetch, provide a polyfill or custom implementation.'
      )
    }
    this.fetchClient = fetchClient
    this.baseUrl = baseUrl
    this.maxResponseBytes = positiveLimit(
      options.maxResponseBytes,
      DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    this.#maxHandshakeResponseBytes = positiveLimit(
      options.maxHandshakeResponseBytes,
      DEFAULT_SIMPLIFIED_FETCH_MAX_HANDSHAKE_RESPONSE_BYTES,
      'maxHandshakeResponseBytes'
    )
    this.#requestTimeoutMs = positiveLimit(
      options.requestTimeoutMs,
      DEFAULT_SIMPLIFIED_FETCH_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs'
    )
  }

  /**
   * Sends a message to an HTTP server using the transport mechanism.
   * Handles both general and authenticated message types. For general messages,
   * the payload is deserialized and sent as an HTTP request. For other message types,
   * the message is sent as a POST request to the `/auth` endpoint.
   *
   * @param message - The AuthMessage to send.
   * @returns A promise that resolves when the message is successfully sent.
   *
   * @throws Will throw an error if no listener has been registered via `onData`.
   */
  async send(message: AuthMessage): Promise<void> {
    if (this.onDataCallback == null) {
      throw new Error(
        'Listen before you start speaking. God gave you two ears and one mouth for a reason.'
      )
    }
    if (message.messageType !== 'general') return await this.#sendAuthMessage(message)
    await this.#sendGeneralMessage(message)
  }

  async #fetchAuthMessage(
    url: string,
    message: AuthMessage,
    signal: AbortSignal
  ): Promise<Response> {
    try {
      return await this.fetchClient(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100(message),
        // Authentication messages, signatures, certificate material, and
        // request bodies are scoped to the configured peer. Native fetch
        // follows redirects by default and can replay them elsewhere.
        redirect: 'error',
        signal
      })
    } catch (error) {
      throw this.#createNetworkError(url, error)
    }
  }

  async #sendAuthMessage(message: AuthMessage): Promise<void> {
    return await new Promise((resolve, reject) => {
      void (async () => {
        try {
          const url = `${this.baseUrl}/.well-known/auth`
          const responseWork = this.#withDeadline(url, async signal => {
            const response = await this.#fetchAuthMessage(url, message, signal)
            if (!response.ok) {
              const body = await this.readResponseBody(
                url,
                response,
                this.#maxHandshakeResponseBytes,
                signal
              )
              throw this.#createUnauthenticatedResponseError(url, response, body)
            }
            const responseBytes = await this.readResponseBody(
              url,
              response,
              this.#maxHandshakeResponseBytes,
              signal
            )
            await this.onDataCallback!(
              normalizeBRC100ByteFields(JSON.parse(toUTF8(responseBytes)), [
                'payload',
                'signature'
              ]) as AuthMessage
            )
          })
          if (message.messageType !== 'initialRequest') resolve()
          await responseWork
          if (message.messageType === 'initialRequest') resolve()
        } catch (error) {
          reject(error)
        }
      })()
    })
  }

  #encodeRequestBody(body: number[], contentType: string): string | Uint8Array {
    if (
      contentType.includes('application/json') ||
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('text/plain')
    ) {
      return toUTF8Strict(body)
    }
    return new Uint8Array(body)
  }

  #prepareGeneralRequest(message: AuthMessage): any {
    const request: any = this.deserializeRequestPayload(message.payload)
    if (typeof request.headers !== 'object') request.headers = {}
    request.headers['x-bsv-auth-version'] = message.version
    request.headers['x-bsv-auth-identity-key'] = message.identityKey
    request.headers['x-bsv-auth-nonce'] = message.nonce
    request.headers['x-bsv-auth-your-nonce'] = message.yourNonce
    request.headers['x-bsv-auth-signature'] = toHex(message.signature)
    request.headers['x-bsv-auth-request-id'] = request.requestId

    if (request.body != null) {
      const contentType = request.headers['content-type']
      if (contentType == null) {
        throw new Error('Content-Type header is required for requests with a body.')
      }
      request.body = this.#encodeRequestBody(request.body, String(contentType ?? ''))
    }
    return request
  }

  async #fetchGeneralResponse(url: string, request: any, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchClient(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal
      })
    } catch (error) {
      throw this.#createNetworkError(url, error)
    }
  }

  #validateResponseAuthentication(url: string, response: Response, body: number[]): void {
    const missingHeaders = [
      'x-bsv-auth-version',
      'x-bsv-auth-identity-key',
      'x-bsv-auth-signature'
    ].filter(headerName => {
      const value = response.headers.get(headerName)
      return value == null || value.trim().length === 0
    })
    if (missingHeaders.length > 0) {
      throw this.#createUnauthenticatedResponseError(url, response, body, missingHeaders)
    }
  }

  #parseRequestedCertificates(
    url: string,
    response: Response
  ): RequestedCertificateSet | undefined {
    const header = response.headers.get('x-bsv-auth-requested-certificates')
    if (header == null) return undefined
    if (UtilsToArray(header, 'utf8').length > MAX_REQUESTED_CERTIFICATES_HEADER_BYTES) {
      throw this.#createMalformedHeaderError(
        url,
        'x-bsv-auth-requested-certificates',
        '[oversized]',
        new Error('header exceeds its byte limit')
      )
    }
    try {
      return JSON.parse(header) as RequestedCertificateSet
    } catch (error) {
      throw this.#createMalformedHeaderError(
        url,
        'x-bsv-auth-requested-certificates',
        header,
        error
      )
    }
  }

  #collectSignedResponseHeaders(response: Response): Array<[string, string]> {
    const includedHeaders: Array<[string, string]> = []
    let totalBytes = 0
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase()
      const isSignedHeader = lowerKey.startsWith('x-bsv-') || lowerKey === 'authorization'
      if (isSignedHeader && !lowerKey.startsWith('x-bsv-auth')) {
        const keyBytes = UtilsToArray(lowerKey, 'utf8').length
        const valueBytes = UtilsToArray(value, 'utf8').length
        if (
          keyBytes < 1 ||
          keyBytes > MAX_SIGNED_RESPONSE_HEADER_KEY_BYTES ||
          valueBytes > MAX_SIGNED_RESPONSE_HEADER_VALUE_BYTES
        ) {
          throw new Error('Authenticated response contains an oversized signed header')
        }
        totalBytes += keyBytes + valueBytes
        if (
          includedHeaders.length >= MAX_SIGNED_RESPONSE_HEADERS ||
          totalBytes > MAX_SIGNED_RESPONSE_HEADER_BYTES
        ) {
          throw new Error('Authenticated response signed headers exceed their limit')
        }
        includedHeaders.push([lowerKey, value])
      }
    })
    return includedHeaders.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
  }

  #writeGeneralResponsePayload(response: Response, body: number[]): number[] {
    const writer = new Writer()
    const requestId = response.headers.get('x-bsv-auth-request-id')
    if (requestId != null) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(requestId)) {
        throw new Error('Authenticated response request ID must be canonical base64')
      }
      const requestIdBytes = UtilsToArray(requestId, 'base64')
      if (requestIdBytes.length !== 32 || toBase64(requestIdBytes) !== requestId) {
        throw new Error('Authenticated response request ID must encode exactly 32 bytes')
      }
      writer.write(requestIdBytes)
    }
    writer.writeVarIntNum(response.status)

    const includedHeaders = this.#collectSignedResponseHeaders(response)
    writer.writeVarIntNum(includedHeaders.length)
    for (const [headerKey, headerValue] of includedHeaders) {
      const keyBytes = UtilsToArray(headerKey, 'utf8')
      const valueBytes = UtilsToArray(headerValue, 'utf8')
      writer.writeVarIntNum(keyBytes.length)
      writer.write(keyBytes)
      writer.writeVarIntNum(valueBytes.length)
      writer.write(valueBytes)
    }
    // BRC-104 sections 6.7.3 and 6.9 use -1 for absent or empty response
    // bodies. Zero would not reproduce a conforming server's signed preimage.
    if (body.length === 0) {
      writer.writeVarIntNum(-1)
    } else {
      writer.writeVarIntNum(body.length)
      writer.write(body)
    }
    return writer.toArray()
  }

  #createGeneralResponseMessage(url: string, response: Response, body: number[]): AuthMessage {
    const signatureHex = response.headers.get('x-bsv-auth-signature')
    if (
      signatureHex == null ||
      signatureHex.length === 0 ||
      signatureHex.length > MAX_AUTH_SIGNATURE_HEX_BYTES * 2 ||
      !/^(?:[0-9a-fA-F]{2})+$/.test(signatureHex)
    ) {
      throw this.#createMalformedHeaderError(
        url,
        'x-bsv-auth-signature',
        '[invalid]',
        new Error('signature must be bounded even-length hexadecimal')
      )
    }
    const message: AuthMessage = {
      version: response.headers.get('x-bsv-auth-version'),
      messageType:
        response.headers.get('x-bsv-auth-message-type') === 'certificateRequest'
          ? 'certificateRequest'
          : 'general',
      identityKey: response.headers.get('x-bsv-auth-identity-key'),
      nonce: response.headers.get('x-bsv-auth-nonce') ?? undefined,
      yourNonce: response.headers.get('x-bsv-auth-your-nonce') ?? undefined,
      requestedCertificates: this.#parseRequestedCertificates(url, response),
      payload: this.#writeGeneralResponsePayload(response, body),
      signature: UtilsToArray(signatureHex, 'hex')
    }
    if (message.version == null) {
      throw this.#createUnauthenticatedResponseError(url, response, body)
    }
    return message
  }

  async #sendGeneralMessage(message: AuthMessage): Promise<void> {
    const request = this.#prepareGeneralRequest(message)
    const url = `${this.baseUrl}${request.urlPostfix}`
    await this.#withDeadline(url, async signal => {
      const response = await this.#fetchGeneralResponse(url, request, signal)
      const body = await this.readResponseBody(url, response, this.maxResponseBytes, signal)
      this.#validateResponseAuthentication(url, response, body)
      await this.onDataCallback!(this.#createGeneralResponseMessage(url, response, body))
    })
  }

  private async readResponseBody(
    url: string,
    response: Response,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<number[]> {
    const contentLength = response.headers.get('content-length')
    if (contentLength != null) {
      if (!/^\d+$/.test(contentLength)) {
        throw new Error(`Invalid Content-Length returned by ${url}`)
      }
      const declaredLength = Number(contentLength)
      if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Authenticated response from ${url} exceeds ${maximumBytes} bytes`)
      }
    }
    if (response.body == null) return []

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    const cancelOnAbort = (): void => {
      void reader.cancel(new Error('Authenticated response deadline exceeded')).catch(() => {})
    }
    signal?.addEventListener('abort', cancelOnAbort, { once: true })
    try {
      while (true) {
        if (signal?.aborted === true) throw new Error(`Authenticated request to ${url} timed out`)
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > maximumBytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`Authenticated response from ${url} exceeds ${maximumBytes} bytes`)
        }
        chunks.push(value)
      }
    } finally {
      signal?.removeEventListener('abort', cancelOnAbort)
      reader.releaseLock()
    }

    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return Array.from(bytes)
  }

  async #withDeadline<T>(url: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(
          new Error(
            `Authenticated request to ${url} timed out after ${this.#requestTimeoutMs} milliseconds`
          )
        )
      }, this.#requestTimeoutMs)
    })
    try {
      return await Promise.race([work(controller.signal), deadline])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  /**
   * Registers a callback to handle incoming messages.
   * This must be called before sending any messages to ensure responses can be processed.
   *
   * @param callback - A function to invoke when an incoming AuthMessage is received.
   * @returns A promise that resolves once the callback is set.
   */
  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.onDataCallback = async m => await callback(m)
  }

  #createNetworkError(url: string, originalError: unknown): Error {
    const baseMessage = `Network error while sending authenticated request to ${url}`
    if (originalError instanceof Error) {
      const error = new Error(`${baseMessage}: ${originalError.message}`)
      error.stack = originalError.stack
      ;(error as any).cause = originalError
      return error
    }
    return new Error(`${baseMessage}: ${toSafeString(originalError)}`)
  }

  #createUnauthenticatedResponseError(
    url: string,
    response: Response,
    bodyBytes: number[],
    missingHeaders: string[] = []
  ): Error {
    const statusText = (response.statusText ?? '').trim()
    const statusDescription =
      statusText.length > 0 ? `${response.status} ${statusText}` : `${response.status}`
    const headerMessage =
      missingHeaders.length > 0
        ? `missing headers: ${missingHeaders.join(', ')}`
        : 'response lacked required BSV auth headers'
    const bodyPreview = this.#getBodyPreview(bodyBytes, response.headers.get('content-type'))
    const parts = [
      `Received HTTP ${statusDescription} from ${url} without valid BSV authentication (${headerMessage})`
    ]
    if (bodyPreview != null) {
      parts.push(`body preview: ${bodyPreview}`)
    }

    const error = new Error(parts.join(' - '))
    ;(error as any).details = {
      url,
      status: response.status,
      statusText: response.statusText,
      missingHeaders,
      bodyPreview
    }
    return error
  }

  #createMalformedHeaderError(
    url: string,
    headerName: string,
    headerValue: string,
    cause: unknown
  ): Error {
    const errorMessage = `Failed to parse ${headerName} returned by ${url}: ${headerValue}`
    if (cause instanceof Error) {
      const error = new Error(`${errorMessage}. ${cause.message}`)
      error.stack = cause.stack
      ;(error as any).cause = cause
      return error
    }
    return new Error(`${errorMessage}. ${toSafeString(cause)}`)
  }

  #getBodyPreview(bodyBytes: number[], contentType: string | null): string | undefined {
    if (bodyBytes.length === 0) {
      return undefined
    }

    const maxBytesForPreview = 1024
    const truncated = bodyBytes.length > maxBytesForPreview
    const slice = truncated ? bodyBytes.slice(0, maxBytesForPreview) : bodyBytes
    const isText = this.#isTextualContent(contentType, slice)

    let preview: string
    if (isText) {
      try {
        preview = toUTF8(slice)
      } catch {
        preview = this.#formatBinaryPreview(slice, truncated)
      }
    } else {
      preview = this.#formatBinaryPreview(slice, truncated)
    }

    if (preview.length > 512) {
      preview = `${preview.slice(0, 512)}…`
    }
    if (truncated) {
      preview = `${preview} (truncated)`
    }
    return preview
  }

  #isTextualContent(contentType: string | null, sample: number[]): boolean {
    if (sample.length === 0) {
      return false
    }

    if (contentType != null) {
      const lowered = contentType.toLowerCase()
      const textualTokens = [
        'application/json',
        'application/problem+json',
        'application/xml',
        'application/xhtml+xml',
        'application/javascript',
        'application/ecmascript',
        'application/x-www-form-urlencoded',
        'text/'
      ]
      if (textualTokens.some(token => lowered.includes(token)) || lowered.includes('charset=')) {
        return true
      }
    }

    const printableCount = sample.reduce((count, byte) => {
      if (byte === 9 || byte === 10 || byte === 13) {
        return count + 1
      }
      if (byte >= 32 && byte <= 126) {
        return count + 1
      }
      return count
    }, 0)
    return printableCount / sample.length > 0.8
  }

  #formatBinaryPreview(bytes: number[], truncated: boolean): string {
    const hex = bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')
    return `0x${hex}${truncated ? '…' : ''}`
  }

  /**
   * Deserializes a request payload from a byte array into an HTTP request-like structure.
   *
   * @param payload - The serialized payload to deserialize.
   * @returns An object representing the deserialized request, including the method,
   *          URL postfix (path and query string), headers, body, and request ID.
   */
  deserializeRequestPayload(payload: number[]): {
    method: string
    urlPostfix: string
    headers: Record<string, string>
    body: number[]
    requestId: string
  } {
    if (!Array.isArray(payload) || payload.length > MAX_AUTH_REQUEST_PAYLOAD_BYTES) {
      throw new Error('Authenticated request payload exceeds the configured limit')
    }
    // Create a reader
    const requestReader = new Reader(payload)
    // The first 32 bytes is the requestId
    const requestId = toBase64(requestReader.read(32))

    // Method
    const methodLength = requestReader.readVarIntNumStrict(false)
    if (methodLength < 0 || methodLength > MAX_REQUEST_METHOD_BYTES) {
      throw new Error('Authenticated request contains an invalid method length')
    }
    let method = 'GET'
    if (methodLength > 0) {
      method = toUTF8Strict(requestReader.read(methodLength))
    }

    // Path
    const pathLength = requestReader.readVarIntNumStrict()
    if (pathLength > MAX_REQUEST_TARGET_COMPONENT_BYTES) {
      throw new Error('Authenticated request path exceeds its byte limit')
    }
    let path = ''
    if (pathLength > 0) {
      path = toUTF8Strict(requestReader.read(pathLength))
    }

    // Search
    const searchLength = requestReader.readVarIntNumStrict()
    if (searchLength > MAX_REQUEST_TARGET_COMPONENT_BYTES) {
      throw new Error('Authenticated request query exceeds its byte limit')
    }
    let search = ''
    if (searchLength > 0) {
      search = toUTF8Strict(requestReader.read(searchLength))
    }

    // Read headers
    const requestHeaders = Object.create(null) as Record<string, string>
    const nHeaders = requestReader.readVarIntNumStrict(false)
    if (nHeaders > MAX_SIGNED_RESPONSE_HEADERS) {
      throw new Error('Authenticated request header count exceeds its limit')
    }
    let headerBytes = 0
    if (nHeaders > 0) {
      for (let i = 0; i < nHeaders; i++) {
        const nHeaderKeyBytes = requestReader.readVarIntNumStrict(false)
        if (nHeaderKeyBytes < 1 || nHeaderKeyBytes > MAX_SIGNED_RESPONSE_HEADER_KEY_BYTES) {
          throw new Error('Authenticated request header name exceeds its byte limit')
        }
        const headerKeyBytes = requestReader.read(nHeaderKeyBytes)
        const headerKey = toUTF8Strict(headerKeyBytes)
        const nHeaderValueBytes = requestReader.readVarIntNumStrict(false)
        // BRC-105 carries the payment's Atomic BEEF in this request header.
        // It shares the aggregate budget; ordinary headers and all
        // signed response headers retain their smaller per-value ceiling.
        const maxValueBytes =
          headerKey.toLowerCase() === 'x-bsv-payment'
            ? MAX_SIGNED_RESPONSE_HEADER_BYTES
            : MAX_SIGNED_RESPONSE_HEADER_VALUE_BYTES
        if (nHeaderValueBytes > maxValueBytes) {
          throw new Error('Authenticated request header value exceeds its byte limit')
        }
        const headerValueBytes = requestReader.read(nHeaderValueBytes)
        const headerValue = toUTF8Strict(headerValueBytes)
        headerBytes += nHeaderKeyBytes + nHeaderValueBytes
        if (headerBytes > MAX_SIGNED_RESPONSE_HEADER_BYTES) {
          throw new Error('Authenticated request headers exceed their byte limit')
        }
        if (Object.hasOwn(requestHeaders, headerKey)) {
          throw new Error(`Authenticated request contains duplicate header: ${headerKey}`)
        }
        requestHeaders[headerKey] = headerValue
      }
    }

    // Read body
    let requestBody
    const requestBodyBytes = requestReader.readVarIntNumStrict()
    if (requestBodyBytes < -1 || requestBodyBytes > MAX_AUTH_REQUEST_PAYLOAD_BYTES) {
      throw new Error('Authenticated request body exceeds the configured limit')
    }
    if (requestBodyBytes > 0) {
      requestBody = requestReader.read(requestBodyBytes)
    }
    if (!requestReader.eof()) {
      throw new Error('Authenticated request contains trailing bytes')
    }

    // Return the deserialized RequestInit
    return {
      urlPostfix: path + search,
      method,
      headers: requestHeaders,
      body: requestBody,
      requestId
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return candidate
}
