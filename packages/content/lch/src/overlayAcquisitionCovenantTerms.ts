import {
  canonicalOutputJSON,
  OUTPUT_PROFILES,
  outputU64,
  parseOutputJSON,
  parseOutputPurchasePrepare,
  Utils,
  verifyOutputPurchaseTerms,
  type OutputCapabilitySelection,
  type OutputPurchasePrepare,
  type OutputReleasePolicy,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import {
  parseRevenueListingDescriptor,
  REVENUE_LISTING_FAMILY,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'
import { validateLicenseRequest } from './acquisition.js'
import { snapshotBytes, snapshotLCHRecord, snapshotSignedObject } from './boundary.js'
import { decodeDeterministicCbor } from './cbor.js'
import { LCH_IRI, LCH_LIMITS, LCH_MECHANISMS, LCH_PROFILES } from './constants.js'
import { LCHReader, validateOffer, type InspectedLCH } from './core.js'
import { validateEncryptionDescriptor } from './encryption.js'
import { lchAssert } from './errors.js'
import { objectId, toHex } from './hash.js'
import {
  decodeLCHCollectorRevenue,
  decodeLCHOverlayBinding,
  decodeLCHOverlayReleasePolicy,
  LCH_OVERLAY_PROFILES,
  type LCHOverlayBinding
} from './overlayAcquisitionCodec.js'
import { validateLCHOverlayAcceptedPolicy } from './overlayAcquisitionConsent.js'
import {
  validateLCHOverlayFixedRenderPolicy,
  type LCHOverlayFixedRenderPolicy
} from './overlayAcquisitionPolicy.js'
import { validateLCHOverlayCapability } from './overlayAcquisitionTerms.js'
import { PublicBRC77Verifier } from './signatures.js'
import type {
  LCHSignatureVerifier,
  LCHValue,
  SegmentedEncryptionDescriptor,
  SignedObject
} from './types.js'

export const LCH_OVERLAY_COVENANT_MECHANISMS = Object.freeze(
  [
    LCH_OVERLAY_PROFILES.acquisition,
    LCH_OVERLAY_PROFILES.collectorSettlement,
    LCH_OVERLAY_PROFILES.standingOffer,
    LCH_PROFILES.fixedRender,
    LCH_MECHANISMS.encryption,
    LCH_MECHANISMS.brc78Key,
    REVENUE_LISTING_FAMILY
  ].sort((left, right) => Number(left > right) - Number(left < right))
)
const CRITICAL = new Set<string>(LCH_OVERLAY_COVENANT_MECHANISMS)
const PURCHASE_PROFILE = 'https://bsv.brc.dev/tokens/0197#listing-purchase-v1'
const LINEAGE_SCHEMA = 'https://bsv.brc.dev/tokens/0197#lineage-package-v1'
function map(input: unknown, name: string): Record<string, LCHValue> {
  return snapshotLCHRecord(input, name)
}
function closed(input: Record<string, LCHValue>, required: string[], optional: string[] = []) {
  lchAssert(
    required.every(key => Object.hasOwn(input, key)) &&
      Object.keys(input).every(key => required.includes(key) || optional.includes(key)),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Missing or unsupported covenant terms'
  )
}
function bytes(input: unknown, size: number, name: string): Uint8Array {
  lchAssert(
    input instanceof Uint8Array && input.length === size,
    'ERR_LCH_LICENSE',
    `${name} differs`
  )
  return input
}
function equal(input: unknown, expected: Uint8Array, name: string): void {
  lchAssert(
    toHex(bytes(input, expected.length, name)) === toHex(expected),
    'ERR_LCH_LICENSE',
    `${name} differs`
  )
}
function uint(input: unknown, name: string): bigint {
  lchAssert(
    typeof input === 'bigint' || (typeof input === 'number' && Number.isSafeInteger(input)),
    'ERR_LCH_LICENSE',
    `${name} is not an exact integer`
  )
  const value = BigInt(input)
  lchAssert(value >= 0n && value <= 0xffffffffffffffffn, 'ERR_LCH_LICENSE', `${name} exceeds U64`)
  return value
}

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

function validateCovenantOfferMechanism(offer: SignedObject) {
  const payment = map(offer.body.payment, 'Offer payment'),
    pricing = map(payment.pricing, 'Offer pricing'),
    keyDelivery = map(offer.body.keyDelivery, 'Offer key delivery'),
    enforcement = map(offer.body.enforcement, 'Offer enforcement')
  closed(payment, ['protocol', 'endpoint', 'asset', 'unit', 'recoveryPeriodSeconds', 'pricing'])
  closed(pricing, ['kind', 'requirements'])
  closed(keyDelivery, ['mechanism'])
  closed(enforcement, ['class'])
  lchAssert(
    offer.body.usageProfile === LCH_PROFILES.fixedRender &&
      payment.protocol === LCH_OVERLAY_PROFILES.collectorSettlement &&
      keyDelivery.mechanism === LCH_MECHANISMS.brc78Key &&
      (enforcement.class === LCH_IRI + '#advisory' ||
        enforcement.class === LCH_IRI + '#conformingApplication') &&
      pricing.kind === 'fixed' &&
      Array.isArray(pricing.requirements) &&
      pricing.requirements.length === 1,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unsupported covenant fixed-render mechanism'
  )
  const requirement = map(pricing.requirements[0], 'Standing requirement')
  // Buyer is forbidden even if it equals this Request's authenticated buyer.
  closed(requirement, ['dutyUid', 'payee', 'endpoint', 'satoshis'], ['interest'])
  lchAssert(
    requirement.interest === undefined ||
      (typeof requirement.interest === 'string' &&
        requirement.interest.length > 0 &&
        requirement.interest.length <= 4096),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Standing requirement interest is invalid'
  )
  return { payment, requirement }
}

async function authenticateCovenantOffer(input: LCHOverlayCovenantTermsInput) {
  lchAssert(
    input.header instanceof Uint8Array &&
      input.header.length <= LCH_LIMITS.headerBytes &&
      input.request instanceof Uint8Array &&
      input.request.length <= 2097152,
    'ERR_LCH_CBOR',
    'Original LCH Header or Request exceeds its bound'
  )
  const header = snapshotBytes(input.header, 'Original Header'),
    requestBytes = snapshotBytes(input.request, 'Original License Request'),
    offer = snapshotSignedObject(input.offer, 'Original standing Offer'),
    prepare = parseOutputPurchasePrepare(input.prepare),
    descriptor = parseRevenueListingDescriptor(input.descriptor),
    selection = JSON.parse(
      canonicalOutputJSON(input.selection, { bytes: 524288 })
    ) as OutputCapabilitySelection,
    installed = new Set(input.installedMechanisms),
    inspected = await input.reader.inspect(header),
    verifier = input.verifier ?? new PublicBRC77Verifier(),
    extensions = map(offer.body.extensions, 'Offer extensions'),
    binding = decodeLCHOverlayBinding(extensions[LCH_OVERLAY_PROFILES.acquisition]),
    standing = map(extensions[LCH_OVERLAY_PROFILES.standingOffer], 'Standing Offer extension'),
    initialRevenue = decodeLCHCollectorRevenue(extensions[LCH_OVERLAY_PROFILES.collectorSettlement])
  closed(standing, ['version'])
  const critical = offer.body.critical
  lchAssert(
    binding.mode === 'listing-covenant' &&
      standing.version === 1 &&
      Array.isArray(critical) &&
      [
        LCH_OVERLAY_PROFILES.acquisition,
        LCH_OVERLAY_PROFILES.collectorSettlement,
        LCH_OVERLAY_PROFILES.standingOffer
      ].every(name => critical.includes(name)) &&
      extensions[LCH_OVERLAY_PROFILES.paidSettlement] === undefined,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Covenant Offer critical semantics differ'
  )
  await validateOffer(offer, verifier, binding.seller, { supportedCriticalIdentifiers: CRITICAL })
  const { payment, requirement } = validateCovenantOfferMechanism(offer)
  return {
    requestBytes,
    offer,
    prepare,
    descriptor,
    selection,
    installed,
    inspected,
    verifier,
    binding,
    initialRevenue,
    payment,
    requirement
  }
}
type AuthenticatedCovenantOffer = Awaited<ReturnType<typeof authenticateCovenantOffer>>

async function authenticateCovenantConsent(context: AuthenticatedCovenantOffer) {
  const {
    requestBytes,
    offer,
    prepare,
    descriptor,
    inspected,
    verifier,
    binding,
    initialRevenue,
    payment,
    requirement
  } = context
  const request = snapshotSignedObject(
      decodeDeterministicCbor(requestBytes),
      'Original License Request'
    ),
    requestId = await validateLicenseRequest(request, verifier, {
      supportedCriticalIdentifiers: CRITICAL
    }),
    offerId = await objectId('offer', offer.body),
    route = binding.endpoint + '/overlay/v1/purchases/prepare',
    releasePolicy = decodeLCHOverlayReleasePolicy(binding.releasePolicy!)
  equal(offer.body.assetId, inspected.assetId, 'Offer Asset')
  equal(request.body.assetId, inspected.assetId, 'Request Asset')
  equal(request.body.offerId, offerId, 'Request Offer')
  lchAssert(
    payment.endpoint === route &&
      requirement.endpoint === route &&
      toHex(bytes(request.body.buyer, 33, 'Buyer')) === prepare.recipient &&
      prepare.request === Utils.toBase64(requestBytes) &&
      prepare.requestId === toHex(requestId) &&
      prepare.assetId === toHex(inspected.assetId) &&
      prepare.termsDigest === toHex(offerId) &&
      prepare.topic === binding.service &&
      canonicalOutputJSON(prepare.listing.chain) ===
        canonicalOutputJSON({
          network: binding.chain.network,
          genesisHash: toHex(binding.chain.genesisHash)
        }),
    'ERR_LCH_LICENSE',
    'Outer purchase differs from signed LCH consent'
  )
  const price = uint(requirement.satoshis, 'Price')
  lchAssert(
    descriptor.administration === 'seller-v1' &&
      descriptor.scriptFamily === REVENUE_LISTING_FAMILY &&
      descriptor.seller === toHex(binding.seller) &&
      toHex(bytes(requirement.payee, 33, 'Payee')) === descriptor.seller &&
      descriptor.assetId === prepare.assetId &&
      descriptor.termsDigest === prepare.termsDigest &&
      descriptor.purchasePrice === price.toString() &&
      descriptor.lineageAnchor.txid === toHex(binding.lineageAnchor!.txid) &&
      descriptor.lineageAnchor.outputIndex === binding.lineageAnchor!.outputIndex &&
      canonicalOutputJSON(descriptor.chain) === canonicalOutputJSON(prepare.listing.chain) &&
      canonicalOutputJSON(descriptor.initialRevenue) === canonicalOutputJSON(initialRevenue),
    'ERR_LCH_LICENSE',
    'Standing Offer differs from listing descriptor or initial revenue'
  )
  return { request, releasePolicy, price }
}
type AuthenticatedCovenantConsent = Awaited<ReturnType<typeof authenticateCovenantConsent>>

async function validateCovenantCapabilityAndPolicy(
  context: AuthenticatedCovenantOffer,
  consent: AuthenticatedCovenantConsent
) {
  const { selection, binding, installed, offer, requestBytes, prepare, requirement } = context
  const { request, releasePolicy, price } = consent
  lchAssert(
    selection.service.kind === 'topic' && selection.profile.id === OUTPUT_PROFILES.purchase,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Selected purchase topic profile is required'
  )
  validateLCHOverlayCapability(selection, binding, LCH_OVERLAY_COVENANT_MECHANISMS, installed)
  const policies = selection.profile.parameters.releasePolicies,
    domains = selection.profile.parameters.domainProfiles
  lchAssert(
    Array.isArray(domains) &&
      domains.includes(PURCHASE_PROFILE) &&
      Array.isArray(policies) &&
      policies.some(value => canonicalOutputJSON(value) === canonicalOutputJSON(releasePolicy)),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Offer release policy is not advertised'
  )
  const reference = await validateLCHOverlayAcceptedPolicy(offer, request, requestBytes)
  lchAssert(
    typeof requirement.dutyUid === 'string' && typeof request.body.action === 'string',
    'ERR_LCH_POLICY',
    'Compensation duty or action is absent'
  )
  const policy: LCHOverlayFixedRenderPolicy = {
    reference,
    assetId: prepare.assetId,
    seller: toHex(binding.seller),
    buyer: prepare.recipient,
    action: request.body.action,
    dutyUid: requirement.dutyUid,
    payee: toHex(bytes(requirement.payee, 33, 'Payee')),
    satoshis: price
  }
  await validateLCHOverlayFixedRenderPolicy(policy)
  lchAssert(
    !Object.hasOwn(parseOutputJSON(reference.inline!) as object, 'assignee'),
    'ERR_LCH_POLICY',
    'Standing Offer policy must leave its assignee open'
  )
  return policy
}

async function resolveCovenantContent(
  input: LCHOverlayCovenantTermsInput,
  inspected: InspectedLCH
) {
  const encryption = map(
    inspected.representation.encryption,
    'Asset encryption'
  ) as unknown as SegmentedEncryptionDescriptor
  validateEncryptionDescriptor(encryption)
  lchAssert(
    encryption.algorithm === LCH_MECHANISMS.encryption,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unsupported Asset encryption'
  )
  const maximum = input.maximumCiphertextBytes ?? 536870912
  lchAssert(
    Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      maximum <= 536870912 &&
      uint(inspected.representation.ciphertextLength, 'Ciphertext length') <= BigInt(maximum),
    'ERR_LCH_CONTENT_UNAVAILABLE',
    'Committed ciphertext exceeds the local bound'
  )
  await input.reader.resolve(inspected)
  return encryption
}

/** Authenticate one reusable standing Offer and individual consent. No buyer
 * is inserted into the Offer; no signature/descriptor substitutes for Script,
 * lineage, role authority, admission or release verification.
 */
export async function validateLCHOverlayCovenantTerms(
  input: LCHOverlayCovenantTermsInput
): Promise<LCHOverlayCovenantTerms> {
  const context = await authenticateCovenantOffer(input)
  const { prepare, descriptor, selection, inspected, offer, requestBytes, binding, payment } =
    context
  const consent = await authenticateCovenantConsent(context)
  const { request, releasePolicy } = consent
  const policy = await validateCovenantCapabilityAndPolicy(context, consent)
  const encryption = await resolveCovenantContent(input, inspected)

  return {
    prepare,
    descriptor,
    selected: {
      seller: selection.manifest.body.identity,
      rulesDigest: selection.service.rulesDigest
    },
    inspected,
    offer,
    request,
    requestBytes,
    binding,
    releasePolicy,
    encryption,
    policy,
    recoverySeconds: uint(payment.recoveryPeriodSeconds, 'Recovery'),
    advertisedRecoverySeconds: outputU64(selection.profile.parameters.recoverySeconds).toString(),
    notBefore: uint(offer.body.notBefore, 'Offer notBefore'),
    ...(offer.body.notAfter === undefined
      ? {}
      : { notAfter: uint(offer.body.notAfter, 'Offer notAfter') })
  }
}

/** Validate the original promise without pretending recovery opens a new Offer. */
export function validateLCHOverlayCovenantPromise(
  terms: LCHOverlayCovenantTerms,
  input: OutputSignedPurchaseTerms
): OutputSignedPurchaseTerms {
  const packet = verifyOutputPurchaseTerms(input, terms.prepare, terms.selected.seller),
    body = packet.body,
    cutoff = outputU64(body.purchaseUntil),
    minimum = [86400n, outputU64(terms.advertisedRecoverySeconds), terms.recoverySeconds].reduce(
      (a, b) => {
        if (a > b) return a
        return b
      },
      0n
    )
  lchAssert(
    body.domainProfile === PURCHASE_PROFILE &&
      body.domainEvidence.schema === LINEAGE_SCHEMA &&
      canonicalOutputJSON(body.releasePolicy) === canonicalOutputJSON(terms.releasePolicy) &&
      cutoff > terms.notBefore &&
      (terms.notAfter === undefined || cutoff <= terms.notAfter) &&
      outputU64(body.recoveryUntil) >= cutoff + minimum,
    'ERR_LCH_QUOTE',
    'Purchase cutoff, release policy or recovery promise differs'
  )
  return packet
}
export function validateLCHOverlayCovenantWindow(
  terms: LCHOverlayCovenantTerms,
  packet: OutputSignedPurchaseTerms | null,
  now: string
): void {
  const observed = outputU64(now)
  lchAssert(
    observed >= terms.notBefore && (terms.notAfter === undefined || observed < terms.notAfter),
    'ERR_LCH_QUOTE',
    'Offer is outside its new-purchase window'
  )
  if (packet === null) return
  const original = validateLCHOverlayCovenantPromise(terms, packet)
  lchAssert(
    outputU64(original.body.purchaseUntil) > observed,
    'ERR_LCH_QUOTE',
    'Purchase window expired'
  )
}
