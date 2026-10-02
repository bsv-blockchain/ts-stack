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
import { RevenueListing } from '@bsv/sdk/script/templates/RevenueListing'
import { planRevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingPlan'
import type { ChainViewResolver } from '../SDKEvidenceVerifier.js'
import { parseVerificationContext } from '../validation.js'
import type { VerificationContext } from '../ports.js'
import { layout, operation } from './LineageLayout.js'
import {
  assembleLineage,
  lineageLimits,
  parseRevenueListingLineagePackage,
  requireLineage,
  type RevenueListingLineageLimits,
  type RevenueListingLineagePackage
} from './LineagePackage.js'
import {
  RevenueListingLineageVerifier,
  type RevenueListingLineageResult
} from './RevenueListingLineageVerifier.js'

export const REVENUE_LISTING_PURCHASE_PROFILE =
  'https://bsv.brc.dev/tokens/0197#listing-purchase-v1'
export const REVENUE_LISTING_LINEAGE_SCHEMA = 'https://bsv.brc.dev/tokens/0197#lineage-package-v1'
type VerifiedLineage = Extract<RevenueListingLineageResult, { status: 'verified' }>
export type RevenueListingPurchaseResult =
  | {
      status: 'verified'
      request: OutputPurchasePrepare
      terms: OutputSignedPurchaseTerms
      purchase: OutputEvidence
      preparedLineage: RevenueListingLineagePackage
      /** Full independently checked history through the purchased successor. */
      lineage: VerifiedLineage
      predecessor: OutputPurchasePrepare['listing']
      successor: OutputPurchasePrepare['listing']
      previousSatoshis: string
      increment: string
    }
  | Exclude<RevenueListingLineageResult, { status: 'verified' }>

/** Verify the exact prepared BRC-196 purchase, not a seller's claimed increment.
 * This validates Bitcoin/family/history/request association. It does not establish
 * asset authority, unspentness, winning a conflict, admission, release or usability.
 */
export class RevenueListingPurchaseVerifier {
  private readonly limits: Readonly<RevenueListingLineageLimits>
  private readonly lineage: RevenueListingLineageVerifier
  private readonly lock: RevenueListing['lock']
  private readonly decode: RevenueListing['decode']
  private readonly resolve: ChainViewResolver['resolve']
  constructor(
    private readonly family: RevenueListing,
    private readonly chains: ChainViewResolver,
    limits: Partial<RevenueListingLineageLimits> = {}
  ) {
    this.limits = lineageLimits(limits)
    this.lineage = new RevenueListingLineageVerifier(family, chains, this.limits)
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
  ): Promise<RevenueListingPurchaseResult> {
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
        prepared = parseRevenueListingLineagePackage(bytes, limits)
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
        increment: prepared.descriptor.purchasePrice
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
    prepared: RevenueListingLineagePackage,
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
    prepared: RevenueListingLineagePackage,
    purchase: OutputEvidence,
    terms: OutputSignedPurchaseTerms,
    limits: Readonly<RevenueListingLineageLimits>
  ): { package: RevenueListingLineagePackage; previousSatoshis: string } {
    const part = Beef.fromBinaryStrict(decodeOutputBytes(purchase.beef, limits.bytes))
    requireLineage(
      (part.atomicTxid ?? part.txs.at(-1)?.txid) === purchase.txid &&
        part.findTxid(purchase.txid)?.tx !== undefined,
      'Purchase BEEF target differs'
    )
    requireLineage(
      !prepared.transactions.some(entry => entry.txid === purchase.txid),
      'Purchase already appears in predecessor history'
    )
    const next = parseRevenueListingLineagePackage(
      {
        ...prepared,
        target: { ...prepared.target, txid: purchase.txid, outputIndex: 0 },
        transactions: [...prepared.transactions, { txid: purchase.txid, beef: purchase.beef }].sort(
          (left, right) => Number(left.txid > right.txid) - Number(left.txid < right.txid)
        )
      },
      limits
    )
    const assembly = assembleLineage(next, limits),
      tx = assembly.beef.findTransactionForSigning(purchase.txid),
      previous = assembly.transactions.get(prepared.target.txid)
    requireLineage(tx && previous, 'Purchase/predecessor raw evidence is unavailable')
    layout(tx, false)
    requireLineage(operation(tx, 0) === 1, 'Administrative transition is not a purchase')
    const plan = planRevenueListingSpend(
      this.family,
      prepared.descriptor,
      [{ rawTransaction: previous.toHex(), outputIndex: prepared.target.outputIndex }],
      {
        operation: 'purchase',
        acquisitionId: terms.body.acquisitionId,
        requestDigest: terms.body.requestDigest,
        recipient: terms.body.recipient
      }
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
    return { package: next, previousSatoshis: plan.inputs[0].satoshis }
  }
}
function purchaseFailure(
  error: unknown
): Exclude<RevenueListingPurchaseResult, { status: 'verified' }> {
  if (error instanceof OutputProtocolError) {
    if (error.code === 'context-changed' || error.code === 'cancelled' || error.code === 'limited')
      return { status: error.code, dependencies: [] }
  }
  return { status: 'invalid', dependencies: [] }
}
