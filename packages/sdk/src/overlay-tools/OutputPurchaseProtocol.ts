import * as s from './OutputProtocolSchema.js'
import { parseOutputReleasePolicy } from './OutputCapabilities.js'
import { parseOutputSTEAK } from './OutputObservation.js'
import { bindOutputReleaseEvidence, parseOutputReleaseEvidence } from './OutputReleaseProtocol.js'
import { outputPacketDigest, outputU64, verifyOutputPacket } from './OutputProtocol.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import { outputAssert } from './OutputProtocolError.js'

const prepare = s.object({
  version: s.literal(1),
  requestId: s.requestId,
  topic: s.text,
  listing: s.outpoint,
  assetId: s.hex,
  termsDigest: s.hex,
  recipient: s.identity,
  request: s.bytes
})
const terms = s.object({
  version: s.literal(1),
  acquisitionId: s.hex,
  requestDigest: s.hex,
  seller: s.identity,
  recipient: s.identity,
  topic: s.text,
  listing: s.outpoint,
  assetId: s.hex,
  termsDigest: s.hex,
  domainProfile: s.iri,
  domainEvidence: s.object({ schema: s.iri, bytes: s.bytes }),
  releasePolicy: parseOutputReleasePolicy,
  purchaseUntil: s.u64,
  recoveryUntil: s.u64
})
const signedTerms = s.object({ body: terms, signature: s.bytes })
const submit = s.object({ version: s.literal(1), acquisitionId: s.hex, txid: s.hex, beef: s.bytes })
const recover = s.object({ version: s.literal(1), acquisitionId: s.hex })
const potatoes = s.object({
  body: s.object({
    version: s.literal(1),
    acquisitionId: s.hex,
    requestDigest: s.hex,
    seller: s.identity,
    recipient: s.identity,
    topic: s.text,
    txid: s.hex,
    assetId: s.hex,
    termsDigest: s.hex,
    releasePolicy: parseOutputReleasePolicy,
    evidenceDigest: s.hex,
    schema: s.iri,
    secret: s.bytes,
    issuedAt: s.u64,
    recoveryUntil: s.u64
  }),
  signature: s.bytes
})
const common = { version: s.literal(1), acquisitionId: s.hex, recoveryUntil: s.u64 }
const reserved = { ...common, txid: s.hex }
const admitted = { ...reserved, steak: parseOutputSTEAK }
const decision = s.object({
  reason: s.text,
  policy: parseOutputReleasePolicy,
  evidence: s.bytes,
  decidedAt: s.u64,
  globalOutcome: s.literal('unknown')
})
const result = s.tagged('status', {
  prepared: s.object({ ...common, status: s.literal('prepared') }),
  expired: s.object({ ...common, status: s.literal('expired') }),
  'admission-pending': s.object({ ...reserved, status: s.literal('admission-pending') }),
  'admission-rejected': s.object({
    ...reserved,
    status: s.literal('admission-rejected'),
    decision
  }),
  'admitted-delivery-pending': s.object({
    ...admitted,
    status: s.literal('admitted-delivery-pending')
  }),
  'delivery-failed': s.object({ ...admitted, status: s.literal('delivery-failed'), decision }),
  delivered: s.object({ ...admitted, status: s.literal('delivered'), potatoes })
})
const envelope = s.object({ result }, { releaseEvidence: parseOutputReleaseEvidence })

export type OutputPurchasePrepare = ReturnType<typeof prepare>
export type OutputPurchaseTerms = ReturnType<typeof terms>
export type OutputSignedPurchaseTerms = ReturnType<typeof signedTerms>
export type OutputPurchaseSubmit = ReturnType<typeof submit>
export type OutputPurchaseRecover = ReturnType<typeof recover>
export type OutputSignedPotatoes = ReturnType<typeof potatoes>
export type OutputPurchaseResult = ReturnType<typeof result>
export type OutputPurchaseEnvelope = ReturnType<typeof envelope>

/** Closed representation only; caller authentication and domain validation are separate. */
export const parseOutputPurchasePrepare = (input: unknown): OutputPurchasePrepare =>
  s.normalized(input, prepare)
export const parseOutputPurchaseSubmit = (input: unknown): OutputPurchaseSubmit =>
  s.normalized(input, submit)
export const parseOutputPurchaseRecover = (input: unknown): OutputPurchaseRecover =>
  s.normalized(input, recover)
export const parseOutputPotatoes = (input: unknown): OutputSignedPotatoes =>
  s.normalized(input, potatoes)

/** Intrinsic deadline arithmetic does not authenticate or reserve a purchase. */
export function parseOutputPurchaseTerms(input: unknown): OutputSignedPurchaseTerms {
  const packet = s.normalized(input, signedTerms)
  outputAssert(
    outputU64(packet.body.recoveryUntil) >= outputU64(packet.body.purchaseUntil) + 86400n,
    'Purchase recovery promise is less than one day'
  )
  return packet
}

/** Status fields and signed-body digest binding only; this does not verify signatures or delivery. */
export function parseOutputPurchaseEnvelope(input: unknown): OutputPurchaseEnvelope {
  const parsed = s.normalized(input, envelope)
  const response = parsed.result
  outputAssert(
    Object.hasOwn(parsed, 'releaseEvidence') === (response.status === 'delivered'),
    'Release evidence belongs exactly to delivered purchases'
  )
  if (response.status === 'delivered') {
    const body = response.potatoes.body,
      evidence = parsed.releaseEvidence!
    outputAssert(
      body.acquisitionId === response.acquisitionId &&
        body.txid === response.txid &&
        body.recoveryUntil === response.recoveryUntil &&
        evidence.txid === response.txid &&
        canonicalOutputJSON(body.releasePolicy) === canonicalOutputJSON(evidence.policy) &&
        body.evidenceDigest === outputPacketDigest('release-evidence', evidence),
      'Private result and release evidence differ'
    )
  }
  return parsed
}

/** Verify original seller terms against a separately retained complete request and selected seller. */
export function verifyOutputPurchaseTerms(
  input: unknown,
  originalRequest: OutputPurchasePrepare,
  selectedSeller: string
): OutputSignedPurchaseTerms {
  const request = parseOutputPurchasePrepare(originalRequest),
    seller = s.identity(selectedSeller)
  const packet = parseOutputPurchaseTerms(input),
    body = packet.body
  const acquisitionId = outputPacketDigest('purchase', {
    chain: request.listing.chain,
    seller,
    recipient: request.recipient,
    topic: request.topic,
    requestId: request.requestId
  })
  outputAssert(
    body.seller === seller &&
      body.acquisitionId === acquisitionId &&
      body.requestDigest === outputPacketDigest('purchase-request', request) &&
      body.recipient === request.recipient &&
      body.topic === request.topic &&
      body.assetId === request.assetId &&
      body.termsDigest === request.termsDigest &&
      canonicalOutputJSON(body.listing) === canonicalOutputJSON(request.listing),
    'Purchase terms differ from selected request'
  )
  outputAssert(
    verifyOutputPacket('purchase-terms', packet, seller),
    'Purchase terms signature failed',
    'unauthorized'
  )
  return packet
}

/**
 * Bind a response to already verified original terms and an independently chosen
 * transaction. POTATOES authentication does not establish key usability, domain
 * eligibility, Script validity or satisfaction of the selected release policy.
 * Authenticate the entire response through BRC-103/104 transport first: the
 * wrapper's STEAK and non-delivered statuses are not signed by POTATOES.
 * Recovery deliberately does not expire old terms or re-gate historical delivery.
 */
export function verifyOutputPurchaseEnvelope(
  input: unknown,
  originalTerms: OutputSignedPurchaseTerms,
  expectedTxid?: string
): OutputPurchaseEnvelope {
  const original = parseOutputPurchaseTerms(originalTerms),
    termsBody = original.body
  outputAssert(
    verifyOutputPacket('purchase-terms', original, termsBody.seller),
    'Original purchase terms signature failed',
    'unauthorized'
  )
  const txid = expectedTxid === undefined ? undefined : s.hex(expectedTxid)
  const parsed = parseOutputPurchaseEnvelope(input),
    response = parsed.result
  outputAssert(
    response.acquisitionId === termsBody.acquisitionId &&
      outputU64(response.recoveryUntil) >= outputU64(termsBody.recoveryUntil),
    'Purchase response changed original identity or recovery promise'
  )
  if ('txid' in response) {
    outputAssert(
      txid !== undefined && response.txid === txid,
      'Purchase response transaction mismatch'
    )
  }
  if ('decision' in response) {
    outputAssert(
      canonicalOutputJSON(response.decision.policy) ===
        canonicalOutputJSON(termsBody.releasePolicy),
      'Purchase decision policy mismatch'
    )
  }
  if ('steak' in response) {
    outputAssert(
      Object.hasOwn(response.steak, termsBody.topic),
      'Purchase STEAK lacks the selected topic'
    )
  }
  if (response.status === 'delivered') {
    const body = response.potatoes.body
    outputAssert(
      body.requestDigest === termsBody.requestDigest &&
        body.seller === termsBody.seller &&
        body.recipient === termsBody.recipient &&
        body.topic === termsBody.topic &&
        body.assetId === termsBody.assetId &&
        body.termsDigest === termsBody.termsDigest &&
        canonicalOutputJSON(body.releasePolicy) === canonicalOutputJSON(termsBody.releasePolicy),
      'Private result differs from original purchase terms'
    )
    bindOutputReleaseEvidence(parsed.releaseEvidence, {
      chain: termsBody.listing.chain,
      txid: response.txid,
      policy: termsBody.releasePolicy
    })
    outputAssert(
      verifyOutputPacket('potatoes', response.potatoes, termsBody.seller),
      'Private result signature failed',
      'unauthorized'
    )
  }
  return parsed
}
