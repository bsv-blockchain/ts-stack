import {
  Beef,
  canonicalOutputJSON,
  decodeOutputBytes,
  OutputProtocolError,
  parseOutputEvidence,
  parseOutputPurchasePrepare,
  Utils,
  verifyOutputPurchaseTerms,
  type OutputEvidence,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import type { RevenueListingProfile } from '@bsv/sdk/script/templates/RevenueListingProfile'
import { planRevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfilePlan'
import { RevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import type { ChainViewResolver } from '../SDKEvidenceVerifier.js'
import { parseVerificationContext } from '../validation.js'
import type { VerificationContext } from '../ports.js'
import {
  assembleLineage,
  lineageLimits,
  requireLineage,
  type RevenueListingLineageLimits
} from './LineagePackage.js'
import {
  parseRevenueListingProfileLineagePackage,
  type RevenueListingProfileLineagePackage
} from './ProfileLineagePackage.js'
import {
  RevenueListingProfileLineageVerifier,
  type RevenueListingProfileLineageResult
} from './RevenueListingProfileLineageVerifier.js'

import {
  REVENUE_LISTING_PURCHASE_PROFILE,
  REVENUE_LISTING_LINEAGE_SCHEMA
} from './RevenueListingPurchaseVerifier.js'
type VerifiedLineage = Extract<RevenueListingProfileLineageResult, { status: 'verified' }>
export type RevenueListingProfilePurchaseResult =
  | {
      status: 'verified'
      request: OutputPurchasePrepare
      terms: OutputSignedPurchaseTerms
      purchase: OutputEvidence
      preparedLineage: RevenueListingProfileLineagePackage
      /** Full independently checked history through the purchased successor. */
      lineage: VerifiedLineage
      predecessor: OutputPurchasePrepare['listing']
      successor: OutputPurchasePrepare['listing']
      previousSatoshis: string
      increment: string
      /** Full input-zero SHA256d preimage digest, returned only after complete
       * Bitcoin, Script, lineage and original-request verification succeeds.
       */
      purchaseCommitment: string
    }
  | (Exclude<RevenueListingProfileLineageResult, { status: 'verified' }> & {
      /** Bounded local diagnostic for preparation/ABI refusals. Not a wire
       * decision, global conflict verdict or replacement for status/dependencies.
       */
      reason?: string
    })

/** Verify the exact prepared BRC-196 purchase, not a seller's claimed increment.
 * This validates Bitcoin/family/history/request association. It does not establish
 * asset authority, unspentness, winning a conflict, admission, release or usability.
 */
export class RevenueListingProfilePurchaseVerifier {
  private readonly limits: Readonly<RevenueListingLineageLimits>
  private readonly lineage: RevenueListingProfileLineageVerifier
  private readonly lock: RevenueListingProfile['lock']
  private readonly decode: RevenueListingProfile['decode']
  private readonly resolve: ChainViewResolver['resolve']
  constructor(
    private readonly family: RevenueListingProfile,
    private readonly chains: ChainViewResolver,
    limits: Partial<RevenueListingLineageLimits> = {}
  ) {
    this.limits = lineageLimits(limits)
    this.lineage = new RevenueListingProfileLineageVerifier(family, chains, this.limits)
    this.lock = family.lock
    this.decode = family.decode
    this.resolve = chains.resolve
  }
  async verify(
    purchaseInput: unknown,
    original: {
      request: OutputPurchasePrepare
      terms: OutputSignedPurchaseTerms
      /** Independently selected/authenticated seller, never inferred from terms. */
      seller: string
    },
    contextInput: VerificationContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RevenueListingProfilePurchaseResult> {
    if (signal.aborted) return { status: 'cancelled', dependencies: [] }
    try {
      this.current()
      const context = parseVerificationContext(contextInput),
        request = parseOutputPurchasePrepare(original.request),
        terms = verifyOutputPurchaseTerms(original.terms, request, original.seller),
        purchase = parseOutputEvidence(purchaseInput),
        limits = {
          ...this.limits,
          bytes: Math.min(this.limits.bytes, context.limits.bytes),
          transactions: Math.min(this.limits.transactions, context.limits.transactions),
          inputs: Math.min(this.limits.inputs, context.limits.dependencies)
        },
        bytes = Uint8Array.from(decodeOutputBytes(terms.body.domainEvidence.bytes, limits.bytes)),
        prepared = parseRevenueListingProfileLineagePackage(bytes, limits)
      requireLineage(
        terms.body.domainProfile === REVENUE_LISTING_PURCHASE_PROFILE &&
          terms.body.domainEvidence.schema === REVENUE_LISTING_LINEAGE_SCHEMA,
        'Prepared purchase domain differs'
      )
      requireLineage(
        Utils.toHex(bytes) === Utils.toHex(new TextEncoder().encode(canonicalOutputJSON(prepared))),
        'Prepared lineage must use exact JCS bytes'
      )
      this.bindPrepared(prepared, terms, context)
      requireLineage(purchase.outputIndex === 0, 'Purchase evidence must select successor zero')
      const combined = this.extend(prepared, purchase, terms, limits),
        verified = await this.lineage.verify(combined.package, context, signal)
      this.current()
      if (verified.status !== 'verified') return verified
      return {
        status: 'verified',
        request,
        terms,
        purchase,
        preparedLineage: prepared,
        lineage: verified,
        predecessor: { ...terms.body.listing, chain: { ...terms.body.listing.chain } },
        successor: { ...verified.target, chain: { ...verified.target.chain } },
        previousSatoshis: combined.previousSatoshis,
        increment: prepared.descriptor.purchasePrice,
        purchaseCommitment: combined.purchaseCommitment
      }
    } catch (error) {
      return purchaseFailure(error)
    }
  }
  private current(): void {
    if (
      this.family.lock !== this.lock ||
      this.family.decode !== this.decode ||
      this.chains.resolve !== this.resolve
    )
      throw new OutputProtocolError('context-changed', 'Installed listing family changed')
  }
  private bindPrepared(
    prepared: RevenueListingProfileLineagePackage,
    terms: OutputSignedPurchaseTerms,
    context: VerificationContext
  ): void {
    const descriptor = prepared.descriptor,
      body = terms.body
    requireLineage(
      canonicalOutputJSON(prepared.target) === canonicalOutputJSON(body.listing) &&
        canonicalOutputJSON(descriptor.chain) === canonicalOutputJSON(context.view.chain) &&
        descriptor.seller === body.seller &&
        descriptor.assetId === body.assetId &&
        descriptor.termsDigest === body.termsDigest,
      'Prepared listing, chain, seller, asset or terms differ'
    )
  }
  private extend(
    prepared: RevenueListingProfileLineagePackage,
    purchase: OutputEvidence,
    terms: OutputSignedPurchaseTerms,
    limits: Readonly<RevenueListingLineageLimits>
  ): {
    package: RevenueListingProfileLineagePackage
    previousSatoshis: string
    purchaseCommitment: string
  } {
    const next = this.extendHistory(prepared, purchase, limits),
      bound = this.bindTransaction(prepared, purchase, terms, next, limits)
    return { package: next, ...bound }
  }
  /** Preserve original evidence association before assembling the successor. */
  private extendHistory(
    prepared: RevenueListingProfileLineagePackage,
    purchase: OutputEvidence,
    limits: Readonly<RevenueListingLineageLimits>
  ): RevenueListingProfileLineagePackage {
    const part = Beef.fromBinaryStrict(decodeOutputBytes(purchase.beef, limits.bytes))
    requireLineage(
      (part.atomicTxid === undefined || part.atomicTxid === purchase.txid) &&
        part.findTxid(purchase.txid)?.tx !== undefined,
      'Purchase BEEF target differs'
    )
    requireLineage(
      !prepared.transactions.some(entry => entry.txid === purchase.txid),
      'Purchase already appears in predecessor history'
    )
    return parseRevenueListingProfileLineagePackage(
      {
        ...prepared,
        target: { ...prepared.target, txid: purchase.txid, outputIndex: 0 },
        transactions: [...prepared.transactions, { txid: purchase.txid, beef: purchase.beef }].sort(
          (left, right) => Number(left.txid > right.txid) - Number(left.txid < right.txid)
        )
      },
      limits
    )
  }
  private commitment(
    transaction: import('@bsv/sdk').Transaction,
    previous: import('@bsv/sdk').Transaction,
    packet: RevenueListingProfileLineagePackage,
    combined: RevenueListingProfileLineagePackage,
    action: import('@bsv/sdk/script/templates/RevenueListingProfilePlan').RevenueListingProfileAction
  ): string {
    const assembly = assembleLineage(combined, this.limits)
    transaction.inputs.forEach(input => {
      const source = assembly.transactions.get(input.sourceTXID!)
      requireLineage(source !== undefined, 'Complete purchase funding source required')
      input.sourceTransaction = source
    })
    const commitment = new RevenueListingProfileSpend(
      this.family,
      packet.descriptor,
      [{ rawTransaction: previous.toHex(), outputIndex: packet.target.outputIndex }],
      action
    ).prepare(transaction).purchaseCommitment
    requireLineage(commitment !== undefined, 'Purchase commitment unavailable')
    return commitment
  }
  /** Check the exact purchase layout and mandatory outputs before full Script/history verification. */
  private bindTransaction(
    prepared: RevenueListingProfileLineagePackage,
    purchase: OutputEvidence,
    terms: OutputSignedPurchaseTerms,
    next: RevenueListingProfileLineagePackage,
    limits: Readonly<RevenueListingLineageLimits>
  ): { previousSatoshis: string; purchaseCommitment: string } {
    const assembly = assembleLineage(next, limits),
      tx = assembly.beef.findTransactionForSigning(purchase.txid),
      previous = assembly.transactions.get(prepared.target.txid)
    requireLineage(tx && previous, 'Purchase/predecessor raw evidence is unavailable')
    const action = {
      operation: 'purchase' as const,
      acquisitionId: terms.body.acquisitionId,
      requestDigest: terms.body.requestDigest,
      recipient: terms.body.recipient
    }
    const plan = planRevenueListingProfileSpend(
      this.family,
      prepared.descriptor,
      [{ rawTransaction: previous.toHex(), outputIndex: prepared.target.outputIndex }],
      action
    )
    requireLineage(
      tx.inputs[0].sourceTXID === prepared.target.txid &&
        tx.inputs[0].sourceOutputIndex === prepared.target.outputIndex,
      'Purchase consumed another prepared listing'
    )
    plan.outputs.forEach((mandatory, index) =>
      requireLineage(
        tx.outputs[index]?.satoshis?.toString() === mandatory.satoshis &&
          tx.outputs[index].lockingScript.toHex() === mandatory.lockingScript,
        'Purchase successor increment/state or recipient-bound receipt differs'
      )
    )
    // Full lineage verification executes the actual covenant even for a mined
    // purchase and independently verifies funding/ancestor Bitcoin evidence.
    return {
      previousSatoshis: plan.input.satoshis,
      purchaseCommitment: this.commitment(tx, previous, prepared, next, action)
    }
  }
}
function purchaseFailure(
  error: unknown
): Exclude<RevenueListingProfilePurchaseResult, { status: 'verified' }> {
  if (error instanceof OutputProtocolError) {
    const reason = error.message.slice(0, 512)
    if (error.code === 'context-changed' || error.code === 'cancelled' || error.code === 'limited')
      return { status: error.code, dependencies: [], reason }
    return { status: 'invalid', dependencies: [], reason }
  }
  return { status: 'invalid', dependencies: [], reason: 'Purchase representation is invalid' }
}
