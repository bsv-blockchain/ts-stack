import {
  outputPacketDigest,
  type OutputPurchaseEnvelope,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import {
  parseRevenueListingProfileDescriptor,
  type RevenueListingProfileDescriptor
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import type { UnverifiedLCHOverlayContext } from './overlayAcquisitionCodec.js'
import {
  validateLCHOverlayCovenantProfilePromise,
  type LCHOverlayCovenantProfileTerms
} from './overlayAcquisitionCovenantProfileTerms.js'
import {
  bindLCHCovenantSettlementCore,
  decodeLCHCovenantPurchaseEvidenceCore,
  type LCHCovenantLineage,
  type LCHCovenantPurchaseEvidence,
  type LCHBoundCovenantSettlement,
  type LCHCovenantSettlementProfile
} from './overlayAcquisitionCovenantSettlementCore.js'

export interface LCHOverlayCovenantProfileLineage extends LCHCovenantLineage<RevenueListingProfileDescriptor> {}
export interface LCHOverlayCovenantProfilePurchaseEvidence extends LCHCovenantPurchaseEvidence<RevenueListingProfileDescriptor> {}
export interface LCHOverlayBoundCovenantProfileSettlement extends LCHBoundCovenantSettlement<RevenueListingProfileDescriptor> {}
const current: LCHCovenantSettlementProfile<RevenueListingProfileDescriptor> = {
  parseDescriptor: parseRevenueListingProfileDescriptor,
  listingId: descriptor =>
    outputPacketDigest('sale-listing', parseRevenueListingProfileDescriptor(descriptor)),
  promise: validateLCHOverlayCovenantProfilePromise
}
/** Authenticate the current closed transport representation and seller genesis
 * authorization. Complete reserve-stage/activation history, actual input Scripts,
 * installed chain currentness and release-policy proof remain independent checks.
 */
export function decodeLCHOverlayCovenantProfilePurchaseEvidence(
  bytes: Uint8Array
): LCHOverlayCovenantProfilePurchaseEvidence {
  return decodeLCHCovenantPurchaseEvidenceCore(bytes, current)
}
/** Bind exact current consent, original lineage, signed settlement, POTATOES and
 * historical release. A verified representation supplies no Bitcoin, role,
 * unspentness, License or decryption verdict. Alias evidence remains separate.
 */
export function bindLCHOverlayCovenantProfileSettlement(
  context: UnverifiedLCHOverlayContext,
  terms: LCHOverlayCovenantProfileTerms,
  preparedInput: OutputSignedPurchaseTerms,
  deliveredInput: OutputPurchaseEnvelope,
  expectedTxid: string
): LCHOverlayBoundCovenantProfileSettlement {
  return bindLCHCovenantSettlementCore(
    context,
    terms,
    preparedInput,
    deliveredInput,
    expectedTxid,
    current
  )
}
