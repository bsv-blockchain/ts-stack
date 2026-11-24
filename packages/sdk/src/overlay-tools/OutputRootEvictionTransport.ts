import type { WalletInterface } from '../wallet/Wallet.interfaces.js'
import {
  restoreOutputCapability,
  type OutputCapabilityRecoveryRequest
} from './OutputCapabilityRetention.js'
import { OUTPUT_PROFILES, type OutputCapabilitySelection } from './OutputCapabilities.js'
import { outputEndpoint } from './OutputEndpoint.js'
import { outputHex32, outputU64 } from './OutputProtocol.js'
import { OutputProtocolError, outputAssert } from './OutputProtocolError.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import {
  parseOutputRootEvictionRequest,
  verifyOutputRootEvictionRequest,
  verifyOutputRootEvictionResult,
  type OutputSignedRootEvictionRequest,
  type OutputSignedRootEvictionResult
} from './OutputRootEvictionProtocol.js'
import { parseOutputServiceError, type OutputServiceError } from './OutputServiceError.js'
import { OutputFiniteHTTP } from './internal/OutputFiniteHTTP.js'

export interface OutputRootEvictionTransportOptions {
  /** Original integrity-protected local capability record, never supplied by a peer. */
  contract: unknown
  /** Trusted root endpoint, identity, chain and installed rule validators. */
  trust: OutputCapabilityRecoveryRequest
  /** Original signed request, durably saved together with the selected contract. */
  request: unknown
  /** Independently retained root evaluation policy; never copied from a result. */
  policyDigest: string
  /** Authenticates the requester, or an independently authorized status auditor. */
  wallet: WalletInterface
  fetch?: typeof fetch
  /** Total deadline including authentication, 1–30000 ms; default 30000. */
  requestTimeoutMs?: number
}

/** An authenticated and schema-checked root service error. */
export class OutputRootEvictionServiceError extends OutputProtocolError {
  readonly packet: OutputServiceError
  constructor(packet: OutputServiceError) {
    const owned = parseOutputServiceError(packet)
    super(owned.error.code, owned.error.message, owned.error.retryable)
    this.name = 'OutputRootEvictionServiceError'
    this.packet = owned
  }
}

/**
 * Finite authenticated BRC-199 request/status client for one retained operation.
 * Persist the original request, selected capability and independently selected
 * evaluation policy before the first send. Discovery or a response cannot replace
 * them. Restored selections support exact retries/status after manifest expiry;
 * they do not authorize fresh operations under an expired capability.
 *
 * No automatic discovery, polling, persistence, payments, evidence acceptance or
 * local serving decisions occur here. A verified result reports that root's
 * observation; it does not prove present eligibility or agreement by other roots.
 * One physical request is in flight per instance, including late wallet/fetch work
 * after logical cancellation. Current request/auditor authority belongs to the root.
 */
export class OutputRootEvictionTransport {
  private readonly selection: OutputCapabilitySelection
  private readonly request: OutputSignedRootEvictionRequest
  private readonly policy: string
  private readonly body: string
  private readonly responseBytes: number
  private readonly http: OutputFiniteHTTP

  constructor(options: OutputRootEvictionTransportOptions) {
    outputAssert(
      options.trust.kind === 'coordination' &&
        options.trust.service === 'root-advertisements' &&
        options.trust.profile === OUTPUT_PROFILES.eviction,
      'Root transport requires the root-advertisements coordination profile'
    )
    this.selection = restoreOutputCapability(options.contract, options.trust)
    outputAssert(options.wallet !== undefined, 'Root coordination requires a wallet')
    const original = parseOutputRootEvictionRequest(options.request)
    this.request = verifyOutputRootEvictionRequest(original, {
      root: this.selection.manifest.body.identity,
      chain: this.selection.manifest.body.chain,
      requester: original.body.requester
    })
    this.policy = outputHex32(options.policyDigest)
    const profile = this.selection.profile
    outputAssert(
      original.body.targets.length <= Math.min(64, profile.parameters.maxTargets as number) &&
        outputU64(original.body.expiresAt) - outputU64(original.body.issuedAt) <=
          outputU64(profile.parameters.maxLifetimeSeconds),
      'Root request exceeds its original selected limits',
      'limited'
    )
    this.body = canonicalOutputJSON(this.request, {
      bytes: Math.min(1048576, profile.maxRequestBytes)
    })
    this.responseBytes = Math.min(1048576, profile.maxResponseBytes)
    this.http = new OutputFiniteHTTP({
      selection: this.selection,
      wallet: options.wallet,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs,
      messages: {
        fetch: 'Root coordination requires a fetch implementation',
        timeout: 'Invalid root coordination request deadline',
        headers: 'Root HTTP header limit',
        responseEndpoint: 'Root response changed endpoint',
        encoding: 'Root requires identity encoding',
        cancelled: 'Root request cancelled',
        active: 'Root request or earlier I/O is still active',
        deadline: 'Root request deadline',
        contract: 'Root response changed selected contract',
        payment: 'Root coordination cannot request payment',
        status: 'Root error status mismatch',
        endpoint: 'Root transport changed endpoint',
        body: 'Root HTTP body limit'
      },
      serviceError: packet => new OutputRootEvictionServiceError(packet)
    })
  }

  /** Submit or retry only the original saved signed request. */
  async submit(signal?: AbortSignal): Promise<OutputSignedRootEvictionResult> {
    return await this.exchange('request', this.body, signal)
  }

  /** Query only the original requester/request ID under the original selection. */
  async status(signal?: AbortSignal): Promise<OutputSignedRootEvictionResult> {
    const body = canonicalOutputJSON(
      {
        version: 1,
        requester: this.request.body.requester,
        requestId: this.request.body.requestId
      },
      { bytes: Math.min(1048576, this.selection.profile.maxRequestBytes) }
    )
    return await this.exchange('status', body, signal)
  }

  private async exchange(
    operation: 'request' | 'status',
    body: string,
    signal?: AbortSignal
  ): Promise<OutputSignedRootEvictionResult> {
    const url = outputEndpoint(
      this.selection.manifest.body.baseURL,
      `/overlay/v1/root-evictions/${operation}`
    )
    const bytes = await this.http.exchange(url, body, this.responseBytes, signal)
    return verifyOutputRootEvictionResult(bytes, this.request, this.policy)
  }
}
