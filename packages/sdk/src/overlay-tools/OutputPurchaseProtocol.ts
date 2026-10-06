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
const commitmentBinding = s.object({
  profile: s.literal('full-purchase-commitment-v1'),
  domainProfile: s.iri,
  purchaseCommitment: s.hex
})
const potatoes = s.object({
  body: s.object(
    {
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
    },
    { purchaseCommitment: s.hex }
  ),
  signature: s.bytes
})
const common = { version: s.literal(1), acquisitionId: s.hex, recoveryUntil: s.u64 }
const reserved = { ...common, txid: s.hex }
const candidateIdentity = { purchaseCommitment: s.hex }
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
  'admission-pending': s.object(
    { ...reserved, status: s.literal('admission-pending') },
    candidateIdentity
  ),
  'admission-rejected': s.object(
    {
      ...reserved,
      status: s.literal('admission-rejected'),
      decision
    },
    candidateIdentity
  ),
  'admitted-delivery-pending': s.object(
    {
      ...admitted,
      status: s.literal('admitted-delivery-pending')
    },
    candidateIdentity
  ),
  'delivery-failed': s.object(
    { ...admitted, status: s.literal('delivery-failed'), decision },
    candidateIdentity
  ),
  delivered: s.object({ ...admitted, status: s.literal('delivered'), potatoes }, candidateIdentity)
})
const envelope = s.object(
  { result },
  {
    releaseEvidence: parseOutputReleaseEvidence,
    currentAlias: s.object({ txid: s.hex, beef: s.bytes })
  }
)

export type OutputPurchasePrepare = ReturnType<typeof prepare>
export type OutputPurchaseTerms = ReturnType<typeof terms>
export type OutputSignedPurchaseTerms = ReturnType<typeof signedTerms>
export type OutputPurchaseSubmit = ReturnType<typeof submit>
export type OutputPurchaseRecover = ReturnType<typeof recover>
export type OutputSignedPotatoes = ReturnType<typeof potatoes>
export type OutputPurchaseResult = ReturnType<typeof result>
export type OutputPurchaseEnvelope = ReturnType<typeof envelope>
/** Local, explicitly selected binding supplied by an independent full domain
 * verifier. It is never a wire request or proof of transaction equivalence. */
export type OutputPurchaseCommitmentBinding = ReturnType<typeof commitmentBinding>
/** Transport evidence only. Independently verify the complete transaction,
 * purchase commitment and selected-chain placement before using this alias.
 */
export type OutputPurchaseCurrentAlias = NonNullable<OutputPurchaseEnvelope['currentAlias']>

/** Closed representation only; caller authentication and domain validation are separate. */
export const parseOutputPurchasePrepare = (input: unknown): OutputPurchasePrepare =>
  s.normalized(input, prepare)
export const parseOutputPurchaseSubmit = (input: unknown): OutputPurchaseSubmit =>
  s.normalized(input, submit)
export const parseOutputPurchaseRecover = (input: unknown): OutputPurchaseRecover =>
  s.normalized(input, recover)
export const parseOutputPurchaseCommitmentBinding = (
  input: unknown
): OutputPurchaseCommitmentBinding => s.normalized(input, commitmentBinding)
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
  outputAssert(
    parsed.currentAlias === undefined || 'txid' in response,
    'A current alias requires a reserved purchase'
  )
  if (response.status === 'delivered') {
    const body = response.potatoes.body,
      evidence = parsed.releaseEvidence!
    outputAssert(
      body.acquisitionId === response.acquisitionId &&
        body.txid === response.txid &&
        body.purchaseCommitment === response.purchaseCommitment &&
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
  expectedTxid?: string,
  /** Independently derived from a fully verified domain purchase. A supplied
   * commitment never relaxes exact historical txid or release-evidence checks.
   */
  expectedPurchaseCommitment?: string
): OutputPurchaseEnvelope {
  const original = parseOutputPurchaseTerms(originalTerms),
    termsBody = original.body
  outputAssert(
    verifyOutputPacket('purchase-terms', original, termsBody.seller),
    'Original purchase terms signature failed',
    'unauthorized'
  )
  const txid = expectedTxid === undefined ? undefined : s.hex(expectedTxid),
    commitment =
      expectedPurchaseCommitment === undefined ? undefined : s.hex(expectedPurchaseCommitment)
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
    if (termsBody.domainProfile === 'https://bsv.brc.dev/tokens/0197#listing-purchase-v1')
      outputAssert(
        response.purchaseCommitment !== undefined,
        'Listing purchase commitment required'
      )
    if (commitment !== undefined)
      outputAssert(response.purchaseCommitment === commitment, 'Purchase commitment mismatch')
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

/** Explicit economic-identity transport companion. Authenticate the response's
 * historical release txid without requiring it to equal the original funded
 * txid. The independent domain must verify BOTH complete transactions against
 * this same identity before accepting rights; neither this check nor currentAlias
 * establishes Bitcoin validity, chain currentness or usable secret material.
 * The existing exact-txid verifier and omitted transport option remain unchanged.
 */
export function verifyOutputPurchaseCommitmentEnvelope(
  input: unknown,
  originalTerms: OutputSignedPurchaseTerms,
  expectedBinding: OutputPurchaseCommitmentBinding
): OutputPurchaseEnvelope {
  const original = parseOutputPurchaseTerms(originalTerms),
    binding = parseOutputPurchaseCommitmentBinding(expectedBinding),
    parsed = parseOutputPurchaseEnvelope(input)
  outputAssert(
    binding.domainProfile === original.body.domainProfile,
    'Purchase commitment binding changed domain',
    'context-changed'
  )
  return verifyOutputPurchaseEnvelope(
    parsed,
    original,
    'txid' in parsed.result ? parsed.result.txid : undefined,
    binding.purchaseCommitment
  )
}
