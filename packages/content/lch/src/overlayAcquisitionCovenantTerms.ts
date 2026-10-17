import {
  canonicalOutputJSON,
  type OutputSignedPurchaseTerms,
  type OutputCapabilitySelection,
  type OutputPurchasePrepare,
  type OutputReleasePolicy
} from '@bsv/sdk'
import {
  parseRevenueListingDescriptor,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'
import { type LCHReader, type InspectedLCH } from './core.js'
import { decodeLCHCollectorRevenue, type LCHOverlayBinding } from './overlayAcquisitionCodec.js'
import { type LCHOverlayFixedRenderPolicy } from './overlayAcquisitionPolicy.js'
import {
  type LCHSignatureVerifier,
  type SegmentedEncryptionDescriptor,
  type SignedObject
} from './types.js'
import {
  validateLCHCovenantTermsCore,
  validateLCHCovenantPromiseCore,
  validateLCHCovenantWindowCore
} from './overlayAcquisitionCovenantTermsCore.js'
export { LCH_OVERLAY_COVENANT_MECHANISMS } from './overlayAcquisitionCovenantTermsCore.js'

export interface LCHOverlayCovenantTermsInput {
  reader: LCHReader
  header: Uint8Array
  offer: SignedObject
  request: Uint8Array
  prepare: OutputPurchasePrepare
  /** Representation/binding only here. Both sides must separately verify the
   * complete authorized genesis and every actual Script transition.
   */
  descriptor: RevenueListingDescriptor
  selection: OutputCapabilitySelection
  installedMechanisms: ReadonlySet<string>
  verifier?: LCHSignatureVerifier
  maximumCiphertextBytes?: number
}
export interface LCHOverlayCovenantTerms {
  prepare: OutputPurchasePrepare
  descriptor: RevenueListingDescriptor
  selected: { seller: string; rulesDigest: string }
  inspected: InspectedLCH
  offer: SignedObject
  request: SignedObject
  requestBytes: Uint8Array
  binding: LCHOverlayBinding
  releasePolicy: OutputReleasePolicy
  encryption: SegmentedEncryptionDescriptor
  policy: LCHOverlayFixedRenderPolicy
  recoverySeconds: bigint
  advertisedRecoverySeconds: string
  notBefore: bigint
  notAfter?: bigint
}

/** Historical collector interface retained for compatibility. Current C callers
 * explicitly select validateLCHOverlayCovenantProfileTerms instead. */
export async function validateLCHOverlayCovenantTerms(
  input: LCHOverlayCovenantTermsInput
): Promise<LCHOverlayCovenantTerms> {
  return await validateLCHCovenantTermsCore(input, {
    parseDescriptor: parseRevenueListingDescriptor,
    collector: decodeLCHCollectorRevenue,
    matches: (descriptor, collector) =>
      descriptor.administration === 'seller-v1' &&
      canonicalOutputJSON(descriptor.initialRevenue) === canonicalOutputJSON(collector)
  })
}
export function validateLCHOverlayCovenantPromise(
  terms: LCHOverlayCovenantTerms,
  input: OutputSignedPurchaseTerms
): OutputSignedPurchaseTerms {
  return validateLCHCovenantPromiseCore(terms, input)
}
export function validateLCHOverlayCovenantWindow(
  terms: LCHOverlayCovenantTerms,
  packet: OutputSignedPurchaseTerms | null,
  now: string
): void {
  validateLCHCovenantWindowCore(terms, packet, now)
}
