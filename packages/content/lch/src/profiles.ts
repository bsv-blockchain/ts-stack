import { LCH_MECHANISMS, LCH_PROFILES } from './constants.js'
import { lchAssert } from './errors.js'

export interface LCHCapabilitySet {
  usageProfiles: ReadonlySet<string>
  paymentMechanisms: ReadonlySet<string>
  keyDeliveryMechanisms: ReadonlySet<string>
  encryptionMechanisms: ReadonlySet<string>
  enforcementClasses: ReadonlySet<string>
  compositionMappings: ReadonlySet<string>
}

export const CORE_CAPABILITIES: LCHCapabilitySet = {
  usageProfiles: new Set(Object.values(LCH_PROFILES)),
  paymentMechanisms: new Set([
    LCH_MECHANISMS.brc105Single,
    LCH_MECHANISMS.brc105Multipay,
    LCH_MECHANISMS.brc121Single
  ]),
  keyDeliveryMechanisms: new Set([LCH_MECHANISMS.brc78Key, LCH_MECHANISMS.rawKey]),
  encryptionMechanisms: new Set([LCH_MECHANISMS.encryption]),
  enforcementClasses: new Set([
    'https://bsv.brc.dev/apps/0170#advisory',
    'https://bsv.brc.dev/apps/0170#conformingApplication',
    'https://bsv.brc.dev/apps/0170#protectedModule'
  ]),
  compositionMappings: new Set([LCH_MECHANISMS.wholePlacement])
}

export interface OfferedMechanisms {
  usageProfile: string
  payment: string
  keyDelivery: string
  encryption: string
  enforcement: string
  critical?: readonly string[]
}

export function supportsProfile(
  offer: OfferedMechanisms,
  capabilities = CORE_CAPABILITIES
): boolean {
  return (
    capabilities.usageProfiles.has(offer.usageProfile) &&
    capabilities.paymentMechanisms.has(offer.payment) &&
    capabilities.keyDeliveryMechanisms.has(offer.keyDelivery) &&
    capabilities.encryptionMechanisms.has(offer.encryption) &&
    capabilities.enforcementClasses.has(offer.enforcement) &&
    (offer.critical ?? []).every(identifier =>
      [
        ...capabilities.usageProfiles,
        ...capabilities.paymentMechanisms,
        ...capabilities.keyDeliveryMechanisms,
        ...capabilities.encryptionMechanisms,
        ...capabilities.enforcementClasses,
        ...capabilities.compositionMappings
      ].includes(identifier)
    )
  )
}

export function requireProfile(offer: OfferedMechanisms, capabilities = CORE_CAPABILITIES): void {
  lchAssert(
    supportsProfile(offer, capabilities),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'No fully supported LCH acquisition profile'
  )
}
