import {
  canonicalOutputJSONWithInlineStrings as canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputHex32,
  ownOutputJSONWithInlineStrings as ownOutputJSON,
  closedOutputObject,
  parseOutputChain,
  outputU64,
  OutputProtocolError,
  parseOutputPurchaseSubmit,
  Utils,
  type OutputChain,
  type OutputPurchaseCurrentAlias,
  type OutputPurchaseSubmit,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'
import type { PrivatePurchaseAliasPlacement } from './PrivatePurchaseAliasState.js'

/** Installed local selected-chain authority. A source report or remote height
 * cannot implement this contract without independently verified ancestry/work.
 * The coordinator separately verifies every purchase input, receipt and lineage. */
export interface PrivatePurchaseAliasChainSelection {
  context(signal: AbortSignal): Promise<VerificationContext>
  current(context: VerificationContext): boolean
}

export interface PrivatePurchaseAliasCurrentnessAssessment {
  readonly currentAlias: OutputPurchaseCurrentAlias
  readonly contextId: string
  readonly chainPolicyDigest: string
  readonly blockHash: string
  readonly height: string
  readonly tipHash: string
  readonly tipHeight: string
  /** Use again at the native selection/first-release writer, and immediately
   * before reporting currentAlias. Never persist this guard as a current verdict. */
  readonly placement: PrivatePurchaseAliasPlacement
}

/** Derive from fresh guarded native custody. This subject selects the acquisition
 * and chain; it does not establish purchase equivalence, admission or entitlement. */
export interface PrivatePurchaseAliasCurrentnessSubject {
  readonly acquisitionId: string
  readonly chain: OutputChain
}

export interface PrivatePurchaseAliasCurrentness {
  assess(
    subject: PrivatePurchaseAliasCurrentnessSubject,
    candidate: OutputPurchaseSubmit,
    signal: AbortSignal
  ): Promise<PrivatePurchaseAliasCurrentnessAssessment | undefined>
}

/** Fresh exact-subject Script/SPV assessment in the installed selected ancestry.
 * This verifies inclusion/currentness, not purchase equivalence or private rights.
 * Historical entitlement recovery must remain available when no alias assessment
 * can be obtained. No historical release is re-gated through this adapter. */
export class SDKPrivatePurchaseAliasCurrentness implements PrivatePurchaseAliasCurrentness {
  private readonly verifier: SDKEvidenceVerifier
  private readonly resolve: ChainViewResolver['resolve']
  private readonly context: PrivatePurchaseAliasChainSelection['context']
  private readonly current: PrivatePurchaseAliasChainSelection['current']
  constructor(
    private readonly chains: ChainViewResolver,
    private readonly selection: PrivatePurchaseAliasChainSelection,
    limits: Partial<TransactionEvidenceLimits> = {}
  ) {
    outputAssert(typeof chains.resolve === 'function', 'Selected alias ancestry is required')
    outputAssert(typeof selection.context === 'function', 'Selected alias context is required')
    outputAssert(
      typeof selection.current === 'function' &&
        selection.current.constructor.name !== 'AsyncFunction',
      'Selected alias authority must be synchronous'
    )
    this.resolve = chains.resolve
    this.context = selection.context
    this.current = selection.current
    this.verifier = new SDKEvidenceVerifier(chains, limits)
  }

  async assess(
    subject: PrivatePurchaseAliasCurrentnessSubject,
    input: OutputPurchaseSubmit,
    signal: AbortSignal
  ): Promise<PrivatePurchaseAliasCurrentnessAssessment | undefined> {
    const value = ownOutputJSON(subject, { bytes: 4096 }).value
    closedOutputObject(value, ['acquisitionId', 'chain'])
    const owned = {
      acquisitionId: outputHex32(value.acquisitionId),
      chain: parseOutputChain(value.chain)
    }
    const candidate = parseOutputPurchaseSubmit(input)
    outputAssert(
      candidate.acquisitionId === owned.acquisitionId,
      'Selected alias belongs to another acquisition',
      'conflict'
    )
    outputAssert(!signal.aborted, 'Alias chain assessment cancelled', 'cancelled')
    const snapshot = parseVerificationContext(await this.context.call(this.selection, signal))
    outputAssert(
      canonicalOutputJSON(snapshot.view.chain) === canonicalOutputJSON(owned.chain),
      'Selected alias context belongs to another chain',
      'context-changed'
    )
    const checkCurrent = () => {
      outputAssert(!signal.aborted, 'Alias chain assessment cancelled', 'cancelled')
      outputAssert(
        this.chains.resolve === this.resolve &&
          this.selection.context === this.context &&
          this.selection.current === this.current,
        'Selected alias chain capability changed',
        'context-changed'
      )
      outputAssert(
        BigInt(Date.now()) < outputU64(snapshot.limits.deadline) * 1000n,
        'Selected alias assessment deadline elapsed',
        'limited'
      )
      const checked: unknown = this.current.call(this.selection, structuredClone(snapshot))
      if (checked instanceof Promise) void checked.catch(() => undefined)
      outputAssert(
        checked === true && !signal.aborted,
        'Selected alias ancestry changed',
        'context-changed'
      )
      outputAssert(
        this.chains.resolve === this.resolve &&
          this.selection.context === this.context &&
          this.selection.current === this.current,
        'Selected alias chain capability changed',
        'context-changed'
      )
    }
    checkCurrent()
    const bytes = decodeOutputBytes(candidate.beef, snapshot.limits.bytes)
    let variantId: string
    try {
      variantId = Utils.toHex(Hash.sha256(bytes))
    } finally {
      bytes.fill(0)
    }
    const checked = await this.verifier.verify(
      {
        chain: snapshot.view.chain,
        evidence: { txid: candidate.txid, beef: candidate.beef, outputIndex: 0 },
        variantId
      },
      snapshot,
      signal
    )
    checkCurrent()
    if (checked.status !== 'verified') {
      if (checked.status === 'unresolved' || checked.status === 'limited') return undefined
      throw new OutputProtocolError(
        checked.status,
        'Selected alias verification ' + checked.status,
        checked.status !== 'invalid'
      )
    }
    outputAssert(
      checked.contextId === snapshot.id &&
        checked.variantId === variantId &&
        checked.fact.txid === candidate.txid &&
        canonicalOutputJSON(checked.fact.chain) === canonicalOutputJSON(snapshot.view.chain),
      'Selected alias verification subject changed',
      'context-changed'
    )
    if (checked.placement === undefined) return undefined
    outputAssert(
      outputU64(checked.placement.height) <= outputU64(snapshot.view.tipHeight),
      'Selected alias inclusion is above the selected tip',
      'invalid'
    )
    // The placement comes from the existing verifier's authenticated immutable
    // ancestry; a matching pair of remotely supplied hash/height strings is not
    // sufficient to reach this branch.
    return Object.freeze({
      currentAlias: Object.freeze({ txid: candidate.txid, beef: candidate.beef }),
      contextId: snapshot.id,
      chainPolicyDigest: snapshot.view.chainPolicyDigest,
      blockHash: checked.placement.blockHash,
      height: checked.placement.height,
      tipHash: snapshot.view.tipHash,
      tipHeight: snapshot.view.tipHeight,
      placement: Object.freeze({ checkCurrent })
    })
  }
}
