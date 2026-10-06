import { canonicalOutputJSON, outputU64 } from '@bsv/sdk'
import { REVENUE_LISTING_FAMILY } from '@bsv/sdk/script/templates/RevenueListing'
import {
  parseRevenueListingProfileDescriptor,
  parseRevenueListingProfileSchedule,
  type RevenueListingProfileDescriptor,
  type RevenueListingProfileSchedule
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import { snapshotLCHRecord } from './boundary.js'
import { lchAssert } from './errors.js'
import { toHex } from './hash.js'
import type { LCHValue } from './types.js'

/** Owned decoded C terms. CBOR identities become exact lowercase public-key hex. */
export interface LCHCollectorRevenueProfile {
  version: 1
  family: typeof REVENUE_LISTING_FAMILY
  expiryHeight: number
  initialRevenue: RevenueListingProfileSchedule
  schedule: 'immutable'
  derivation: 'brc29-anyone-fixed'
  withdrawal: 'permissionless-quanta'
  remainders: 'retain-until-payout'
  retirement: 'seller-child-or-expiry-height-exact-top-up'
}
function closed(input: unknown, keys: readonly string[], name: string): Record<string, LCHValue> {
  const value = snapshotLCHRecord(input, name)
  lchAssert(
    keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key)),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    `${name} has missing or unknown fields`
  )
  return value
}
function integer(input: unknown, maximum: bigint, name: string): number {
  lchAssert(
    typeof input === 'bigint' || (typeof input === 'number' && Number.isSafeInteger(input)),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    `${name} must be an exact CBOR unsigned integer`
  )
  const value = BigInt(input)
  lchAssert(value > 0n && value <= maximum, 'ERR_LCH_PROFILE_UNSUPPORTED', `${name} exceeds bounds`)
  return Number(value)
}

/** Current immutable BRC-198 C representation only. The surrounding Offer,
 * authority, genesis/activation, Script and chain view require independent checks.
 */
export function decodeLCHCollectorRevenueProfile(input: unknown): LCHCollectorRevenueProfile {
  const value = closed(
    input,
    [
      'version',
      'family',
      'expiryHeight',
      'initialRevenue',
      'schedule',
      'derivation',
      'withdrawal',
      'remainders',
      'retirement'
    ],
    'Collector profile'
  )
  lchAssert(
    value.version === 1 &&
      value.family === REVENUE_LISTING_FAMILY &&
      value.schedule === 'immutable' &&
      value.derivation === 'brc29-anyone-fixed' &&
      value.withdrawal === 'permissionless-quanta' &&
      value.remainders === 'retain-until-payout' &&
      value.retirement === 'seller-child-or-expiry-height-exact-top-up',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unsupported immutable collector rules'
  )
  const expiryHeight = integer(value.expiryHeight, 499999999n, 'Expiry height'),
    revenue = closed(value.initialRevenue, ['recipients'], 'Immutable revenue')
  lchAssert(
    Array.isArray(revenue.recipients) &&
      revenue.recipients.length >= 1 &&
      revenue.recipients.length <= 8,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Collector requires one through eight recipients'
  )
  const initialRevenue = parseRevenueListingProfileSchedule({
    recipients: revenue.recipients.map(input => {
      const recipient = closed(input, ['identity', 'weight'], 'Collector recipient')
      lchAssert(
        recipient.identity instanceof Uint8Array && recipient.identity.length === 33,
        'ERR_LCH_PROFILE_UNSUPPORTED',
        'Collector identity must be a 33-byte CBOR byte string'
      )
      return {
        identity: toHex(recipient.identity),
        weight: integer(recipient.weight, 10000n, 'Recipient weight')
      }
    })
  })
  return {
    version: 1,
    family: REVENUE_LISTING_FAMILY,
    expiryHeight,
    initialRevenue,
    schedule: 'immutable',
    derivation: 'brc29-anyone-fixed',
    withdrawal: 'permissionless-quanta',
    remainders: 'retain-until-payout',
    retirement: 'seller-child-or-expiry-height-exact-top-up'
  }
}

/** Compare the entire current collector extension with the exact descriptor.
 * This binding neither authenticates an Offer nor establishes Bitcoin ancestry.
 */
export function bindLCHCollectorRevenueProfile(
  input: unknown,
  descriptorInput: unknown
): {
  collector: LCHCollectorRevenueProfile
  descriptor: RevenueListingProfileDescriptor
} {
  const collector = decodeLCHCollectorRevenueProfile(input),
    descriptor = parseRevenueListingProfileDescriptor(descriptorInput)
  lchAssert(
    collector.family === descriptor.scriptFamily &&
      collector.expiryHeight === descriptor.expiryHeight &&
      canonicalOutputJSON(collector.initialRevenue) ===
        canonicalOutputJSON(descriptor.initialRevenue),
    'ERR_LCH_LICENSE',
    'Collector family, expiry or complete schedule differs from descriptor'
  )
  return { collector, descriptor }
}

/** New preparations require an independently verified active stage and current
 * installed chain height. Caller-owned verification guards must still fence the
 * operation. This predicate is never applied retroactively to retained delivery.
 */
export function validateLCHCollectorPreparation(
  descriptorInput: unknown,
  stage: unknown,
  height: unknown
): void {
  const descriptor = parseRevenueListingProfileDescriptor(descriptorInput)
  lchAssert(
    stage === 'active' && outputU64(height) < BigInt(descriptor.expiryHeight),
    'ERR_LCH_QUOTE',
    'New preparation requires an active listing below expiry height'
  )
}
