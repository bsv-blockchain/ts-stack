import { LCH_IRI } from './constants.js'
import { validateAuthorityChain, type AuthorityBody } from './authority.js'
import { snapshotLCHRecord, snapshotSignedObject } from './boundary.js'
import { lchAssert } from './errors.js'
import { toHex, objectId } from './hash.js'
import { isCompressedPublicKey } from './signatures.js'
import type {
  LCHSignatureVerifier,
  RevocationObservation,
  RevocationSource,
  SignedObject
} from './types.js'
import type { LCHOverlayPaidTerms } from './overlayAcquisitionTerms.js'

/** Explicit finite chain selection. No network search, guessed signer role or
 * automatically widened interest is hidden in an acquisition adapter.
 */
export interface LCHOverlayAuthorityPath {
  controller: Uint8Array
  actor: Uint8Array
  interest: string
  capability: string
  chain: readonly SignedObject[]
}
export interface LCHOverlayAuthorityAssessment {
  now: bigint
  network: RevocationObservation['network']
  verifier: LCHSignatureVerifier
  revocationSource?: RevocationSource
}

/** Validate the complete finite selection before funding, including referenced
 * Offer authorities. No unused malformed path is silently treated as evidence.
 */
export async function validateLCHOverlayAuthoritySelection(
  terms: LCHOverlayPaidTerms,
  paths: readonly LCHOverlayAuthorityPath[],
  now: bigint,
  network: RevocationObservation['network'],
  verifier: LCHSignatureVerifier,
  revocationSource?: RevocationSource
): Promise<void> {
  lchAssert(paths.length <= 128, 'ERR_LCH_AUTHORITY', 'Too many selected authority paths')
  const ids = new Set<string>(),
    roles = new Set(
      ['issueOffer', 'receivePayment', 'issueLicense', 'releaseKey'].map(
        role => LCH_IRI + '#' + role
      )
    ),
    rights = terms.inspected.asset.rights,
    interests = terms.offer.body.requiredInterests
  lchAssert(
    Array.isArray(rights) && Array.isArray(interests),
    'ERR_LCH_AUTHORITY',
    'Asset interests are absent'
  )
  for await (const path of paths) {
    lchAssert(
      path.actor instanceof Uint8Array &&
        isCompressedPublicKey(path.actor) &&
        path.controller instanceof Uint8Array &&
        isCompressedPublicKey(path.controller) &&
        toHex(path.controller) !== toHex(path.actor) &&
        Array.isArray(path.chain) &&
        path.chain.length > 0 &&
        path.chain.length <= 16 &&
        roles.has(path.capability) &&
        interests.includes(path.interest) &&
        rights.some(value => {
          const right = snapshotLCHRecord(value, 'Rights interest')
          return (
            right.interest === path.interest &&
            right.controller instanceof Uint8Array &&
            toHex(right.controller) === toHex(path.controller)
          )
        }),
      'ERR_LCH_AUTHORITY',
      'Selected authority path is outside the required Asset roles'
    )
    await validateLCHOverlayAuthority(terms, path.actor, path.capability, paths, {
      now,
      network,
      verifier,
      revocationSource
    })
    for await (const authority of path.chain)
      ids.add(toHex(await objectId('authority', authority.body)))
  }
  const referenced = terms.offer.body.authorityIds
  lchAssert(
    referenced === undefined ||
      (Array.isArray(referenced) &&
        referenced.every(id => id instanceof Uint8Array && ids.has(toHex(id)))),
    'ERR_LCH_AUTHORITY',
    'Referenced Offer Authority is not in the finite selection'
  )
}

/** Authenticate an actor for every independently controlled required interest.
 * Missing or ambiguous chain selection remains unresolved. Revocation sources
 * must retain their authenticated assessment for historical issuance; a fresh
 * current observation is not rewritten as a historical observation.
 */
export async function validateLCHOverlayAuthority(
  terms: LCHOverlayPaidTerms,
  actor: Uint8Array,
  capability: string,
  paths: readonly LCHOverlayAuthorityPath[],
  assessment: LCHOverlayAuthorityAssessment
): Promise<void> {
  const { now, network, verifier, revocationSource } = assessment
  actor = actor.slice()
  lchAssert(paths.length <= 128, 'ERR_LCH_AUTHORITY', 'Too many selected authority paths')
  const owned = paths.map(path => {
    const value = snapshotLCHRecord(path, 'Authority path')
    lchAssert(
      Object.keys(value)
        .sort((left, right) => Number(left > right) - Number(left < right))
        .join(',') === 'actor,capability,chain,controller,interest' &&
        value.actor instanceof Uint8Array &&
        value.controller instanceof Uint8Array &&
        typeof value.capability === 'string' &&
        typeof value.interest === 'string' &&
        Array.isArray(value.chain),
      'ERR_LCH_AUTHORITY',
      'Invalid selected authority path'
    )
    return {
      ...value,
      chain: value.chain.map(entry => snapshotSignedObject(entry))
    } as unknown as LCHOverlayAuthorityPath
  })
  const rights = terms.inspected.asset.rights,
    interests = terms.offer.body.requiredInterests
  lchAssert(
    Array.isArray(rights) && Array.isArray(interests),
    'ERR_LCH_AUTHORITY',
    'Asset interests are absent'
  )
  for await (const interest of interests) {
    lchAssert(typeof interest === 'string', 'ERR_LCH_AUTHORITY', 'Invalid required interest')
    const controllers = rights
      .map(value => snapshotLCHRecord(value, 'Rights interest'))
      .filter(value => value.interest === interest)
    lchAssert(
      controllers.length > 0,
      'ERR_LCH_AUTHORITY',
      'Required interest has no Asset controller'
    )
    for await (const right of controllers) {
      lchAssert(
        right.controller instanceof Uint8Array,
        'ERR_LCH_AUTHORITY',
        'Rights controller is invalid'
      )
      if (toHex(right.controller) === toHex(actor)) continue
      const selected = owned.filter(
        path =>
          path.interest === interest &&
          path.capability === capability &&
          toHex(path.actor) === toHex(actor) &&
          toHex(path.controller) === toHex(right.controller as Uint8Array)
      )
      lchAssert(
        selected.length === 1,
        'ERR_LCH_AUTHORITY',
        'Authority path is missing or ambiguous'
      )
      await validateAuthorityChain(
        selected[0].chain as unknown as ReadonlyArray<{
          body: AuthorityBody
          signatures: Uint8Array[]
        }>,
        {
          controller: right.controller,
          actor,
          assetId: terms.inspected.assetId,
          interest,
          capability,
          policyAction: terms.policy.action,
          usageProfile: terms.offer.body.usageProfile as string,
          now,
          network
        },
        verifier,
        revocationSource
      )
    }
  }
}

export async function validateLCHOverlayPaidRoles(
  terms: LCHOverlayPaidTerms,
  paths: readonly LCHOverlayAuthorityPath[],
  now: bigint,
  network: RevocationObservation['network'],
  verifier: LCHSignatureVerifier,
  revocationSource?: RevocationSource
): Promise<void> {
  // A payment proxy needs additional payee-to-collector authority. This concrete
  // adapter deliberately selects direct authorized seller collection instead.
  lchAssert(
    terms.policy.payee === toHex(terms.binding.seller),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'This adapter requires the seller to be the requirement payee'
  )
  const issuer = terms.offer.body.licenseIssuer
  lchAssert(issuer instanceof Uint8Array, 'ERR_LCH_AUTHORITY', 'License issuer is invalid')
  await validateLCHOverlayAuthoritySelection(terms, paths, now, network, verifier, revocationSource)
  for await (const role of [
    { actor: terms.binding.seller, capability: LCH_IRI + '#issueOffer' },
    { actor: terms.binding.seller, capability: LCH_IRI + '#receivePayment' },
    { actor: issuer, capability: LCH_IRI + '#issueLicense' }
  ])
    await validateLCHOverlayAuthority(terms, role.actor, role.capability, paths, {
      now,
      network,
      verifier,
      revocationSource
    })
}
