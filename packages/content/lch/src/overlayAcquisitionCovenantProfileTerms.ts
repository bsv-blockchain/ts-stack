import { canonicalOutputJSON, type OutputSignedPurchaseTerms } from '@bsv/sdk'
import {
  parseRevenueListingProfileDescriptor,
  type RevenueListingProfileDescriptor
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import { decodeLCHCollectorRevenueProfile } from './overlayAcquisitionCollectorProfile.js'
import type {
  LCHOverlayCovenantTermsInput,
  LCHOverlayCovenantTerms
} from './overlayAcquisitionCovenantTerms.js'
import {
  validateLCHCovenantTermsCore,
  validateLCHCovenantPromiseCore,
  validateLCHCovenantWindowCore
} from './overlayAcquisitionCovenantTermsCore.js'

export interface LCHOverlayCovenantProfileTermsInput extends Omit<
  LCHOverlayCovenantTermsInput,
  'descriptor'
> {
  descriptor: RevenueListingProfileDescriptor
}
export interface LCHOverlayCovenantProfileTerms extends Omit<
  LCHOverlayCovenantTerms,
  'descriptor'
> {
  descriptor: RevenueListingProfileDescriptor
}
/** Authenticate the exact current immutable collector, standing Offer, signed
 * individual consent, capability and content commitments. Independent authorized
 * lineage/Script/currentness and rights checks remain mandatory on both sides.
 * Height expiry is a new-preparation check, never a historical delivery check. */
export function validateLCHOverlayCovenantProfileTerms(
  input: LCHOverlayCovenantProfileTermsInput
): Promise<LCHOverlayCovenantProfileTerms> {
  return validateLCHCovenantTermsCore(input, {
    parseDescriptor: parseRevenueListingProfileDescriptor,
    collector: decodeLCHCollectorRevenueProfile,
    matches: (descriptor, collector) =>
      collector.family === descriptor.scriptFamily &&
      collector.expiryHeight === descriptor.expiryHeight &&
      canonicalOutputJSON(collector.initialRevenue) ===
        canonicalOutputJSON(descriptor.initialRevenue)
  })
}
export function validateLCHOverlayCovenantProfilePromise(
  terms: LCHOverlayCovenantProfileTerms,
  input: OutputSignedPurchaseTerms
): OutputSignedPurchaseTerms {
  return validateLCHCovenantPromiseCore(terms, input)
}
export function validateLCHOverlayCovenantProfileWindow(
  terms: LCHOverlayCovenantProfileTerms,
  packet: OutputSignedPurchaseTerms | null,
  now: string
): void {
  validateLCHCovenantWindowCore(terms, packet, now)
}
