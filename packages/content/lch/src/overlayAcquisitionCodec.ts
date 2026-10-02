import {
  canonicalOutputBase,
  canonicalOutputJSON,
  parseOutputJSON,
  parseOutputReleasePolicy,
  type OutputReleasePolicy
} from '@bsv/sdk'
import {
  parseRevenueListingState,
  REVENUE_LISTING_FAMILY,
  type RevenueListingState
} from '@bsv/sdk/script/templates/RevenueListing'
import { snapshotLCHRecord, snapshotSignedObject } from './boundary.js'
import { decodeDeterministicCbor, encodeDeterministicCbor } from './cbor.js'
import { LCHError, lchAssert } from './errors.js'
import { objectId, toHex } from './hash.js'
import { isCompressedPublicKey } from './signatures.js'
import type { LCHObjectType, LCHValue, SignedObject } from './types.js'

/** Explicit BRC-198 installation; ordinary BRC-170 capabilities stay unchanged. */
export const LCH_OVERLAY_PROFILES = Object.freeze({
  acquisition: 'https://bsv.brc.dev/apps/0198#overlay-acquisition-v1',
  paidSettlement: 'https://bsv.brc.dev/apps/0198#paid-lookup-settlement-v1',
  collectorSettlement: 'https://bsv.brc.dev/apps/0198#listing-accumulation-v1',
  standingOffer: 'https://bsv.brc.dev/apps/0198#standing-offer-v1'
})
export const LCH_OVERLAY_LIMITS = Object.freeze({
  contextBytes: 2097152,
  evidenceObjects: 128,
  signatureChecks: 256,
  authorityDepth: 16
})
export type LCHOverlayMode = 'paid-lookup' | 'listing-covenant'
export interface LCHOverlayBinding {
  version: 1
  mode: LCHOverlayMode
  seller: Uint8Array
  service: string
  endpoint: string
  chain: { network: string; genesisHash: Uint8Array }
  lineageAnchor?: { txid: Uint8Array; outputIndex: number }
  /** Exact original UTF-8 JCS, rather than a digest or diagnostic map. */
  releasePolicy?: Uint8Array
}
const EVIDENCE_TYPES = [
  'authority',
  'offer',
  'payment-authorization',
  'payment-delivery-ack',
  'payment-demand',
  'payment-receipt',
  'quote',
  'transaction-evidence'
] as const satisfies readonly LCHObjectType[]
export type LCHOverlayEvidenceType = (typeof EVIDENCE_TYPES)[number]
export interface LCHOverlayTypedEvidence {
  type: LCHOverlayEvidenceType
  object: SignedObject
}
/** Representation only. Signatures, authority, payment and rights are not verified. */
export interface UnverifiedLCHOverlayContext {
  version: 1
  license: SignedObject
  evidence: LCHOverlayTypedEvidence[]
  settlement: Uint8Array
  purchaseEvidence?: Uint8Array
  paymentEvidence?: Uint8Array
}
function map(input: unknown, name: string): Record<string, LCHValue> {
  return snapshotLCHRecord(input, name)
}
function closed(
  value: Record<string, LCHValue>,
  required: string[],
  optional: string[] = []
): void {
  lchAssert(
    required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => required.includes(key) || optional.includes(key)),
    'ERR_LCH_CBOR',
    'BRC-198 map has missing or unknown fields'
  )
}
function bytes(input: LCHValue | undefined, name: string, length?: number): Uint8Array {
  lchAssert(
    input instanceof Uint8Array &&
      (length === undefined ? input.length > 0 : input.length === length),
    'ERR_LCH_CBOR',
    `${name} has invalid bytes`
  )
  return input.slice()
}
function text(input: LCHValue | undefined, name: string): string {
  lchAssert(
    typeof input === 'string' && input.length > 0 && input.length <= 2048,
    'ERR_LCH_CBOR',
    `${name} has invalid text`
  )
  return input
}
function uint(input: LCHValue | undefined, maximum: bigint, name: string): bigint {
  lchAssert(
    typeof input === 'bigint' || (typeof input === 'number' && Number.isSafeInteger(input)),
    'ERR_LCH_CBOR',
    `${name} is not an exact unsigned integer`
  )
  const value = BigInt(input)
  lchAssert(value >= 0n && value <= maximum, 'ERR_LCH_CBOR', `${name} exceeds its bounds`)
  return value
}
/** Check exact JCS bytes, including rejecting a BOM and normalization of spelling. */
export function decodeLCHOverlayJSON(input: Uint8Array): unknown {
  lchAssert(
    input instanceof Uint8Array &&
      input.length > 0 &&
      input.length <= LCH_OVERLAY_LIMITS.contextBytes,
    'ERR_LCH_CBOR',
    'BRC-198 JSON bytes exceed their bound'
  )
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(input),
      parsed = parseOutputJSON(decoded, { bytes: LCH_OVERLAY_LIMITS.contextBytes }),
      canonical = new TextEncoder().encode(
        canonicalOutputJSON(parsed, { bytes: LCH_OVERLAY_LIMITS.contextBytes })
      )
    lchAssert(toHex(canonical) === toHex(input), 'ERR_LCH_CBOR', 'BRC-198 JSON is not exact JCS')
    return parsed
  } catch (cause) {
    if (cause instanceof LCHError) throw cause
    throw new LCHError('ERR_LCH_CBOR', 'Invalid BRC-198 UTF-8 JCS', { cause })
  }
}
/** Validate E's representation; this does not authenticate its surrounding Offer. */
export function decodeLCHOverlayBinding(input: unknown): LCHOverlayBinding {
  const value = map(input, 'Overlay binding')
  closed(
    value,
    ['version', 'mode', 'seller', 'service', 'endpoint', 'chain'],
    ['lineageAnchor', 'releasePolicy']
  )
  lchAssert(
    value.version === 1 && (value.mode === 'paid-lookup' || value.mode === 'listing-covenant'),
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unsupported BRC-198 binding'
  )
  const seller = bytes(value.seller, 'Seller', 33),
    endpoint = text(value.endpoint, 'Endpoint'),
    chain = map(value.chain, 'Binding chain')
  closed(chain, ['network', 'genesisHash'])
  lchAssert(isCompressedPublicKey(seller), 'ERR_LCH_SIGNATURE', 'Invalid binding seller')
  lchAssert(
    canonicalOutputBase(endpoint) === endpoint,
    'ERR_LCH_ENDPOINT',
    'Binding endpoint is not a canonical HTTPS base'
  )
  const binding: LCHOverlayBinding = {
    version: 1,
    mode: value.mode,
    seller,
    service: text(value.service, 'Service'),
    endpoint,
    chain: {
      network: text(chain.network, 'Network'),
      genesisHash: bytes(chain.genesisHash, 'Genesis hash', 32)
    }
  }
  if (value.mode === 'paid-lookup') {
    lchAssert(
      value.lineageAnchor === undefined && value.releasePolicy === undefined,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Paid binding cannot carry covenant terms'
    )
  } else {
    const anchor = map(value.lineageAnchor, 'Lineage anchor')
    closed(anchor, ['txid', 'outputIndex'])
    binding.lineageAnchor = {
      txid: bytes(anchor.txid, 'Anchor txid', 32),
      outputIndex: Number(uint(anchor.outputIndex, 4294967295n, 'Anchor output index'))
    }
    binding.releasePolicy = bytes(value.releasePolicy, 'Release policy')
    parseOutputReleasePolicy(decodeLCHOverlayJSON(binding.releasePolicy))
  }
  return binding
}
/** C's exact initial schedule, checked by the same BRC-197 state validator as Script tooling. */
export function decodeLCHCollectorRevenue(input: unknown): RevenueListingState {
  const value = map(input, 'Collector revenue')
  closed(value, ['version', 'family', 'initialRevenue', 'amendment', 'remainders', 'retirement'])
  lchAssert(
    value.version === 1 &&
      value.family === REVENUE_LISTING_FAMILY &&
      value.amendment === 'unanimous-current-recipients' &&
      value.remainders === 'retain-until-payout' &&
      value.retirement === 'externally-funded-exact-top-up',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unsupported collector revenue rules'
  )
  const state = map(value.initialRevenue, 'Initial revenue')
  closed(state, ['revision', 'recipients'])
  lchAssert(
    uint(state.revision, 0n, 'Initial revenue revision') === 0n &&
      Array.isArray(state.recipients) &&
      state.recipients.length >= 1 &&
      state.recipients.length <= 8,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Invalid initial revenue'
  )
  const recipients = state.recipients.map(input => {
    const recipient = map(input, 'Revenue recipient')
    closed(recipient, ['identity', 'weight'])
    return {
      identity: toHex(bytes(recipient.identity, 'Recipient identity', 33)),
      weight: Number(uint(recipient.weight, 10000n, 'Recipient weight'))
    }
  })
  return parseRevenueListingState({ revision: '0', recipients })
}
function signed(input: unknown, name: string): SignedObject {
  const envelope = map(input, name)
  closed(envelope, ['body', 'signatures'])
  const result = snapshotSignedObject(envelope, name)
  lchAssert(
    result.body.version === 1 && result.signatures.length > 0,
    'ERR_LCH_SIGNATURE',
    'Missing signatures or unsupported signed-object version'
  )
  return result
}
/** Validate deterministic representation, ordering and total verification budget; no authentication. */
export async function decodeUnverifiedLCHOverlayContext(
  input: Uint8Array,
  mode: LCHOverlayMode
): Promise<UnverifiedLCHOverlayContext> {
  lchAssert(
    input instanceof Uint8Array && input.length <= LCH_OVERLAY_LIMITS.contextBytes,
    'ERR_LCH_CBOR',
    'BRC-198 context exceeds its byte bound'
  )
  lchAssert(
    mode === 'paid-lookup' || mode === 'listing-covenant',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unknown acquisition mode'
  )
  const value = map(decodeDeterministicCbor(input.slice()), 'Acquisition context')
  closed(value, [
    'version',
    'license',
    'evidence',
    'settlement',
    mode === 'paid-lookup' ? 'paymentEvidence' : 'purchaseEvidence'
  ])
  lchAssert(
    value.version === 1 &&
      Array.isArray(value.evidence) &&
      value.evidence.length <= LCH_OVERLAY_LIMITS.evidenceObjects,
    'ERR_LCH_CBOR',
    'Unsupported or oversized acquisition context'
  )
  const license = signed(value.license, 'License'),
    evidence: LCHOverlayTypedEvidence[] = []
  let checks = license.signatures.length,
    previous = ''
  for await (const item of value.evidence) {
    const entry = map(item, 'Typed evidence')
    closed(entry, ['type', 'object'])
    lchAssert(
      typeof entry.type === 'string' && (EVIDENCE_TYPES as readonly string[]).includes(entry.type),
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Unsupported typed evidence domain'
    )
    const type = entry.type as LCHOverlayEvidenceType,
      object = signed(entry.object, type)
    checks += object.signatures.length
    lchAssert(
      checks <= LCH_OVERLAY_LIMITS.signatureChecks,
      'ERR_LCH_SIGNATURE',
      'Acquisition signature budget exceeded'
    )
    const ordered = type + '\0' + toHex(await objectId(type, object.body))
    lchAssert(
      ordered > previous,
      'ERR_LCH_CBOR',
      'Typed evidence must be sorted and unique by domain and body ID'
    )
    previous = ordered
    evidence.push({ type, object })
  }
  const settlement = bytes(value.settlement, 'Settlement')
  decodeLCHOverlayJSON(settlement)
  const result: UnverifiedLCHOverlayContext = { version: 1, license, evidence, settlement }
  const role = mode === 'paid-lookup' ? 'paymentEvidence' : 'purchaseEvidence',
    payload = bytes(value[role], role)
  decodeLCHOverlayJSON(payload)
  result[role] = payload
  return result
}
/** Emit only a representation that its corresponding mode decoder accepts. */
export async function encodeLCHOverlayContext(
  input: UnverifiedLCHOverlayContext,
  mode: LCHOverlayMode
): Promise<Uint8Array> {
  const owned = map(input, 'Acquisition context'),
    encoded = encodeDeterministicCbor(owned)
  await decodeUnverifiedLCHOverlayContext(encoded, mode)
  return encoded
}
/** Parse a binding's exact policy bytes without authorizing a release. */
export function decodeLCHOverlayReleasePolicy(input: Uint8Array): OutputReleasePolicy {
  return parseOutputReleasePolicy(decodeLCHOverlayJSON(input))
}
