import { outputPacketDigest } from '@bsv/sdk'
import { PrivatePurchaseAccess } from '../src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseDisclosure } from '../src/private/PrivatePurchaseDisclosure.js'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'
import type { PrivatePurchaseCandidateProfile } from '../src/private/PrivatePurchaseProgress.js'

/** Native private access/disclosure; lifecycle bytes are not chain proof. */
export function purchaseDisclosureFixture(candidateProfile?: PrivatePurchaseCandidateProfile) {
  const f = purchaseStoreFixture({}, undefined, candidateProfile)
  let permitted = true,
    authenticated = true,
    control = true
  const decisions: Array<{ mode: string; request: unknown }> = []
  const access = new PrivatePurchaseAccess(
    f.owner.domain,
    f.f.original.request.topic,
    (request, _buyer, mode) => {
      decisions.push({ mode, request })
      return permitted
    },
    candidateProfile
  )
  const caller = {
    buyer: f.buyer,
    capability: outputPacketDigest('capabilities', f.f.f.body),
    profile: f.f.f.body.services[0].profiles[0].id,
    current: () => authenticated
  }
  const disclosure = new PrivatePurchaseDisclosure(
    f.owner.domain,
    f.owner.store,
    f.f.f.contracts,
    access,
    f.clock,
    () => control
  )
  return {
    f,
    access,
    caller,
    disclosure,
    decisions,
    setPermitted: (value: boolean) => {
      permitted = value
    },
    setAuthenticated: (value: boolean) => {
      authenticated = value
    },
    setControl: (value: boolean) => {
      control = value
    }
  }
}
