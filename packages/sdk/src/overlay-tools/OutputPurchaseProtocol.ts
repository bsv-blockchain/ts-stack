import * as s from './OutputProtocolSchema.js'
import {
  parseOutputReleasePolicy,
  parseOutputReleasePolicyWithInlineStrings,
  validateOutputReleasePolicyOfOwnedParent
} from './OutputCapabilities.js'
import {
  parseOutputSTEAK,
  parseOutputSTEAKWithInlineStrings,
  validateOutputSTEAKOfOwnedParent
} from './OutputObservation.js'
import {
  bindOutputReleaseEvidence,
  bindOutputReleaseEvidenceWithInlineStrings,
  parseOutputReleaseEvidence,
  parseOutputReleaseEvidenceWithInlineStrings,
  validateOutputReleaseEvidenceOfOwnedParent
} from './OutputReleaseProtocol.js'
import {
  outputPacketDigest,
  outputPacketDigestWithInlineStrings,
  outputU64,
  verifyOutputPacket,
  verifyOutputPacketWithInlineStrings
} from './OutputProtocol.js'
import {
  canonicalOutputJSON,
  canonicalOutputJSONWithInlineRecords as canonicalOutputJSONWithInlineStrings
} from './OutputProtocolJSON.js'
import { outputAssert } from './OutputProtocolError.js'

const prepare = s.fixedObject({
  version: s.literal(1),
  requestId: s.requestId,
  topic: s.text,
  listing: s.outpoint,
  assetId: s.hex,
  termsDigest: s.hex,
  recipient: s.identity,
  request: s.bytes
})
const terms = s.fixedObject({
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
  domainEvidence: s.fixedObject({ schema: s.iri, bytes: s.bytes }),
  releasePolicy: parseOutputReleasePolicy,
  purchaseUntil: s.u64,
  recoveryUntil: s.u64
})
const signedTerms = s.fixedObject({ body: terms, signature: s.bytes })
const submit = s.fixedObject({
  version: s.literal(1),
  acquisitionId: s.hex,
  txid: s.hex,
  beef: s.bytes
})
const recover = s.fixedObject({ version: s.literal(1), acquisitionId: s.hex })
const commitmentBinding = s.fixedObject({
  profile: s.literal('full-purchase-commitment-v1'),
  domainProfile: s.iri,
  purchaseCommitment: s.hex
})
const potatoes = s.fixedObject({
  body: s.fixedObject(
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
const decision = s.fixedObject({
  reason: s.text,
  policy: parseOutputReleasePolicy,
  evidence: s.bytes,
  decidedAt: s.u64,
  globalOutcome: s.literal('unknown')
})
type Shape = Record<string, s.Schema<unknown>>
function purchaseState<
  T extends string,
  R extends Shape,
  E extends Shape = Record<never, never>,
  O extends Shape = Record<never, never>
>(status: T, base: R, extra = {} as E, optional?: O) {
  return s.fixedObject({ ...base, status: s.literal(status), ...extra }, optional)
}
const result = s.tagged('status', {
  prepared: purchaseState('prepared', common),
  expired: purchaseState('expired', common),
  'admission-pending': purchaseState('admission-pending', reserved, {}, candidateIdentity),
  'admission-rejected': purchaseState(
    'admission-rejected',
    reserved,
    { decision },
    candidateIdentity
  ),
  'admitted-delivery-pending': purchaseState(
    'admitted-delivery-pending',
    admitted,
    {},
    candidateIdentity
  ),
  'delivery-failed': purchaseState('delivery-failed', admitted, { decision }, candidateIdentity),
  delivered: purchaseState('delivered', admitted, { potatoes }, candidateIdentity)
})

const envelope = s.fixedObject(
  { result },
  {
    releaseEvidence: parseOutputReleaseEvidence,
    currentAlias: s.fixedObject({ txid: s.hex, beef: s.bytes })
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

/** Owned original request normalization. Each call independently checks the complete
 * returned packet, its request/seller association and BRC-77 signature. No verified
 * result, authorization, expiry, chain assessment or rights decision is retained. */
export class OutputPurchaseTermsVerifier {
  private readonly request: OutputPurchasePrepare
  private readonly seller: string
  constructor(originalRequest: OutputPurchasePrepare, selectedSeller: string) {
    this.request = parseOutputPurchasePrepare(originalRequest)
    this.seller = s.identity(selectedSeller)
  }
  verify(input: unknown): OutputSignedPurchaseTerms {
    const request = this.request,
      seller = this.seller
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
}

/** Verify original seller terms against a separately retained complete request and selected seller. */
export function verifyOutputPurchaseTerms(
  input: unknown,
  originalRequest: OutputPurchasePrepare,
  selectedSeller: string
): OutputSignedPurchaseTerms {
  return new OutputPurchaseTermsVerifier(originalRequest, selectedSeller).verify(input)
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

/** Explicit fresh owned-copy parsing; ordinary purchase parsers are unchanged. */
export const parseOutputPurchasePrepareWithInlineStrings = (
  input: unknown
): OutputPurchasePrepare => s.normalizedWithInlineStrings(input, prepare)
export const parseOutputPurchaseSubmitWithInlineStrings = (input: unknown): OutputPurchaseSubmit =>
  s.normalizedWithInlineStrings(input, submit)

/** Retains the intrinsic recovery promise; authentication remains separate. */
export function parseOutputPurchaseTermsWithInlineStrings(
  input: unknown
): OutputSignedPurchaseTerms {
  const packet = s.normalizedWithInlineStrings(input, signedTermsWithInlineStrings())
  outputAssert(
    outputU64(packet.body.recoveryUntil) >= outputU64(packet.body.purchaseUntil) + 86400n,
    'Purchase recovery promise is less than one day'
  )
  return packet
}

/** Native fresh-copy terms verification. Every call checks the complete original
 * request, selected seller, returned terms, domain-separated digests and BRC-77
 * signature. It retains no parsed request, authorization or verification verdict. */
export function verifyOutputPurchaseTermsWithInlineStrings(
  input: unknown,
  originalRequest: OutputPurchasePrepare,
  selectedSeller: string
): OutputSignedPurchaseTerms {
  const request = parseOutputPurchasePrepareWithInlineStrings(originalRequest),
    seller = s.identity(selectedSeller)
  const packet = parseOutputPurchaseTermsWithInlineStrings(input),
    body = packet.body
  const acquisitionId = outputPacketDigestWithInlineStrings('purchase', {
    chain: request.listing.chain,
    seller,
    recipient: request.recipient,
    topic: request.topic,
    requestId: request.requestId
  })
  outputAssert(
    body.seller === seller &&
      body.acquisitionId === acquisitionId &&
      body.requestDigest === outputPacketDigestWithInlineStrings('purchase-request', request) &&
      body.recipient === request.recipient &&
      body.topic === request.topic &&
      body.assetId === request.assetId &&
      body.termsDigest === request.termsDigest &&
      canonicalOutputJSONWithInlineStrings(body.listing) ===
        canonicalOutputJSONWithInlineStrings(request.listing),
    'Purchase terms differ from selected request'
  )
  outputAssert(
    verifyOutputPacketWithInlineStrings('purchase-terms', packet, seller),
    'Purchase terms signature failed',
    'unauthorized'
  )
  return packet
}

/** Explicit fresh ownership; ordinary public parser paths remain unchanged. */
export const parseOutputPotatoesWithInlineStrings = (input: unknown): OutputSignedPotatoes =>
  s.normalizedWithInlineStrings(input, potatoesWithInlineStrings())
export const parseOutputPurchaseCommitmentBindingWithInlineStrings = (
  input: unknown
): OutputPurchaseCommitmentBinding => s.normalizedWithInlineStrings(input, commitmentBinding)

/** Explicit fresh-ownership representation companion. Status and signed-body digest
 * binding only; this does not verify signatures, custody or delivery. No input or verdict is cached. */
export function parseOutputPurchaseEnvelopeWithInlineStrings(
  input: unknown
): OutputPurchaseEnvelope {
  const parsed = s.normalizedWithInlineStrings(input, envelopeWithInlineStrings())
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
        canonicalOutputJSONWithInlineStrings(body.releasePolicy) ===
          canonicalOutputJSONWithInlineStrings(evidence.policy) &&
        body.evidenceDigest === outputPacketDigestWithInlineStrings('release-evidence', evidence),
      'Private result and release evidence differ'
    )
  }
  return parsed
}

/** Explicit fresh-ownership companion. Signatures and original purchase associations
 * are independently verified on every call; no delivered or authority verdict is cached. */
export function verifyOutputPurchaseEnvelopeWithInlineStrings(
  input: unknown,
  originalTerms: OutputSignedPurchaseTerms,
  expectedTxid?: string,
  /** Independently derived from a fully verified domain purchase. A supplied
   * commitment never relaxes exact historical txid or release-evidence checks.
   */
  expectedPurchaseCommitment?: string
): OutputPurchaseEnvelope {
  const original = parseOutputPurchaseTermsWithInlineStrings(originalTerms),
    termsBody = original.body
  outputAssert(
    verifyOutputPacketWithInlineStrings('purchase-terms', original, termsBody.seller),
    'Original purchase terms signature failed',
    'unauthorized'
  )
  const txid = expectedTxid === undefined ? undefined : s.hex(expectedTxid),
    commitment =
      expectedPurchaseCommitment === undefined ? undefined : s.hex(expectedPurchaseCommitment)
  const parsed = parseOutputPurchaseEnvelopeWithInlineStrings(input),
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
      canonicalOutputJSONWithInlineStrings(response.decision.policy) ===
        canonicalOutputJSONWithInlineStrings(termsBody.releasePolicy),
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
        canonicalOutputJSONWithInlineStrings(body.releasePolicy) ===
          canonicalOutputJSONWithInlineStrings(termsBody.releasePolicy),
      'Private result differs from original purchase terms'
    )
    bindOutputReleaseEvidenceWithInlineStrings(parsed.releaseEvidence, {
      chain: termsBody.listing.chain,
      txid: response.txid,
      policy: termsBody.releasePolicy
    })
    outputAssert(
      verifyOutputPacketWithInlineStrings('potatoes', response.potatoes, termsBody.seller),
      'Private result signature failed',
      'unauthorized'
    )
  }
  return parsed
}

/** Explicit fresh-ownership companion. Signatures and original purchase associations
 * are independently verified on every call; no delivered or authority verdict is cached. */
export function verifyOutputPurchaseCommitmentEnvelopeWithInlineStrings(
  input: unknown,
  originalTerms: OutputSignedPurchaseTerms,
  expectedBinding: OutputPurchaseCommitmentBinding
): OutputPurchaseEnvelope {
  const original = parseOutputPurchaseTermsWithInlineStrings(originalTerms),
    binding = parseOutputPurchaseCommitmentBindingWithInlineStrings(expectedBinding),
    parsed = parseOutputPurchaseEnvelopeWithInlineStrings(input)
  outputAssert(
    binding.domainProfile === original.body.domainProfile,
    'Purchase commitment binding changed domain',
    'context-changed'
  )
  return verifyOutputPurchaseEnvelopeWithInlineStrings(
    parsed,
    original,
    'txid' in parsed.result ? parsed.result.txid : undefined,
    binding.purchaseCommitment
  )
}

// Fixed companion grammars preserve the ordinary schemas above. They retain no
// supplied input, partial graph, decision or current authority between calls.
let termsWithInlineStringsGrammar: s.Schema<OutputPurchaseTerms> | undefined
function termsWithInlineStrings(): s.Schema<OutputPurchaseTerms> {
  termsWithInlineStringsGrammar ??= s.fixedObject({
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
    domainEvidence: s.fixedObject({ schema: s.iri, bytes: s.bytes }),
    releasePolicy: s.fromOwnedParent(
      parseOutputReleasePolicyWithInlineStrings,
      validateOutputReleasePolicyOfOwnedParent
    ),
    purchaseUntil: s.u64,
    recoveryUntil: s.u64
  })
  return termsWithInlineStringsGrammar
}

let signedTermsWithInlineStringsGrammar: s.Schema<OutputSignedPurchaseTerms> | undefined
function signedTermsWithInlineStrings(): s.Schema<OutputSignedPurchaseTerms> {
  signedTermsWithInlineStringsGrammar ??= s.fixedObject({
    body: termsWithInlineStrings(),
    signature: s.bytes
  })
  return signedTermsWithInlineStringsGrammar
}

let potatoesWithInlineStringsGrammar: s.Schema<OutputSignedPotatoes> | undefined
function potatoesWithInlineStrings(): s.Schema<OutputSignedPotatoes> {
  potatoesWithInlineStringsGrammar ??= s.fixedObject({
    body: s.fixedObject(
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
        releasePolicy: s.fromOwnedParent(
          parseOutputReleasePolicyWithInlineStrings,
          validateOutputReleasePolicyOfOwnedParent
        ),
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
  return potatoesWithInlineStringsGrammar
}

let admittedWithInlineStringsGrammar: typeof admitted | undefined
function admittedWithInlineStrings(): typeof admitted {
  admittedWithInlineStringsGrammar ??= {
    ...reserved,
    steak: s.fromOwnedParent(parseOutputSTEAKWithInlineStrings, validateOutputSTEAKOfOwnedParent)
  }
  return admittedWithInlineStringsGrammar
}

let decisionWithInlineStringsGrammar: typeof decision | undefined
function decisionWithInlineStrings(): typeof decision {
  decisionWithInlineStringsGrammar ??= s.fixedObject({
    reason: s.text,
    policy: s.fromOwnedParent(
      parseOutputReleasePolicyWithInlineStrings,
      validateOutputReleasePolicyOfOwnedParent
    ),
    evidence: s.bytes,
    decidedAt: s.u64,
    globalOutcome: s.literal('unknown')
  })
  return decisionWithInlineStringsGrammar
}

let resultWithInlineStringsGrammar: s.Schema<OutputPurchaseResult> | undefined
function resultWithInlineStrings(): s.Schema<OutputPurchaseResult> {
  resultWithInlineStringsGrammar ??= s.tagged('status', {
    prepared: purchaseState('prepared', common),
    expired: purchaseState('expired', common),
    'admission-pending': purchaseState('admission-pending', reserved, {}, candidateIdentity),
    'admission-rejected': purchaseState(
      'admission-rejected',
      reserved,
      { decision: decisionWithInlineStrings() },
      candidateIdentity
    ),
    'admitted-delivery-pending': purchaseState(
      'admitted-delivery-pending',
      admittedWithInlineStrings(),
      {},
      candidateIdentity
    ),
    'delivery-failed': purchaseState(
      'delivery-failed',
      admittedWithInlineStrings(),
      { decision: decisionWithInlineStrings() },
      candidateIdentity
    ),
    delivered: purchaseState(
      'delivered',
      admittedWithInlineStrings(),
      { potatoes: potatoesWithInlineStrings() },
      candidateIdentity
    )
  })
  return resultWithInlineStringsGrammar
}

let envelopeWithInlineStringsGrammar: s.Schema<OutputPurchaseEnvelope> | undefined
function envelopeWithInlineStrings(): s.Schema<OutputPurchaseEnvelope> {
  envelopeWithInlineStringsGrammar ??= s.fixedObject(
    { result: resultWithInlineStrings() },
    {
      releaseEvidence: s.fromOwnedParent(
        parseOutputReleaseEvidenceWithInlineStrings,
        validateOutputReleaseEvidenceOfOwnedParent
      ),
      currentAlias: s.fixedObject({ txid: s.hex, beef: s.bytes })
    }
  )
  return envelopeWithInlineStringsGrammar
}
