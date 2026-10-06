import { createHash } from 'node:crypto'
import {
  ownOutputJSON,
  bindOutputReleaseEvidence,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  parseOutputPurchaseEnvelope,
  verifyOutputPurchaseEnvelope,
  type OutputPurchaseEnvelope,
  type OutputPurchaseResult,
  type OutputReleaseEvidence,
  type STEAK
} from '@bsv/sdk'
import { parseOutputSTEAK } from '@bsv/sdk/overlay-tools/OutputObservation'
import type { PrivatePurchaseOriginal } from './PrivatePurchaseContracts.js'

export const PRIVATE_PURCHASE_PROGRESS_BYTES = 524288
/** Explicit local immutable-candidate companion. It does not establish domain
 * validity; the installed full verifier supplies the commitment before pinning. */
export type PrivatePurchaseCandidateProfile = 'full-purchase-commitment-v1'
type PurchaseDecision = Extract<OutputPurchaseResult, { status: 'admission-rejected' }>['decision']
export interface PrivatePurchaseProgress {
  format: 'private-purchase-progress/1'
  acquisitionId: string
  requestDigest: string
  recipient: string
  createdAt: string
  updatedAt: string
  recoveryUntil: string
  status: OutputPurchaseResult['status']
  txid: string | null
  /** Present only after pinning under the explicitly installed companion. */
  purchaseCommitment?: string
  operationId: string | null
  admission: { steak: STEAK; acceptedAt: string; assessmentContextId: string } | null
  decision: PurchaseDecision | null
  releaseEvidence: OutputReleaseEvidence | null
  /** Digest of the exact signed POTATOES packet retained in separate protected result slots. */
  delivery: { digest: string; issuedAt: string; schema: string } | null
}
export type PrivatePurchaseEvent =
  | { type: 'pin'; txid: string; purchaseCommitment?: string }
  | { type: 'admitted'; steak: STEAK; acceptedAt: string; assessmentContextId: string }
  | { type: 'admission-rejected'; reason: string; evidence: string }
  | { type: 'delivery-failed'; reason: string; evidence: string }
  | { type: 'delivered'; envelope: OutputPurchaseEnvelope }
  | { type: 'expire' }

function ownedEvent(
  input: PrivatePurchaseEvent,
  profile?: PrivatePurchaseCandidateProfile
): PrivatePurchaseEvent {
  const value = ownOutputJSON(input).value
  closedOutputObject(
    value,
    ['type'],
    [
      'txid',
      'purchaseCommitment',
      'steak',
      'acceptedAt',
      'assessmentContextId',
      'reason',
      'evidence',
      'envelope'
    ]
  )
  const fields: Record<string, readonly string[]> = {
    pin: ['txid', ...(profile ? ['purchaseCommitment'] : [])],
    admitted: ['steak', 'acceptedAt', 'assessmentContextId'],
    'admission-rejected': ['reason', 'evidence'],
    'delivery-failed': ['reason', 'evidence'],
    delivered: ['envelope'],
    expire: []
  }
  const type = outputString(value.type)
  outputAssert(Object.hasOwn(fields, type), 'Unsupported purchase transition', 'unsupported')
  closedOutputObject(value, ['type', ...fields[type]])
  return value as unknown as PrivatePurchaseEvent
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update('private-purchase-record/1\0')
    .update(canonicalOutputJSON(value))
    .digest('hex')
}
export function privatePurchaseOperation(original: PrivatePurchaseOriginal, txid: string): string {
  const body = original.terms.body
  return digest({
    purpose: 'topic-admission',
    acquisitionId: body.acquisitionId,
    requestDigest: body.requestDigest,
    recipient: body.recipient,
    topic: body.topic,
    chain: body.listing.chain,
    txid: outputHex32(txid)
  })
}

function response(progress: PrivatePurchaseProgress): OutputPurchaseEnvelope {
  outputAssert(progress.status !== 'delivered', 'Delivered purchase requires its protected result')
  const common = {
      version: 1 as const,
      acquisitionId: progress.acquisitionId,
      recoveryUntil: progress.recoveryUntil
    },
    reserved = {
      ...common,
      txid: progress.txid,
      ...(progress.purchaseCommitment === undefined
        ? {}
        : { purchaseCommitment: progress.purchaseCommitment })
    },
    admitted = { ...reserved, steak: progress.admission?.steak }
  switch (progress.status) {
    case 'prepared':
    case 'expired':
      return parseOutputPurchaseEnvelope({ result: { ...common, status: progress.status } })
    case 'admission-pending':
      return parseOutputPurchaseEnvelope({ result: { ...reserved, status: progress.status } })
    case 'admission-rejected':
      return parseOutputPurchaseEnvelope({
        result: { ...reserved, status: progress.status, decision: progress.decision }
      })
    case 'admitted-delivery-pending':
      return parseOutputPurchaseEnvelope({ result: { ...admitted, status: progress.status } })
    case 'delivery-failed':
      return parseOutputPurchaseEnvelope({
        result: { ...admitted, status: progress.status, decision: progress.decision }
      })
  }
}

function purchaseAdmission(
  input: unknown,
  topic: string,
  createdAt: string,
  updatedAt: string
): PrivatePurchaseProgress['admission'] {
  if (input === null) return null
  closedOutputObject(input, ['steak', 'acceptedAt', 'assessmentContextId'])
  const steak = parseOutputSTEAK(input.steak),
    acceptedAt = outputU64(input.acceptedAt).toString()
  outputAssert(
    Object.hasOwn(steak, topic) &&
      outputU64(acceptedAt) >= outputU64(createdAt) &&
      outputU64(acceptedAt) <= outputU64(updatedAt),
    'Purchase admission time or topic differs',
    'unavailable'
  )
  return { steak, acceptedAt, assessmentContextId: outputString(input.assessmentContextId) }
}

function purchaseDelivery(
  input: unknown,
  admission: PrivatePurchaseProgress['admission'],
  updatedAt: string
): PrivatePurchaseProgress['delivery'] {
  if (input === null) return null
  closedOutputObject(input, ['digest', 'issuedAt', 'schema'])
  const issuedAt = outputU64(input.issuedAt).toString()
  outputAssert(
    outputU64(issuedAt) >= outputU64(admission!.acceptedAt) &&
      outputU64(issuedAt) <= outputU64(updatedAt),
    'Purchase delivery clock differs',
    'unavailable'
  )
  return { digest: outputHex32(input.digest), issuedAt, schema: outputString(input.schema) }
}

function purchaseProgressReservation(
  input: unknown,
  original: PrivatePurchaseOriginal,
  profile?: PrivatePurchaseCandidateProfile
) {
  const value = input
  closedOutputObject(
    value,
    [
      'format',
      'acquisitionId',
      'requestDigest',
      'recipient',
      'createdAt',
      'updatedAt',
      'recoveryUntil',
      'status',
      'txid',
      'operationId',
      'admission',
      'decision',
      'releaseEvidence',
      'delivery'
    ],
    profile ? ['purchaseCommitment'] : []
  )
  const body = original.terms.body
  outputAssert(
    value.format === 'private-purchase-progress/1' &&
      value.acquisitionId === body.acquisitionId &&
      value.requestDigest === body.requestDigest &&
      value.recipient === body.recipient &&
      value.createdAt === original.createdAt &&
      value.recoveryUntil === body.recoveryUntil,
    'Purchase progress differs from its original reservation',
    'unavailable'
  )
  const createdAt = outputU64(value.createdAt).toString(),
    updatedAt = outputU64(value.updatedAt).toString()
  outputAssert(
    outputU64(updatedAt) >= outputU64(createdAt) &&
      outputU64(createdAt) < outputU64(body.purchaseUntil),
    'Purchase progress clock differs from its reservation',
    'unavailable'
  )
  return { value, body, createdAt, updatedAt }
}

function purchaseProgressPosition(
  value: Record<string, unknown>,
  original: PrivatePurchaseOriginal,
  profile?: PrivatePurchaseCandidateProfile
) {
  const status = value.status as PrivatePurchaseProgress['status'],
    unpinned = status === 'prepared' || status === 'expired',
    admitted =
      status === 'admitted-delivery-pending' ||
      status === 'delivery-failed' ||
      status === 'delivered',
    decided = status === 'admission-rejected' || status === 'delivery-failed'
  outputAssert(
    (value.txid === null) === unpinned &&
      (value.operationId === null) === unpinned &&
      (value.admission !== null) === admitted &&
      (value.decision !== null) === decided &&
      (value.releaseEvidence !== null) === (status === 'delivered') &&
      (value.delivery !== null) === (status === 'delivered'),
    'Purchase progress fields differ from its status',
    'unavailable'
  )
  if (profile)
    outputAssert(
      Object.hasOwn(value, 'purchaseCommitment') === !unpinned,
      'Purchase commitment differs from its reservation status',
      'unavailable'
    )
  const txid = value.txid === null ? null : outputHex32(value.txid),
    operationId = value.operationId === null ? null : outputHex32(value.operationId)
  outputAssert(
    txid === null || operationId === privatePurchaseOperation(original, txid),
    'Purchase admission operation differs',
    'unavailable'
  )
  return { status, txid, operationId }
}

function validatePurchaseProgressResult(
  progress: PrivatePurchaseProgress,
  original: PrivatePurchaseOriginal
): void {
  const { status, txid, updatedAt, admission, delivery } = progress
  if (status !== 'delivered') {
    const checked = verifyOutputPurchaseEnvelope(
      response(progress),
      original.terms,
      txid ?? undefined,
      progress.purchaseCommitment
    )
    if ('decision' in checked.result) {
      outputAssert(
        outputU64(checked.result.decision.decidedAt) === outputU64(updatedAt),
        'Purchase decision clock differs',
        'unavailable'
      )
      progress.decision = checked.result.decision
    }
  } else
    outputAssert(
      outputU64(progress.releaseEvidence!.acceptedAt) <= outputU64(delivery!.issuedAt) &&
        (progress.releaseEvidence!.policy.kind !== 'local-admission' ||
          progress.releaseEvidence!.acceptedAt === admission!.acceptedAt),
      'Purchase release follows its delivery',
      'unavailable'
    )
}

/** Representation and transition checks only. Installed validators and effect owners establish the premises. */
export function parsePrivatePurchaseProgress(
  input: unknown,
  original: PrivatePurchaseOriginal,
  profile?: PrivatePurchaseCandidateProfile
): PrivatePurchaseProgress {
  outputAssert(
    profile === undefined || profile === 'full-purchase-commitment-v1',
    'Unsupported purchase candidate profile',
    'unsupported'
  )
  const captured = ownOutputJSON(input, { bytes: PRIVATE_PURCHASE_PROGRESS_BYTES }).value
  const { value, body, createdAt, updatedAt } = purchaseProgressReservation(
    captured,
    original,
    profile
  )
  const { status, txid, operationId } = purchaseProgressPosition(value, original, profile)
  const admission = purchaseAdmission(value.admission, body.topic, createdAt, updatedAt),
    delivery = purchaseDelivery(value.delivery, admission, updatedAt)
  const progress: PrivatePurchaseProgress = {
    format: 'private-purchase-progress/1',
    acquisitionId: outputHex32(value.acquisitionId),
    requestDigest: outputHex32(value.requestDigest),
    recipient: outputIdentity(value.recipient),
    createdAt,
    updatedAt,
    recoveryUntil: body.recoveryUntil,
    status,
    txid,
    ...(value.purchaseCommitment === undefined
      ? {}
      : { purchaseCommitment: outputHex32(value.purchaseCommitment) }),
    operationId,
    admission,
    decision: value.decision as unknown as PurchaseDecision | null,
    releaseEvidence:
      value.releaseEvidence === null
        ? null
        : bindOutputReleaseEvidence(value.releaseEvidence, {
            chain: body.listing.chain,
            txid: txid!,
            policy: body.releasePolicy
          }),
    delivery
  }
  validatePurchaseProgressResult(progress, original)
  return progress
}

export function createPrivatePurchaseProgress(
  original: PrivatePurchaseOriginal,
  profile?: PrivatePurchaseCandidateProfile
): PrivatePurchaseProgress {
  const body = original.terms.body
  return parsePrivatePurchaseProgress(
    {
      format: 'private-purchase-progress/1',
      acquisitionId: body.acquisitionId,
      requestDigest: body.requestDigest,
      recipient: body.recipient,
      createdAt: original.createdAt,
      updatedAt: original.createdAt,
      recoveryUntil: body.recoveryUntil,
      status: 'prepared',
      txid: null,
      operationId: null,
      admission: null,
      decision: null,
      releaseEvidence: null,
      delivery: null
    },
    original,
    profile
  )
}

export function advancePrivatePurchaseProgress(
  input: PrivatePurchaseProgress,
  original: PrivatePurchaseOriginal,
  eventInput: PrivatePurchaseEvent,
  nowInput: string,
  profile?: PrivatePurchaseCandidateProfile
): PrivatePurchaseProgress {
  const event = ownedEvent(eventInput, profile),
    progress = parsePrivatePurchaseProgress(input, original, profile),
    now = outputU64(nowInput)
  outputAssert(
    now >= outputU64(progress.updatedAt),
    'Purchase progress clock moved backwards',
    'context-changed'
  )
  if (event.type === 'pin') {
    const txid = outputHex32(event.txid)
    const commitment = profile ? outputHex32(event.purchaseCommitment) : undefined
    if (progress.txid !== null) {
      outputAssert(
        progress.txid === txid && progress.purchaseCommitment === commitment,
        'Purchase is reserved for another transaction',
        'conflict'
      )
      return progress
    }
    outputAssert(
      progress.status === 'prepared' && now < outputU64(progress.recoveryUntil),
      'Purchase recovery reservation expired',
      'expired'
    )
    progress.txid = txid
    if (commitment !== undefined) progress.purchaseCommitment = commitment
    progress.operationId = privatePurchaseOperation(original, txid)
    progress.status = 'admission-pending'
  } else if (event.type === 'expire') {
    if (progress.status !== 'prepared') return progress
    outputAssert(
      now >= outputU64(progress.recoveryUntil),
      'Purchase recovery reservation remains active',
      'conflict'
    )
    progress.status = 'expired'
  } else if (event.type === 'admitted') {
    outputAssert(
      progress.status === 'admission-pending',
      'Purchase has no pending admission',
      'conflict'
    )
    progress.admission = {
      steak: parseOutputSTEAK(event.steak),
      acceptedAt: outputU64(event.acceptedAt).toString(),
      assessmentContextId: outputString(event.assessmentContextId)
    }
    progress.status = 'admitted-delivery-pending'
  } else if (event.type === 'admission-rejected' || event.type === 'delivery-failed') {
    outputAssert(
      progress.status ===
        (event.type === 'admission-rejected' ? 'admission-pending' : 'admitted-delivery-pending'),
      'Purchase decision has no matching pending work',
      'conflict'
    )
    progress.decision = {
      reason: outputString(event.reason),
      policy: original.terms.body.releasePolicy,
      evidence: event.evidence,
      decidedAt: now.toString(),
      globalOutcome: 'unknown'
    }
    progress.status = event.type
  } else {
    outputAssert(
      progress.status === 'admitted-delivery-pending',
      'Purchase has no admitted delivery obligation',
      'conflict'
    )
    const envelope = verifyOutputPurchaseEnvelope(
        event.envelope,
        original.terms,
        progress.txid!,
        progress.purchaseCommitment
      ),
      result = envelope.result
    outputAssert(
      result.status === 'delivered' &&
        result.recoveryUntil === progress.recoveryUntil &&
        canonicalOutputJSON(result.steak) === canonicalOutputJSON(progress.admission!.steak),
      'Purchase delivery changed its retained admission',
      'conflict'
    )
    progress.status = 'delivered'
    progress.releaseEvidence = envelope.releaseEvidence!
    progress.delivery = {
      digest: digest(result.potatoes),
      issuedAt: result.potatoes.body.issuedAt,
      schema: result.potatoes.body.schema
    }
  }
  progress.updatedAt = now.toString()
  return parsePrivatePurchaseProgress(progress, original, profile)
}

/** Only supply delivered bytes loaded from the original protected result reservation. */
export function privatePurchaseEnvelope(
  progressInput: PrivatePurchaseProgress,
  original: PrivatePurchaseOriginal,
  delivered?: unknown,
  profile?: PrivatePurchaseCandidateProfile
): OutputPurchaseEnvelope {
  const progress = parsePrivatePurchaseProgress(progressInput, original, profile)
  if (progress.status !== 'delivered') {
    outputAssert(delivered === undefined, 'Pending purchase cannot disclose a private result')
    return response(progress)
  }
  outputAssert(delivered !== undefined, 'Original purchase delivery is unavailable', 'unavailable')
  const checked = verifyOutputPurchaseEnvelope(
      delivered,
      original.terms,
      progress.txid!,
      progress.purchaseCommitment
    ),
    result = checked.result
  outputAssert(
    result.status === 'delivered' &&
      digest(result.potatoes) === progress.delivery!.digest &&
      result.recoveryUntil === progress.recoveryUntil &&
      canonicalOutputJSON(result.steak) === canonicalOutputJSON(progress.admission!.steak) &&
      canonicalOutputJSON(checked.releaseEvidence) ===
        canonicalOutputJSON(progress.releaseEvidence),
    'Purchase delivery differs from its retained result',
    'unavailable'
  )
  return checked
}
