import { snapshotLCHRecord, snapshotSignedObject, snapshotBytes } from './boundary.js'
import { encodeDeterministicCbor } from './cbor.js'
import { LCH_MECHANISMS } from './constants.js'
import { lchAssert } from './errors.js'
import { toHex } from './hash.js'
import { validatePolicyReference, type PolicyReference } from './policy.js'
import type { LCHValue, SignedObject } from './types.js'

/** Shared accepted-policy checks after the mode adapter has authenticated the
 * Offer/Request and their IDs. This supplies neither payment nor role authority.
 */
export async function validateLCHOverlayAcceptedPolicy(
  suppliedOffer: SignedObject,
  suppliedRequest: SignedObject,
  suppliedBytes: Uint8Array
): Promise<PolicyReference> {
  const offer = snapshotSignedObject(suppliedOffer, 'Accepted Offer'),
    request = snapshotSignedObject(suppliedRequest, 'Accepted Request'),
    requestBytes = snapshotBytes(suppliedBytes, 'Accepted Request bytes'),
    reference = await validatePolicyReference(offer.body.policy)
  lchAssert(
    request.body.acceptedPolicyDigest instanceof Uint8Array &&
      toHex(request.body.acceptedPolicyDigest) === toHex(reference.digest),
    'ERR_LCH_LICENSE',
    'Accepted Policy differs'
  )
  const human = Array.isArray(offer.body.humanTerms) ? offer.body.humanTerms : [],
    accepted = request.body.acceptedHumanTermDigests ?? []
  lchAssert(
    Array.isArray(accepted) && accepted.length === human.length,
    'ERR_LCH_TERMS',
    'Human terms consent differs'
  )
  await Array.from(human).reduce(
    (sequence, term) =>
      sequence.then(async () => {
        const ref = await validatePolicyReference(term, { mediaType: undefined })
        lchAssert(
          accepted.some(value => value instanceof Uint8Array && toHex(value) === toHex(ref.digest)),
          'ERR_LCH_TERMS',
          'A human term was not accepted'
        )
      }),
    Promise.resolve()
  )
  const selected = snapshotLCHRecord(request.body.selection, 'Request Selection')
  lchAssert(
    Object.keys(selected).length === 1 && selected.type === 'all',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'This fixed-render adapter requires whole-Asset Selection'
  )
  if (request.body.mechanismChoices !== undefined) {
    const choices = snapshotLCHRecord(request.body.mechanismChoices, 'Request mechanisms'),
      payment = snapshotLCHRecord(offer.body.payment, 'Offer payment'),
      keyDelivery = snapshotLCHRecord(offer.body.keyDelivery, 'Offer key delivery'),
      enforcement = snapshotLCHRecord(offer.body.enforcement, 'Offer enforcement'),
      expected = {
        usageProfile: offer.body.usageProfile,
        payment: payment.protocol,
        keyDelivery: keyDelivery.mechanism,
        encryption: LCH_MECHANISMS.encryption,
        enforcement: enforcement.class
      }
    lchAssert(
      Object.entries(choices).every(
        ([name, value]) =>
          Object.hasOwn(expected, name) && expected[name as keyof typeof expected] === value
      ),
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Request mechanism choices differ from Offer'
    )
  }
  lchAssert(
    toHex(encodeDeterministicCbor(request as unknown as LCHValue)) === toHex(requestBytes),
    'ERR_LCH_CBOR',
    'License Request is not byte-stable deterministic CBOR'
  )
  return reference
}
