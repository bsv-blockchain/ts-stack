import { AuthFetch } from '../auth/clients/AuthFetch.js'
import type { WalletInterface } from '../wallet/Wallet.interfaces.js'
import {
  restoreOutputCapability,
  type OutputCapabilityRecoveryRequest
} from './OutputCapabilityRetention.js'
import type { OutputCapabilitySelection } from './OutputCapabilities.js'
import { outputEndpoint } from './OutputEndpoint.js'
import {
  OUTPUT_LOOKUP_PROFILE,
  negotiateOutputLookupLimits,
  parseOutputLookupBatch,
  outputLookupCheckpoint,
  parseOutputLookupCheckpoint,
  parseOutputLookupClose,
  parseOutputLookupOpen,
  parseOutputLookupRead,
  validateOutputLookupContinuation,
  type OutputLookupBatch,
  type OutputLookupCheckpoint,
  type OutputLookupLimits
} from './OutputLookupProtocol.js'
import { outputPacketDigest, outputU64 } from './OutputProtocol.js'
import { OutputProtocolError, outputAssert } from './OutputProtocolError.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import * as s from './OutputProtocolSchema.js'
import {
  OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES,
  outputServiceErrorHTTPStatus,
  parseOutputServiceError,
  type OutputServiceError
} from './OutputServiceError.js'
import { readLookupResponseBytes } from './LookupResponseReader.js'
import { LookupResourceLimitError } from './LookupResources.js'

export interface OutputLookupTransportOptions {
  /** Original integrity-protected local capability record, never remote input. */
  contract: unknown
  /** Trusted endpoint, identity, chain and installed rules for that saved record. */
  trust: OutputCapabilityRecoveryRequest
  /** Required when the retained profile selects BRC-103 authentication. */
  wallet?: WalletInterface
  fetch?: typeof fetch
  /** Total request deadline, including authentication; 1–30000 ms, default 30000. */
  requestTimeoutMs?: number
  /** Unix seconds, supplied by the trusted host clock. */
  now?: () => string
}

/** A schema-checked service error; the transport authenticates it when selected. */
export class OutputLookupServiceError extends OutputProtocolError {
  readonly packet: OutputServiceError
  constructor(packet: OutputServiceError) {
    const owned = parseOutputServiceError(packet)
    super(owned.error.code, owned.error.message, owned.error.retryable)
    this.name = 'OutputLookupServiceError'
    this.packet = owned
  }
}

const maximumHeaderBytes = 16384
const maximumRequestBytes = 1048576
const closedResponse = s.object({ version: s.literal(1), closed: s.literal(true) })

function checkHeaders(headers: Headers): void {
  let bytes = 0
  const encoder = new TextEncoder()
  headers.forEach((value, name) => {
    bytes += encoder.encode(name).length + encoder.encode(value).length
    outputAssert(bytes <= maximumHeaderBytes, 'Lookup HTTP header limit', 'limited')
  })
}

function checkHTTPResponse(response: Response, url: string): void {
  outputAssert(
    !response.redirected && (response.url === '' || response.url === url),
    'Lookup response changed endpoint',
    'unauthorized'
  )
  checkHeaders(response.headers)
  const encoding = response.headers.get('content-encoding')
  outputAssert(
    encoding === null || encoding.toLowerCase() === 'identity',
    'Lookup requires identity encoding'
  )
  // BRC-104 does not sign Content-Type, and existing authentication middleware
  // can send a signed JSON body as application/octet-stream. The strict JSON
  // decoder below checks actual UTF-8 bytes after authentication instead.
}

/**
 * Bounded BRC-193 HTTP transport for one retained service contract. No discovery,
 * cursor advancement, persistence, polling loop, wallet payment or observation
 * acceptance occurs here. Persist a freshly selected contract and random opening
 * request ID before first use. Restored contracts may only continue/retry those
 * original operations, not initiate new operations after manifest expiry.
 *
 * A read takes the caller's DURABLY COMMITTED previous batch. Commit its returned
 * observations and cursor together before supplying that batch to the next read.
 * Retrying with the same prior batch is non-destructive. One request is in flight
 * per instance, including late non-cancellable wallet/fetch work after timeout.
 */
export class OutputLookupTransport {
  private readonly selection: OutputCapabilitySelection
  private readonly wallet?: WalletInterface
  private readonly fetchClient: typeof fetch
  private readonly now: () => string
  private readonly timeout: number
  private readonly allowLocalHTTP: boolean
  private readonly extensions: readonly string[]
  private active = false

  constructor(options: OutputLookupTransportOptions) {
    outputAssert(
      options.trust.kind === 'lookup' && options.trust.profile === OUTPUT_LOOKUP_PROFILE,
      'Lookup transport requires the live lookup profile'
    )
    this.selection = restoreOutputCapability(options.contract, options.trust)
    this.wallet = options.wallet
    outputAssert(
      this.selection.profile.authentication === 'none' || this.wallet !== undefined,
      'Authenticated lookup requires a wallet'
    )
    this.fetchClient = options.fetch ?? globalThis.fetch?.bind(globalThis)
    outputAssert(typeof this.fetchClient === 'function', 'Lookup requires a fetch implementation')
    this.now = options.now ?? (() => String(Math.floor(Date.now() / 1000)))
    this.timeout = options.requestTimeoutMs ?? 30000
    outputAssert(
      Number.isSafeInteger(this.timeout) && this.timeout > 0 && this.timeout <= 30000,
      'Invalid lookup request deadline'
    )
    this.allowLocalHTTP = options.trust.allowLocalHTTP === true
    this.extensions = [...(options.trust.supportedExtensions ?? [])]
  }

  /** Execute/retry an opening already saved with this original contract. */
  async open(input: unknown, signal?: AbortSignal): Promise<OutputLookupBatch> {
    const request = parseOutputLookupOpen(input, this.extensions)
    outputAssert(
      request.service === this.selection.service.name,
      'Lookup service changed',
      'context-changed'
    )
    outputAssert(
      request.requiredRulesDigest === undefined ||
        request.requiredRulesDigest === this.selection.service.rulesDigest,
      'Lookup rules changed',
      'context-changed'
    )
    const limits = this.limits(request.limits)
    const bytes = await this.exchange('open', request, limits.maxBytes, signal)
    const batch = this.batch(bytes, limits)
    outputAssert(batch.phase === 'snapshot', 'Opening did not establish a snapshot')
    outputAssert(
      batch.scope.queryDigest ===
        outputPacketDigest('lookup-query', { service: request.service, query: request.query }),
      'Lookup query changed',
      'context-changed'
    )
    return batch
  }

  /** The previous batch must have been committed by the caller's checkpoint store. */
  async read(
    previousInput: unknown,
    requested: OutputLookupLimits,
    signal?: AbortSignal
  ): Promise<OutputLookupBatch> {
    return await this.readCheckpoint(
      outputLookupCheckpoint(previousInput, this.extensions),
      requested,
      signal
    )
  }

  /** Resume from continuity metadata committed atomically with the received groups. */
  async readCheckpoint(
    checkpointInput: unknown,
    requested: OutputLookupLimits,
    signal?: AbortSignal
  ): Promise<OutputLookupBatch> {
    const previous = parseOutputLookupCheckpoint(checkpointInput)
    this.checkScope(previous)
    this.checkDeadlines(previous)
    const request = parseOutputLookupRead({
      version: 1,
      session: previous.session,
      cursor: previous.cursor,
      limits: requested
    })
    const limits = this.limits(request.limits)
    const bytes = await this.exchange('read', request, limits.maxBytes, signal)
    const batch = this.batch(bytes, limits)
    validateOutputLookupContinuation(previous, batch)
    return batch
  }

  /** Idempotent close remains available after expiry; it does not disclose existence. */
  async close(session: string, signal?: AbortSignal): Promise<{ version: 1; closed: true }> {
    const request = parseOutputLookupClose({ version: 1, session })
    return s.normalized(await this.exchange('close', request, 4096, signal), closedResponse, 4096)
  }

  private limits(requested: OutputLookupLimits): OutputLookupLimits {
    const profile = this.selection.profile
    return negotiateOutputLookupLimits(requested, {
      maxBytes: profile.maxResponseBytes,
      maxObservations: profile.parameters.maxObservations as number,
      waitMs: profile.parameters.maxWaitMs as number
    })
  }

  private checkScope(batch: OutputLookupCheckpoint): void {
    const { manifest, service, profile } = this.selection
    const provider =
      profile.authentication === 'brc103'
        ? manifest.body.identity
        : new URL(manifest.body.baseURL).origin
    outputAssert(
      canonicalOutputJSON(batch.scope.chain) === canonicalOutputJSON(manifest.body.chain) &&
        batch.scope.provider === provider &&
        batch.scope.service === service.name &&
        batch.scope.rulesDigest === service.rulesDigest,
      'Lookup response changed selected scope',
      'context-changed'
    )
  }

  private checkDeadlines(batch: OutputLookupCheckpoint): void {
    const now = outputU64(this.now())
    outputAssert(
      now < outputU64(batch.expiresAt) && now < outputU64(batch.replayUntil),
      'Lookup session expired',
      'reset-required'
    )
    outputAssert(
      outputU64(batch.replayUntil) - outputU64(batch.expiresAt) ===
        outputU64(this.selection.profile.parameters.replaySeconds),
      'Lookup retention differs from original contract',
      'context-changed'
    )
  }

  private batch(bytes: Uint8Array, limits: OutputLookupLimits): OutputLookupBatch {
    const result = parseOutputLookupBatch(bytes, limits.maxBytes, this.extensions)
    outputAssert(
      canonicalOutputJSON(result.limits) === canonicalOutputJSON(limits),
      'Lookup changed negotiated limits'
    )
    this.checkScope(result)
    this.checkDeadlines(result)
    return result
  }

  private async exchange(
    operation: 'open' | 'read' | 'close',
    input: unknown,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const body = canonicalOutputJSON(input, {
      bytes: Math.min(maximumRequestBytes, this.selection.profile.maxRequestBytes)
    })
    const url = outputEndpoint(
      this.selection.manifest.body.baseURL,
      `/overlay/v1/lookup/${operation}`,
      this.allowLocalHTTP
    )
    outputAssert(!signal?.aborted, 'Lookup request cancelled', 'cancelled')
    outputAssert(!this.active, 'Lookup request or earlier I/O is still active', 'limited')
    this.active = true
    const controller = new AbortController()
    const stop = () =>
      controller.abort(new OutputProtocolError('cancelled', 'Lookup request cancelled'))
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const timer = setTimeout(
      () =>
        controller.abort(new OutputProtocolError('unavailable', 'Lookup request deadline', true)),
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
      outputAssert(
        response.headers.get(key) === value,
        'Lookup response changed selected contract',
        'context-changed'
      )
    const bytes = await readLookupResponseBytes(response, {
      maxResponseBytes: response.status === 200 ? maximumBytes : OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES,
      signal
    })
    if (response.status === 200) return bytes
    outputAssert(response.status !== 402, 'Live lookup cannot request payment', 'unsupported')
    const packet = parseOutputServiceError(bytes)
    outputAssert(
      response.status === outputServiceErrorHTTPStatus(packet.error.code),
      'Lookup error status mismatch'
    )
    throw new OutputLookupServiceError(packet)
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
        'Lookup transport changed endpoint',
        'unauthorized'
      )
      const headers = new Headers(init?.headers)
      headers.set('cache-control', 'no-store')
      checkHeaders(headers)
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
        checkHTTPResponse(response, url)
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
          throw new OutputProtocolError('limited', 'Lookup HTTP body limit')
        throw error
      }
    }
  }
}
