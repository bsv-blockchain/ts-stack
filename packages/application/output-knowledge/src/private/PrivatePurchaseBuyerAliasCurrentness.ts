import {
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  parseOutputPurchaseCommitmentBinding,
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  verifyOutputPurchaseTerms,
  verifyOutputPurchaseCommitmentEnvelopeWithInlineStrings as verifyOutputPurchaseCommitmentEnvelope,
  type OutputPurchaseCommitmentBinding,
  type OutputPurchaseEnvelope,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import type { PrivatePurchaseBuyerValidation } from './PrivatePurchaseBuyerPorts.js'
import type {
  PrivatePurchaseAliasCurrentness,
  PrivatePurchaseAliasCurrentnessAssessment
} from './SDKPrivatePurchaseAliasCurrentness.js'

/** Read-only buyer companion. The binding must come from the buyer's already
 * fully verified original paid candidate, never from the provider's alias label.
 * This checks the optional alias against the original signed request/domain AND
 * the buyer's own selected chain. It does not accept a new License/key, pay,
 * submit, change historical release evidence or establish usable entitlement. */
export class PrivatePurchaseBuyerAliasCurrentness {
  private readonly seller: string
  private readonly domainProfile: string
  private readonly binding: NonNullable<PrivatePurchaseBuyerValidation['candidateBinding']>
  private readonly assessChain: PrivatePurchaseAliasCurrentness['assess']
  private readonly validationId: string
  private readonly options: {
    seller: string
    domainProfile: string
    validation: PrivatePurchaseBuyerValidation
    currentness: PrivatePurchaseAliasCurrentness
  }
  constructor(options: {
    seller: string
    domainProfile: string
    validation: PrivatePurchaseBuyerValidation
    currentness: PrivatePurchaseAliasCurrentness
  }) {
    this.options = Object.freeze({ ...options })
    this.seller = outputIdentity(options.seller)
    this.domainProfile = outputString(options.domainProfile)
    this.validationId = outputString(options.validation.id)
    outputAssert(
      typeof options.validation.candidateBinding === 'function' &&
        typeof options.currentness.assess === 'function',
      'Buyer alias currentness requires full independent domain and selected-chain verification'
    )
    this.binding = options.validation.candidateBinding
    this.assessChain = options.currentness.assess
  }
  private current(signal: AbortSignal): void {
    outputAssert(!signal.aborted, 'Buyer alias assessment cancelled', 'cancelled')
    outputAssert(
      this.options.validation.id === this.validationId &&
        this.options.validation.candidateBinding === this.binding &&
        this.options.currentness.assess === this.assessChain,
      'Buyer alias verification owner changed',
      'context-changed'
    )
  }
  async assess(
    requestInput: OutputPurchasePrepare,
    termsInput: OutputSignedPurchaseTerms,
    bindingInput: OutputPurchaseCommitmentBinding,
    envelopeInput: OutputPurchaseEnvelope,
    signal: AbortSignal
  ): Promise<PrivatePurchaseAliasCurrentnessAssessment | undefined> {
    this.current(signal)
    const request = parseOutputPurchasePrepare(requestInput),
      terms = verifyOutputPurchaseTerms(termsInput, request, this.seller),
      binding = parseOutputPurchaseCommitmentBinding(bindingInput)
    outputAssert(
      terms.body.domainProfile === this.domainProfile &&
        binding.domainProfile === this.domainProfile &&
        binding.profile === 'full-purchase-commitment-v1',
      'Buyer alias assessment changes installed domain',
      'context-changed'
    )
    const envelope = verifyOutputPurchaseCommitmentEnvelope(envelopeInput, terms, binding)
    if (!envelope.currentAlias) return undefined
    const candidate = parseOutputPurchaseSubmit({
      version: 1,
      acquisitionId: terms.body.acquisitionId,
      ...envelope.currentAlias
    })
    const verified = await this.binding.call(
      this.options.validation,
      structuredClone(request),
      structuredClone(terms),
      structuredClone(candidate),
      signal
    )
    this.current(signal)
    const commitment = Object.getOwnPropertyDescriptor(verified, 'purchaseCommitment')?.value
    outputAssert(
      outputHex32(commitment) === binding.purchaseCommitment,
      'Buyer alias changes original purchase commitment',
      'conflict'
    )
    const check = Object.getOwnPropertyDescriptor(verified, 'checkCurrent')?.value
    outputAssert(
      typeof check === 'function' && check.constructor.name !== 'AsyncFunction',
      'Buyer alias domain requires an owned synchronous guard'
    )
    const domainCurrent = () => {
      this.current(signal)
      outputAssert(
        Object.getOwnPropertyDescriptor(verified, 'checkCurrent')?.value === check,
        'Buyer alias domain guard changed',
        'context-changed'
      )
      const result: unknown = check.call(verified)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(
        result === undefined &&
          Object.getOwnPropertyDescriptor(verified, 'purchaseCommitment')?.value === commitment &&
          Object.getOwnPropertyDescriptor(verified, 'checkCurrent')?.value === check,
        'Buyer alias domain guard must finish synchronously with unchanged identity',
        'context-changed'
      )
    }
    domainCurrent()
    const assessment = await this.assessChain.call(
      this.options.currentness,
      { acquisitionId: terms.body.acquisitionId, chain: structuredClone(request.listing.chain) },
      structuredClone(candidate),
      signal
    )
    domainCurrent()
    if (!assessment) return undefined
    outputAssert(
      assessment.currentAlias.txid === candidate.txid &&
        assessment.currentAlias.beef === candidate.beef,
      'Buyer alias chain assessment changes exact evidence',
      'context-changed'
    )
    const placement = assessment.placement,
      chainCheck = Object.getOwnPropertyDescriptor(placement, 'checkCurrent')?.value
    outputAssert(
      typeof chainCheck === 'function' && chainCheck.constructor.name !== 'AsyncFunction',
      'Buyer alias chain requires an owned synchronous guard'
    )
    const checkCurrent = () => {
      domainCurrent()
      outputAssert(
        Object.getOwnPropertyDescriptor(placement, 'checkCurrent')?.value === chainCheck,
        'Buyer alias chain guard changed',
        'context-changed'
      )
      const result: unknown = chainCheck.call(placement)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(
        result === undefined,
        'Buyer alias chain guard must finish synchronously',
        'context-changed'
      )
      domainCurrent()
    }
    checkCurrent()
    return Object.freeze({
      ...assessment,
      currentAlias: Object.freeze({ txid: candidate.txid, beef: candidate.beef }),
      placement: Object.freeze({ checkCurrent })
    })
  }
}
