import type { WalletInterface } from '../wallet/Wallet.interfaces.js'
import {
  restoreOutputCapability,
  type OutputCapabilityRecoveryRequest
} from './OutputCapabilityRetention.js'
import { OUTPUT_PROFILES, type OutputCapabilitySelection } from './OutputCapabilities.js'
import { canonicalOutputBase, outputEndpoint } from './OutputEndpoint.js'
import { outputPacketDigest, outputU64, verifyOutputPacket } from './OutputProtocol.js'
import { OutputProtocolError, outputAssert } from './OutputProtocolError.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import type { OutputSignedProposal } from './OutputObservation.js'
import {
  parseOutputProposalPut,
  parseOutputProposalPutResponse,
  parseOutputProposalGet,
  parseOutputProposalGetResponse,
  parseOutputProposalFinalize,
  parseOutputProposalFinalizeResponse,
  type OutputProposalPut,
  type OutputProposalPutResponse,
  type OutputProposalGet,
  type OutputProposalGetResponse,
  type OutputProposalFinalize,
  type OutputProposalFinalizeResponse
} from './OutputProposalProtocol.js'
import { parseOutputServiceError, type OutputServiceError } from './OutputServiceError.js'
import { OutputFiniteHTTP } from './internal/OutputFiniteHTTP.js'

export type OutputProposalOperation = 'put' | 'get' | 'finalize'
export interface OutputProposalTransportResults {
  put: OutputProposalPutResponse
  get: OutputProposalGetResponse
  finalize: {
    response: OutputProposalFinalizeResponse
    /** Compares only the returned operation ID and transaction ID to this saved request. */
    matchesRequest: boolean
  }
}
export interface OutputProposalTransportOptions<Operation extends OutputProposalOperation> {
  /** Original integrity-protected local contract, persisted before first dispatch. */
  contract: unknown
  /** Explicit provider endpoint/identity/chain and installed service rules. */
  trust: OutputCapabilityRecoveryRequest
  operation: Operation
  /** Exact original request persisted with its selection. This instance cannot replace it. */
  request: unknown
  wallet: WalletInterface
  fetch?: typeof fetch
  requestTimeoutMs?: number
  /** Trusted Unix seconds; prevents presenting an already-expired active get. */
  now?: () => string
}
type OperationRequest =
  | { operation: 'put'; request: OutputProposalPut }
  | { operation: 'get'; request: OutputProposalGet }
  | { operation: 'finalize'; request: OutputProposalFinalize }

/** Authenticated, schema-checked service error; local transport failures remain distinct. */
export class OutputProposalServiceError extends OutputProtocolError {
  readonly packet: OutputServiceError
  constructor(packet: OutputServiceError) {
    const owned = parseOutputServiceError(packet)
    super(owned.error.code, owned.error.message, owned.error.retryable)
    this.name = 'OutputProposalServiceError'
    this.packet = owned
  }
}

/**
 * Finite BRC-194 client for one durably saved operation. Each send retries the
 * same owned request under its original selection. This transport never selects
 * a replacement operation, pays, signs a proposal/transaction, polls or persists.
 * Fresh effects require a selection valid at initiation; restoring old local
 * material only permits original recovery and never grants current authority.
 *
 * A returned proposal is authenticated data, not acceptance by an installed
 * domain policy or Bitcoin verification. Finalize can discover another existing
 * reservation: matchesRequest reports the exact ID comparison, not mining,
 * purchase readiness or permission to release a secret.
 */
export class OutputProposalTransport<Operation extends OutputProposalOperation> {
  private readonly selection: OutputCapabilitySelection
  private readonly original: OperationRequest
  private readonly body: string
  private readonly url: string
  private readonly responseBytes: number
  private readonly http: OutputFiniteHTTP
  private readonly extensions: readonly string[]
  private readonly now: () => string

  constructor(options: OutputProposalTransportOptions<Operation>) {
    outputAssert(
      options.trust.kind === 'topic' && options.trust.profile === OUTPUT_PROFILES.proposal,
      'Proposal transport requires the topic proposal profile'
    )
    this.selection = restoreOutputCapability(options.contract, options.trust)
    // Another profile's explicit local-HTTP exception never grants private delivery.
    canonicalOutputBase(this.selection.manifest.body.baseURL)
    outputAssert(options.wallet !== undefined, 'Proposals require an authentication wallet')
    this.extensions = [...(options.trust.supportedExtensions ?? [])]
    this.now = options.now ?? (() => String(Math.floor(Date.now() / 1000)))
    this.original = this.parseRequest(options.operation, options.request)
    this.body = canonicalOutputJSON(this.original.request, {
      bytes: Math.min(1048576, this.selection.profile.maxRequestBytes)
    })
    this.responseBytes = Math.min(4194304, this.selection.profile.maxResponseBytes)
    this.url = outputEndpoint(
      this.selection.manifest.body.baseURL,
      `/overlay/v1/proposals/${this.original.operation}`
    )
    this.http = new OutputFiniteHTTP({
      selection: this.selection,
      wallet: options.wallet,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs,
      messages: {
        fetch: 'Proposal transport requires a fetch implementation',
        timeout: 'Invalid proposal request deadline',
        headers: 'Proposal HTTP header limit',
        responseEndpoint: 'Proposal response changed endpoint',
        encoding: 'Proposals require identity encoding',
        cancelled: 'Proposal request cancelled',
        active: 'Proposal request or earlier I/O is still active',
        deadline: 'Proposal request deadline',
        contract: 'Proposal response changed selected contract',
        payment: 'Proposal operations cannot request payment',
        status: 'Proposal error status mismatch',
        endpoint: 'Proposal transport changed endpoint',
        body: 'Proposal HTTP body limit'
      },
      serviceError: packet => new OutputProposalServiceError(packet)
    })
  }

  /** Explicitly dispatch or retry only this instance's exact saved operation. */
  async send(signal?: AbortSignal): Promise<OutputProposalTransportResults[Operation]> {
    const bytes = await this.http.exchange(this.url, this.body, this.responseBytes, signal)
    // Both request and response are parsed under the same owned discriminator.
    return this.response(bytes) as OutputProposalTransportResults[Operation]
  }

  private parseRequest(operation: OutputProposalOperation, value: unknown): OperationRequest {
    if (operation === 'put') {
      const request = parseOutputProposalPut(value, this.extensions)
      this.proposal(request.proposal)
      return { operation, request }
    }
    if (operation === 'get') {
      const request = parseOutputProposalGet(value)
      this.service(request.service)
      this.policy(request.policy)
      return { operation, request }
    }
    outputAssert(operation === 'finalize', 'Unknown proposal transport operation', 'unsupported')
    const request = parseOutputProposalFinalize(value)
    this.service(request.service)
    return { operation, request }
  }

  private service(service: string): void {
    outputAssert(
      service === this.selection.service.name,
      'Proposal service changed',
      'context-changed'
    )
  }

  private policy(reference: { id: string; digest: string }): void {
    // The selected capability codec has checked the closed array and every digest.
    const policies = this.selection.profile.parameters.policies as unknown as {
      id: string
      digest: string
    }[]
    outputAssert(
      policies.some(item => item.id === reference.id && item.digest === reference.digest),
      'Proposal policy is not enabled by the selected contract',
      'unsupported'
    )
  }

  private proposal(proposal: OutputSignedProposal): void {
    const body = proposal.body
    this.service(body.service)
    this.policy(body.policy)
    outputAssert(
      canonicalOutputJSON(body.chain) === canonicalOutputJSON(this.selection.manifest.body.chain),
      'Proposal chain changed',
      'context-changed'
    )
    outputAssert(
      verifyOutputPacket('proposal', proposal, body.author),
      'Invalid proposal author signature',
      'unauthorized'
    )
    outputAssert(
      outputU64(body.expiresAt) - outputU64(body.issuedAt) <=
        outputU64(this.selection.profile.parameters.maxLifetimeSeconds),
      'Proposal exceeds selected lifetime',
      'limited'
    )
  }

  private response(bytes: Uint8Array): OutputProposalTransportResults[OutputProposalOperation] {
    const original = this.original
    if (original.operation === 'put') {
      const response = parseOutputProposalPutResponse(bytes)
      outputAssert(
        response.proposalId === outputPacketDigest('proposal', original.request.proposal.body) &&
          response.expiresAt === original.request.proposal.body.expiresAt,
        'Proposal acknowledgement changed the saved publication',
        'context-changed'
      )
      return response
    }
    if (original.operation === 'get') {
      const response = parseOutputProposalGetResponse(bytes, this.extensions)
      this.proposal(response.proposal)
      outputAssert(
        response.proposal.body.channel === original.request.channel &&
          canonicalOutputJSON(response.proposal.body.policy) ===
            canonicalOutputJSON(original.request.policy),
        'Proposal response changed the queried channel',
        'context-changed'
      )
      if (response.state.status === 'active')
        outputAssert(
          outputU64(this.now()) < outputU64(response.proposal.body.expiresAt),
          'Active proposal has expired',
          'expired'
        )
      return response
    }
    const response = parseOutputProposalFinalizeResponse(bytes)
    outputAssert(
      response.proposalId === original.request.proposalId,
      'Finalization changed the saved proposal',
      'context-changed'
    )
    outputAssert(
      ['finalizing', 'finalized', 'finalization-failed'].includes(response.state.status),
      'Finalization did not report a reserved admission'
    )
    const state = response.state
    return {
      response,
      matchesRequest:
        'operationId' in state &&
        state.operationId === original.request.operationId &&
        state.txid === original.request.txid
    }
  }
}
