import {
  bindOutputPaidLookupAcquired,
  bindOutputPaidLookupChallenge,
  bindOutputReleaseEvidence,
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  outputPacketDigest,
  parseOutputEvidence,
  parseOutputOutpoint,
  parseOutputPaidLookupChallenge,
  parseOutputPaidLookupPayment,
  parseOutputReleasePolicy,
  verifyOutputPacket,
  parseOutputReleaseEvidence,
  type OutputEvidence,
  type OutputPaidLookupAcquired,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupPayment,
  type OutputReleaseEvidence,
  type OutputReleasePolicy,
  type OutputSignedPacket
} from '@bsv/sdk'
import {
  decodeLCHOverlayJSON,
  LCH_OVERLAY_PROFILES,
  type UnverifiedLCHOverlayContext
} from './overlayAcquisitionCodec.js'
import { lchAssert } from './errors.js'
import type { LCHOverlayPaidTerms } from './overlayAcquisitionTerms.js'
import { validateLCHOverlayPaidPromise } from './overlayAcquisitionTerms.js'

export interface LCHLookupSettlementBody {
  version: 1
  seller: string
  buyer: string
  requestId: string
  offerId: string
  assetId: string
  dutyUid: string
  acquisitionId: string
  funding: ReturnType<typeof parseOutputOutpoint>
  satoshis: string
  acceptancePolicy: OutputReleasePolicy
  releaseEvidenceDigest: string
  issuedAt: string
  recoveryUntil: string
}
export interface LCHOverlayPaymentEvidence {
  version: 1
  challenge: OutputPaidLookupChallenge
  payment: OutputEvidence
  release: OutputReleaseEvidence
  derivationSuffix: string
}
/** Exact UTF-8 JCS representation plus BRC-77 identity verification. An actual
 * funding/acceptance assessment remains mandatory before accepting settlement.
 */
export function decodeLCHLookupSettlement(
  bytes: Uint8Array,
  expectedSeller: string
): OutputSignedPacket<LCHLookupSettlementBody> {
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
    'funding',
    'satoshis',
    'acceptancePolicy',
    'releaseEvidenceDigest',
    'issuedAt',
    'recoveryUntil'
  ])
  lchAssert(
    value.version === 1 && typeof packet.signature === 'string',
    'ERR_LCH_PAYMENT',
    'Invalid settlement version/signature'
  )
  const body: LCHLookupSettlementBody = {
      version: 1,
      seller: outputIdentity(value.seller),
      buyer: outputIdentity(value.buyer),
      requestId: outputHex32(value.requestId),
      offerId: outputHex32(value.offerId),
      assetId: outputHex32(value.assetId),
      dutyUid: outputString(value.dutyUid),
      acquisitionId: outputHex32(value.acquisitionId),
      funding: parseOutputOutpoint(value.funding),
      satoshis: outputU64(value.satoshis).toString(),
      acceptancePolicy: parseOutputReleasePolicy(value.acceptancePolicy),
      releaseEvidenceDigest: outputHex32(value.releaseEvidenceDigest),
      issuedAt: outputU64(value.issuedAt).toString(),
      recoveryUntil: outputU64(value.recoveryUntil).toString()
    },
    result = { body, signature: packet.signature }
  lchAssert(
    body.seller === expectedSeller &&
      verifyOutputPacket('lch-lookup-settlement', result, expectedSeller),
    'ERR_LCH_SIGNATURE',
    'Settlement signer differs from the authorized seller'
  )
  return result
}
export function decodeLCHOverlayPaymentEvidence(bytes: Uint8Array): LCHOverlayPaymentEvidence {
  const value = decodeLCHOverlayJSON(bytes)
  closedOutputObject(value, ['version', 'challenge', 'payment', 'release', 'derivationSuffix'])
  lchAssert(
    value.version === 1 && typeof value.derivationSuffix === 'string',
    'ERR_LCH_PAYMENT',
    'Invalid payment evidence version/suffix'
  )
  const challenge = parseOutputPaidLookupChallenge(value.challenge),
    payment = parseOutputEvidence(value.payment),
    suffix = parseOutputPaidLookupPayment({
      derivationPrefix: challenge.derivationPrefix,
      derivationSuffix: value.derivationSuffix,
      transaction: payment.beef
    }).derivationSuffix,
    parsedRelease = parseOutputReleaseEvidence(value.release),
    release = bindOutputReleaseEvidence(parsedRelease, {
      chain: parsedRelease.chain,
      txid: payment.txid,
      policy: challenge.acceptancePolicy
    })
  return { version: 1, challenge, payment, release, derivationSuffix: suffix }
}
export interface LCHOverlayBoundPaidSettlement {
  packet: OutputSignedPacket<LCHLookupSettlementBody>
  id: string
  evidence: LCHOverlayPaymentEvidence
}
/** Bind every repeated commitment to the original funded acquisition. This is
 * deliberately separate from Script/SPV and release-policy verification.
 */
export function bindLCHOverlayPaidSettlement(
  context: UnverifiedLCHOverlayContext,
  terms: LCHOverlayPaidTerms,
  challengeInput: OutputPaidLookupChallenge,
  paymentInput: OutputPaidLookupPayment,
  deliveredInput: OutputPaidLookupAcquired
): LCHOverlayBoundPaidSettlement {
  const challenge = bindOutputPaidLookupChallenge(challengeInput, terms.acquire, terms.selected),
    payment = parseOutputPaidLookupPayment(paymentInput),
    delivered = bindOutputPaidLookupAcquired(
      deliveredInput,
      challenge,
      terms.acquire,
      terms.selected
    )
  validateLCHOverlayPaidPromise(terms, challenge, terms.advertisedRecoverySeconds)
  lchAssert(
    delivered.status === 'delivered' &&
      delivered.result?.schema === LCH_OVERLAY_PROFILES.acquisition &&
      context.paymentEvidence instanceof Uint8Array,
    'ERR_LCH_LICENSE',
    'Complete paid LCH delivery is required'
  )
  const packet = decodeLCHLookupSettlement(context.settlement, terms.policy.seller),
    evidence = decodeLCHOverlayPaymentEvidence(context.paymentEvidence),
    body = packet.body,
    release = bindOutputReleaseEvidence(evidence.release, {
      chain: terms.acquire.listing.chain,
      txid: evidence.payment.txid,
      policy: challenge.acceptancePolicy
    })
  lchAssert(
    canonicalOutputJSON(evidence.challenge) === canonicalOutputJSON(challenge) &&
      payment.derivationPrefix === challenge.derivationPrefix &&
      evidence.derivationSuffix === payment.derivationSuffix &&
      evidence.payment.beef === payment.transaction &&
      canonicalOutputJSON(body.funding) === canonicalOutputJSON(delivered.funding) &&
      body.funding.txid === evidence.payment.txid &&
      body.funding.outputIndex === evidence.payment.outputIndex &&
      canonicalOutputJSON(body.funding.chain) ===
        canonicalOutputJSON(terms.acquire.listing.chain) &&
      canonicalOutputJSON(delivered.acceptance) === canonicalOutputJSON(release) &&
      body.buyer === terms.policy.buyer &&
      body.requestId === terms.acquire.requestId &&
      body.offerId === terms.acquire.termsDigest &&
      body.assetId === terms.acquire.assetId &&
      body.dutyUid === terms.policy.dutyUid &&
      body.acquisitionId === challenge.acquisitionId &&
      body.satoshis === terms.policy.satoshis.toString() &&
      body.satoshis === challenge.satoshis &&
      canonicalOutputJSON(body.acceptancePolicy) ===
        canonicalOutputJSON(challenge.acceptancePolicy) &&
      body.releaseEvidenceDigest === outputPacketDigest('release-evidence', release) &&
      body.recoveryUntil === challenge.recoveryUntil &&
      outputU64(body.issuedAt) >= outputU64(release.acceptedAt),
    'ERR_LCH_PAYMENT',
    'Settlement differs from the exact funded License Request'
  )
  return { packet, evidence, id: outputPacketDigest('lch-lookup-settlement', body) }
}
