import type { WalletInterface } from '../wallet/Wallet.interfaces.js'
import {
  restoreOutputCapability,
  type OutputCapabilityRecoveryRequest
} from './OutputCapabilityRetention.js'
import { OUTPUT_PROFILES, type OutputCapabilitySelection } from './OutputCapabilities.js'
import { canonicalOutputBase, outputEndpoint } from './OutputEndpoint.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import { outputPacketDigest, outputU64 } from './OutputProtocol.js'
import { OutputProtocolError, outputAssert } from './OutputProtocolError.js'
import { parseOutputServiceError, type OutputServiceError } from './OutputServiceError.js'
import {
  bindOutputPaidLookupChallenge,
  bindOutputPaidLookupAcquired,
  parseOutputPaidLookupAcquire,
  parseOutputPaidLookupAcquired,
  type OutputPaidLookupAcquire,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupAcquired
} from './OutputPaidLookupProtocol.js'
import {
  parseOutputPaidLookupPayment,
  type OutputPaidLookupPayment
} from './OutputPaidLookupFunding.js'
import { OutputFiniteHTTP, type OutputFiniteHTTPResponse } from './internal/OutputFiniteHTTP.js'

export type OutputPaidLookupOperation = 'quote' | 'pay' | 'recover'
export type OutputPaidLookupQuote =
  | { kind: 'challenge'; challenge: OutputPaidLookupChallenge }
  | { kind: 'status'; response: OutputPaidLookupAcquired }
export interface OutputPaidLookupTransportResults {
  quote: OutputPaidLookupQuote
  pay: OutputPaidLookupAcquired
  recover: OutputPaidLookupAcquired
}
interface CommonOptions {
  /** Integrity-protected original local contract, persisted before first dispatch. */
  contract: unknown
  trust: OutputCapabilityRecoveryRequest
  /** Exact original Acquire, including the stable recipient and request ID. */
  request: unknown
  wallet: WalletInterface
  fetch?: typeof fetch
  requestTimeoutMs?: number
}
interface OperationOptions {
  quote: { operation: 'quote' }
  pay: { operation: 'pay'; challenge: unknown; payment: unknown }
  recover: { operation: 'recover'; challenge?: unknown }
}
export type OutputPaidLookupTransportOptions<Operation extends OutputPaidLookupOperation> =
  CommonOptions & { operation: Operation } & OperationOptions[Operation]

export class OutputPaidLookupServiceError extends OutputProtocolError {
  readonly packet: OutputServiceError
  constructor(input: OutputServiceError) {
    const packet = parseOutputServiceError(input)
    super(packet.error.code, packet.error.message, packet.error.retryable)
    this.name = 'OutputPaidLookupServiceError'
    this.packet = packet
  }
}
/**
 * One immutable selected-host BRC-195 HTTP operation. No automatic payment,
 * construction, persistence, polling, fan-out or proof of secret usability.
 * A durable buyer owner stores selection/request, then quote, then exact signed
 * payment bytes before creating each corresponding transport. Recovery can use
 * the original manifest after expiry but cannot authorize a new financial effect.
 */
export class OutputPaidLookupTransport<Operation extends OutputPaidLookupOperation> {
  private readonly selection: OutputCapabilitySelection
  private readonly original: OutputPaidLookupAcquire
  private readonly challenge?: OutputPaidLookupChallenge
  private readonly payment?: OutputPaidLookupPayment
  private readonly operation: Operation
  private readonly extensions: readonly string[]
  private readonly url: string
  private readonly body: string
  private readonly maximumBytes: number
  private readonly http: OutputFiniteHTTP
  private readonly wallet: WalletInterface
  constructor(options: OutputPaidLookupTransportOptions<Operation>) {
    outputAssert(
      options.trust.kind === 'lookup' && options.trust.profile === OUTPUT_PROFILES.acquisition,
      'Paid lookup transport requires its acquisition profile'
    )
    this.selection = restoreOutputCapability(options.contract, options.trust)
    canonicalOutputBase(this.selection.manifest.body.baseURL)
    this.extensions = [...(options.trust.supportedExtensions ?? [])]
    this.original = parseOutputPaidLookupAcquire(options.request, this.extensions)
    outputAssert(
      this.original.service === this.selection.service.name &&
        canonicalOutputJSON(this.original.listing.chain) ===
          canonicalOutputJSON(this.selection.manifest.body.chain),
      'Paid lookup request differs from selected service or chain',
      'context-changed'
    )
    outputAssert(
      options.operation === 'quote' ||
        options.operation === 'pay' ||
        options.operation === 'recover',
      'Unknown paid lookup operation',
      'unsupported'
    )
    this.operation = options.operation as Operation
    this.wallet = options.wallet
    outputAssert(
      this.wallet !== undefined && typeof this.wallet.getPublicKey === 'function',
      'Paid lookup requires an authentication wallet'
    )
    if ('challenge' in options && options.challenge !== undefined)
      this.challenge = this.bindChallenge(options.challenge)
    if (options.operation === 'pay') {
      outputAssert(this.challenge !== undefined, 'Payment requires its retained original challenge')
      outputAssert('payment' in options, 'Payment requires its retained signed transaction')
      this.payment = parseOutputPaidLookupPayment(options.payment)
      outputAssert(
        this.payment.derivationPrefix === this.challenge.derivationPrefix,
        'Payment differs from original prefix'
      )
    }
    const acquire = canonicalOutputJSON(this.original, {
      bytes: Math.min(4194304, this.selection.profile.maxRequestBytes)
    })
    const acquisitionId = outputPacketDigest('acquisition', {
      chain: this.original.listing.chain,
      seller: this.selection.manifest.body.identity,
      buyer: this.original.recipient,
      service: this.original.service,
      requestId: this.original.requestId
    })
    this.body =
      this.operation === 'recover'
        ? canonicalOutputJSON(
            { version: 1, acquisitionId },
            { bytes: this.selection.profile.maxRequestBytes }
          )
        : acquire
    this.url = outputEndpoint(
      this.selection.manifest.body.baseURL,
      '/overlay/v1/private/' + (this.operation === 'recover' ? 'recover' : 'acquire')
    )
    this.maximumBytes = Math.min(4194304, this.selection.profile.maxResponseBytes)
    this.http = new OutputFiniteHTTP({
      selection: this.selection,
      wallet: this.wallet,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs,
      messages: {
        fetch: 'Paid lookup requires a fetch implementation',
        timeout: 'Invalid paid lookup deadline',
        headers: 'Paid lookup HTTP header limit',
        responseEndpoint: 'Paid lookup response changed endpoint',
        encoding: 'Paid lookup requires identity encoding',
        cancelled: 'Paid lookup cancelled',
        active: 'Paid lookup or earlier I/O is still active',
        deadline: 'Paid lookup deadline',
        contract: 'Paid lookup response changed original contract',
        payment: 'This paid lookup operation cannot request another payment',
        status: 'Paid lookup error status mismatch',
        endpoint: 'Paid lookup transport changed endpoint',
        body: 'Paid lookup response byte limit'
      },
      serviceError: packet => new OutputPaidLookupServiceError(packet)
    })
  }
  async send(signal?: AbortSignal): Promise<OutputPaidLookupTransportResults[Operation]> {
    outputAssert(!signal?.aborted, 'Paid lookup cancelled', 'cancelled')
    const response = await this.http.exchangeAcquisition(
      this.url,
      this.body,
      this.maximumBytes,
      {
        buyer: this.original.recipient,
        allowChallenge: this.operation === 'quote',
        ...(this.payment
          ? { paymentHeader: canonicalOutputJSON(this.payment, { bytes: 98304 }) }
          : {})
      },
      signal
    )
    return this.result(response) as OutputPaidLookupTransportResults[Operation]
  }
  private bindChallenge(input: unknown): OutputPaidLookupChallenge {
    const challenge = bindOutputPaidLookupChallenge(
      input,
      this.original,
      {
        seller: this.selection.manifest.body.identity,
        rulesDigest: this.selection.service.rulesDigest
      },
      this.extensions
    )
    outputAssert(
      canonicalOutputJSON(challenge.acceptancePolicy) ===
        canonicalOutputJSON(this.selection.profile.parameters.acceptancePolicy),
      'Paid lookup challenge changed selected acceptance policy',
      'context-changed'
    )
    outputAssert(
      outputU64(challenge.recoveryUntil) - outputU64(challenge.payableUntil) >=
        outputU64(this.selection.profile.parameters.recoverySeconds),
      'Paid lookup challenge shortened selected recovery promise',
      'context-changed'
    )
    return challenge
  }
  private result(
    response: OutputFiniteHTTPResponse
  ): OutputPaidLookupTransportResults[OutputPaidLookupOperation] {
    outputAssert(
      response.headers.get('x-bsv-auth-identity-key') === this.selection.manifest.body.identity,
      'Paid lookup response seller changed',
      'unauthorized'
    )
    const paymentHeaders = [
      'x-bsv-payment-version',
      'x-bsv-payment-satoshis-required',
      'x-bsv-payment-derivation-prefix'
    ]
    if (response.statusCode === 402) {
      outputAssert(
        this.operation === 'quote',
        'Recovery cannot authorize a new payment',
        'unsupported'
      )
      const challenge = this.bindChallenge(response.body)
      outputAssert(
        response.headers.get(paymentHeaders[0]) === '1.0' &&
          response.headers.get(paymentHeaders[1]) === challenge.satoshis &&
          response.headers.get(paymentHeaders[2]) === challenge.derivationPrefix,
        'Paid lookup headers differ from original challenge'
      )
      return { kind: 'challenge', challenge }
    }
    outputAssert(
      paymentHeaders.every(name => !response.headers.has(name)),
      'Non-challenge paid lookup response contains payment headers'
    )
    const packet = parseOutputPaidLookupAcquired(response.body)
    const challenge = this.challenge ?? this.bindChallenge(packet.challenge)
    const acquired = bindOutputPaidLookupAcquired(
      packet,
      challenge,
      this.original,
      {
        seller: this.selection.manifest.body.identity,
        rulesDigest: this.selection.service.rulesDigest
      },
      this.extensions
    )
    return this.operation === 'quote' ? { kind: 'status', response: acquired } : acquired
  }
}
