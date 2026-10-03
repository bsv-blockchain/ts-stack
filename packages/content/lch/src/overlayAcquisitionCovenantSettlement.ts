import {
  bindOutputReleaseEvidence,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  parseOutputEvidence,
  parseOutputOutpoint,
  parseOutputPurchaseTerms,
  parseOutputReleaseEvidence,
  parseOutputReleasePolicy,
  Utils,
  verifyOutputPacket,
  verifyOutputPurchaseEnvelope,
  type OutputEvidence,
  type OutputOutpoint,
  type OutputPurchaseEnvelope,
  type OutputReleaseEvidence,
  type OutputReleasePolicy,
  type OutputSignedPacket,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import {
  parseRevenueListingDescriptor,
  revenueListingId,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'
import { encodeDeterministicCbor } from './cbor.js'
import { lchAssert } from './errors.js'
import { toHex } from './hash.js'
import {
  decodeLCHOverlayJSON,
  LCH_OVERLAY_PROFILES,
  type UnverifiedLCHOverlayContext
} from './overlayAcquisitionCodec.js'
import {
  validateLCHOverlayCovenantPromise,
  type LCHOverlayCovenantTerms
} from './overlayAcquisitionCovenantTerms.js'
import type { LCHValue } from './types.js'

export interface LCHCovenantSettlementBody {
  version: 1
  seller: string
  buyer: string
  requestId: string
  offerId: string
  assetId: string
  dutyUid: string
  acquisitionId: string
  listingId: string
  previous: OutputOutpoint
  successor: OutputOutpoint
  txid: string
  satoshis: string
  releasePolicy: OutputReleasePolicy
  releaseEvidenceDigest: string
  issuedAt: string
  recoveryUntil: string
}
/** Portable representation. A signed genesis does not establish Bitcoin
 * ancestry, actual Script execution, currentness or an eligible purchase.
 * Install the complete BRC-197 verifier separately on each side.
 */
export interface LCHOverlayCovenantLineage {
  version: 1
  descriptor: RevenueListingDescriptor
  genesis: OutputSignedPacket<{ version: 1; listingId: string; genesis: OutputOutpoint }>
  target: OutputOutpoint
  transactions: { txid: string; beef: string }[]
}
export interface LCHOverlayCovenantPurchaseEvidence {
  version: 1
  lineage: LCHOverlayCovenantLineage
  purchase: OutputEvidence
  terms: OutputSignedPurchaseTerms
  release: OutputReleaseEvidence
}
const same = (left: unknown, right: unknown) =>
  canonicalOutputJSON(left, { bytes: 2097152 }) === canonicalOutputJSON(right, { bytes: 2097152 })

/** Exact bounded JCS plus collector signature only. It is not a settlement
 * verdict until complete purchase and release verification have succeeded.
 */
export function decodeLCHCovenantSettlement(
  bytes: Uint8Array,
  expectedSeller: string
): OutputSignedPacket<LCHCovenantSettlementBody> {
  const packet = decodeLCHOverlayJSON(bytes)
  closedOutputObject(packet, ['body', 'signature'])
  const value = packet.body
  closedOutputObject(value, [
    'version',
    'seller',
    'buyer',
    'requestId',
    'offerId',
    'assetId',
    'dutyUid',
    'acquisitionId',
    'listingId',
    'previous',
    'successor',
    'txid',
    'satoshis',
    'releasePolicy',
    'releaseEvidenceDigest',
    'issuedAt',
    'recoveryUntil'
  ])
  lchAssert(
    value.version === 1 && typeof packet.signature === 'string',
    'ERR_LCH_PAYMENT',
    'Invalid covenant settlement version/signature'
  )
  const body: LCHCovenantSettlementBody = {
    version: 1,
    seller: outputIdentity(value.seller),
    buyer: outputIdentity(value.buyer),
    requestId: outputHex32(value.requestId),
    offerId: outputHex32(value.offerId),
    assetId: outputHex32(value.assetId),
    dutyUid: outputString(value.dutyUid),
    acquisitionId: outputHex32(value.acquisitionId),
    listingId: outputHex32(value.listingId),
    previous: parseOutputOutpoint(value.previous),
    successor: parseOutputOutpoint(value.successor),
    txid: outputHex32(value.txid),
    satoshis: outputU64(value.satoshis).toString(),
    releasePolicy: parseOutputReleasePolicy(value.releasePolicy),
    releaseEvidenceDigest: outputHex32(value.releaseEvidenceDigest),
    issuedAt: outputU64(value.issuedAt).toString(),
    recoveryUntil: outputU64(value.recoveryUntil).toString()
  }
  const result = { body, signature: packet.signature }
  lchAssert(
    body.seller === outputIdentity(expectedSeller) &&
      verifyOutputPacket('lch-covenant-settlement', result, expectedSeller),
    'ERR_LCH_SIGNATURE',
    'Covenant settlement signer differs from the authorized collector'
  )
  return result
}
function lineage(input: unknown): LCHOverlayCovenantLineage {
  closedOutputObject(input, ['version', 'descriptor', 'genesis', 'target', 'transactions'])
  closedOutputObject(input.genesis, ['body', 'signature'])
  const value = input.genesis.body
  closedOutputObject(value, ['version', 'listingId', 'genesis'])
  const descriptor = parseRevenueListingDescriptor(input.descriptor),
    genesis = parseOutputOutpoint(value.genesis),
    target = parseOutputOutpoint(input.target),
    listingId = outputHex32(value.listingId)
  lchAssert(
    input.version === 1 &&
      value.version === 1 &&
      listingId === revenueListingId(descriptor) &&
      genesis.outputIndex === 0 &&
      same(genesis.chain, descriptor.chain) &&
      same(target.chain, descriptor.chain) &&
      typeof input.genesis.signature === 'string',
    'ERR_LCH_PAYMENT',
    'Invalid covenant lineage representation'
  )
  const authorization = {
    body: { version: 1 as const, listingId, genesis },
    signature: input.genesis.signature
  }
  lchAssert(
    verifyOutputPacket('sale-genesis', authorization, descriptor.seller),
    'ERR_LCH_SIGNATURE',
    'Covenant genesis authorization failed'
  )
  lchAssert(
    Array.isArray(input.transactions) &&
      input.transactions.length > 0 &&
      input.transactions.length <= 256,
    'ERR_LCH_PAYMENT',
    'Invalid covenant lineage transaction bound'
  )
  let previous = ''
  const transactions = input.transactions.map(entry => {
    closedOutputObject(entry, ['txid', 'beef'])
    const txid = outputHex32(entry.txid)
    lchAssert(txid > previous, 'ERR_LCH_PAYMENT', 'Covenant lineage must be sorted and unique')
    previous = txid
    decodeOutputBytes(entry.beef, 2097152)
    return { txid, beef: entry.beef as string }
  })
  return { version: 1, descriptor, genesis: authorization, target, transactions }
}
/** Closed transport representation and genesis signature. The complete
 * original listing DAG and actual purchase Script remain independent checks.
 */
export function decodeLCHOverlayCovenantPurchaseEvidence(
  bytes: Uint8Array
): LCHOverlayCovenantPurchaseEvidence {
  const value = decodeLCHOverlayJSON(bytes)
  closedOutputObject(value, ['version', 'lineage', 'purchase', 'terms', 'release'])
  lchAssert(value.version === 1, 'ERR_LCH_PAYMENT', 'Invalid covenant evidence version')
  return {
    version: 1,
    lineage: lineage(value.lineage),
    purchase: parseOutputEvidence(value.purchase),
    terms: parseOutputPurchaseTerms(value.terms),
    release: parseOutputReleaseEvidence(value.release)
  }
}
export interface LCHOverlayBoundCovenantSettlement {
  packet: OutputSignedPacket<LCHCovenantSettlementBody>
  id: string
  evidence: LCHOverlayCovenantPurchaseEvidence
  delivered: OutputPurchaseEnvelope
}
/** Authenticate and bind every repeated commitment to original consent and
 * the selected purchase. Neither this nor POTATOES establishes Bitcoin truth,
 * asset roles, release-policy satisfaction, a valid License or playable keys.
 */
export function bindLCHOverlayCovenantSettlement(
  context: UnverifiedLCHOverlayContext,
  terms: LCHOverlayCovenantTerms,
  preparedInput: OutputSignedPurchaseTerms,
  deliveredInput: OutputPurchaseEnvelope,
  expectedTxid: string
): LCHOverlayBoundCovenantSettlement {
  const prepared = validateLCHOverlayCovenantPromise(terms, preparedInput),
    delivered = verifyOutputPurchaseEnvelope(deliveredInput, prepared, expectedTxid),
    result = delivered.result
  lchAssert(
    result.status === 'delivered' &&
      result.potatoes.body.schema === LCH_OVERLAY_PROFILES.acquisition &&
      context.purchaseEvidence instanceof Uint8Array &&
      context.paymentEvidence === undefined,
    'ERR_LCH_LICENSE',
    'Complete covenant LCH delivery is required'
  )
  lchAssert(
    toHex(encodeDeterministicCbor(context as unknown as LCHValue)) ===
      Utils.toHex(decodeOutputBytes(result.potatoes.body.secret, 2097152)),
    'ERR_LCH_LICENSE',
    'Covenant context differs from signed POTATOES'
  )
  const packet = decodeLCHCovenantSettlement(context.settlement, terms.policy.seller),
    evidence = decodeLCHOverlayCovenantPurchaseEvidence(context.purchaseEvidence),
    original = lineage(
      decodeLCHOverlayJSON(
        Uint8Array.from(decodeOutputBytes(prepared.body.domainEvidence.bytes, 2097152))
      )
    ),
    body = packet.body,
    release = bindOutputReleaseEvidence(evidence.release, {
      chain: terms.prepare.listing.chain,
      txid: expectedTxid,
      policy: prepared.body.releasePolicy
    })
  lchAssert(
    same(evidence.terms, prepared) &&
      same(evidence.lineage, original) &&
      same(original.descriptor, terms.descriptor) &&
      same(original.target, terms.prepare.listing) &&
      evidence.purchase.txid === expectedTxid &&
      evidence.purchase.outputIndex === 0 &&
      same(delivered.releaseEvidence, release) &&
      body.buyer === terms.prepare.recipient &&
      body.requestId === terms.prepare.requestId &&
      body.offerId === terms.prepare.termsDigest &&
      body.assetId === terms.prepare.assetId &&
      body.dutyUid === terms.policy.dutyUid &&
      body.acquisitionId === prepared.body.acquisitionId &&
      body.listingId === revenueListingId(terms.descriptor) &&
      same(body.previous, terms.prepare.listing) &&
      same(body.successor, {
        chain: terms.prepare.listing.chain,
        txid: expectedTxid,
        outputIndex: 0
      }) &&
      body.txid === expectedTxid &&
      body.satoshis === terms.policy.satoshis.toString() &&
      same(body.releasePolicy, prepared.body.releasePolicy) &&
      body.releaseEvidenceDigest === outputPacketDigest('release-evidence', release) &&
      body.recoveryUntil === prepared.body.recoveryUntil &&
      outputU64(body.issuedAt) >= outputU64(release.acceptedAt) &&
      outputU64(body.issuedAt) <= outputU64(result.potatoes.body.issuedAt),
    'ERR_LCH_PAYMENT',
    'Covenant settlement differs from the exact prepared purchase'
  )
  return { packet, evidence, delivered, id: outputPacketDigest('lch-covenant-settlement', body) }
}
