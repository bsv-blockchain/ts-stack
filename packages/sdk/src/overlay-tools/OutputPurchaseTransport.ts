import type { WalletInterface } from '../wallet/Wallet.interfaces.js'
import {
  restoreOutputCapability,
  type OutputCapabilityRecoveryRequest
} from './OutputCapabilityRetention.js'
import { OUTPUT_PROFILES, type OutputCapabilitySelection } from './OutputCapabilities.js'
import { canonicalOutputBase, outputEndpoint } from './OutputEndpoint.js'
import { canonicalOutputJSON, parseOutputJSON } from './OutputProtocolJSON.js'
import { outputU64 } from './OutputProtocol.js'
import { OutputProtocolError, outputAssert } from './OutputProtocolError.js'
import { parseOutputServiceError, type OutputServiceError } from './OutputServiceError.js'
import {
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  verifyOutputPurchaseTerms,
  verifyOutputPurchaseEnvelope,
  type OutputPurchasePrepare,
  type OutputPurchaseSubmit,
  type OutputSignedPurchaseTerms,
  type OutputPurchaseEnvelope
} from './OutputPurchaseProtocol.js'
import { OutputFiniteHTTP } from './internal/OutputFiniteHTTP.js'

export type OutputPurchaseOperation = 'prepare' | 'submit' | 'recover'
interface CommonOptions {
  /** Protected original selection and request. Restoring them is not permission for new work. */
  contract: unknown
  trust: OutputCapabilityRecoveryRequest
  request: unknown
  wallet: WalletInterface
  fetch?: typeof fetch
  requestTimeoutMs?: number
}
interface OperationOptions {
  prepare: { operation: 'prepare' }
  submit: { operation: 'submit'; terms: unknown; candidate: unknown }
  recover: { operation: 'recover'; terms: unknown; candidate?: unknown }
}
export type OutputPurchaseTransportOptions<Operation extends OutputPurchaseOperation> =
  CommonOptions & { operation: Operation } & OperationOptions[Operation]
export interface OutputPurchaseTransportResults {
  prepare: OutputSignedPurchaseTerms
  submit: OutputPurchaseEnvelope
  recover: OutputPurchaseEnvelope
}
export class OutputPurchaseServiceError extends OutputProtocolError {
  readonly packet: OutputServiceError
  constructor(input: OutputServiceError) {
    const packet = parseOutputServiceError(input)
    super(packet.error.code, packet.error.message, packet.error.retryable)
    this.name = 'OutputPurchaseServiceError'
    this.packet = packet
  }
}
/** One authenticated immutable BRC-196 exchange. No transaction construction,
 * payment header, broadcast, polling, durable state or claim of Script/key validity.
 * The durable buyer reserves original custody before prepare, and retains terms
 * and signed transaction before submit. Recovery never starts a new purchase.
 */
export class OutputPurchaseTransport<Operation extends OutputPurchaseOperation> {
  private readonly selection: OutputCapabilitySelection
  private readonly original: OutputPurchasePrepare
  private readonly terms?: OutputSignedPurchaseTerms
  private readonly candidate?: OutputPurchaseSubmit
  private readonly operation: Operation
  private readonly body: string
  private readonly url: string
  private readonly http: OutputFiniteHTTP
  constructor(options: OutputPurchaseTransportOptions<Operation>) {
    outputAssert(
      options.trust.kind === 'topic' && options.trust.profile === OUTPUT_PROFILES.purchase,
      'Purchase transport requires its explicit topic purchase profile',
      'unsupported'
    )
    this.selection = restoreOutputCapability(options.contract, options.trust)
    canonicalOutputBase(this.selection.manifest.body.baseURL)
    this.original = parseOutputPurchasePrepare(options.request)
    outputAssert(
      this.original.topic === this.selection.service.name &&
        canonicalOutputJSON(this.original.listing.chain) ===
          canonicalOutputJSON(this.selection.manifest.body.chain),
      'Purchase request differs from selected topic or chain',
      'context-changed'
    )
    outputAssert(
      ['prepare', 'submit', 'recover'].includes(options.operation),
      'Unknown purchase operation',
      'unsupported'
    )
    this.operation = options.operation
    outputAssert(
      options.wallet !== undefined && typeof options.wallet.getPublicKey === 'function',
      'Purchase requires an authentication wallet'
    )
    if ('terms' in options) this.terms = this.bindTerms(options.terms)
    if ('candidate' in options && options.candidate !== undefined) {
      this.candidate = parseOutputPurchaseSubmit(options.candidate)
      outputAssert(
        this.candidate.acquisitionId === this.terms?.body.acquisitionId,
        'Purchase candidate differs from original acquisition',
        'context-changed'
      )
    }
    if (this.operation !== 'prepare')
      outputAssert(this.terms !== undefined, 'Purchase requires original signed terms')
    if (this.operation === 'submit')
      outputAssert(
        this.candidate !== undefined,
        'Purchase submit requires the original signed transaction'
      )
    let request: unknown = this.original
    if (this.operation === 'submit') request = this.candidate
    else if (this.operation !== 'prepare')
      request = { version: 1, acquisitionId: this.terms!.body.acquisitionId }
    this.body = canonicalOutputJSON(request, {
      bytes: Math.min(4194304, this.selection.profile.maxRequestBytes)
    })
    this.url = outputEndpoint(
      this.selection.manifest.body.baseURL,
      '/overlay/v1/purchases/' + this.operation
    )
    this.http = new OutputFiniteHTTP({
      selection: this.selection,
      wallet: options.wallet,
      recipient: this.original.recipient,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs,
      messages: {
        fetch: 'Purchase requires a fetch implementation',
        timeout: 'Invalid purchase deadline',
        headers: 'Purchase HTTP header bound',
        responseEndpoint: 'Purchase response changed endpoint',
        encoding: 'Purchase requires identity encoding',
        cancelled: 'Purchase cancelled',
        active: 'Purchase or earlier I/O is still active',
        deadline: 'Purchase deadline',
        contract: 'Purchase response changed original contract',
        payment: 'Purchase cannot request an HTTP payment',
        status: 'Purchase error status mismatch',
        endpoint: 'Purchase transport changed endpoint',
        body: 'Purchase response byte bound'
      },
      serviceError: packet => new OutputPurchaseServiceError(packet)
    })
  }
  private bindTerms(input: unknown): OutputSignedPurchaseTerms {
    const terms = verifyOutputPurchaseTerms(
        input,
        this.original,
        this.selection.manifest.body.identity
      ),
      parameters = this.selection.profile.parameters
    outputAssert(
      (parameters.domainProfiles as string[]).includes(terms.body.domainProfile) &&
        (parameters.releasePolicies as unknown[]).some(
          policy => canonicalOutputJSON(policy) === canonicalOutputJSON(terms.body.releasePolicy)
        ),
      'Purchase terms changed selected domain or release policy',
      'context-changed'
    )
    outputAssert(
      outputU64(terms.body.recoveryUntil) - outputU64(terms.body.purchaseUntil) >=
        outputU64(parameters.recoverySeconds),
      'Purchase terms shortened selected recovery promise',
      'context-changed'
    )
    return terms
  }
  async send(signal?: AbortSignal): Promise<OutputPurchaseTransportResults[Operation]> {
    const bytes = await this.http.exchange(
      this.url,
      this.body,
      Math.min(4194304, this.selection.profile.maxResponseBytes),
      signal
    )
    // Transport authentication precedes closed decoding. POTATOES binds the
    // original transaction, but STEAK still is not mining or domain eligibility.
    const parsed = parseOutputJSON(bytes, {
      bytes: Math.min(4194304, this.selection.profile.maxResponseBytes)
    })
    return (
      this.operation === 'prepare'
        ? this.bindTerms(parsed)
        : verifyOutputPurchaseEnvelope(parsed, this.terms!, this.candidate?.txid)
    ) as OutputPurchaseTransportResults[Operation]
  }
}
