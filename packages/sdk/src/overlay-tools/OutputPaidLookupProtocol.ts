import * as s from './OutputProtocolSchema.js'
import { parseOutputReleasePolicy } from './OutputCapabilities.js'
import { bindOutputReleaseEvidence, parseOutputReleaseEvidence } from './OutputReleaseProtocol.js'
import { outputPacketDigest, outputU64, validateOutputExtensions } from './OutputProtocol.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import { outputAssert } from './OutputProtocolError.js'

// BRC-105 permits prefixes such as hex as well as base64. Wallet support for a
// particular representation is an explicit capability check before funding.
const derivation = (input: unknown): string => {
  outputAssert(
    typeof input === 'string' &&
      input.length > 0 &&
      input.length <= 128 &&
      Array.from(input).every(character => character.codePointAt(0)! <= 127),
    'Expected bounded ASCII payment derivation'
  )
  return input
}
const acquire = s.object(
  {
    version: s.literal(1),
    requestId: s.requestId,
    service: s.text,
    assetId: s.hex,
    listing: s.outpoint,
    termsDigest: s.hex,
    recipient: s.identity,
    request: s.bytes
  },
  s.extensions
)
const challenge = s.object({
  version: s.literal(1),
  acquisitionId: s.hex,
  requestDigest: s.hex,
  seller: s.identity,
  buyer: s.identity,
  assetId: s.hex,
  termsDigest: s.hex,
  satoshis: s.u64,
  derivationPrefix: derivation,
  acceptancePolicy: parseOutputReleasePolicy,
  rulesDigest: s.hex,
  payableUntil: s.u64,
  recoveryUntil: s.u64
})
const recover = s.object({ version: s.literal(1), acquisitionId: s.hex })
const acquired = s.object(
  {
    version: s.literal(1),
    acquisitionId: s.hex,
    status: s.literal(
      'quoted',
      'funding-pending',
      'funded',
      'delivery-pending',
      'delivered',
      'failed',
      'expired'
    ),
    recoveryUntil: s.u64,
    challenge
  },
  {
    funding: s.outpoint,
    reason: s.text,
    acceptance: parseOutputReleaseEvidence,
    result: s.object({ evidence: s.evidence, context: s.bytes, schema: s.text })
  }
)

export type OutputPaidLookupAcquire = ReturnType<typeof acquire>
export type OutputPaidLookupChallenge = ReturnType<typeof challenge>
export type OutputPaidLookupRecover = ReturnType<typeof recover>
export type OutputPaidLookupAcquired = ReturnType<typeof acquired>

/** Bounded representation only. The authenticated caller must separately equal recipient. */
export function parseOutputPaidLookupAcquire(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputPaidLookupAcquire {
  const value = s.normalized(input, acquire)
  validateOutputExtensions(value, supportedExtensions)
  return value
}

/** Checks intrinsic amount and minimum recovery promises, never current-time funding eligibility. */
export function parseOutputPaidLookupChallenge(input: unknown): OutputPaidLookupChallenge {
  const value = s.normalized(input, challenge)
  const amount = outputU64(value.satoshis)
  outputAssert(
    amount > 0n && amount <= 2100000000000000n,
    'Paid lookup amount must fit positive BRC-100 SatoshiValue'
  )
  outputAssert(
    outputU64(value.recoveryUntil) >= outputU64(value.payableUntil) + 86400n,
    'Paid lookup recovery promise is less than one day'
  )
  return value
}

/** Uncharged recovery request; this representation grants no authority to read its record. */
export const parseOutputPaidLookupRecover = (input: unknown): OutputPaidLookupRecover =>
  s.normalized(input, recover)

/**
 * Bind a quote received over authenticated BRC-103/104 to the original request
 * and independently selected seller/rules. This quote has no standalone signature.
 * Offer, release-policy, deadline and wallet feasibility selection remain separate.
 */
export function bindOutputPaidLookupChallenge(
  input: unknown,
  originalRequest: unknown,
  selected: { seller: string; rulesDigest: string },
  supportedExtensions: readonly string[] = []
): OutputPaidLookupChallenge {
  const expected = s.normalized(selected, s.object({ seller: s.identity, rulesDigest: s.hex }))
  const request = parseOutputPaidLookupAcquire(originalRequest, supportedExtensions)
  const value = parseOutputPaidLookupChallenge(input)
  const acquisitionId = outputPacketDigest('acquisition', {
    chain: request.listing.chain,
    seller: expected.seller,
    buyer: request.recipient,
    service: request.service,
    requestId: request.requestId
  })
  outputAssert(
    value.acquisitionId === acquisitionId &&
      value.requestDigest === outputPacketDigest('acquire-request', request) &&
      value.seller === expected.seller &&
      value.buyer === request.recipient &&
      value.assetId === request.assetId &&
      value.termsDigest === request.termsDigest &&
      value.rulesDigest === expected.rulesDigest,
    'Paid lookup challenge differs from selected request'
  )
  return value
}

/** Closed state representation and internal bindings only; no wallet or release verdict. */
export function parseOutputPaidLookupAcquired(input: unknown): OutputPaidLookupAcquired {
  const value = s.normalized(input, acquired)
  parseOutputPaidLookupChallenge(value.challenge)
  outputAssert(
    value.acquisitionId === value.challenge.acquisitionId &&
      outputU64(value.recoveryUntil) >= outputU64(value.challenge.recoveryUntil),
    'Paid lookup response changed acquisition or recovery promise'
  )
  const hasFunding = value.funding !== undefined
  const hasAcceptance = value.acceptance !== undefined
  const hasResult = value.result !== undefined
  if (value.status === 'quoted')
    outputAssert(
      !hasFunding && !hasAcceptance && !hasResult && value.reason === undefined,
      'Quoted lookup contains a funding outcome'
    )
  if (value.status === 'expired')
    outputAssert(
      !hasFunding && !hasAcceptance && !hasResult && value.reason !== undefined,
      'Expired lookup has invalid funding outcome'
    )
  if (value.status === 'failed')
    outputAssert(value.reason !== undefined, 'Failed lookup requires retained reason')
  if (['funding-pending', 'funded', 'delivery-pending', 'delivered'].includes(value.status))
    outputAssert(hasFunding, 'Lookup status requires funding identity')
  if (['funded', 'delivery-pending', 'delivered'].includes(value.status))
    outputAssert(hasAcceptance, 'Lookup status requires acceptance evidence')
  outputAssert(
    hasResult === (value.status === 'delivered'),
    'Lookup result requires delivered status'
  )
  if (value.acceptance !== undefined) {
    outputAssert(value.funding !== undefined, 'Acceptance requires funding identity')
    bindOutputReleaseEvidence(value.acceptance, {
      chain: value.funding.chain,
      txid: value.funding.txid,
      policy: value.challenge.acceptancePolicy
    })
  }
  return value
}

/**
 * Compare an authenticated response with the independently retained original
 * quote and request. A result refers to the frozen purchased output; it need not
 * be today's catalogue successor. Never infer settlement or secret usability.
 */
export function bindOutputPaidLookupAcquired(
  input: unknown,
  retainedChallenge: unknown,
  originalRequest: unknown,
  selected: { seller: string; rulesDigest: string },
  supportedExtensions: readonly string[] = []
): OutputPaidLookupAcquired {
  const request = parseOutputPaidLookupAcquire(originalRequest, supportedExtensions)
  const retained = bindOutputPaidLookupChallenge(
    retainedChallenge,
    request,
    selected,
    supportedExtensions
  )
  const value = parseOutputPaidLookupAcquired(input)
  outputAssert(
    canonicalOutputJSON(value.challenge) === canonicalOutputJSON(retained),
    'Paid lookup response replaced frozen challenge'
  )
  if (value.funding !== undefined)
    outputAssert(
      canonicalOutputJSON(value.funding.chain) === canonicalOutputJSON(request.listing.chain),
      'Paid lookup funding chain changed'
    )
  if (value.result !== undefined)
    outputAssert(
      value.result.evidence.txid === request.listing.txid &&
        value.result.evidence.outputIndex === request.listing.outputIndex,
      'Paid lookup result changed frozen output'
    )
  return value
}
