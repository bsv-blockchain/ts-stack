import type {
  OutputEvidence,
  OutputOutpoint,
  OutputPurchaseEnvelope,
  OutputReleaseEvidence,
  OutputReleasePolicy,
  OutputSignedPacket,
  OutputSignedPurchaseTerms
} from '@bsv/sdk'
import {
  parseRevenueListingDescriptor,
  revenueListingId,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'
import type { UnverifiedLCHOverlayContext } from './overlayAcquisitionCodec.js'
import {
  validateLCHOverlayCovenantPromise,
  type LCHOverlayCovenantTerms
} from './overlayAcquisitionCovenantTerms.js'
import {
  bindLCHCovenantSettlementCore,
  decodeLCHCovenantPurchaseEvidenceCore,
  type LCHCovenantSettlementProfile
} from './overlayAcquisitionCovenantSettlementCore.js'
export { decodeLCHCovenantSettlement } from './overlayAcquisitionCovenantSettlementCore.js'

export interface LCHCovenantSettlementBody {
  version: 1
  seller: string
  buyer: string
  requestId: string
  offerId: string
  assetId: string
  dutyUid: string
  acquisitionId: string
  listingId: string
  previous: OutputOutpoint
  successor: OutputOutpoint
  txid: string
  purchaseCommitment: string
  satoshis: string
  releasePolicy: OutputReleasePolicy
  releaseEvidenceDigest: string
  issuedAt: string
  recoveryUntil: string
}
/** Portable representation. A signed genesis does not establish Bitcoin
 * ancestry, actual Script execution, currentness or an eligible purchase.
 * Install the complete matching historical-family verifier separately on each side.
 * Current BRC-197 uses the separate LCHOverlayCovenantProfileLineage representation.
 */
export interface LCHOverlayCovenantLineage {
  version: 1
  descriptor: RevenueListingDescriptor
  genesis: OutputSignedPacket<{ version: 1; listingId: string; genesis: OutputOutpoint }>
  target: OutputOutpoint
  transactions: { txid: string; beef: string }[]
}
export interface LCHOverlayCovenantPurchaseEvidence {
  version: 1
  lineage: LCHOverlayCovenantLineage
  purchase: OutputEvidence
  terms: OutputSignedPurchaseTerms
  release: OutputReleaseEvidence
}
export interface LCHOverlayBoundCovenantSettlement {
  packet: OutputSignedPacket<LCHCovenantSettlementBody>
  id: string
  evidence: LCHOverlayCovenantPurchaseEvidence
  delivered: OutputPurchaseEnvelope
}

const historical: LCHCovenantSettlementProfile<RevenueListingDescriptor> = {
  parseDescriptor: parseRevenueListingDescriptor,
  listingId: revenueListingId,
  promise: validateLCHOverlayCovenantPromise
}
/** Historical representation and bindings retained for compatibility. */
export function decodeLCHOverlayCovenantPurchaseEvidence(
  bytes: Uint8Array
): LCHOverlayCovenantPurchaseEvidence {
  return decodeLCHCovenantPurchaseEvidenceCore(bytes, historical)
}
export function bindLCHOverlayCovenantSettlement(
  context: UnverifiedLCHOverlayContext,
  terms: LCHOverlayCovenantTerms,
  preparedInput: OutputSignedPurchaseTerms,
  deliveredInput: OutputPurchaseEnvelope,
  expectedTxid: string
): LCHOverlayBoundCovenantSettlement {
  return bindLCHCovenantSettlementCore(
    context,
    terms,
    preparedInput,
    deliveredInput,
    expectedTxid,
    historical
  )
}
