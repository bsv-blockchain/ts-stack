import { outputPacketDigest, outputU64 } from '@bsv/sdk'
import type { RevenueListingProfileDescriptor } from '@bsv/sdk/script/templates/RevenueListingProfile'
import { lchAssert } from './errors.js'
import { validateLCHCollectorPreparation } from './overlayAcquisitionCollectorProfile.js'
import type { LCHOverlayCovenantProfilePreparation } from './overlayAcquisitionCovenantProfile.js'
import {
  LCHCovenantSellerCore,
  type LCHCovenantSellerListing,
  type LCHCovenantSellerOptions,
  type LCHCovenantSellerVerification,
  type LCHCovenantSellerProfile
} from './overlayAcquisitionCovenantSellerCore.js'
import {
  validateLCHOverlayCovenantProfileTerms,
  validateLCHOverlayCovenantProfilePromise,
  validateLCHOverlayCovenantProfileWindow
} from './overlayAcquisitionCovenantProfileTerms.js'
export type {
  LCHOverlayCovenantSellerCustody as LCHOverlayCovenantProfileSellerCustody,
  LCHOverlayCovenantSellerProgress as LCHOverlayCovenantProfileSellerProgress
} from './overlayAcquisitionCovenantSeller.js'

export interface LCHOverlayCovenantProfileSellerListing extends LCHCovenantSellerListing<RevenueListingProfileDescriptor> {}
export interface LCHOverlayCovenantProfileSellerVerification extends LCHCovenantSellerVerification<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation
> {}
export interface LCHOverlayCovenantProfileSellerOptions extends LCHCovenantSellerOptions<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation
> {}

const current: LCHCovenantSellerProfile<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation
> = {
  adapter: 'immutable-standing-collector/1',
  terms: validateLCHOverlayCovenantProfileTerms,
  promise: validateLCHOverlayCovenantProfilePromise,
  window: validateLCHOverlayCovenantProfileWindow,
  listingId: descriptor => outputPacketDigest('sale-listing', descriptor),
  preparation: (terms, assessment, clock, purchaseUntil) => {
    const stage = Object.getOwnPropertyDescriptor(assessment, 'stage')?.value as unknown,
      height = Object.getOwnPropertyDescriptor(assessment, 'currentHeight')?.value as unknown
    lchAssert(
      (stage === 'activation' || stage === 'active') && typeof height === 'string',
      'ERR_LCH_LICENSE',
      'Current seller preparation requires owned stage and installed chain height'
    )
    return () => {
      lchAssert(
        Object.getOwnPropertyDescriptor(assessment, 'stage')?.value === stage &&
          Object.getOwnPropertyDescriptor(assessment, 'currentHeight')?.value === height,
        'ERR_LCH_LICENSE',
        'Current seller preparation assessment changed'
      )
      validateLCHCollectorPreparation(terms.descriptor, stage, height)
      const now = clock()
      validateLCHOverlayCovenantProfileWindow(terms, null, now)
      lchAssert(
        outputU64(now) < outputU64(purchaseUntil),
        'ERR_LCH_QUOTE',
        'Current seller preparation window elapsed'
      )
    }
  }
}
/** Explicit immutable C seller. Current preparation proves complete authorized
 * reserve/activation ancestry and returns a retained stage/height/time fence.
 * The coordinator rechecks it before promising private material. Retained
 * issuance verifies the original actual admitted subject, full commitment,
 * release, roles, CEKs and License without treating recovery as new funding.
 * This distinct installation never reinterprets historical protected material.
 */
export class LCHOverlayCovenantProfileSeller extends LCHCovenantSellerCore<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation
> {
  constructor(options: LCHOverlayCovenantProfileSellerOptions) {
    super(options, current)
  }
}
