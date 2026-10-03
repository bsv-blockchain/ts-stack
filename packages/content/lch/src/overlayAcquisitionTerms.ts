import {
  canonicalOutputJSON,
  bindOutputPaidLookupChallenge,
  outputPacketDigest,
  verifyOutputPacket,
  Utils,
  outputU64,
  type OutputCapabilitySelection,
  type OutputPaidLookupAcquire,
  type OutputPaidLookupChallenge
} from '@bsv/sdk'
import { snapshotBytes, snapshotLCHRecord, snapshotSignedObject } from './boundary.js'
import { decodeDeterministicCbor } from './cbor.js'
import { LCH_IRI, LCH_MECHANISMS, LCH_PROFILES, LCH_LIMITS } from './constants.js'
import { LCHReader, validateOffer, type InspectedLCH } from './core.js'
import { validateLicenseRequest } from './acquisition.js'
import { validateEncryptionDescriptor } from './encryption.js'
import { lchAssert } from './errors.js'
import { objectId, toHex } from './hash.js'
import { validateLCHOverlayAcceptedPolicy } from './overlayAcquisitionConsent.js'
import { PublicBRC77Verifier } from './signatures.js'
import {
  decodeLCHOverlayBinding,
  LCH_OVERLAY_PROFILES,
  type LCHOverlayBinding
} from './overlayAcquisitionCodec.js'
import {
  validateLCHOverlayFixedRenderPolicy,
  type LCHOverlayFixedRenderPolicy
} from './overlayAcquisitionPolicy.js'
import type {
  LCHValue,
  LCHSignatureVerifier,
  SegmentedEncryptionDescriptor,
  SignedObject
} from './types.js'

export const LCH_OVERLAY_PAID_MECHANISMS = Object.freeze(
  [
    LCH_OVERLAY_PROFILES.acquisition,
    LCH_OVERLAY_PROFILES.paidSettlement,
    LCH_PROFILES.fixedRender,
    LCH_MECHANISMS.brc105Single,
    LCH_MECHANISMS.encryption,
    LCH_MECHANISMS.brc78Key
  ].sort((left, right) => Number(left > right) - Number(left < right))
)
const CRITICAL = new Set<string>(LCH_OVERLAY_PAID_MECHANISMS)

function map(value: unknown, name: string): Record<string, LCHValue> {
  return snapshotLCHRecord(value, name)
}
function closed(
  value: Record<string, LCHValue>,
  required: string[],
  optional: string[] = []
): void {
  lchAssert(
    required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => required.includes(key) || optional.includes(key)),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Missing or unsupported paid-overlay terms'
  )
}
function bytes(value: unknown, length: number, name: string): Uint8Array {
  lchAssert(
    value instanceof Uint8Array && value.length === length,
    'ERR_LCH_LICENSE',
    `${name} differs`
  )
  return value
}
function equalBytes(actual: unknown, expected: Uint8Array, name: string): void {
  lchAssert(
    toHex(bytes(actual, expected.length, name)) === toHex(expected),
    'ERR_LCH_LICENSE',
    `${name} differs`
  )
}
function text(value: LCHValue | undefined, name: string): string {
  lchAssert(typeof value === 'string' && value.length > 0, 'ERR_LCH_LICENSE', `${name} is absent`)
  return value
}
function uint(value: unknown, name: string): bigint {
  lchAssert(
    typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)),
    'ERR_LCH_LICENSE',
    `${name} is not an integer`
  )
  const n = BigInt(value)
  lchAssert(n >= 0n && n <= 0xffffffffffffffffn, 'ERR_LCH_LICENSE', `${name} exceeds U64`)
  return n
}
/** Consume only a previously authenticated and independently selected manifest.
 * E is required for this opt-in profile even though it is noncritical elsewhere.
 */
export function validateLCHOverlayCapability(
  selection: OutputCapabilitySelection,
  binding: LCHOverlayBinding,
  required: readonly string[],
  installed: ReadonlySet<string>
): void {
  lchAssert(
    verifyOutputPacket('capabilities', selection.manifest, toHex(binding.seller)) &&
      selection.digest === outputPacketDigest('capabilities', selection.manifest.body) &&
      selection.manifest.body.services.some(
        service => canonicalOutputJSON(service) === canonicalOutputJSON(selection.service)
      ) &&
      selection.service.profiles.some(
        profile => canonicalOutputJSON(profile) === canonicalOutputJSON(selection.profile)
      ),
    'ERR_LCH_SIGNATURE',
    'Selected capability authenticity differs'
  )
  const extension = map(
    selection.manifest.body.extensions?.[LCH_OVERLAY_PROFILES.acquisition],
    'LCH capability'
  )
  closed(extension, ['version', 'bindings'])
  lchAssert(
    extension.version === 1 &&
      Array.isArray(extension.bindings) &&
      extension.bindings.length > 0 &&
      extension.bindings.length <= 256,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'LCH capability bindings are absent'
  )
  const seen = new Set<string>()
  let mechanisms: string[] | undefined
  for (const raw of extension.bindings) {
    const entry = map(raw, 'LCH capability binding')
    closed(entry, ['kind', 'service', 'mode', 'mechanisms'])
    lchAssert(
      (entry.kind === 'lookup' || entry.kind === 'topic') &&
        (entry.mode === 'paid-lookup' || entry.mode === 'listing-covenant') &&
        typeof entry.service === 'string' &&
        entry.service.length > 0 &&
        Array.isArray(entry.mechanisms) &&
        entry.mechanisms.length > 0 &&
        entry.mechanisms.length <= 64,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Invalid LCH capability binding'
    )
    const key = canonicalOutputJSON([entry.kind, entry.service, entry.mode])
    lchAssert(!seen.has(key), 'ERR_LCH_PROFILE_UNSUPPORTED', 'Duplicate LCH capability binding')
    seen.add(key)
    const names = mechanismNames(entry.mechanisms)
    if (
      entry.kind === selection.service.kind &&
      entry.service === binding.service &&
      entry.mode === binding.mode
    )
      mechanisms = names
  }
  lchAssert(
    mechanisms !== undefined &&
      required.every(name => installed.has(name) && mechanisms.includes(name)),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Selected mechanisms are not installed and advertised'
  )
  lchAssert(
    binding.service === selection.service.name &&
      toHex(binding.seller) === selection.manifest.body.identity &&
      binding.endpoint === selection.manifest.body.baseURL &&
      binding.chain.network === selection.manifest.body.chain.network &&
      toHex(binding.chain.genesisHash) === selection.manifest.body.chain.genesisHash,
    'ERR_LCH_LICENSE',
    'LCH capability differs from the selected seller/service/chain'
  )
}

export interface LCHOverlayPaidTermsInput {
  reader: LCHReader
  /** Complete original bytes; never a displayed or diagnostic description. */
  header: Uint8Array
  offer: SignedObject
  request: Uint8Array
  acquire: OutputPaidLookupAcquire
  selection: OutputCapabilitySelection
  installedMechanisms: ReadonlySet<string>
  verifier?: LCHSignatureVerifier
  maximumCiphertextBytes?: number
}
export interface LCHOverlayPaidTerms {
  acquire: OutputPaidLookupAcquire
  selected: { seller: string; rulesDigest: string }
  inspected: InspectedLCH
  offer: SignedObject
  request: SignedObject
  requestBytes: Uint8Array
  binding: LCHOverlayBinding
  encryption: SegmentedEncryptionDescriptor
  policy: LCHOverlayFixedRenderPolicy
  recoverySeconds: bigint
  advertisedRecoverySeconds: string
  notBefore: bigint
  notAfter?: bigint
}

/** Authenticate original identities, consent, concrete fixed-render policy and
 * ciphertext before funding. Role authority is checked separately against the
 * Asset's required interests; an Offer signature alone is never that authority.
 */
export async function validateLCHOverlayPaidTerms(
  input: LCHOverlayPaidTermsInput
): Promise<LCHOverlayPaidTerms> {
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
    offer = snapshotSignedObject(input.offer, 'Original Offer'),
    acquire = JSON.parse(
      canonicalOutputJSON(input.acquire, { bytes: 4194304 })
    ) as OutputPaidLookupAcquire,
    selection = JSON.parse(
      canonicalOutputJSON(input.selection, { bytes: 524288 })
    ) as OutputCapabilitySelection,
    installed = new Set(input.installedMechanisms),
    inspected = await input.reader.inspect(header),
    verifier = input.verifier ?? new PublicBRC77Verifier(),
    extensions = map(offer.body.extensions, 'Offer extensions'),
    binding = decodeLCHOverlayBinding(extensions[LCH_OVERLAY_PROFILES.acquisition])
  lchAssert(
    binding.mode === 'paid-lookup',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Paid lookup binding required'
  )
  const paid = map(extensions[LCH_OVERLAY_PROFILES.paidSettlement], 'Paid settlement extension')
  closed(paid, ['version'])
  lchAssert(
    paid.version === 1 &&
      Array.isArray(offer.body.critical) &&
      offer.body.critical.includes(LCH_OVERLAY_PROFILES.acquisition) &&
      offer.body.critical.includes(LCH_OVERLAY_PROFILES.paidSettlement) &&
      extensions[LCH_OVERLAY_PROFILES.collectorSettlement] === undefined &&
      extensions[LCH_OVERLAY_PROFILES.standingOffer] === undefined,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Paid Offer critical semantics differ'
  )
  await validateOffer(offer, verifier, binding.seller, { supportedCriticalIdentifiers: CRITICAL })
  const payment = map(offer.body.payment, 'Offer payment'),
    pricing = map(payment.pricing, 'Offer pricing'),
    keyDelivery = map(offer.body.keyDelivery, 'Offer key delivery'),
    enforcement = map(offer.body.enforcement, 'Offer enforcement')
  lchAssert(
    offer.body.usageProfile === LCH_PROFILES.fixedRender &&
      payment.protocol === LCH_MECHANISMS.brc105Single &&
      keyDelivery.mechanism === LCH_MECHANISMS.brc78Key &&
      (enforcement.class === LCH_IRI + '#advisory' ||
        enforcement.class === LCH_IRI + '#conformingApplication'),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unsupported paid-overlay fixed-render mechanism'
  )
  closed(keyDelivery, ['mechanism'])
  closed(enforcement, ['class'])
  closed(payment, ['protocol', 'endpoint', 'asset', 'unit', 'recoveryPeriodSeconds', 'pricing'])
  closed(pricing, ['kind', 'requirements'])
  lchAssert(
    pricing.kind === 'fixed' &&
      Array.isArray(pricing.requirements) &&
      pricing.requirements.length === 1,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Exactly one fixed-price requirement is supported'
  )
  const requirement = map(pricing.requirements[0], 'Payment requirement')
  closed(requirement, ['dutyUid', 'payee', 'buyer', 'endpoint', 'satoshis'], ['interest'])
  const request = snapshotSignedObject(
      decodeDeterministicCbor(requestBytes),
      'Original License Request'
    ),
    requestId = await validateLicenseRequest(request, verifier, {
      supportedCriticalIdentifiers: CRITICAL
    }),
    offerId = await objectId('offer', offer.body),
    route = binding.endpoint + '/overlay/v1/private/acquire'
  equalBytes(offer.body.assetId, inspected.assetId, 'Offer Asset')
  equalBytes(request.body.assetId, inspected.assetId, 'Request Asset')
  equalBytes(request.body.offerId, offerId, 'Request Offer')
  equalBytes(requirement.buyer, bytes(request.body.buyer, 33, 'Buyer'), 'Requirement buyer')
  lchAssert(
    payment.endpoint === route &&
      requirement.endpoint === route &&
      toHex(bytes(request.body.buyer, 33, 'Buyer')) === acquire.recipient &&
      acquire.request === Utils.toBase64(requestBytes) &&
      acquire.requestId === toHex(requestId) &&
      acquire.assetId === toHex(inspected.assetId) &&
      acquire.termsDigest === toHex(offerId) &&
      acquire.service === binding.service &&
      canonicalOutputJSON(acquire.listing.chain) ===
        canonicalOutputJSON({
          network: binding.chain.network,
          genesisHash: toHex(binding.chain.genesisHash)
        }),
    'ERR_LCH_LICENSE',
    'Outer acquisition differs from signed LCH consent'
  )
  const reference = await validateLCHOverlayAcceptedPolicy(offer, request, requestBytes)
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
  validateLCHOverlayCapability(selection, binding, LCH_OVERLAY_PAID_MECHANISMS, installed)
  const satoshis = uint(requirement.satoshis, 'Price')
  lchAssert(
    satoshis > 0n && satoshis <= 2100000000000000n,
    'ERR_LCH_PAYMENT',
    'Price exceeds SatoshiValue'
  )
  const policy: LCHOverlayFixedRenderPolicy = {
    reference,
    assetId: toHex(inspected.assetId),
    seller: toHex(binding.seller),
    buyer: acquire.recipient,
    action: text(request.body.action, 'Action'),
    dutyUid: text(requirement.dutyUid, 'Duty UID'),
    payee: toHex(bytes(requirement.payee, 33, 'Payee')),
    satoshis
  }
  await validateLCHOverlayFixedRenderPolicy(policy)
  const maximumCiphertextBytes = input.maximumCiphertextBytes ?? 536870912
  lchAssert(
    Number.isSafeInteger(maximumCiphertextBytes) &&
      maximumCiphertextBytes > 0 &&
      maximumCiphertextBytes <= 536870912 &&
      uint(inspected.representation.ciphertextLength, 'Ciphertext length') <=
        BigInt(maximumCiphertextBytes),
    'ERR_LCH_CONTENT_UNAVAILABLE',
    'Committed ciphertext exceeds the local bound'
  )
  await input.reader.resolve(inspected)
  return {
    acquire,
    selected: {
      seller: selection.manifest.body.identity,
      rulesDigest: selection.service.rulesDigest
    },
    inspected,
    offer,
    request,
    requestBytes,
    binding,
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
/** New work uses current time; funded recovery uses its frozen original cutoff. */
export function validateLCHOverlayPaidWindow(
  terms: LCHOverlayPaidTerms,
  challenge: OutputPaidLookupChallenge | null,
  now: string,
  advertisedRecoverySeconds: string
): void {
  const observed = outputU64(now)
  lchAssert(
    observed >= terms.notBefore && (terms.notAfter === undefined || observed < terms.notAfter),
    'ERR_LCH_QUOTE',
    'Offer is outside its new-acquisition window'
  )
  if (challenge === null) return
  validateLCHOverlayPaidPromise(terms, challenge, advertisedRecoverySeconds)
  lchAssert(
    outputU64(challenge.payableUntil) > observed,
    'ERR_LCH_QUOTE',
    'Challenge funding window expired'
  )
}
/** Historical funded delivery retains these terms without pretending to open
 * a new Offer after its window. The quote cutoff and recovery promise stay fixed.
 */
export function validateLCHOverlayPaidPromise(
  terms: LCHOverlayPaidTerms,
  challenge: OutputPaidLookupChallenge,
  advertisedRecoverySeconds: string
): void {
  bindOutputPaidLookupChallenge(challenge, terms.acquire, terms.selected)
  const cutoff = outputU64(challenge.payableUntil),
    minimum = [86400n, outputU64(advertisedRecoverySeconds), terms.recoverySeconds].reduce(
      (a, b) => {
        if (a > b) return a
        return b
      },
      0n
    )
  lchAssert(
    challenge.satoshis === terms.policy.satoshis.toString() &&
      cutoff > terms.notBefore &&
      (terms.notAfter === undefined || cutoff <= terms.notAfter) &&
      outputU64(challenge.recoveryUntil) >= cutoff + minimum,
    'ERR_LCH_QUOTE',
    'Challenge price, cutoff or recovery promise differs from Offer'
  )
}

function mechanismNames(mechanisms: readonly LCHValue[]): string[] {
  let previous = ''
  const names: string[] = []
  for (const name of mechanisms) {
    lchAssert(
      typeof name === 'string' && name.length <= 2048 && name > previous,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Mechanisms must be sorted and unique'
    )
    let absolute = false
    try {
      absolute = new URL(name).protocol.length > 1
    } catch {
      /* assertion below */
    }
    lchAssert(absolute, 'ERR_LCH_PROFILE_UNSUPPORTED', 'Mechanism must be an absolute IRI')
    previous = name
    names.push(name)
  }
  return names
}
