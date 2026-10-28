import {
  parseRevenueListingProfileDescriptor,
  type RevenueListingProfileDescriptor
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import {
  parseListingLineagePackage,
  type ListingLineagePackage,
  type RevenueListingLineageLimits
} from './LineagePackage.js'

/** The current immutable descriptor and reserve-stage signed genesis. */
export interface RevenueListingProfileLineagePackage extends ListingLineagePackage<RevenueListingProfileDescriptor> {}

/** Owned representation and genesis authorization, never a Bitcoin verdict. */
export function parseRevenueListingProfileLineagePackage(
  input: unknown,
  limits: Partial<RevenueListingLineageLimits> = {}
): RevenueListingProfileLineagePackage {
  return parseListingLineagePackage(input, parseRevenueListingProfileDescriptor, limits)
}
