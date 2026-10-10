import { outputU64, Utils } from '@bsv/sdk'
import { snapshotLCHRecord, snapshotSignedObject } from './boundary.js'
import { encodeDeterministicCbor } from './cbor.js'
import { LCH_IRI, LCH_MECHANISMS } from './constants.js'
import { validateKeyGrantsForSelection } from './encryption.js'
import { lchAssert } from './errors.js'
import { objectId, toHex } from './hash.js'
import type { WalletBRC78KeyDelivery } from './keyDelivery.js'
import { verifySignedObject } from './objects.js'
import { validatePolicyReference } from './policy.js'
import {
  validateLCHOverlayAuthority,
  type LCHOverlayAuthorityPath,
  type LCHOverlayAuthorityTerms
} from './overlayAcquisitionAuthority.js'
import {
  LCH_OVERLAY_PROFILES,
  type UnverifiedLCHOverlayContext,
  type LCHOverlayMode
} from './overlayAcquisitionCodec.js'
import { LCH_OVERLAY_COVENANT_MECHANISMS } from './overlayAcquisitionCovenantTerms.js'
import { validateLCHOverlayFixedRenderAgreement } from './overlayAcquisitionPolicy.js'
import { LCH_OVERLAY_PAID_MECHANISMS } from './overlayAcquisitionTerms.js'
import type {
  KeyGrant,
  LCHSignatureVerifier,
  LCHValue,
  RevocationObservation,
  RevocationSource,
  SegmentedEncryptionDescriptor,
  SignedObject
} from './types.js'

const equal = (left: unknown, right: unknown) =>
  toHex(encodeDeterministicCbor(left as LCHValue)) ===
  toHex(encodeDeterministicCbor(right as LCHValue))
export interface LCHOverlayLicenseTerms extends LCHOverlayAuthorityTerms {
  request: SignedObject
  encryption: SegmentedEncryptionDescriptor
}
export interface LCHOverlayLicenseValidation {
  terms: LCHOverlayLicenseTerms
  paths: readonly LCHOverlayAuthorityPath[]
  verifier: LCHSignatureVerifier
  context: UnverifiedLCHOverlayContext
  requestId: string
  mode: LCHOverlayMode
  settlement: { id: string; issuedAt: string; acceptedAt: string }
  selectedAt: string
  authorityNetwork: RevocationObservation['network']
  revocations?: { at(time: string): RevocationSource }
  keyDelivery: Pick<WalletBRC78KeyDelivery, 'recover'>
  /** Internal only: true requires the caller's protected positive verification receipt. */
  locallyVerified: boolean
  clock(): string
  current(): void
}
/** Shared internal exact-License boundary. The calling concrete domain owns
 * original terms, proof/release checks, immutable verification custody and the
 * currentness guard. This function does not accept a remote verification claim.
 */
export async function validateLCHOverlayLicense(
  input: LCHOverlayLicenseValidation
): Promise<Map<string, Uint8Array>> {
  input.current()
  lchAssert(
    input.mode === 'paid-lookup' || input.mode === 'listing-covenant',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unsupported License acquisition mode'
  )
  const profile =
      input.mode === 'paid-lookup'
        ? LCH_OVERLAY_PROFILES.paidSettlement
        : LCH_OVERLAY_PROFILES.collectorSettlement,
    mechanisms =
      input.mode === 'paid-lookup' ? LCH_OVERLAY_PAID_MECHANISMS : LCH_OVERLAY_COVENANT_MECHANISMS
  const { terms, paths, verifier, context, locallyVerified, requestId, settlement } = input,
    license = snapshotSignedObject(context.license),
    body = license.body,
    issuer = terms.offer.body.licenseIssuer
  lchAssert(issuer instanceof Uint8Array, 'ERR_LCH_LICENSE', 'License issuer is missing')
  await typedEvidence(context, terms, paths, verifier, mechanisms)
  await verifySignedObject('license', license, verifier, issuer, {
    supportedCriticalIdentifiers: new Set([LCH_OVERLAY_PROFILES.acquisition, profile])
  })
  lchAssert(
    Object.keys(body).every(key =>
      [
        'version',
        'assetId',
        'offerId',
        'requestId',
        'issuer',
        'subject',
        'issuedAt',
        'agreement',
        'selection',
        'fulfillments',
        'keyGrants',
        'extensions',
        'critical'
      ].includes(key)
    ) &&
      body.version === 1 &&
      equal(body.assetId, terms.request.body.assetId) &&
      equal(body.offerId, terms.request.body.offerId) &&
      equal(body.requestId, decodeOutputHex(requestId)) &&
      equal(body.subject, terms.request.body.buyer) &&
      equal(body.issuer, issuer) &&
      equal(body.selection, { type: 'all' }) &&
      body.segmentSelection === undefined &&
      body.notBefore === undefined &&
      body.notAfter === undefined &&
      integer(body.issuedAt) <= outputU64(input.clock()) &&
      integer(body.issuedAt) >= outputU64(settlement.issuedAt),
    'ERR_LCH_LICENSE',
    'License IDs, subject, selection or persistent rights differ'
  )
  lchAssert(
    equal(body.fulfillments, [
      {
        dutyUid: terms.policy.dutyUid,
        settlementProfile: profile,
        receiptIds: [decodeOutputHex(settlement.id)]
      }
    ]),
    'ERR_LCH_LICENSE',
    'License fulfilled a different duty or settlement'
  )
  const extensions = snapshotLCHRecord(body.extensions, 'License extensions')
  lchAssert(
    equal(extensions[LCH_OVERLAY_PROFILES.acquisition], {
      version: 1,
      mode: input.mode,
      settlementId: decodeOutputHex(settlement.id)
    }) &&
      equal(extensions[profile], { version: 1 }) &&
      Array.isArray(body.critical) &&
      body.critical.length === 2 &&
      body.critical.includes(LCH_OVERLAY_PROFILES.acquisition) &&
      body.critical.includes(profile),
    'ERR_LCH_LICENSE',
    'License lacks the exact critical acquisition settlement binding'
  )
  await validateLCHOverlayFixedRenderAgreement(
    terms.policy,
    await validatePolicyReference(body.agreement)
  )
  if (!locallyVerified)
    await Array.from([
      { actor: terms.binding.seller, capability: LCH_IRI + '#issueOffer', at: input.selectedAt },
      {
        actor: terms.binding.seller,
        capability: LCH_IRI + '#receivePayment',
        at: settlement.acceptedAt
      },
      {
        actor: issuer,
        capability: LCH_IRI + '#issueLicense',
        at: integer(body.issuedAt).toString()
      }
    ]).reduce(
      (sequence, role) =>
        sequence.then(async () => {
          await validateLCHOverlayAuthority(terms, role.actor, role.capability, paths, {
            now: outputU64(role.at),
            network: input.authorityNetwork,
            verifier,
            revocationSource: input.revocations?.at(role.at)
          })
        }),
      Promise.resolve()
    )
  const grants = body.keyGrants
  lchAssert(Array.isArray(grants), 'ERR_LCH_KEY', 'License key grants are absent')
  const typed: KeyGrant[] = grants.map(value => {
    const grant = snapshotLCHRecord(value, 'Key grant')
    lchAssert(
      Object.keys(grant)
        .sort((left, right) => Number(left > right) - Number(left < right))
        .join(',') === 'delivery,keyId,payload' &&
        grant.keyId instanceof Uint8Array &&
        grant.payload instanceof Uint8Array &&
        grant.delivery === LCH_MECHANISMS.brc78Key,
      'ERR_LCH_KEY',
      'Unsupported or ambiguous key grant'
    )
    return grant as unknown as KeyGrant
  })
  validateKeyGrantsForSelection(terms.encryption, { type: 'all' }, typed)
  const keys = new Map<string, Uint8Array>()
  await Array.from(typed).reduce(
    (sequence, grant) =>
      sequence.then(async () => {
        const sender = grant.payload.slice(4, 37)
        if (!locallyVerified && toHex(sender) !== toHex(issuer))
          await validateLCHOverlayAuthority(terms, sender, LCH_IRI + '#releaseKey', paths, {
            now: integer(body.issuedAt),
            network: input.authorityNetwork,
            verifier,
            revocationSource: input.revocations?.at(integer(body.issuedAt).toString())
          })
        const recovered = await input.keyDelivery.recover(grant.payload)
        input.current()
        lchAssert(
          toHex(recovered.keyId) === toHex(grant.keyId) &&
            toHex(grant.payload.slice(37, 70)) === terms.policy.buyer,
          'ERR_LCH_KEY',
          'Key grant commitment or recipient differs'
        )
        keys.set(toHex(recovered.keyId), recovered.cek)
      }),
    Promise.resolve()
  )
  return keys
}
async function typedEvidence(
  context: UnverifiedLCHOverlayContext,
  terms: LCHOverlayLicenseTerms,
  paths: readonly LCHOverlayAuthorityPath[],
  verifier: LCHSignatureVerifier,
  mechanisms: readonly string[]
): Promise<void> {
  const expected = new Map<string, SignedObject>(),
    offerKey = 'offer:' + toHex(await objectId('offer', terms.offer.body))
  expected.set(offerKey, terms.offer)
  await Array.from(paths).reduce(
    (sequence, path) =>
      sequence.then(async () => {
        await Array.from(path.chain).reduce(
          (sequence, authority) =>
            sequence.then(async () => {
              expected.set(
                'authority:' + toHex(await objectId('authority', authority.body)),
                authority
              )
            }),
          Promise.resolve()
        )
      }),
    Promise.resolve()
  )
  const seen = new Set<string>()
  await Array.from(context.evidence).reduce(
    (sequence, entry) =>
      sequence.then(async () => {
        lchAssert(
          entry.type === 'offer' || entry.type === 'authority',
          'ERR_LCH_PROFILE_UNSUPPORTED',
          'This direct collector profile does not use multilateral evidence'
        )
        const key = entry.type + ':' + toHex(await objectId(entry.type, entry.object.body)),
          original = expected.get(key)
        lchAssert(
          original !== undefined && equal(original.body, entry.object.body),
          'ERR_LCH_AUTHORITY',
          'Context evidence was not part of the original accepted terms'
        )
        const signer = entry.type === 'offer' ? terms.binding.seller : entry.object.body.grantor
        lchAssert(signer instanceof Uint8Array, 'ERR_LCH_AUTHORITY', 'Evidence signer is missing')
        await verifySignedObject(entry.type, entry.object, verifier, signer, {
          supportedCriticalIdentifiers: entry.type === 'offer' ? new Set(mechanisms) : new Set()
        })
        seen.add(key)
      }),
    Promise.resolve()
  )
  lchAssert(
    expected.size === seen.size && [...expected.keys()].every(key => seen.has(key)),
    'ERR_LCH_AUTHORITY',
    'Typed acquisition evidence is incomplete'
  )
}
function decodeOutputHex(value: string): Uint8Array {
  return Uint8Array.from(Utils.toArray(value, 'hex'))
}
function integer(value: unknown): bigint {
  lchAssert(
    typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)),
    'ERR_LCH_LICENSE',
    'LCH issuance time is not an exact integer'
  )
  const result = BigInt(value)
  lchAssert(
    result >= 0n && result <= 0xffffffffffffffffn,
    'ERR_LCH_LICENSE',
    'LCH issuance time exceeds U64'
  )
  return result
}
