// @ts-nocheck
import * as Utils from '../../primitives/utils.js'
import Random from '../../primitives/Random.js'
import P2PKH from '../../script/templates/P2PKH.js'
import PublicKey from '../../primitives/PublicKey.js'
import {
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '../../wallet/Wallet.interfaces.js'
import { createNonce } from '../utils/createNonce.js'
import { Peer } from '../Peer.js'
import { SimplifiedFetchTransport } from '../transports/SimplifiedFetchTransport.js'
import { SessionManager, AsyncSessionManager } from '../SessionManager.js'
import { RequestedCertificateSet } from '../types.js'
import { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'
import { Writer } from '../../primitives/utils.js'
import { getVerifiableCertificates } from '../utils/index.js'

interface SimplifiedFetchRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: any
  retryCounter?: number
  paymentContext?: PaymentRetryContext
  paymentRetryAttempts?: number
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

/**
 * AuthFetch provides a lightweight fetch client for interacting with servers
 * over a simplified HTTP transport mechanism. It integrates session management, peer communication,
 * and certificate handling to enable secure and mutually-authenticated requests.
 *
 * Additionally, it automatically handles 402 Payment Required responses by creating
 * and sending BSV payment transactions when necessary.
 */
export class AuthFetch {
  private readonly sessionManager: SessionManager
  private readonly wallet: WalletInterface
  private pendingRequestNonces: Set<string> = new Set()
  private readonly certificatesReceived: VerifiableCertificate[] = []
  private readonly requestedCertificates?: RequestedCertificateSet
  private readonly originator?: OriginatorDomainNameStringUnder250Bytes
  peers: Record<string, AuthPeer> = {}

  /**
   * Constructs a new AuthFetch instance.
   * @param wallet - The wallet instance for signing and authentication.
   * @param requestedCertificates - Optional set of certificates to request from peers.
   */
  constructor(
    wallet: WalletInterface,
    requestedCertificates?: RequestedCertificateSet,
    sessionManager?: SessionManager | AsyncSessionManager,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ) {
    this.wallet = wallet
    this.requestedCertificates = requestedCertificates
    // See `Peer.sessionManager`: field stays typed as the synchronous
    // `SessionManager` for back-compat; if an `AsyncSessionManager` is
    // injected, the underlying Peer awaits all calls internally.
    this.sessionManager = (sessionManager ?? new SessionManager()) as SessionManager
    this.originator = originator
  }

  /**
   * Mutually authenticates and sends a HTTP request to a server.
   *
   * 1) Attempt the request.
   * 2) If 402 Payment Required, automatically create and send payment.
   * 3) Return the final response.
   *
   * @param url - The URL to send the request to.
   * @param config - Configuration options for the request, including method, headers, and body.
   * @returns A promise that resolves with the server's response, structured as a Response-like object.
   *
   * @throws Will throw an error if unsupported headers are used or other validation fails.
   */
  async fetch(url: string, config: SimplifiedFetchRequestOptions = {}): Promise<Response> {
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

          // Create a new transport for this base url if needed
          let peerToUse: AuthPeer
          if (this.peers[baseURL] === undefined) {
            // Create a peer for the request
            const newTransport = new SimplifiedFetchTransport(baseURL)
            const newPeer = new Peer(
              this.wallet,
              newTransport,
              this.requestedCertificates,
              this.sessionManager,
              undefined,
              this.originator
            )
            await newPeer.ready
            peerToUse = {
              peer: newPeer,
              pendingCertificateRequests: []
            }
            this.peers[baseURL] = peerToUse
            this.peers[baseURL].peer.listenForCertificatesReceived(
              (senderPublicKey: string, certs: VerifiableCertificate[]) => {
                this.certificatesReceived.push(...certs)
              }
            )
            this.peers[baseURL].peer.listenForCertificatesRequested((async (
              verifier: string,
              requestedCertificates: RequestedCertificateSet
            ) => {
              try {
                this.peers[baseURL].pendingCertificateRequests.push(true)
                const certificatesToInclude = await getVerifiableCertificates(
                  this.wallet,
                  requestedCertificates,
                  verifier,
                  this.originator
                )
                if (certificatesToInclude.length > 0) {
                  await this.peers[baseURL].peer.sendCertificateResponse(
                    verifier,
                    certificatesToInclude
                  )
                }
              } finally {
                // Give the backend 500 ms to process the certificates we just sent, before releasing the queue entry
                await this.wait(500)
                this.peers[baseURL].pendingCertificateRequests.shift()
              }
            }) as Function)
          } else {
            // Check if there's a session associated with this baseURL
            if (this.peers[baseURL].supportsMutualAuth === false) {
              // Use standard fetch if mutual authentication is not supported
              try {
                const response = await this.handleFetchAndValidate(url, config, this.peers[baseURL])
                resolve(response)
              } catch (error) {
                reject(error)
              }
              return
            }
            peerToUse = this.peers[baseURL]
          }

          // Serialize the simplified fetch request.
          const requestNonce = Random(32)
          const requestNonceAsBase64 = Utils.toBase64(requestNonce)

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
          }
          const resolveRequest = (response: Response): void => {
            cleanup()
            resolve(response)
          }
          const rejectRequest = (error: unknown): void => {
            cleanup()
            reject(error)
          }

          this.pendingRequestNonces.add(requestNonceAsBase64)
          listenerId = peerToUse.peer.listenForGeneralMessages(
            (senderPublicKey: string, payload: number[]) => {
              // Create a reader
              const responseReader = new Utils.Reader(payload)
              // Deserialize first 32 bytes of payload
              const responseNonceAsBase64 = Utils.toBase64(responseReader.read(32))
              if (responseNonceAsBase64 !== requestNonceAsBase64) {
                return
              }

              // Save the identity key for the peer for future requests, since we have it here.
              this.peers[baseURL].identityKey = senderPublicKey
              this.peers[baseURL].supportsMutualAuth = true

              // Status code
              const statusCode = responseReader.readVarIntNum()

              // Headers
              const responseHeaders = {}
              const nHeaders = responseReader.readVarIntNum()
              if (nHeaders > 0) {
                for (let i = 0; i < nHeaders; i++) {
                  const nHeaderKeyBytes = responseReader.readVarIntNum()
                  const headerKeyBytes = responseReader.read(nHeaderKeyBytes)
                  const headerKey = Utils.toUTF8(headerKeyBytes)
                  const nHeaderValueBytes = responseReader.readVarIntNum()
                  const headerValueBytes = responseReader.read(nHeaderValueBytes)
                  const headerValue = Utils.toUTF8(headerValueBytes)
                  responseHeaders[headerKey] = headerValue
                }
              }

              // Add back the server identity key header
              responseHeaders['x-bsv-auth-identity-key'] = senderPublicKey

              // Body
              let responseBody
              const responseBodyBytes = responseReader.readVarIntNum()
              if (responseBodyBytes > 0) {
                responseBody = responseReader.read(responseBodyBytes)
              }

              // Create the Response object
              const responseValue = new Response(
                responseBody ? new Uint8Array(responseBody) : null,
                {
                  status: statusCode,
                  statusText: `${statusCode}`,
                  headers: new Headers(responseHeaders)
                }
              )

              // Resolve or reject the correct request with the response data
              resolveRequest(responseValue)
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

            // Send the request, now that all listeners are set up
            await peerToUse.peer.toPeer(writer.toArray(), peerToUse.identityKey)
          } catch (error) {
            cleanup()
            const isStaleSession =
              error instanceof Error &&
              (error.message.includes('Session not found for nonce') ||
                (error.message.includes('without valid BSV authentication') &&
                  peerToUse.identityKey != null &&
                  (error as any).details?.status === 401))
            if (isStaleSession) {
              // Stale session: server no longer recognises the session nonce
              // (e.g. after a server restart). Clear the cached peer so a fresh
              // handshake is performed on retry.
              delete this.peers[baseURL]
              config.retryCounter ??= 3
              const response = await this.fetch(url, config)
              resolveRequest(response)
              return
            }
            if (error instanceof Error && error.message.includes('HTTP server failed to authenticate')) {
              try {
                const response = await this.handleFetchAndValidate(url, config, peerToUse)
                resolveRequest(response)
                return
              } catch (fetchError) {
                rejectRequest(fetchError)
              }
            } else {
              rejectRequest(error)
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

    let peerToUse: { peer: Peer; identityKey?: string }
    if (this.peers[baseURL] === undefined) {
      const newTransport = new SimplifiedFetchTransport(baseURL)
      const newPeer = new Peer(
        this.wallet,
        newTransport,
        this.requestedCertificates,
        this.sessionManager,
        this.originator
      )
      await newPeer.ready
      peerToUse = { peer: newPeer }
      this.peers[baseURL] = peerToUse
    } else {
      peerToUse = { peer: this.peers[baseURL].peer }
    }

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
          this.certificatesReceived.push(...certs)
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

  private writeOptionalText(writer: Writer, value: string): void {
    if (value.length === 0) {
      writer.writeVarIntNum(-1)
      return
    }
    const bytes = Utils.toArray(value)
    writer.writeVarIntNum(bytes.length)
    writer.write(bytes)
  }

  private includedRequestHeaders(headers: Record<string, string>): Array<[string, string]> {
    const includedHeaders: Array<[string, string]> = []
    for (const [key, originalValue] of Object.entries(headers)) {
      const normalizedKey = key.toLowerCase()
      let value = originalValue
      if (normalizedKey.startsWith('x-bsv-') || normalizedKey === 'authorization') {
        if (normalizedKey.startsWith('x-bsv-auth')) {
          throw new Error('No BSV auth headers allowed here!')
        }
      } else if (normalizedKey.startsWith('content-type')) {
        value = value.split(';')[0].trim()
      } else {
        throw new Error(
          'Unsupported header in the simplified fetch implementation. Only content-type, authorization, and x-bsv-* headers are supported.'
        )
      }
      includedHeaders.push([normalizedKey, value])
    }
    return includedHeaders.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
  }

  private writeRequestHeaders(writer: Writer, headers: Array<[string, string]>): void {
    writer.writeVarIntNum(headers.length)
    for (const [key, value] of headers) {
      const keyBytes = Utils.toArray(key, 'utf8')
      const valueBytes = Utils.toArray(value, 'utf8')
      writer.writeVarIntNum(keyBytes.length)
      writer.write(keyBytes)
      writer.writeVarIntNum(valueBytes.length)
      writer.write(valueBytes)
    }
  }

  private defaultRequestBody(method: string, body: any, headers: Array<[string, string]>): any {
    const methodsWithBody = ['POST', 'PUT', 'PATCH', 'DELETE']
    if (!methodsWithBody.includes(method.toUpperCase()) || body !== undefined) return body
    const contentType = headers.find(([key]) => key === 'content-type')?.[1]
    return contentType?.includes('application/json') === true ? '{}' : ''
  }

  private async writeRequestBody(writer: Writer, body: any): Promise<void> {
    if (!body) {
      writer.writeVarIntNum(-1)
      return
    }
    const bytes = await this.normalizeBodyToNumberArray(body)
    writer.writeVarIntNum(bytes.length)
    writer.write(bytes)
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
    const writer = new Utils.Writer()
    // Write request nonce
    writer.write(requestNonce)
    // Method length
    writer.writeVarIntNum(method.length)
    // Method
    writer.write(Utils.toArray(method))

    this.writeOptionalText(writer, parsedUrl.pathname)
    this.writeOptionalText(writer, parsedUrl.search)

    // Construct headers to send / sign:
    // Ensures clients only provided supported HTTP request headers
    // - Include custom headers prefixed with x-bsv (excluding those starting with x-bsv-auth)
    // - Include a normalized version of the content-type header
    // - Include the authorization header
    const includedHeaders = this.includedRequestHeaders(headers)
    this.writeRequestHeaders(writer, includedHeaders)

    // If method typically carries a body and body is undefined, default it
    // This prevents signature verification errors due to mismatch default body types with express
    body = this.defaultRequestBody(method, body, includedHeaders)
    await this.writeRequestBody(writer, body)
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
    const response = await fetch(url, config)
    response.headers.forEach(header => {
      if (header.toLocaleLowerCase().startsWith('x-bsv')) {
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
    const satoshisRequired = Number.parseInt(satoshisRequiredHeader)
    if (Number.isNaN(satoshisRequired) || satoshisRequired <= 0) {
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

    let paymentContext = config.paymentContext
    if (paymentContext == null) {
      paymentContext = await this.createPaymentContext(
        url,
        config,
        satoshisRequired,
        serverIdentityKey,
        derivationPrefix
      )
    } else {
      const requirementsChanged = !this.isPaymentContextCompatible(
        paymentContext,
        satoshisRequired,
        serverIdentityKey,
        derivationPrefix
      )
      if (requirementsChanged) {
        this.logPaymentAttempt(
          'warn',
          'Server adjusted payment requirements; regenerating transaction',
          this.composePaymentLogDetails(url, paymentContext)
        )
        paymentContext = await this.createPaymentContext(
          url,
          config,
          satoshisRequired,
          serverIdentityKey,
          derivationPrefix
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

    const headersWithPayment: Record<string, string> = {
      ...config.headers
    }
    headersWithPayment['x-bsv-payment'] = JSON.stringify({
      derivationPrefix: paymentContext.derivationPrefix,
      derivationSuffix: paymentContext.derivationSuffix,
      transaction: paymentContext.transactionBase64
    })

    const nextConfig: SimplifiedFetchRequestOptions = {
      ...config,
      headers: headersWithPayment,
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
      this.logPaymentAttempt(
        'info',
        `Paid request attempt ${attemptNumber} succeeded`,
        attemptDetails
      )
      return response
    } catch (error) {
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
    derivationPrefix: string
  ): Promise<PaymentRetryContext> {
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

    const { tx } = await this.wallet.createAction(
      {
        description: `Payment for request to ${new URL(url).origin}`,
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
          randomizeOutputs: false
        }
      },
      this.originator
    )

    const { publicKey: clientIdentityKey } = await this.wallet.getPublicKey(
      { identityKey: true },
      this.originator
    )

    return {
      satoshisRequired,
      transactionBase64: Utils.toBase64(tx),
      derivationPrefix,
      derivationSuffix,
      serverIdentityKey,
      clientIdentityKey,
      attempts: 0,
      maxAttempts: this.getMaxPaymentAttempts(config),
      errors: [],
      requestSummary: this.buildPaymentRequestSummary(url, config)
    }
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
    const headers = { ...config.headers }
    const method = typeof config.method === 'string' ? config.method.toUpperCase() : 'GET'
    const bodySummary = this.describeRequestBodyForLogging(config.body)

    return {
      url,
      method,
      headers,
      bodyType: bodySummary.type,
      bodyByteLength: bodySummary.byteLength
    }
  }

  private describeRequestBodyForLogging(body: any): RequestBodySummary {
    return (
      this.describeSimpleRequestBody(body) ??
      this.describePlatformRequestBody(body) ??
      this.describeSerializableRequestBody(body)
    )
  }

  private describeSimpleRequestBody(body: any): RequestBodySummary | undefined {
    if (body == null) {
      return { type: 'none', byteLength: 0 }
    }

    if (typeof body === 'string') {
      return { type: 'string', byteLength: Utils.toArray(body, 'utf8').length }
    }

    if (Array.isArray(body)) {
      if (body.every(item => typeof item === 'number')) {
        return { type: 'number[]', byteLength: body.length }
      }
      return { type: 'array', byteLength: body.length }
    }
    return undefined
  }

  private describePlatformRequestBody(body: any): RequestBodySummary | undefined {
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
      return { type: 'URLSearchParams', byteLength: Utils.toArray(serialized, 'utf8').length }
    }

    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      return { type: 'ReadableStream', byteLength: 0 }
    }
    return undefined
  }

  private describeSerializableRequestBody(body: any): RequestBodySummary {
    try {
      const serialized = JSON.stringify(body)
      if (typeof serialized === 'string') {
        return { type: 'object', byteLength: Utils.toArray(serialized, 'utf8').length }
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
      url,
      request: context.requestSummary,
      payment: {
        satoshis: context.satoshisRequired,
        transactionBase64: context.transactionBase64,
        derivationPrefix: context.derivationPrefix,
        derivationSuffix: context.derivationSuffix,
        serverIdentityKey: context.serverIdentityKey,
        clientIdentityKey: context.clientIdentityKey
      },
      attempts: {
        used: context.attempts,
        max: context.maxAttempts
      },
      errors: context.errors
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
    const entry: PaymentErrorLogEntry = {
      attempt,
      timestamp: new Date().toISOString(),
      message: '',
      stack: undefined
    }

    if (error instanceof Error) {
      entry.message = error.message
      entry.stack = error.stack ?? undefined
    } else {
      entry.message = Utils.toSafeString(error)
    }

    return entry
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
    const message = `Paid request to ${url} failed after ${context.attempts}/${context.maxAttempts} attempts. Sent ${context.satoshisRequired} satoshis to ${context.serverIdentityKey}.`
    const error = new Error(message)

    const failureDetails = {
      request: context.requestSummary,
      payment: {
        satoshis: context.satoshisRequired,
        transactionBase64: context.transactionBase64,
        derivationPrefix: context.derivationPrefix,
        derivationSuffix: context.derivationSuffix,
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
      return Utils.toArray(body, 'utf8')
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
    if (body instanceof Blob) {
      const arrayBuffer = await body.arrayBuffer()
      return Array.from(new Uint8Array(arrayBuffer))
    }

    // 5. FormData
    if (body instanceof FormData) {
      const entries: [string, string][] = []
      body.forEach((value, key) => {
        entries.push([key, typeof value === 'string' ? value : value.name])
      })
      const urlEncoded = new URLSearchParams(entries).toString()
      return Utils.toArray(urlEncoded, 'utf8')
    }

    // 6. URLSearchParams
    if (body instanceof URLSearchParams) {
      return Utils.toArray(body.toString(), 'utf8')
    }

    // 7. ReadableStream
    if (body instanceof ReadableStream) {
      throw new TypeError('ReadableStream cannot be directly converted to number[].')
    }

    // 8. Plain object JSON body
    if (typeof body === 'object') return Utils.toArray(JSON.stringify(body), 'utf8')

    // 9. Fallback
    throw new Error('Unsupported body type in this SimplifiedFetch implementation.')
  }
}
