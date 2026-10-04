import {
  ownOutputJSON,
  bindOutputPaidLookupChallenge,
  bindOutputReleaseEvidence,
  canonicalOutputJSON,
  closedOutputObject,
  inspectOutputPaidLookupFunding,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  parseOutputChain,
  parseOutputPaidLookupChallenge,
  parseOutputPaidLookupAcquire,
  parseOutputPaidLookupPayment,
  type OutputChain,
  type OutputJSONObject,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupPayment,
  type OutputReleaseEvidence,
  type OutputWalletFundingOperation
} from '@bsv/sdk'
import { createHash } from 'node:crypto'

export const PRIVATE_ACQUISITION_PROGRESS_BYTES = 524288
export const PRIVATE_ACQUISITION_ACCEPTANCE_BYTES = 131072
export const PRIVATE_ACQUISITION_RECEIPT_BYTES = 16384
const MAX_TIME = 18446744073709551615n

export interface PrivateAcquisitionCandidate {
  payment: OutputPaidLookupPayment
  digest: string
  receivedAt: string
  verdict: 'pending' | 'invalid' | 'accepted'
  reason: string | null
}
export interface PrivateAcquisitionFunding {
  /** Retained checked BRC-29 derivation; representation alone does not prove its origin. */
  sellerPaymentKey: string
  operation: OutputWalletFundingOperation
  acceptance: OutputReleaseEvidence
}
export interface PrivateAcquisitionWalletReceipt {
  operationId: string
  funding: OutputWalletFundingOperation['funding']
  seller: string
  satoshis: string
  /** Exact native wallet receipt, interpreted by the installed wallet adapter. */
  evidence: OutputJSONObject
}
export interface PrivateAcquisitionProgress {
  format: 'private-acquisition-progress/1'
  chain: OutputChain
  challenge: OutputPaidLookupChallenge
  createdAt: string
  updatedAt: string
  recoveryUntil: string
  phase:
    | 'quoted'
    | 'funding-pending'
    | 'funded'
    | 'delivery-pending'
    | 'delivered'
    | 'failed'
    | 'expired'
  candidate: PrivateAcquisitionCandidate | null
  funding: PrivateAcquisitionFunding | null
  walletReceipt: PrivateAcquisitionWalletReceipt | null
  delivery: { preparedAt: string; deliveredAt: string | null } | null
  reason: string | null
}

function owned(input: unknown, bytes: number): OutputJSONObject {
  const value = ownOutputJSON(input, { bytes }).value
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected acquisition record object'
  )
  return value as OutputJSONObject
}
function reason(input: unknown): string {
  return outputString(input)
}
export function privateAcquisitionCandidateDigest(payment: OutputPaidLookupPayment): string {
  return createHash('sha256')
    .update('private-acquisition-candidate/1\0')
    .update(canonicalOutputJSON(parseOutputPaidLookupPayment(payment)))
    .digest('hex')
}
function candidate(
  input: unknown,
  challenge: OutputPaidLookupChallenge
): PrivateAcquisitionCandidate {
  const value = owned(input, 98304 + 4096)
  closedOutputObject(value, ['payment', 'digest', 'receivedAt', 'verdict', 'reason'])
  const payment = parseOutputPaidLookupPayment(value.payment)
  outputAssert(
    payment.derivationPrefix === challenge.derivationPrefix,
    'Acquisition candidate changed quote prefix',
    'conflict'
  )
  const receivedAt = outputU64(value.receivedAt).toString()
  outputAssert(
    outputU64(receivedAt) < outputU64(challenge.recoveryUntil),
    'Acquisition candidate was not received before recovery expiry',
    'expired'
  )
  outputAssert(
    value.digest === privateAcquisitionCandidateDigest(payment),
    'Acquisition candidate digest differs',
    'unavailable'
  )
  outputAssert(
    value.verdict === 'pending' || value.verdict === 'invalid' || value.verdict === 'accepted',
    'Unknown acquisition candidate verdict'
  )
  outputAssert(
    (value.reason !== null) === (value.verdict === 'invalid'),
    'Acquisition candidate reason differs from verdict'
  )
  return {
    payment,
    digest: outputHex32(value.digest),
    receivedAt,
    verdict: value.verdict,
    reason: value.reason === null ? null : reason(value.reason)
  }
}
function funding(
  input: unknown,
  state: Pick<PrivateAcquisitionProgress, 'chain' | 'challenge' | 'candidate'>
): PrivateAcquisitionFunding {
  const value = owned(input, 262144)
  closedOutputObject(value, ['sellerPaymentKey', 'operation', 'acceptance'])
  outputAssert(
    state.candidate !== null && state.candidate.verdict === 'accepted',
    'Funding has no accepted candidate'
  )
  const sellerPaymentKey = outputIdentity(value.sellerPaymentKey)
  const { operation } = inspectOutputPaidLookupFunding(state.candidate.payment, state.challenge, {
    chain: state.chain,
    sellerPaymentKey
  })
  outputAssert(
    canonicalOutputJSON(value.operation) === canonicalOutputJSON(operation),
    'Acquisition funding operation changed',
    'unavailable'
  )
  const acceptance = bindOutputReleaseEvidence(
    owned(value.acceptance, PRIVATE_ACQUISITION_ACCEPTANCE_BYTES),
    {
      chain: state.chain,
      txid: operation.funding.txid,
      policy: state.challenge.acceptancePolicy
    }
  )
  return { sellerPaymentKey, operation, acceptance }
}
function receipt(
  input: unknown,
  operation: OutputWalletFundingOperation
): PrivateAcquisitionWalletReceipt {
  const value = owned(input, PRIVATE_ACQUISITION_RECEIPT_BYTES)
  closedOutputObject(value, ['operationId', 'funding', 'seller', 'satoshis', 'evidence'])
  outputAssert(
    value.operationId === operation.id &&
      value.seller === operation.seller &&
      value.satoshis === operation.satoshis &&
      canonicalOutputJSON(value.funding) === canonicalOutputJSON(operation.funding),
    'Wallet receipt changed acquisition funding',
    'unavailable'
  )
  return {
    operationId: operation.id,
    funding: structuredClone(operation.funding),
    seller: operation.seller,
    satoshis: operation.satoshis,
    evidence: owned(value.evidence, PRIVATE_ACQUISITION_RECEIPT_BYTES)
  }
}

/**
 * Own and validate one retained lifecycle. This is not evidence verification,
 * authorization, wallet execution, storage capacity or permission to disclose.
 * The owner separately retains the original request, contract and protected result.
 */
export function parsePrivateAcquisitionProgress(input: unknown): PrivateAcquisitionProgress {
  const value = owned(input, PRIVATE_ACQUISITION_PROGRESS_BYTES)
  closedOutputObject(value, [
    'format',
    'chain',
    'challenge',
    'createdAt',
    'updatedAt',
    'recoveryUntil',
    'phase',
    'candidate',
    'funding',
    'walletReceipt',
    'delivery',
    'reason'
  ])
  outputAssert(
    value.format === 'private-acquisition-progress/1',
    'Unsupported acquisition progress',
    'unsupported'
  )
  const challenge = parseOutputPaidLookupChallenge(value.challenge)
  const createdAt = outputU64(value.createdAt).toString(),
    updatedAt = outputU64(value.updatedAt).toString(),
    recoveryUntil = outputU64(value.recoveryUntil).toString()
  outputAssert(
    outputU64(createdAt) < outputU64(challenge.payableUntil) &&
      outputU64(updatedAt) >= outputU64(createdAt) &&
      outputU64(recoveryUntil) >= outputU64(challenge.recoveryUntil),
    'Acquisition clock or recovery promise differs'
  )
  outputAssert(
    [
      'quoted',
      'funding-pending',
      'funded',
      'delivery-pending',
      'delivered',
      'failed',
      'expired'
    ].includes(value.phase as string),
    'Unknown acquisition phase'
  )
  const state: PrivateAcquisitionProgress = {
    format: value.format,
    chain: parseOutputChain(value.chain),
    challenge,
    createdAt,
    updatedAt,
    recoveryUntil,
    phase: value.phase as PrivateAcquisitionProgress['phase'],
    candidate: value.candidate === null ? null : candidate(value.candidate, challenge),
    funding: null,
    walletReceipt: null,
    delivery: null,
    reason: value.reason === null ? null : reason(value.reason)
  }
  if (state.candidate !== null)
    outputAssert(
      outputU64(state.candidate.receivedAt) >= outputU64(createdAt) &&
        outputU64(state.candidate.receivedAt) <= outputU64(updatedAt),
      'Candidate receipt is outside acquisition history'
    )
  if (value.funding !== null) {
    state.funding = funding(value.funding, state)
  }
  outputAssert(
    (state.candidate?.verdict === 'accepted') === (state.funding !== null),
    'Candidate acceptance and funding differ'
  )
  if (value.walletReceipt !== null) {
    outputAssert(state.funding !== null, 'Wallet receipt has no reserved funding')
    state.walletReceipt = receipt(value.walletReceipt, state.funding.operation)
  }
  if (value.delivery !== null) state.delivery = parseDelivery(value.delivery, state)
  validateProgressPhase(state)
  return state
}
function parseDelivery(
  input: unknown,
  state: PrivateAcquisitionProgress
): NonNullable<PrivateAcquisitionProgress['delivery']> {
  const value = owned(input, 1024),
    { createdAt, updatedAt, recoveryUntil } = state
  closedOutputObject(value, ['preparedAt', 'deliveredAt'])
  const preparedAt = outputU64(value.preparedAt).toString()
  const deliveredAt = value.deliveredAt === null ? null : outputU64(value.deliveredAt).toString()
  outputAssert(
    state.walletReceipt !== null &&
      state.funding !== null &&
      outputU64(preparedAt) >= outputU64(createdAt) &&
      outputU64(preparedAt) <= outputU64(updatedAt),
    'Delivery has no prior funded history'
  )
  outputAssert(
    deliveredAt === null ||
      (outputU64(deliveredAt) >= outputU64(preparedAt) &&
        outputU64(deliveredAt) <= outputU64(updatedAt)),
    'Delivery time differs from prepared intent'
  )
  outputAssert(
    outputU64(recoveryUntil) >= outputU64(deliveredAt ?? preparedAt) + 86400n,
    'Delivery recovery is less than one day'
  )
  return { preparedAt, deliveredAt }
}
function validateProgressPhase(state: PrivateAcquisitionProgress): void {
  const { challenge, recoveryUntil, updatedAt } = state
  const funded = state.funding !== null,
    credited = state.walletReceipt !== null
  if (state.phase === 'quoted' || state.phase === 'expired')
    outputAssert(
      !funded && !credited && state.delivery === null,
      'Unfunded phase contains a funding outcome'
    )
  if (state.phase === 'funding-pending')
    outputAssert(
      funded && !credited && state.delivery === null,
      'Pending funding contains a wallet outcome'
    )
  if (state.phase === 'failed')
    outputAssert(
      funded && state.delivery?.deliveredAt == null,
      'Failed acquisition has no retained funding or was already delivered'
    )
  if (state.delivery === null)
    outputAssert(
      recoveryUntil === challenge.recoveryUntil,
      'Acquisition recovery changed without delivery intent'
    )
  validateDeliveryPhase(state, funded, credited)
  outputAssert(
    (state.reason !== null) === (state.phase === 'failed' || state.phase === 'expired'),
    'Acquisition reason differs from phase'
  )
  if (state.phase === 'expired')
    outputAssert(
      state.candidate?.verdict !== 'pending' &&
        outputU64(updatedAt) >= outputU64(challenge.recoveryUntil),
      'Pinned or unexpired acquisition cannot expire'
    )
}

function validateDeliveryPhase(
  state: PrivateAcquisitionProgress,
  funded: boolean,
  credited: boolean
): void {
  if (state.phase === 'funded')
    outputAssert(
      funded && credited && state.delivery === null,
      'Funded phase requires exact wallet receipt'
    )
  if (state.phase === 'delivery-pending' || state.phase === 'delivered')
    outputAssert(
      funded &&
        credited &&
        state.delivery !== null &&
        (state.delivery.deliveredAt !== null) === (state.phase === 'delivered'),
      'Delivery phase differs from retained outcome'
    )
}

/** Call only after quote eligibility/material/capacity checks, before any 402 response. */
export function createPrivateAcquisitionProgress(
  request: unknown,
  challenge: unknown,
  selected: { seller: string; rulesDigest: string },
  now: string,
  supportedExtensions: readonly string[] = []
): PrivateAcquisitionProgress {
  const retained = bindOutputPaidLookupChallenge(challenge, request, selected, supportedExtensions)
  const ownedRequest = parseOutputPaidLookupAcquire(request, supportedExtensions)
  return parsePrivateAcquisitionProgress({
    format: 'private-acquisition-progress/1',
    chain: ownedRequest.listing.chain,
    challenge: retained,
    createdAt: now,
    updatedAt: now,
    recoveryUntil: retained.recoveryUntil,
    phase: 'quoted',
    candidate: null,
    funding: null,
    walletReceipt: null,
    delivery: null,
    reason: null
  })
}

export type PrivateAcquisitionEvent =
  | { type: 'pin'; payment: OutputPaidLookupPayment }
  | { type: 'invalid'; candidateDigest: string; reason: string }
  | {
      type: 'reserve-funding'
      candidateDigest: string
      sellerPaymentKey: string
      acceptance: OutputReleaseEvidence
    }
  | { type: 'wallet-accepted'; receipt: PrivateAcquisitionWalletReceipt }
  | { type: 'wallet-rejected'; operationId: string; reason: string }
  | { type: 'prepare-delivery' }
  | { type: 'delivered' }
  | { type: 'fail'; reason: string }
  | { type: 'expire' }

/**
 * Pure transition, committed with the native owner's CAS before any external effect.
 * Reserve-funding requires the installed verifier's exact derivation and acceptance.
 * Wallet events require durable lookup, never guesses from transport success/failure.
 */
export function advancePrivateAcquisitionProgress(
  input: PrivateAcquisitionProgress,
  eventInput: PrivateAcquisitionEvent,
  observedAt: string
): PrivateAcquisitionProgress {
  const state = parsePrivateAcquisitionProgress(input)
  const now =
    outputU64(observedAt) > outputU64(state.updatedAt)
      ? outputU64(observedAt).toString()
      : state.updatedAt
  const event = owned(eventInput, 262144)
  switch (event.type) {
    case 'pin': {
      closedOutputObject(event, ['type', 'payment'])
      const payment = parseOutputPaidLookupPayment(event.payment)
      outputAssert(
        payment.derivationPrefix === state.challenge.derivationPrefix,
        'Acquisition candidate changed quote prefix',
        'conflict'
      )
      const digest = privateAcquisitionCandidateDigest(payment)
      if (state.candidate?.digest === digest) return state
      outputAssert(
        state.phase === 'quoted' && state.candidate?.verdict !== 'pending',
        'Acquisition already has a different payment obligation',
        'conflict'
      )
      outputAssert(
        outputU64(now) < outputU64(state.challenge.recoveryUntil),
        'First acquisition payment arrived after recovery expiry',
        'expired'
      )
      state.candidate = { payment, digest, receivedAt: now, verdict: 'pending', reason: null }
      break
    }
    case 'invalid':
      closedOutputObject(event, ['type', 'candidateDigest', 'reason'])
      outputAssert(
        state.phase === 'quoted' &&
          state.candidate?.verdict === 'pending' &&
          state.candidate.digest === event.candidateDigest,
        'Invalidation does not match pending candidate',
        'conflict'
      )
      state.candidate.verdict = 'invalid'
      state.candidate.reason = reason(event.reason)
      break
    case 'reserve-funding': {
      closedOutputObject(event, ['type', 'candidateDigest', 'sellerPaymentKey', 'acceptance'])
      outputAssert(
        state.phase === 'quoted' &&
          state.candidate?.verdict === 'pending' &&
          state.candidate.digest === event.candidateDigest,
        'Funding does not match pinned candidate',
        'conflict'
      )
      const sellerPaymentKey = outputIdentity(event.sellerPaymentKey)
      const { operation } = inspectOutputPaidLookupFunding(
        state.candidate.payment,
        state.challenge,
        { chain: state.chain, sellerPaymentKey }
      )
      state.candidate.verdict = 'accepted'
      state.funding = funding({ sellerPaymentKey, operation, acceptance: event.acceptance }, state)
      state.phase = 'funding-pending'
      break
    }
    case 'wallet-accepted':
      closedOutputObject(event, ['type', 'receipt'])
      outputAssert(
        state.phase === 'funding-pending' && state.funding !== null,
        'Acquisition has no pending wallet operation',
        'conflict'
      )
      state.walletReceipt = receipt(event.receipt, state.funding.operation)
      state.phase = 'funded'
      break
    case 'wallet-rejected':
      closedOutputObject(event, ['type', 'operationId', 'reason'])
      outputAssert(
        state.phase === 'funding-pending' && state.funding?.operation.id === event.operationId,
        'Wallet rejection changed pending operation',
        'conflict'
      )
      state.phase = 'failed'
      state.reason = reason(event.reason)
      break
    case 'prepare-delivery':
      closedOutputObject(event, ['type'])
      outputAssert(
        state.phase === 'funded' || state.phase === 'delivery-pending',
        'Acquisition is not ready to prepare delivery',
        'conflict'
      )
      state.phase = 'delivery-pending'
      state.delivery = { preparedAt: now, deliveredAt: null }
      extendRecovery(state, now)
      break
    case 'delivered':
      closedOutputObject(event, ['type'])
      outputAssert(
        state.phase === 'delivery-pending' && state.delivery !== null,
        'Acquisition has no retained delivery intent',
        'conflict'
      )
      state.phase = 'delivered'
      state.delivery.deliveredAt = now
      extendRecovery(state, now)
      break
    case 'fail':
      closedOutputObject(event, ['type', 'reason'])
      outputAssert(
        state.phase === 'funded' || state.phase === 'delivery-pending',
        'Only a funded undelivered obligation can report delivery failure',
        'conflict'
      )
      state.phase = 'failed'
      state.reason = reason(event.reason)
      break
    case 'expire':
      closedOutputObject(event, ['type'])
      outputAssert(
        state.phase === 'quoted' &&
          state.candidate?.verdict !== 'pending' &&
          outputU64(now) >= outputU64(state.challenge.recoveryUntil),
        'Pinned, funded or unexpired acquisition cannot expire',
        'conflict'
      )
      state.phase = 'expired'
      state.reason = 'recovery-expired'
      break
    default:
      outputAssert(false, 'Unknown acquisition event', 'unsupported')
  }
  state.updatedAt = now
  return parsePrivateAcquisitionProgress(state)
}
function extendRecovery(state: PrivateAcquisitionProgress, now: string): void {
  const until = outputU64(now) + 86400n
  outputAssert(until <= MAX_TIME, 'Acquisition recovery deadline exhausted', 'limited')
  if (until > outputU64(state.recoveryUntil)) state.recoveryUntil = until.toString()
}
