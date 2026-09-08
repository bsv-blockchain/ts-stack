import {
  admissionSemanticDigest,
  parseStorageOutputIndex,
  parseStorageUint64,
  type AdmissionCommit,
  type AdmissionCommitResult,
  type AdmissionOutboxIntent,
  type AdmissionOutpoint,
  type AdmissionPayloadRef,
  type AdmissionReceipt,
  type StorageScope
} from '../AdmissionStorage.js'

export type AdmissionRejectionCode = Extract<AdmissionCommitResult, { state: 'rejected' }>['code']

export class AdmissionRejectedError extends Error {
  readonly code: AdmissionRejectionCode

  constructor(code: AdmissionRejectionCode) {
    super(code)
    this.name = 'AdmissionRejectedError'
    this.code = code
  }
}

export const rejectAdmission = (code: AdmissionRejectionCode): never => {
  throw new AdmissionRejectedError(code)
}

const isHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

const isUint64 = (value: string): boolean => {
  try {
    parseStorageUint64(value)
    return true
  } catch {
    return false
  }
}

const isWireOutpoint = (outpoint: AdmissionOutpoint): boolean => {
  if (!isHash(outpoint.txid)) return false
  try {
    parseStorageOutputIndex(outpoint.outputIndex)
    return true
  } catch {
    return false
  }
}

export const sameScope = (left: StorageScope, right: StorageScope): boolean =>
  left.network === right.network &&
  left.genesisHash === right.genesisHash &&
  left.nodeId === right.nodeId

export const samePayload = (
  left: AdmissionPayloadRef | undefined,
  right: AdmissionPayloadRef
): boolean =>
  left !== undefined &&
  left.digest === right.digest &&
  left.byteLength === right.byteLength &&
  left.kind === right.kind

export const admissionPlanPayloads = (plan: AdmissionCommit): AdmissionPayloadRef[] => {
  const references = [...plan.payloads]
  for (const decision of plan.decisions) {
    for (const output of decision.outputs) references.push(output.script.payload)
    if (decision.applied.proof !== undefined) references.push(decision.applied.proof)
  }
  for (const intent of plan.outbox) references.push(...intent.payloads)
  return references
}

const isSteakEntry = (entry: unknown): entry is { outputsToAdmit: number[] } => {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const result = entry as Record<string, unknown>
  if (!Array.isArray(result.outputsToAdmit)) return false
  if (result.coinsToRetain !== undefined && !Array.isArray(result.coinsToRetain)) return false
  if (result.coinsRemoved !== undefined && !Array.isArray(result.coinsRemoved)) return false
  return !result.outputsToAdmit.some(
    value =>
      typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4294967295
  )
}

export const isBoundSteak = (plan: AdmissionCommit): boolean => {
  if (typeof plan.steak !== 'string' || !plan.steak.isWellFormed()) return false
  let steak: unknown
  try {
    steak = JSON.parse(plan.steak)
  } catch {
    return false
  }
  if (typeof steak !== 'object' || steak === null || Array.isArray(steak)) return false
  const record = steak as Record<string, unknown>
  for (const entry of Object.values(record)) {
    if (!isSteakEntry(entry)) return false
  }
  return plan.decisions.every(decision => {
    const entry = record[decision.topic]
    if (!isSteakEntry(entry)) return false
    try {
      const expected = decision.outputs.map(output => parseStorageOutputIndex(output.outputIndex))
      return JSON.stringify(entry.outputsToAdmit) === JSON.stringify(expected)
    } catch {
      return false
    }
  })
}

export const validateAdmissionPlan = (
  plan: AdmissionCommit
): AdmissionRejectionCode | undefined => {
  let semanticDigest: string
  try {
    semanticDigest = admissionSemanticDigest(plan.identity)
  } catch {
    return 'digest-mismatch'
  }
  if (
    plan.key.semanticDigest !== semanticDigest ||
    !sameScope(plan.key.scope, plan.identity.scope)
  ) {
    return 'digest-mismatch'
  }
  const topics = new Set(plan.identity.topics.map(item => item.topic))
  const decisionTopics = new Set(plan.decisions.map(decision => decision.topic))
  if (
    topics.size !== plan.identity.topics.length ||
    plan.decisions.length !== topics.size ||
    decisionTopics.size !== plan.decisions.length ||
    decisionTopics.size !== topics.size ||
    plan.decisions.some(decision => !topics.has(decision.topic)) ||
    new Set(plan.outbox.map(intent => intent.eventId)).size !== plan.outbox.length
  ) {
    return 'invalid-plan'
  }
  if (
    plan.identity.mode === 'historical' &&
    plan.outbox.some(intent => intent.kind === 'propagation')
  ) {
    return 'invalid-plan'
  }
  const payloads = admissionPlanPayloads(plan)
  if (
    payloads.some(
      ref => !isHash(ref.digest) || !isUint64(ref.byteLength) || ref.digest.length === 0
    )
  ) {
    return 'payload-not-ready'
  }
  if (!isBoundSteak(plan)) return 'invalid-plan'
  for (const intent of plan.outbox) {
    if (
      intent.eventId.length === 0 ||
      !intent.eventId.isWellFormed() ||
      intent.target.length === 0 ||
      !intent.target.isWellFormed() ||
      (intent.kind !== 'lookup' && intent.kind !== 'propagation')
    ) {
      return 'invalid-plan'
    }
  }
  for (const decision of plan.decisions) {
    if (
      !isUint64(decision.expectedHistory.chainEpoch) ||
      !isUint64(decision.expectedHistory.topicHistoryGeneration)
    ) {
      return 'invalid-plan'
    }
    if (
      decision.spends.some(
        spend => !isWireOutpoint(spend.outpoint) || spend.spender !== plan.identity.txid
      )
    ) {
      return 'invalid-plan'
    }
    if (decision.evictions.some(eviction => !isWireOutpoint(eviction))) return 'invalid-plan'
    if (
      decision.outputs.some(output => {
        if (output.txid !== plan.identity.txid || !isWireOutpoint(output)) return true
        if (
          ![output.satoshis, output.score, output.script.offset, output.script.byteLength].every(
            isUint64
          )
        ) {
          return true
        }
        if (!isHash(output.script.payload.digest) || !isUint64(output.script.payload.byteLength))
          return true
        return (
          parseStorageUint64(output.script.offset) + parseStorageUint64(output.script.byteLength) >
          parseStorageUint64(output.script.payload.byteLength)
        )
      })
    ) {
      return 'invalid-plan'
    }
    if (
      decision.edges.some(edge => !isWireOutpoint(edge.source) || !isWireOutpoint(edge.consumer))
    ) {
      return 'invalid-plan'
    }
    const applied = decision.applied
    if (applied.txid !== plan.identity.txid || !isHash(applied.txid)) return 'invalid-plan'
    if (applied.firstSeenHeight !== undefined && !isUint64(applied.firstSeenHeight))
      return 'invalid-plan'
    if (
      applied.proof !== undefined &&
      (!isHash(applied.proof.digest) || !isUint64(applied.proof.byteLength))
    ) {
      return 'invalid-plan'
    }
    if (
      applied.block !== undefined &&
      (![applied.block.height, applied.block.index].every(isUint64) ||
        !isHash(applied.block.hash) ||
        !isHash(applied.block.merkleRoot))
    ) {
      return 'invalid-plan'
    }
    if (decision.historyUpdate !== undefined) {
      if (
        !isUint64(decision.historyUpdate.nextTopicHistoryGeneration) ||
        !isUint64(decision.historyUpdate.affectedFromHeight) ||
        parseStorageUint64(decision.historyUpdate.nextTopicHistoryGeneration) <=
          parseStorageUint64(decision.expectedHistory.topicHistoryGeneration)
      ) {
        return 'invalid-plan'
      }
    }
  }
  return undefined
}

export const admissionReceiptFor = (
  plan: AdmissionCommit,
  enlistedTargets: readonly string[]
): AdmissionReceipt => {
  const enlisted = new Set(enlistedTargets)
  const lookupTargets = [
    ...new Set(plan.outbox.filter(intent => intent.kind === 'lookup').map(intent => intent.target))
  ]
  if (lookupTargets.some(target => enlisted.has(target))) rejectAdmission('invalid-plan')
  return {
    operationId: plan.key.operationId,
    semanticDigest: plan.key.semanticDigest,
    durability: 'atomic-local',
    steak: plan.steak,
    indexes: [
      ...enlistedTargets.map(target => ({ target, state: 'visible' as const })),
      ...lookupTargets.map(target => ({ target, state: 'pending' as const }))
    ],
    propagation: plan.outbox.some(intent => intent.kind === 'propagation')
      ? 'pending'
      : 'not-requested'
  }
}

export const lookupOutboxIntents = (plan: AdmissionCommit): AdmissionOutboxIntent[] =>
  plan.outbox.filter(intent => intent.kind === 'lookup')

export const propagationOutboxIntents = (plan: AdmissionCommit): AdmissionOutboxIntent[] =>
  plan.outbox.filter(intent => intent.kind === 'propagation')
