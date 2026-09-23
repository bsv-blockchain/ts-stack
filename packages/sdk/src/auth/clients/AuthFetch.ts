// @ts-nocheck
import {
  Reader,
  Writer as UtilsWriter,
  toArray as UtilsToArray,
  toBase64,
  toHex as UtilsToHex,
  toUTF8Strict
} from '../../primitives/utils.js'
import Random from '../../primitives/Random.js'
import P2PKH from '../../script/templates/P2PKH.js'
import PublicKey from '../../primitives/PublicKey.js'
import {
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '../../wallet/Wallet.interfaces.js'
import { stringifyBRC100 } from '../../wallet/BRC100ByteEncoding.js'
import { createNonce } from '../utils/createNonce.js'
import { Peer } from '../Peer.js'
import {
  DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES,
  SimplifiedFetchTransport,
  SimplifiedFetchTransportOptions
} from '../transports/SimplifiedFetchTransport.js'
import { SessionManager, AsyncSessionManager } from '../SessionManager.js'
import { RequestedCertificateSet } from '../types.js'
import { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'
import { Writer } from '../../primitives/utils.js'
import { getVerifiableCertificates } from '../utils/getVerifiableCertificates.js'
import { copyAuthByteArray } from '../AuthMessageValidation.js'
import {
  authenticatedContentType,
  PaymentTransportError,
  paymentTransports,
  preparePaymentTransport,
  resolvePaymentTransportLimits,
  type PaymentTransportLimits
} from '../utils/paymentTransport.js'
import { Beef } from '../../transaction/Beef.js'
import { validateWalletResult } from '../../wallet/WalletResultValidation.js'

interface SimplifiedFetchRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: any
  retryCounter?: number
  paymentContext?: PaymentRetryContext
  paymentRetryAttempts?: number
  /** BRC-118 wire limits. Infeasible payments are refused before broadcast. */
  paymentTransport?: PaymentTransportLimits
  /** Cancellation before broadcast releases the prepared action when the wallet permits. */
  signal?: AbortSignal
  /**
   * Optional wallet action labels applied to BRC-105 payment transactions
   * created for 402 responses. Use these to find payments later via
   * listActions (e.g. app-specific categories). AuthFetch always also
   * applies `brc105 <hexPrefix> <hexSuffix>`, where prefix/suffix are the
   * BRC-105 base64 nonces hex-encoded so wallet label lowercasing does not
   * corrupt them. Decode hex → bytes → base64 to recover the wire values.
   */
  labels?: string[]
}

interface AuthPeer {
  peer: Peer
  identityKey?: string
  supportsMutualAuth?: boolean
  pendingCertificateRequests: Array<true>
}

interface PaymentErrorLogEntry {
  attempt: number
  timestamp: string
  message: string
  stack?: string
}

interface PaymentRetryContext {
  satoshisRequired: number
  transactionBase64: string
  derivationPrefix: string
  derivationSuffix: string
  serverIdentityKey: string
  clientIdentityKey: string
  attempts: number
  maxAttempts: number
  errors: PaymentErrorLogEntry[]
  txid?: string
  state?: 'prepared' | 'submitted' | 'uncertain'
  originalRequest?: { method: string; headers: Record<string, string>; body?: Uint8Array }
  preparedRequest?: {
    headers: Record<string, string>
    body?: Uint8Array
    transport: 'header' | 'multipart'
  }
  requestSummary: {
    url: string
    method: string
    headers: Record<string, string>
    bodyType: string
    bodyByteLength: number
  }
}

interface RequestBodySummary {
  type: string
  byteLength: number
}

const PAYMENT_VERSION = '1.0'
const AUTH_RESPONSE_TIMEOUT_MS = 30000
const MAX_PENDING_AUTH_REQUESTS = 1000
const MAX_BUFFERED_CERTIFICATES = 1000
const MAX_AUTH_RESPONSE_HEADERS = 128
const MAX_AUTH_RESPONSE_HEADER_KEY_BYTES = 256
const MAX_AUTH_RESPONSE_HEADER_VALUE_BYTES = 8192
const MAX_AUTH_RESPONSE_HEADER_BYTES = 64 * 1024
const MAX_AUTH_RESPONSE_FRAME_OVERHEAD_BYTES = 128 * 1024
const MAX_PAYMENT_TRANSACTION_BYTES = 16 * 1024 * 1024
const REDACTED_LOG_VALUE = '[redacted]'

/**
 * Optional 402 response header by which a server declares transactions it already holds.
 *
 * A payment carries its ancestry so the recipient can verify it without asking anyone. Any
 * ancestor the recipient ALREADY has is redundant weight — but the payer cannot know which
 * those are, so today it sends all of them. Chained payments therefore grow without bound:
 * each spends the previous payment's unconfirmed change, so every payment re-ships the whole
 * unconfirmed run until a block collapses it to a merkle path. Past ~32KB of total request
 * headers a Cloudflare-fronted origin refuses the request outright, and the payer has already
 * broadcast and paid by then.
 *
 * `knownTxids` is the existing wallet mechanism for exactly this: listed txids are emitted as
 * txid-only instead of full transactions. It is unused here only because nothing tells the
 * payer what the recipient has.
 *
 * Txid-only encoding is specified by BRC-96 "BEEF V2, Txid Only Extension"
 * (https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0096.md): Tx Data Format `02`
 * carries just the 32-byte txid under version marker `0200BEEF`, for use "when parties
 * exchanging BEEFs have already validated certain transactions". Note the spec's wording —
 * such an entry "is treated as implicitly valid", i.e. the recipient verifies nothing about
 * it, which is why only the recipient may declare one.
 *
 * Format: comma-separated 64-character hex txids. Absent header = no change in behaviour.
 *
 * SAFETY: only the recipient may populate this. Omitting an ancestor the recipient lacks makes
 * the payment unverifiable, so the list must come from the recipient's own records — never
 * inferred by the payer.
 */
const KNOWN_TXIDS_HEADER = 'x-bsv-payment-known-txids'
const TXID_REGEX = /^[0-9a-fA-F]{64}$/
/** Bounded so a hostile or buggy server cannot inflate the createAction call. */
const MAX_KNOWN_TXIDS = 256

/**
 * Parse the known-txids header into a validated list.
 *
 * Deliberately lenient about the header being absent, empty or partly malformed: this is an
 * optimisation, and a bad entry should cost bytes, never a failed payment. Anything that is not
 * a well-formed txid is dropped rather than throwing.
 */
export function parseKnownTxidsHeader(headerValue: string | null): string[] | undefined {
  if (headerValue == null) return undefined
  const txids = headerValue
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => TXID_REGEX.test(t))
  if (txids.length === 0) return undefined
  return Array.from(new Set(txids)).slice(0, MAX_KNOWN_TXIDS)
}

/**
 * AuthFetch provides a lightweight fetch client for interacting with servers
 * over a simplified HTTP transport mechanism. It integrates session management, peer communication,
 * and certificate handling to enable secure and mutually-authenticated requests.
 *
 * Additionally, it automatically handles 402 Payment Required responses by creating
 * and sending BSV payment transactions when necessary. The configured wallet's
 * `createAction` policy is the spending-authorization boundary: applications
 * should use a wallet that requires the intended user/policy approval.
 * Recipients may advertise already-validated ancestors through the optional
 * `x-bsv-payment-known-txids` response header. Up to 256 unique, valid lowercase
 * transaction IDs are forwarded to wallet `createAction` options, including
 * newly created payments after repricing. An absent or invalid-only header
 * preserves existing payment creation behavior.
 * The header is an optional SDK extension, not a standardized BRC-105 header.
 *
 * Payment diagnostics retain only the URL origin, header names (and
 * `Content-Type`), amount, identity keys, retry counts, and bounded error
 * metadata. URL credentials/path/query, authorization values, transaction
 * bytes, and payment derivation material are not included.
 */
export class AuthFetch {
  private readonly sessionManager: SessionManager
  private readonly wallet: WalletInterface
  private readonly pendingRequestNonces: Set<string> = new Set()
  private readonly certificatesReceived: VerifiableCertificate[] = []
  private readonly requestedCertificates?: RequestedCertificateSet
  private readonly originator?: OriginatorDomainNameStringUnder250Bytes
  readonly #transportOptions: SimplifiedFetchTransportOptions
  private readonly maxResponseBytes: number
  private readonly fetchClient?: typeof fetch
  peers: Record<string, AuthPeer> = {}

  /**
   * Constructs a new AuthFetch instance.
   * @param wallet - The wallet instance for signing and authentication.
   * @param requestedCertificates - Optional v0.1 certificate allowlist/request. AuthFetch does not interpret allowlist validation as application authorization.
   */
  constructor(
    wallet: WalletInterface,
    requestedCertificates?: RequestedCertificateSet,
    sessionManager?: SessionManager | AsyncSessionManager,
    originator?: OriginatorDomainNameStringUnder250Bytes,
    transportOptions: SimplifiedFetchTransportOptions = {},
    fetchClient?: typeof fetch
  ) {
    this.wallet = wallet
    this.requestedCertificates = requestedCertificates
    // See `Peer.sessionManager`: field stays typed as the synchronous
    // `SessionManager` for back-compat; if an `AsyncSessionManager` is
    // injected, the underlying Peer awaits all calls internally.
    this.sessionManager = (sessionManager ?? new SessionManager()) as SessionManager
    this.originator = originator
    this.#transportOptions = { ...transportOptions }
    this.fetchClient = fetchClient
    this.maxResponseBytes = positiveResponseLimit(
      transportOptions.maxResponseBytes,
      DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES
    )
  }

  /**
   * Mutually authenticates and sends a HTTP request to a server.
   *
   * 1) Attempt the request.
   * 2) If 402 Payment Required, ask the wallet to authorize, create, and send payment.
   * 3) Return the final response.
   *
   * @param url - The URL to send the request to.
   * @param config - Configuration options for the request, including method, headers, body,
   *   optional payment retry controls, and optional `labels` merged onto any BRC-105 payment action.
   * @returns A promise that resolves with the server's response, structured as a Response-like object.
   *
   * @throws Will throw an error if unsupported headers are used or other validation fails.
   */
  async fetch(url: string, config: SimplifiedFetchRequestOptions = {}): Promise<Response> {
    if (config.signal?.aborted === true)
      throw new PaymentTransportError('ERR_PAYMENT_CANCELLED', 'Paid request cancelled.')
    // Retain the caller's original bytes before any network or wallet await.
    const headers = { ...config.headers }
    const ownedBody =
      config.body == null
        ? undefined
        : new Uint8Array(await this.normalizeBodyToNumberArray(config.body))
    config = {
      ...config,
      headers,
      body: ownedBody,
      paymentTransport: { ...config.paymentTransport },
      labels: config.labels?.slice()
    }
    if (typeof config.retryCounter === 'number') {
      if (config.retryCounter <= 0) {
        throw new Error('Request failed after maximum number of retries.')
      }
      config.retryCounter--
    }
    const response = await new Promise<Response>((resolve, reject) => {
      void (async () => {
        try {
          // Apply defaults
          const { method = 'GET', headers = {}, body } = config

          // Extract a base url
          const parsedUrl = new URL(url)
          const baseURL = parsedUrl.origin

          const peerToUse = await this.#getOrCreatePeer(baseURL)
          if (peerToUse.supportsMutualAuth === false) {
            resolve(await this.handleFetchAndValidate(url, config, peerToUse))
            return
          }

          // Serialize the simplified fetch request.
          const requestNonce = Random(32)
          const requestNonceAsBase64 = toBase64(requestNonce)

          const writer = await this.serializeRequest(method, headers, body, parsedUrl, requestNonce)

          // Setup general message listener to resolve requests once a response is received
          if (this.pendingRequestNonces.size >= MAX_PENDING_AUTH_REQUESTS) {
            throw new Error('Authentication request capacity exceeded.')
          }

          let listenerId: number | undefined
          let responseTimeout: ReturnType<typeof setTimeout>
          let cleaned = false
          const cleanup = (): void => {
            if (cleaned) return
            cleaned = true
            if (
              listenerId !== undefined &&
              typeof peerToUse.peer.stopListeningForGeneralMessages === 'function'
            ) {
              peerToUse.peer.stopListeningForGeneralMessages(listenerId)
            }
            clearTimeout(responseTimeout)
            this.pendingRequestNonces.delete(requestNonceAsBase64)
            config.signal?.removeEventListener('abort', cancelRequest)
          }
          const resolveRequest = (response: Response): void => {
            cleanup()
            resolve(response)
          }
          const rejectRequest = (error: unknown): void => {
            cleanup()
            reject(error)
          }
          const cancelRequest = (): void =>
            rejectRequest(
              new PaymentTransportError(
                'ERR_PAYMENT_CANCELLED',
                'Paid request cancelled.',
                config.paymentContext == null
                  ? undefined
                  : { txid: config.paymentContext.txid, state: config.paymentContext.state }
              )
            )
          config.signal?.addEventListener('abort', cancelRequest, { once: true })
          if (config.signal?.aborted === true) {
            cancelRequest()
            return
          }

          this.pendingRequestNonces.add(requestNonceAsBase64)
          listenerId = peerToUse.peer.listenForGeneralMessages(
            (senderPublicKey: string, payload: number[]) => {
              const responseValue = this.parseAuthenticatedResponse(
                baseURL,
                requestNonceAsBase64,
                senderPublicKey,
                payload
              )
              if (responseValue !== undefined) resolveRequest(responseValue)
            }
          )
          responseTimeout = setTimeout(() => {
            rejectRequest(new Error('Timed out waiting for authenticated response.'))
          }, AUTH_RESPONSE_TIMEOUT_MS)

          // Before sending general messages to the peer, ensure that no certificate requests are pending.
          // This way, the user would need to choose to either allow or reject the certificate request first.
          // If the server has a resource that requires certificates to be sent before access would be granted,
          // this makes sure the user has a chance to send the certificates before the resource is requested.
          try {
            if (peerToUse.pendingCertificateRequests.length > 0) {
              await this.waitForPendingCertificateRequests(peerToUse)
            }

            // A certificate prompt can outlive the request deadline. Never
            // dispatch a request after its caller has already seen a timeout.
            if (cleaned) return
            await peerToUse.peer.toPeer(
              writer.toArray(),
              config.paymentContext?.serverIdentityKey ?? peerToUse.identityKey
            )
          } catch (error) {
            // Late transport/session failures must not start recovery that
            // replays a request after its response deadline has expired.
            if (cleaned) return
            cleanup()
            try {
              resolveRequest(
                await this.recoverAuthenticatedSend(error, baseURL, url, config, peerToUse)
              )
            } catch (recoveryError) {
              rejectRequest(recoveryError)
            }
          }
        } catch (error) {
          reject(error)
        }
      })()
    })
    // Check if server requires payment to access the requested route
    if (response.status === 402) {
      // Create and attach a payment, then retry
      return await this.handlePaymentAndRetry(url, config, response)
    }

    return response
  }

  async #getOrCreatePeer(baseURL: string): Promise<AuthPeer> {
    const existingPeer = this.peers[baseURL]
    if (existingPeer !== undefined) return existingPeer

    const newPeer = new Peer(
      this.wallet,
      this.#createTransport(baseURL),
      this.requestedCertificates,
      this.sessionManager,
      undefined,
      this.originator
    )
    await newPeer.ready
    const peerState: AuthPeer = {
      peer: newPeer,
      pendingCertificateRequests: []
    }
    this.peers[baseURL] = peerState
    newPeer.listenForCertificatesReceived(
      (_senderPublicKey: string, certs: VerifiableCertificate[]) => {
        this.retainReceivedCertificates(certs)
      }
    )
    newPeer.listenForCertificatesRequested((async (
      verifier: string,
      requestedCertificates: RequestedCertificateSet
    ) => {
      try {
        peerState.pendingCertificateRequests.push(true)
        const certificatesToInclude = await getVerifiableCertificates(
          this.wallet,
          requestedCertificates,
          verifier,
          this.originator
        )
        if (certificatesToInclude.length > 0) {
          await newPeer.sendCertificateResponse(verifier, certificatesToInclude)
        }
      } finally {
        // Give the backend 500 ms to process the certificates we just sent, before releasing the queue entry.
        await this.wait(500)
        peerState.pendingCertificateRequests.shift()
      }
    }) as Function)
    return peerState
  }

  private isStaleSessionError(error: unknown, peerToUse: AuthPeer): boolean {
    return (
      error instanceof Error &&
      (error.message.includes('Session not found for nonce') ||
        (error.message.includes('without valid BSV authentication') &&
          peerToUse.identityKey != null &&
          (error as any).details?.status === 401))
    )
  }

  private async recoverAuthenticatedSend(
    error: unknown,
    baseURL: string,
    url: string,
    config: SimplifiedFetchRequestOptions,
    peerToUse: AuthPeer
  ): Promise<Response> {
    if (this.isStaleSessionError(error, peerToUse)) {
      delete this.peers[baseURL]
      config.retryCounter ??= 3
      return await this.fetch(url, config)
    }
    if (error instanceof Error && error.message.includes('HTTP server failed to authenticate')) {
      return await this.handleFetchAndValidate(url, config, peerToUse)
    }
    throw error
  }

  private parseAuthenticatedResponse(
    baseURL: string,
    requestNonceAsBase64: string,
    senderPublicKey: string,
    payload: number[]
  ): Response | undefined {
    if (payload.length > this.maxResponseBytes + MAX_AUTH_RESPONSE_FRAME_OVERHEAD_BYTES) {
      throw new Error('Authenticated response frame exceeds the configured limit.')
    }
    const responseReader = new StrictResponseReader(payload)
    const responseNonceAsBase64 = toBase64(responseReader.readExact(32, 'response nonce'))
    if (responseNonceAsBase64 !== requestNonceAsBase64) return undefined

    const peerState = this.peers[baseURL]
    if (peerState !== undefined) {
      peerState.identityKey = senderPublicKey
      peerState.supportsMutualAuth = true
    }

    const statusCode = responseReader.readVarInt('status code')
    if (statusCode < 200 || statusCode > 599) {
      throw new Error('Authenticated response contains an invalid HTTP status code.')
    }
    const responseHeaders = new Headers()
    const nHeaders = responseReader.readBoundedLength(
      MAX_AUTH_RESPONSE_HEADERS,
      'response header count'
    )
    let headerBytes = 0
    for (let i = 0; i < nHeaders; i++) {
      const nHeaderKeyBytes = responseReader.readBoundedLength(
        MAX_AUTH_RESPONSE_HEADER_KEY_BYTES,
        'response header name length',
        1
      )
      const headerKey = toUTF8Strict(
        responseReader.readExact(nHeaderKeyBytes, 'response header name')
      )
      const nHeaderValueBytes = responseReader.readBoundedLength(
        MAX_AUTH_RESPONSE_HEADER_VALUE_BYTES,
        'response header value length'
      )
      const headerValue = toUTF8Strict(
        responseReader.readExact(nHeaderValueBytes, 'response header value')
      )
      headerBytes += nHeaderKeyBytes + nHeaderValueBytes
      if (headerBytes > MAX_AUTH_RESPONSE_HEADER_BYTES) {
        throw new Error('Authenticated response headers exceed the configured limit.')
      }
      responseHeaders.set(headerKey, headerValue)
    }
    responseHeaders.set('x-bsv-auth-identity-key', senderPublicKey)

    const responseBodyBytes = responseReader.readVarInt('response body length', true)
    if (responseBodyBytes < -1 || responseBodyBytes > this.maxResponseBytes) {
      throw new Error('Authenticated response body exceeds the configured limit.')
    }
    const responseBody =
      responseBodyBytes > 0
        ? new Uint8Array(responseReader.readExact(responseBodyBytes, 'response body'))
        : null
    responseReader.assertFinished()
    return new Response(responseBody, {
      status: statusCode,
      statusText: `${statusCode}`,
      headers: responseHeaders
    })
  }

  /**
   * Request Certificates from a Peer
   * @param baseUrl
   * @param certificatesToRequest
   */
  async sendCertificateRequest(
    baseUrl: string,
    certificatesToRequest: RequestedCertificateSet
  ): Promise<VerifiableCertificate[]> {
    const parsedUrl = new URL(baseUrl)
    const baseURL = parsedUrl.origin

    const peerToUse = await this.#getOrCreatePeer(baseURL)

    // Return a promise that resolves when certificates are received
    const CERTIFICATE_REQUEST_TIMEOUT_MS = 30000
    return await new Promise<VerifiableCertificate[]>((resolve, reject) => {
      let settled = false

      const cleanup = (): void => {
        settled = true
        clearTimeout(timer)
        peerToUse.peer.stopListeningForCertificatesReceived(callbackId)
      }

      // Set up the listener before making the request
      const callbackId = peerToUse.peer.listenForCertificatesReceived(
        (_senderPublicKey: string, certs: VerifiableCertificate[]) => {
          if (settled) return
          cleanup()
          resolve(certs)
        }
      )

      const timer = setTimeout(() => {
        if (settled) return
        cleanup()
        reject(
          new Error(
            `sendCertificateRequest timed out after ${CERTIFICATE_REQUEST_TIMEOUT_MS}ms waiting for certificate response from ${baseURL}`
          )
        )
      }, CERTIFICATE_REQUEST_TIMEOUT_MS)

      void peerToUse.peer
        .requestCertificates(certificatesToRequest, peerToUse.identityKey)
        .catch(error => {
          if (!settled) {
            cleanup()
            reject(error)
          }
        })
    })
  }

  /**
   * Return any certificates we've collected thus far, then clear them out.
   */
  public consumeReceivedCertificates(): VerifiableCertificate[] {
    return this.certificatesReceived.splice(0)
  }

  private retainReceivedCertificates(certs: VerifiableCertificate[]): void {
    if (!Array.isArray(certs) || certs.length > 100) {
      throw new Error('Certificate response exceeds the per-message limit')
    }
    this.certificatesReceived.push(...certs)
    const excess = this.certificatesReceived.length - MAX_BUFFERED_CERTIFICATES
    if (excess > 0) this.certificatesReceived.splice(0, excess)
  }

  #createTransport(baseURL: string): SimplifiedFetchTransport {
    return new SimplifiedFetchTransport(baseURL, this.fetchClient, this.#transportOptions)
  }

  #writeOptionalText(writer: Writer, value: string): void {
    if (value.length === 0) {
      writer.writeVarIntNum(-1)
      return
    }
    const bytes = UtilsToArray(value)
    writer.writeVarIntNum(bytes.length)
    writer.write(bytes)
  }

  #includedRequestHeaders(headers: Record<string, string>): Array<[string, string]> {
    const includedHeaders: Array<[string, string]> = []
    for (const [key, originalValue] of Object.entries(headers)) {
      const normalizedKey = key.toLowerCase()
      let value = originalValue
      if (normalizedKey.startsWith('x-bsv-') || normalizedKey === 'authorization') {
        if (normalizedKey.startsWith('x-bsv-auth')) {
          throw new Error('No BSV auth headers allowed here!')
        }
      } else if (normalizedKey === 'content-type') {
        value = authenticatedContentType(value)
      } else {
        throw new Error(
          'Unsupported header in the simplified fetch implementation. Only content-type, authorization, and x-bsv-* headers are supported.'
        )
      }
      includedHeaders.push([normalizedKey, value])
    }
    return includedHeaders.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
  }

  #writeRequestHeaders(writer: Writer, headers: Array<[string, string]>): void {
    writer.writeVarIntNum(headers.length)
    for (const [key, value] of headers) {
      const keyBytes = UtilsToArray(key, 'utf8')
      const valueBytes = UtilsToArray(value, 'utf8')
      writer.writeVarIntNum(keyBytes.length)
      writer.write(keyBytes)
      writer.writeVarIntNum(valueBytes.length)
      writer.write(valueBytes)
    }
  }

  #defaultRequestBody(method: string, body: any, headers: Array<[string, string]>): any {
    const methodsWithBody = ['POST', 'PUT', 'PATCH', 'DELETE']
    if (!methodsWithBody.includes(method.toUpperCase()) || body !== undefined) return body
    const contentType = headers.find(([key]) => key === 'content-type')?.[1]
    return contentType?.includes('application/json') === true ? '{}' : ''
  }

  async #writeRequestBody(writer: Writer, body: any): Promise<void> {
    if (!body) {
      writer.writeVarIntNum(-1)
      return
    }
    const bytes = await this.normalizeBodyToNumberArray(body)
    writer.writeVarIntNum(bytes.length === 0 ? -1 : bytes.length)
    if (bytes.length > 0) writer.write(bytes)
  }

  /**
   * Serializes the HTTP request to be sent over the Transport.
   *
   * @param method - The HTTP method (e.g., 'GET', 'POST') for the request.
   * @param headers - A record of HTTP headers to include in the request.
   * @param body - The body of the request, if applicable (e.g., for POST/PUT requests).
   * @param parsedUrl - The parsed URL object containing the full request URL.
   * @param requestNonce - A unique random nonce to ensure request integrity.
   * @returns A promise that resolves to a `Writer` containing the serialized request.
   *
   * @throws Will throw an error if unsupported headers are used or serialization fails.
   */
  private async serializeRequest(
    method: string,
    headers: Record<string, string>,
    body: any,
    parsedUrl: URL,
    requestNonce: number[]
  ): Promise<Writer> {
    const writer = new UtilsWriter()
    // Write request nonce
    writer.write(requestNonce)
    // Method length
    writer.writeVarIntNum(method.length)
    // Method
    writer.write(UtilsToArray(method))

    this.#writeOptionalText(writer, parsedUrl.pathname)
    this.#writeOptionalText(writer, parsedUrl.search)

    // Construct headers to send / sign:
    // Ensures clients only provided supported HTTP request headers
    // - Include custom headers prefixed with x-bsv (excluding those starting with x-bsv-auth)
    // - Include a normalized version of the content-type header
    // - Include the authorization header
    const includedHeaders = this.#includedRequestHeaders(headers)
    this.#writeRequestHeaders(writer, includedHeaders)

    // If method typically carries a body and body is undefined, default it
    // This prevents signature verification errors due to mismatch default body types with express
    body = this.#defaultRequestBody(method, body, includedHeaders)
    await this.#writeRequestBody(writer, body)
    return writer
  }

  /**
   * Handles a non-authenticated fetch requests and validates that the server is not claiming to be authenticated.
   */
  private async handleFetchAndValidate(
    url: string,
    config: RequestInit,
    peerToUse: AuthPeer
  ): Promise<Response> {
    const response = await (this.fetchClient ?? fetch)(url, {
      method: config.method,
      headers: config.headers,
      body: config.body,
      // Do not allow a fallback request to replay a caller's body,
      // authorization header, or x-bsv metadata to a redirect destination.
      redirect: 'error'
    })
    response.headers.forEach((_value, name) => {
      if (name.toLocaleLowerCase().startsWith('x-bsv')) {
        throw new Error('The server is trying to claim it has been authenticated when it has not!')
      }
    })

    if (response.ok) {
      peerToUse.supportsMutualAuth = false
      return response
    } else {
      throw new Error(`Request failed with status: ${response.status}`)
    }
  }

  /**
   * If we get 402 Payment Required, we build a transaction via wallet.createAction()
   * and re-attempt the request with an x-bsv-payment header.
   */
  private async handlePaymentAndRetry(
    url: string,
    config: SimplifiedFetchRequestOptions,
    originalResponse: Response
  ): Promise<Response | null> {
    const paymentVersion = originalResponse.headers.get('x-bsv-payment-version')
    if (!paymentVersion || paymentVersion !== PAYMENT_VERSION) {
      throw new Error(
        `Unsupported x-bsv-payment-version response header. Client version: ${PAYMENT_VERSION}, Server version: ${paymentVersion}`
      )
    }

    const satoshisRequiredHeader = originalResponse.headers.get('x-bsv-payment-satoshis-required')
    if (!satoshisRequiredHeader) {
      throw new Error('Missing x-bsv-payment-satoshis-required response header.')
    }
    if (!/^[1-9]\d*$/.test(satoshisRequiredHeader)) {
      throw new Error('Invalid x-bsv-payment-satoshis-required response header value.')
    }
    const satoshisRequired = Number(satoshisRequiredHeader)
    if (!Number.isSafeInteger(satoshisRequired)) {
      throw new Error('Invalid x-bsv-payment-satoshis-required response header value.')
    }

    const serverIdentityKey = originalResponse.headers.get('x-bsv-auth-identity-key')
    if (typeof serverIdentityKey !== 'string') {
      throw new TypeError('Missing x-bsv-auth-identity-key response header.')
    }

    const derivationPrefix = originalResponse.headers.get('x-bsv-payment-derivation-prefix')
    if (typeof derivationPrefix !== 'string' || derivationPrefix.length < 1) {
      throw new Error('Missing x-bsv-payment-derivation-prefix response header.')
    }

    const knownTxids = parseKnownTxidsHeader(originalResponse.headers.get(KNOWN_TXIDS_HEADER))
    const transports = paymentTransports(originalResponse.headers.get('x-bsv-payment-transports'))
    if (transports.size === 0)
      throw new PaymentTransportError(
        'ERR_PAYMENT_TRANSPORT',
        'The server advertised no supported payment transport.'
      )

    let paymentContext = config.paymentContext
    if (paymentContext == null) {
      paymentContext = await this.createPaymentContext(
        url,
        config,
        satoshisRequired,
        serverIdentityKey,
        derivationPrefix,
        knownTxids,
        transports
      )
    } else {
      const requirementsChanged = !this.isPaymentContextCompatible(
        paymentContext,
        satoshisRequired,
        serverIdentityKey,
        derivationPrefix
      )
      if (requirementsChanged) {
        throw new PaymentTransportError(
          'ERR_PAYMENT_REQUIREMENTS_CHANGED',
          'The server changed payment requirements after a payment was prepared. Reconcile the existing payment before authorizing another.',
          { txid: paymentContext.txid, state: paymentContext.state }
        )
      }
    }

    if (paymentContext.attempts >= paymentContext.maxAttempts) {
      throw this.buildPaymentFailureError(
        url,
        paymentContext,
        new Error('Maximum payment attempts exceeded before retrying')
      )
    }

    // Contexts returned by the released API may already represent a spend.
    // Preserve them without another wallet mutation, but validate their real wire bytes.
    if (paymentContext.preparedRequest === undefined) {
      const beef = Beef.fromBinaryStrict(UtilsToArray(paymentContext.transactionBase64, 'base64'))
      if (beef.atomicTxid == null)
        throw new PaymentTransportError(
          'ERR_PAYMENT_TRANSPORT',
          'Existing payment context requires Atomic BEEF.'
        )
      paymentContext.txid = beef.atomicTxid
      paymentContext.state = 'uncertain'
      paymentContext.originalRequest = {
        method: config.method ?? 'GET',
        headers: { ...config.headers },
        body:
          config.body == null
            ? undefined
            : new Uint8Array(await this.normalizeBodyToNumberArray(config.body))
      }
      paymentContext.preparedRequest = preparePaymentTransport(
        JSON.stringify({
          derivationPrefix: paymentContext.derivationPrefix,
          derivationSuffix: paymentContext.derivationSuffix,
          transaction: paymentContext.transactionBase64
        }),
        paymentContext.originalRequest,
        transports,
        resolvePaymentTransportLimits(config.paymentTransport)
      )
    }
    if (!transports.has(paymentContext.preparedRequest.transport)) {
      try {
        paymentContext.preparedRequest = preparePaymentTransport(
          JSON.stringify({
            derivationPrefix: paymentContext.derivationPrefix,
            derivationSuffix: paymentContext.derivationSuffix,
            transaction: paymentContext.transactionBase64
          }),
          paymentContext.originalRequest,
          transports,
          resolvePaymentTransportLimits(config.paymentTransport)
        )
      } catch {
        throw new PaymentTransportError(
          'ERR_PAYMENT_TRANSPORT',
          'The authenticated server no longer supports a deliverable transport for this existing payment.',
          { txid: paymentContext.txid, state: paymentContext.state }
        )
      }
    }

    if (config.signal?.aborted === true) {
      let aborted: boolean | undefined
      if (paymentContext.state === 'prepared') {
        try {
          aborted =
            (await this.wallet.abortAction({ reference: paymentContext.txid }, this.originator))
              .aborted === true
        } catch {
          aborted = false
        }
      }
      throw new PaymentTransportError('ERR_PAYMENT_CANCELLED', 'Paid request cancelled.', {
        txid: paymentContext.txid,
        state: paymentContext.state,
        aborted
      })
    }
    if (paymentContext.state === 'prepared') await this.submitPreparedPayment(paymentContext)
    if (config.signal?.aborted === true) {
      throw new PaymentTransportError(
        'ERR_PAYMENT_CANCELLED',
        'Paid request cancelled after submission; reconcile its outcome.',
        { txid: paymentContext.txid, state: paymentContext.state }
      )
    }

    const nextConfig: SimplifiedFetchRequestOptions = {
      ...config,
      headers: paymentContext.preparedRequest.headers,
      body: paymentContext.preparedRequest.body,
      paymentContext
    }

    if (typeof nextConfig.retryCounter !== 'number') {
      nextConfig.retryCounter = 3
    }

    const attemptNumber = paymentContext.attempts + 1
    const maxAttempts = paymentContext.maxAttempts
    paymentContext.attempts = attemptNumber
    const attemptDetails = this.composePaymentLogDetails(url, paymentContext)
    this.logPaymentAttempt(
      'warn',
      `Attempting paid request (${attemptNumber}/${maxAttempts})`,
      attemptDetails
    )

    try {
      const response = await this.fetch(url, nextConfig)
      if (response.status === 413 || response.status === 431) {
        throw new PaymentTransportError(
          'ERR_PAYMENT_SIZE',
          'The authenticated server rejected the paid request size.',
          { txid: paymentContext.txid, state: paymentContext.state },
          response.status,
          true
        )
      }
      this.logPaymentAttempt(
        response.ok ? 'info' : 'warn',
        `Paid request attempt ${attemptNumber} completed with HTTP ${response.status}`,
        attemptDetails
      )
      return response
    } catch (error) {
      if (error instanceof PaymentTransportError) throw error
      const status = error instanceof Error ? (error as any).details?.status : undefined
      if (status === 413 || status === 431) {
        throw new PaymentTransportError(
          'ERR_PAYMENT_SIZE',
          'An unauthenticated intermediary rejected the paid request size. Reconcile the submitted payment.',
          { txid: paymentContext.txid, state: paymentContext.state },
          status,
          false
        )
      }
      const errorEntry = this.createPaymentErrorEntry(paymentContext.attempts, error)
      paymentContext.errors.push(errorEntry)
      this.logPaymentAttempt('error', `Paid request attempt ${attemptNumber} failed`, {
        ...attemptDetails,
        error: {
          message: errorEntry.message,
          stack: errorEntry.stack
        }
      })

      if (paymentContext.attempts >= paymentContext.maxAttempts) {
        throw this.buildPaymentFailureError(url, paymentContext, error)
      }

      const delayMs = this.getPaymentRetryDelay(paymentContext.attempts)
      await this.wait(delayMs)
      return this.handlePaymentAndRetry(url, nextConfig, originalResponse)
    }
  }

  private isPaymentContextCompatible(
    context: PaymentRetryContext,
    satoshisRequired: number,
    serverIdentityKey: string,
    derivationPrefix: string
  ): boolean {
    return (
      context.satoshisRequired === satoshisRequired &&
      context.serverIdentityKey === serverIdentityKey &&
      context.derivationPrefix === derivationPrefix
    )
  }

  private async createPaymentContext(
    url: string,
    config: SimplifiedFetchRequestOptions,
    satoshisRequired: number,
    serverIdentityKey: string,
    derivationPrefix: string,
    knownTxids: string[] | undefined,
    transports: ReadonlySet<string> = new Set(['header'])
  ): Promise<PaymentRetryContext> {
    const requestSummary = this.buildPaymentRequestSummary(url, config)
    const paymentLabels = Array.isArray(config.labels) ? [...config.labels] : []
    const maxAttempts = this.getMaxPaymentAttempts(config)
    const limits = resolvePaymentTransportLimits(config.paymentTransport)
    if (typeof this.wallet.abortAction !== 'function')
      throw new PaymentTransportError(
        'ERR_PAYMENT_TRANSPORT',
        'Payment preparation requires a BRC-100 wallet with noSend, sendWith, and abortAction support.'
      )
    if (Object.keys(config.headers ?? {}).some(name => name.toLowerCase() === 'x-bsv-payment')) {
      throw new PaymentTransportError(
        'ERR_PAYMENT_REQUIREMENTS_CHANGED',
        'An existing payment was rejected. Reconcile it before authorizing another payment.'
      )
    }
    const originalRequest = {
      method: config.method ?? 'GET',
      headers: { ...config.headers },
      body:
        config.body == null
          ? undefined
          : new Uint8Array(await this.normalizeBodyToNumberArray(config.body))
    }
    if (
      !transports.has('header') &&
      ['GET', 'HEAD'].includes(originalRequest.method.toUpperCase())
    ) {
      throw new PaymentTransportError(
        'ERR_PAYMENT_TRANSPORT',
        'GET and HEAD require header payment support.'
      )
    }
    const { publicKey: clientIdentityKey } = validateWalletResult(
      'getPublicKey',
      await this.wallet.getPublicKey({ identityKey: true }, this.originator),
      { identityKey: true }
    )
    const derivationSuffix = await createNonce(this.wallet, undefined, this.originator)

    const { publicKey: derivedPublicKey } = await this.wallet.getPublicKey(
      {
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: serverIdentityKey
      },
      this.originator
    )
    const lockingScript = new P2PKH()
      .lock(PublicKey.fromString(derivedPublicKey).toAddress())
      .toHex()

    const createArgs = {
      description: 'BRC-105 HTTP request payment',
      labels: this.buildPaymentActionLabels(
        { labels: paymentLabels },
        derivationPrefix,
        derivationSuffix
      ),
      outputs: [
        {
          satoshis: satoshisRequired,
          lockingScript,
          customInstructions: JSON.stringify({
            derivationPrefix,
            derivationSuffix,
            payee: serverIdentityKey
          }),
          outputDescription: 'HTTP request payment'
        }
      ],
      options: {
        randomizeOutputs: false,
        noSend: true,
        acceptDelayedBroadcast: false,
        // Ancestors the recipient already holds are emitted txid-only rather than in full.
        // Undefined when the server did not declare any, which is the pre-existing behaviour.
        ...(knownTxids != null ? { knownTxids } : {})
      }
    }
    if (config.signal?.aborted === true)
      throw new PaymentTransportError(
        'ERR_PAYMENT_CANCELLED',
        'Paid request cancelled before preparation.'
      )
    const rawCreated = await this.wallet.createAction(createArgs, this.originator)
    let txid: string | undefined
    let reference: string | undefined
    try {
      // A malformed result can still identify a prepared reservation. Read only
      // a canonical own data field, never an accessor supplied by an adapter.
      const reported =
        rawCreated == null ? undefined : Object.getOwnPropertyDescriptor(rawCreated, 'txid')?.value
      if (typeof reported === 'string' && /^[0-9a-f]{64}$/.test(reported)) txid = reported
      const created = validateWalletResult('createAction', rawCreated, createArgs)
      reference = created.signableTransaction?.reference

      const transaction = copyAuthByteArray(
        created.tx,
        'BRC-105 payment transaction',
        MAX_PAYMENT_TRANSACTION_BYTES
      )
      const beef = Beef.fromBinaryStrict(transaction)
      const atomicTxid = beef.atomicTxid
      const output = atomicTxid == null ? undefined : beef.findTxid(atomicTxid)?.tx?.outputs[0]
      if (
        atomicTxid == null ||
        (txid != null && txid !== atomicTxid) ||
        output?.satoshis !== satoshisRequired ||
        output.lockingScript.toHex() !== lockingScript
      ) {
        throw new PaymentTransportError(
          'ERR_PAYMENT_TRANSPORT',
          'The prepared payment does not match its authorized recipient and amount.'
        )
      }
      txid = atomicTxid
      const transactionBase64 = toBase64(transaction)
      const preparedRequest = preparePaymentTransport(
        JSON.stringify({ derivationPrefix, derivationSuffix, transaction: transactionBase64 }),
        originalRequest,
        transports,
        limits
      )
      // Exercise the actual released wire decoder's caps before the irreversible sendWith call.
      const frame = await this.serializeRequest(
        originalRequest.method,
        preparedRequest.headers,
        preparedRequest.body,
        new URL(url),
        Random(32)
      )
      this.#createTransport(new URL(url).origin).deserializeRequestPayload(frame.toArray())
      if (config.signal?.aborted === true)
        throw new PaymentTransportError(
          'ERR_PAYMENT_CANCELLED',
          'Paid request cancelled during preparation.'
        )
      return {
        satoshisRequired,
        transactionBase64,
        derivationPrefix,
        derivationSuffix,
        serverIdentityKey,
        clientIdentityKey,
        attempts: 0,
        maxAttempts,
        errors: [],
        requestSummary,
        txid,
        state: 'prepared',
        originalRequest,
        preparedRequest
      }
    } catch (error) {
      let aborted = false
      reference = txid ?? reference
      if (reference != null) {
        try {
          aborted = (await this.wallet.abortAction({ reference }, this.originator)).aborted === true
        } catch {
          /* retain recovery context */
        }
      }
      throw new PaymentTransportError(
        error instanceof PaymentTransportError ? error.code : 'ERR_PAYMENT_TRANSPORT',
        'Payment preparation could not produce a deliverable request; no broadcast was requested.',
        txid == null ? undefined : { txid, state: 'prepared', aborted }
      )
    }
  }

  private async submitPreparedPayment(context: PaymentRetryContext): Promise<void> {
    // Once submission starts its result may be uncertain. Never abort or create a replacement automatically.
    context.state = 'uncertain'
    try {
      const args = {
        description: 'Submit prepared HTTP payment',
        options: { sendWith: [context.txid], acceptDelayedBroadcast: false }
      }
      const result = validateWalletResult(
        'createAction',
        await this.wallet.createAction(args, this.originator),
        args
      )
      if (
        result.sendWithResults?.length !== 1 ||
        result.sendWithResults[0].txid !== context.txid ||
        result.sendWithResults[0].status !== 'unproven'
      ) {
        throw new Error('Payment broadcast did not return affirmative acceptance.')
      }
      context.state = 'submitted'
    } catch {
      throw new PaymentTransportError(
        'ERR_PAYMENT_OUTCOME_UNKNOWN',
        'Payment submission was not confirmed. Reconcile this transaction before retrying.',
        { txid: context.txid, state: context.state }
      )
    }
  }

  /**
   * Builds wallet action labels for a BRC-105 payment.
   * Always includes `brc105 <hexPrefix> <hexSuffix>` (base64 nonces hex-encoded
   * so label lowercasing is lossless); appends caller labels when provided.
   * Caller labels are passed through unchanged — wallet validateLabel trims/lowercases.
   */
  private buildPaymentActionLabels(
    config: SimplifiedFetchRequestOptions,
    derivationPrefix: string,
    derivationSuffix: string
  ): string[] {
    const callerLabels = Array.isArray(config.labels) ? config.labels : []
    return [
      `brc105 ${this.#base64NonceToLabelHex(derivationPrefix)} ${this.#base64NonceToLabelHex(derivationSuffix)}`,
      ...callerLabels
    ]
  }

  /** Hex-encode a base64 BRC-105 nonce for case-stable wallet labels. */
  #base64NonceToLabelHex(base64Nonce: string): string {
    return UtilsToHex(UtilsToArray(base64Nonce, 'base64'))
  }

  private getMaxPaymentAttempts(config: SimplifiedFetchRequestOptions): number {
    const attempts =
      typeof config.paymentRetryAttempts === 'number' ? config.paymentRetryAttempts : undefined
    if (typeof attempts === 'number' && attempts > 0) {
      return Math.floor(attempts)
    }
    return 3
  }

  private buildPaymentRequestSummary(
    url: string,
    config: SimplifiedFetchRequestOptions
  ): PaymentRetryContext['requestSummary'] {
    const headers = Object.fromEntries(
      Object.keys(config.headers ?? {}).map(headerName => [
        headerName,
        headerName.toLowerCase() === 'content-type'
          ? String(config.headers?.[headerName] ?? '')
          : REDACTED_LOG_VALUE
      ])
    )
    const method = typeof config.method === 'string' ? config.method.toUpperCase() : 'GET'
    const bodySummary = this.describeRequestBodyForLogging(config.body)

    return {
      url: this.#safeLogUrl(url),
      method,
      headers,
      bodyType: bodySummary.type,
      bodyByteLength: bodySummary.byteLength
    }
  }

  private describeRequestBodyForLogging(body: any): RequestBodySummary {
    return (
      this.#describeSimpleRequestBody(body) ??
      this.#describePlatformRequestBody(body) ??
      this.#describeSerializableRequestBody(body)
    )
  }

  #describeSimpleRequestBody(body: any): RequestBodySummary | undefined {
    if (body == null) {
      return { type: 'none', byteLength: 0 }
    }

    if (typeof body === 'string') {
      return { type: 'string', byteLength: UtilsToArray(body, 'utf8').length }
    }

    if (Array.isArray(body)) {
      if (body.every(item => typeof item === 'number')) {
        return { type: 'number[]', byteLength: body.length }
      }
      return { type: 'array', byteLength: body.length }
    }
    return undefined
  }

  #describePlatformRequestBody(body: any): RequestBodySummary | undefined {
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
      return { type: 'ArrayBuffer', byteLength: body.byteLength }
    }

    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
      return {
        type: body.constructor == null ? 'TypedArray' : body.constructor.name,
        byteLength: body.byteLength
      }
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return { type: 'Blob', byteLength: body.size }
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return { type: 'FormData', byteLength: 0 }
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      const serialized = body.toString()
      return { type: 'URLSearchParams', byteLength: UtilsToArray(serialized, 'utf8').length }
    }

    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      return { type: 'ReadableStream', byteLength: 0 }
    }
    return undefined
  }

  #describeSerializableRequestBody(body: any): RequestBodySummary {
    try {
      const serialized = stringifyBRC100(body)
      if (typeof serialized === 'string') {
        return { type: 'object', byteLength: UtilsToArray(serialized, 'utf8').length }
      }
    } catch {
      // Ignore JSON serialization issues for logging purposes only
    }

    return { type: typeof body, byteLength: 0 }
  }

  private async waitForPendingCertificateRequests(peer: AuthPeer): Promise<void> {
    const timeoutMs = 30000
    const checkIntervalMs = 100
    const startedAt = Date.now()
    while (peer.pendingCertificateRequests.length > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Timeout waiting for certificate request to complete')
      }
      await this.wait(checkIntervalMs)
    }
  }

  private composePaymentLogDetails(url: string, context: PaymentRetryContext): Record<string, any> {
    return {
      url: this.#safeLogUrl(url),
      request: context.requestSummary,
      payment: {
        satoshis: context.satoshisRequired,
        serverIdentityKey: context.serverIdentityKey,
        clientIdentityKey: context.clientIdentityKey
      },
      attempts: {
        used: context.attempts,
        max: context.maxAttempts
      },
      errors: context.errors.map(({ attempt, timestamp, message }) => ({
        attempt,
        timestamp,
        message
      }))
    }
  }

  private logPaymentAttempt(
    level: 'info' | 'warn' | 'error',
    message: string,
    details: Record<string, any>
  ): void {
    const prefix = '[AuthFetch][Payment]'
    if (level === 'error') {
      console.error(`${prefix} ${message}`, details)
    } else if (level === 'warn') {
      console.warn(`${prefix} ${message}`, details)
    } else if (typeof console.info === 'function') {
      console.info(`${prefix} ${message}`, details)
    } else {
      console.log(`${prefix} ${message}`, details)
    }
  }

  private createPaymentErrorEntry(attempt: number, error: unknown): PaymentErrorLogEntry {
    // Provider exceptions can echo URLs, request headers or payment bytes. Keep
    // only a bounded category in telemetry and terminal diagnostic history.
    return {
      attempt,
      timestamp: new Date().toISOString(),
      message: error instanceof Error ? 'Payment delivery failed.' : 'Payment delivery rejected.',
      stack: undefined
    }
  }

  private getPaymentRetryDelay(attempt: number): number {
    const baseDelay = 250
    const multiplier = Math.min(attempt, 5)
    return baseDelay * multiplier
  }

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private buildPaymentFailureError(
    url: string,
    context: PaymentRetryContext,
    lastError: unknown
  ): Error {
    const safeUrl = this.#safeLogUrl(url)
    const message = `Paid request to ${safeUrl} failed after ${context.attempts}/${context.maxAttempts} attempts. Sent ${context.satoshisRequired} satoshis to ${context.serverIdentityKey}.`
    const error = new PaymentTransportError(
      'ERR_PAYMENT_OUTCOME_UNKNOWN',
      message,
      context.txid == null ? undefined : { txid: context.txid, state: context.state ?? 'uncertain' }
    )

    const failureDetails = {
      request: context.requestSummary,
      payment: {
        satoshis: context.satoshisRequired,
        serverIdentityKey: context.serverIdentityKey,
        clientIdentityKey: context.clientIdentityKey
      },
      attempts: {
        used: context.attempts,
        max: context.maxAttempts
      },
      errors: context.errors
    }

    ;(error as any).details = failureDetails

    if (lastError instanceof Error) {
      ;(error as any).cause = lastError
    }

    return error
  }

  #safeLogUrl(url: string): string {
    try {
      return new URL(url).origin
    } catch {
      return '[invalid URL]'
    }
  }

  private async normalizeBodyToNumberArray(body: BodyInit | null | undefined): Promise<number[]> {
    // 0. Null / undefined
    if (body == null) {
      return []
    }

    // 1. number[]
    if (Array.isArray(body) && body.every(item => typeof item === 'number')) {
      return body // Return the array as is
    }

    // 2. string
    if (typeof body === 'string') {
      return UtilsToArray(body, 'utf8')
    }

    // 3. ArrayBuffer / TypedArrays
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const typedArray =
        body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      return Array.from(typedArray)
    }

    // 4. Blob
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      const arrayBuffer = await body.arrayBuffer()
      return Array.from(new Uint8Array(arrayBuffer))
    }

    // 5. FormData
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const entries: [string, string][] = []
      body.forEach((value, key) => {
        if (typeof value !== 'string')
          throw new PaymentTransportError(
            'ERR_PAYMENT_TRANSPORT',
            'Serialize file-bearing FormData to owned bytes with its Content-Type before authenticated fetch.'
          )
        entries.push([key, value])
      })
      return UtilsToArray(new URLSearchParams(entries).toString(), 'utf8')
    }

    // 6. URLSearchParams
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return UtilsToArray(body.toString(), 'utf8')
    }

    // 7. ReadableStream
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      throw new TypeError('ReadableStream cannot be directly converted to number[].')
    }

    // 8. Plain object JSON body
    if (typeof body === 'object') return UtilsToArray(stringifyBRC100(body), 'utf8')

    // 9. Fallback
    throw new Error('Unsupported body type in this SimplifiedFetch implementation.')
  }
}

class StrictResponseReader {
  private readonly reader: Reader

  constructor(payload: number[]) {
    this.reader = new Reader(payload)
  }

  readVarInt(field: string, signed: boolean = false): number {
    this.#requireBytes(1, field)
    const first = this.reader.bin[this.reader.pos]
    const encodedLength = first === 0xfd ? 3 : first === 0xfe ? 5 : first === 0xff ? 9 : 1
    this.#requireBytes(encodedLength, field)
    const value = this.reader.readVarIntNumStrict(signed)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Authenticated response contains an invalid ${field}.`)
    }
    return value
  }

  readBoundedLength(maximum: number, field: string, minimum = 0): number {
    const value = this.readVarInt(field)
    if (value < minimum || value > maximum) {
      throw new Error(`Authenticated response contains an invalid ${field}.`)
    }
    return value
  }

  readExact(length: number, field: string): number[] {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`Authenticated response contains an invalid ${field} length.`)
    }
    this.#requireBytes(length, field)
    return this.reader.read(length)
  }

  assertFinished(): void {
    if (this.reader.pos !== this.reader.bin.length) {
      throw new Error('Authenticated response contains trailing bytes.')
    }
  }

  #requireBytes(length: number, field: string): void {
    if (this.reader.pos + length > this.reader.bin.length) {
      throw new Error(`Authenticated response truncated while reading ${field}.`)
    }
  }
}

function positiveResponseLimit(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError('maxResponseBytes must be a positive safe integer')
  }
  return candidate
}
