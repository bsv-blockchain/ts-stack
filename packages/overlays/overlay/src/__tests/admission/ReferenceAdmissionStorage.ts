import {
  admissionSemanticDigest,
  isReplaySafeProjection,
  parseStorageOutputIndex,
  parseStorageUint64,
  type AdmissionCommit,
  type AdmissionCommitResult,
  type AdmissionOperationKey,
  type AdmissionOutboxIntent,
  type AdmissionOutput,
  type AdmissionOutpoint,
  type AdmissionPayloadRef,
  type AdmissionReceipt,
  type AdmissionReconcileResult,
  type AdmissionStorage,
  type AdmissionTopicDecision,
  type HistoryFence,
  type ReplaySafeProjection,
  type StorageScope
} from '../../storage/AdmissionStorage.js'
import {
  isRecoveryLeaseCurrent,
  type HistoryRevisionHandoff,
  type RecoveryLease
} from '../../storage/RecoveryContract.js'

type StoredOutput = {
  version: string
  spentBy?: string
  topic?: string
  output?: AdmissionOutput
}

type SavedOperation = {
  semanticDigest: string
  receipt: AdmissionReceipt
}

type Attempt = {
  key: string
  semanticDigest: string
  state: 'unknown' | 'aborted'
}

type ReferenceState = {
  payloads: Map<string, AdmissionPayloadRef>
  pins: Set<string>
  reads: Map<string, string>
  fences: Map<string, HistoryFence>
  leases: Map<string, RecoveryLease>
  outputs: Map<string, StoredOutput>
  edges: Set<string>
  applied: Map<string, AdmissionTopicDecision['applied']>
  outbox: Map<string, AdmissionOutboxIntent>
  handoffs: Map<string, string>
  historyUpdates: Map<string, { affectedFromHeight: string; checkpoint?: string }>
  operations: Map<string, SavedOperation>
  attempts: Map<string, Attempt>
  nextAttempt: number
  nowMs: string
}

export interface AdmissionStorageTestSnapshot {
  payloads: Array<{ ref: AdmissionPayloadRef; pinned: boolean }>
  reads: Array<{ key: string; version: string }>
  fences: Array<{ topic: string; fence: HistoryFence }>
  leases: RecoveryLease[]
  outputs: Array<{
    key: string
    version: string
    spentBy?: string
    topic?: string
    output?: AdmissionOutput
  }>
  edges: string[]
  applied: Array<{ key: string; record: AdmissionTopicDecision['applied'] }>
  outbox: Array<{ scope: StorageScope; eventId: string }>
  handoffs: Array<{ topic: string; checkpoint: string }>
  historyUpdates: Array<{ topic: string; affectedFromHeight: string; checkpoint?: string }>
  operations: Array<{ key: string; semanticDigest: string }>
}

export interface AdmissionStorageFaults {
  /** The transaction commits, but the caller must reconcile its opaque attempt. */
  loseReplyAfterCommitOnce: () => void | Promise<void>
  /** The attempt becomes definitively aborted before any state is published. */
  abortBeforeCommitOnce: () => void | Promise<void>
}

export interface AdmissionStorageSeeds {
  readyPayload: (ref: AdmissionPayloadRef) => void | Promise<void>
  read: (scope: StorageScope, topic: string, key: string, version: string) => void | Promise<void>
  spendable: (
    scope: StorageScope,
    topic: string,
    outpoint: AdmissionOutpoint,
    version: string
  ) => void | Promise<void>
  history: (scope: StorageScope, topic: string, fence: HistoryFence) => void | Promise<void>
  lease: (lease: RecoveryLease) => void | Promise<void>
  now: (milliseconds: string) => void | Promise<void>
}

/**
 * Test harness shape that a durable adapter can implement to run the contract
 * suite. Snapshot data deliberately describes observable fixtures only; it is
 * not a persistence schema.
 */
export interface AdmissionStorageContractHarness {
  readonly storage: { admission?: AdmissionStorage }
  reset: () => void | Promise<void>
  restart: () => AdmissionStorage
  snapshot: () => AdmissionStorageTestSnapshot | Promise<AdmissionStorageTestSnapshot>
  readonly seed: AdmissionStorageSeeds
  readonly faults: AdmissionStorageFaults
}

export interface ReferenceAdmissionStorageOptions {
  /** A projection is only accepted when it declares replay/reconcile support. */
  projector?: unknown
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const scopeKey = (scope: StorageScope): string =>
  JSON.stringify([scope.network, scope.genesisHash, scope.nodeId])
const operationKey = (key: AdmissionOperationKey): string =>
  JSON.stringify([scopeKey(key.scope), key.operationId])
const topicKey = (scope: StorageScope, topic: string): string =>
  JSON.stringify([scopeKey(scope), topic])
const outputKey = (scope: StorageScope, topic: string, outpoint: AdmissionOutpoint): string =>
  JSON.stringify([scopeKey(scope), topic, outpoint.txid, outpoint.outputIndex])
const readKey = (scope: StorageScope, topic: string, key: string): string =>
  JSON.stringify([scopeKey(scope), topic, key])
const outboxKey = (scope: StorageScope, eventId: string): string =>
  JSON.stringify([scope.network, scope.genesisHash, scope.nodeId, eventId])
const leaseKey = (lease: RecoveryLease): string =>
  JSON.stringify([
    lease.scope.network,
    lease.scope.genesisHash,
    lease.scope.nodeId,
    lease.topic,
    lease.peerId,
    lease.jobId
  ])
const edgeKey = (
  scope: StorageScope,
  topic: string,
  source: AdmissionOutpoint,
  consumer: AdmissionOutpoint
): string =>
  JSON.stringify([scope.network, scope.genesisHash, scope.nodeId, topic, source, consumer])
const appliedKey = (scope: StorageScope, topic: string, txid: string): string =>
  JSON.stringify([scope.network, scope.genesisHash, scope.nodeId, topic, txid])
const sameScope = (left: StorageScope, right: StorageScope): boolean =>
  scopeKey(left) === scopeKey(right)
const sameFence = (left: HistoryFence | undefined, right: HistoryFence): boolean =>
  left?.chainEpoch === right.chainEpoch &&
  left.topicHistoryGeneration === right.topicHistoryGeneration
const samePayload = (left: AdmissionPayloadRef | undefined, right: AdmissionPayloadRef): boolean =>
  left !== undefined &&
  left.digest === right.digest &&
  left.byteLength === right.byteLength &&
  left.kind === right.kind
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

const newState = (): ReferenceState => ({
  payloads: new Map(),
  pins: new Set(),
  reads: new Map(),
  fences: new Map(),
  leases: new Map(),
  outputs: new Map(),
  edges: new Set(),
  applied: new Map(),
  outbox: new Map(),
  handoffs: new Map(),
  historyUpdates: new Map(),
  operations: new Map(),
  attempts: new Map(),
  nextAttempt: 1,
  nowMs: '0'
})

const copyState = (state: ReferenceState): ReferenceState => ({
  payloads: new Map([...state.payloads].map(([key, value]) => [key, clone(value)])),
  pins: new Set(state.pins),
  reads: new Map(state.reads),
  fences: new Map([...state.fences].map(([key, value]) => [key, clone(value)])),
  leases: new Map([...state.leases].map(([key, value]) => [key, clone(value)])),
  outputs: new Map([...state.outputs].map(([key, value]) => [key, clone(value)])),
  edges: new Set(state.edges),
  applied: new Map([...state.applied].map(([key, value]) => [key, clone(value)])),
  outbox: new Map([...state.outbox].map(([key, value]) => [key, clone(value)])),
  handoffs: new Map(state.handoffs),
  historyUpdates: new Map([...state.historyUpdates].map(([key, value]) => [key, clone(value)])),
  operations: new Map([...state.operations].map(([key, value]) => [key, clone(value)])),
  attempts: new Map([...state.attempts].map(([key, value]) => [key, clone(value)])),
  nextAttempt: state.nextAttempt,
  nowMs: state.nowMs
})

/**
 * A deliberately small in-memory model for admission-contract tests. It is
 * shared by instances to model restart replay, but proves neither database
 * durability nor crash recovery of a production adapter.
 */
export class ReferenceAdmissionStorage implements AdmissionStorage {
  readonly protocol = 'overlay-admission-v1' as const

  constructor(
    private readonly shared: { state: ReferenceState },
    private readonly faults: { loseReplyAfterCommit: boolean; abortBeforeCommit: boolean },
    private readonly options: ReferenceAdmissionStorageOptions = {}
  ) {}

  async commitAdmission(plan: AdmissionCommit): Promise<AdmissionCommitResult> {
    const semanticDigest = this.planSemanticDigest(plan)
    if (
      semanticDigest === undefined ||
      plan.key.semanticDigest !== semanticDigest ||
      !sameScope(plan.key.scope, plan.identity.scope)
    ) {
      return { state: 'rejected', code: 'digest-mismatch' }
    }

    const key = operationKey(plan.key)
    const active = this.shared.state.attempts.get(key)
    const saved = this.shared.state.operations.get(key)
    if (saved !== undefined && saved.semanticDigest !== semanticDigest) {
      return { state: 'rejected', code: 'digest-mismatch' }
    }
    if (active !== undefined) {
      return active.semanticDigest === semanticDigest
        ? { state: 'pending', attemptId: active.key }
        : { state: 'rejected', code: 'digest-mismatch' }
    }
    if (saved !== undefined) return { state: 'committed', receipt: clone(saved.receipt) }
    if (this.options.projector !== undefined && !isReplaySafeProjection(this.options.projector)) {
      return { state: 'rejected', code: 'unsupported-projection' }
    }

    if (this.faults.abortBeforeCommit) {
      this.faults.abortBeforeCommit = false
      const attemptId = this.newAttempt(key, semanticDigest, 'aborted')
      return { state: 'pending', attemptId }
    }

    const next = copyState(this.shared.state)
    const rejection = this.apply(next, plan)
    if (rejection !== undefined) return rejection

    const receipt = this.makeReceipt(plan)
    next.operations.set(key, { semanticDigest, receipt: clone(receipt) })
    const loseReply = this.faults.loseReplyAfterCommit
    this.faults.loseReplyAfterCommit = false
    if (loseReply) {
      const attemptId = `attempt-${next.nextAttempt++}`
      next.attempts.set(key, { key: attemptId, semanticDigest, state: 'unknown' })
      this.shared.state = next
      return { state: 'pending', attemptId }
    }

    this.shared.state = next
    return { state: 'committed', receipt: clone(receipt) }
  }

  async reconcileAdmission(
    key: AdmissionOperationKey,
    attemptId?: string
  ): Promise<AdmissionReconcileResult> {
    const recordKey = operationKey(key)
    const attempt = this.shared.state.attempts.get(recordKey)
    const saved = this.shared.state.operations.get(recordKey)
    if (saved !== undefined && saved.semanticDigest !== key.semanticDigest) {
      return { state: 'rejected', code: 'digest-mismatch' }
    }
    if (attempt === undefined) {
      if (saved !== undefined) return { state: 'committed', receipt: clone(saved.receipt) }
      const recoveredAttempt = this.newAttempt(recordKey, key.semanticDigest, 'unknown')
      return { state: 'pending', attemptId: recoveredAttempt }
    }
    if (attempt.semanticDigest !== key.semanticDigest)
      return { state: 'rejected', code: 'digest-mismatch' }
    if (attemptId !== undefined && attempt.key !== attemptId) {
      return { state: 'pending', attemptId: attempt.key }
    }
    if (attempt.state === 'aborted') {
      this.shared.state.attempts.delete(recordKey)
      return { state: 'aborted' }
    }
    if (saved === undefined) return { state: 'pending', attemptId: attempt.key }
    this.shared.state.attempts.delete(recordKey)
    return { state: 'committed', receipt: clone(saved.receipt) }
  }

  private planSemanticDigest(plan: AdmissionCommit): string | undefined {
    try {
      return admissionSemanticDigest(plan.identity)
    } catch {
      return undefined
    }
  }

  private newAttempt(key: string, semanticDigest: string, state: Attempt['state']): string {
    const attemptId = `attempt-${this.shared.state.nextAttempt++}`
    this.shared.state.attempts.set(key, { key: attemptId, semanticDigest, state })
    return attemptId
  }

  private apply(
    next: ReferenceState,
    plan: AdmissionCommit
  ): Extract<AdmissionCommitResult, { state: 'rejected' }> | undefined {
    const topics = new Set(plan.identity.topics.map(item => item.topic))
    const decisionTopics = new Set(plan.decisions.map(decision => decision.topic))
    if (
      topics.size !== plan.identity.topics.length ||
      plan.decisions.length !== topics.size ||
      decisionTopics.size !== plan.decisions.length ||
      decisionTopics.size !== topics.size ||
      plan.decisions.some(decision => !topics.has(decision.topic)) ||
      new Set(plan.outbox.map(intent => intent.eventId)).size !== plan.outbox.length ||
      plan.outbox.some(intent => next.outbox.has(outboxKey(plan.identity.scope, intent.eventId)))
    ) {
      return { state: 'rejected', code: 'invalid-plan' }
    }
    if (!this.isSupportedPlan(plan, next)) return { state: 'rejected', code: 'invalid-plan' }

    const references = this.references(plan)
    if (
      references === undefined ||
      references.some(ref => !samePayload(next.payloads.get(ref.digest), ref))
    ) {
      return { state: 'rejected', code: 'payload-not-ready' }
    }

    for (const decision of plan.decisions) {
      if (
        !sameFence(
          next.fences.get(topicKey(plan.identity.scope, decision.topic)),
          decision.expectedHistory
        )
      ) {
        return { state: 'rejected', code: 'read-conflict' }
      }
      if (
        decision.reads.some(
          read =>
            (next.reads.get(readKey(plan.identity.scope, decision.topic, read.key)) ?? null) !==
            read.expectedVersion
        )
      ) {
        return { state: 'rejected', code: 'read-conflict' }
      }
      if (
        decision.spends.some(
          spend =>
            next.outputs.get(outputKey(plan.identity.scope, decision.topic, spend.outpoint))
              ?.version !== spend.expectedVersion ||
            next.outputs.get(outputKey(plan.identity.scope, decision.topic, spend.outpoint))
              ?.spentBy !== undefined
        )
      ) {
        return { state: 'rejected', code: 'spend-conflict' }
      }
      if (
        decision.historyUpdate?.handoff !== undefined &&
        !this.canHandoff(
          next,
          plan.identity.scope,
          decision.topic,
          decision.expectedHistory,
          decision.historyUpdate.handoff
        )
      ) {
        return { state: 'rejected', code: 'read-conflict' }
      }
    }

    for (const reference of references) next.pins.add(reference.digest)
    for (const decision of plan.decisions) {
      for (const spend of decision.spends) {
        const stored = next.outputs.get(
          outputKey(plan.identity.scope, decision.topic, spend.outpoint)
        )
        if (stored !== undefined) stored.spentBy = spend.spender
      }
      for (const eviction of decision.evictions)
        next.outputs.delete(outputKey(plan.identity.scope, decision.topic, eviction))
      for (const output of decision.outputs) {
        const key = outputKey(plan.identity.scope, decision.topic, output)
        if (next.outputs.has(key)) return { state: 'rejected', code: 'invalid-plan' }
        next.outputs.set(key, { version: '1', topic: decision.topic, output: clone(output) })
      }
      for (const edge of decision.edges)
        next.edges.add(edgeKey(plan.identity.scope, decision.topic, edge.source, edge.consumer))
      next.applied.set(
        appliedKey(plan.identity.scope, decision.topic, decision.applied.txid),
        clone(decision.applied)
      )
      if (decision.historyUpdate !== undefined) {
        next.fences.set(topicKey(plan.identity.scope, decision.topic), {
          chainEpoch: decision.expectedHistory.chainEpoch,
          topicHistoryGeneration: decision.historyUpdate.nextTopicHistoryGeneration
        })
        if (decision.historyUpdate.handoff !== undefined) {
          const lease = next.leases.get(leaseKey(decision.historyUpdate.handoff.expected))
          if (lease !== undefined) {
            lease.topicHistoryGeneration = decision.historyUpdate.nextTopicHistoryGeneration
          }
          next.handoffs.set(
            topicKey(plan.identity.scope, decision.topic),
            decision.historyUpdate.handoff.checkpoint
          )
        }
        next.historyUpdates.set(topicKey(plan.identity.scope, decision.topic), {
          affectedFromHeight: decision.historyUpdate.affectedFromHeight,
          ...(decision.historyUpdate.handoff === undefined
            ? {}
            : { checkpoint: decision.historyUpdate.handoff.checkpoint })
        })
      }
    }
    for (const intent of plan.outbox)
      next.outbox.set(outboxKey(plan.identity.scope, intent.eventId), clone(intent))
    return undefined
  }

  private references(plan: AdmissionCommit): AdmissionPayloadRef[] | undefined {
    const references = [...plan.payloads]
    for (const decision of plan.decisions) {
      for (const output of decision.outputs) references.push(output.script.payload)
      if (decision.applied.proof !== undefined) references.push(decision.applied.proof)
    }
    for (const intent of plan.outbox) references.push(...intent.payloads)
    if (references.some(ref => ref.digest.length === 0 || ref.byteLength.length === 0))
      return undefined
    return references
  }

  private isSupportedPlan(statePlan: AdmissionCommit, state: ReferenceState): boolean {
    if (
      statePlan.identity.mode === 'historical' &&
      statePlan.outbox.some(intent => intent.kind === 'propagation')
    ) {
      return false
    }
    const payloads = this.references(statePlan)
    if (
      payloads === undefined ||
      payloads.some(ref => !isHash(ref.digest) || !isUint64(ref.byteLength))
    )
      return false
    if (!this.isBoundSteak(statePlan)) return false
    for (const decision of statePlan.decisions) {
      if (
        !isUint64(decision.expectedHistory.chainEpoch) ||
        !isUint64(decision.expectedHistory.topicHistoryGeneration)
      )
        return false
      if (
        decision.spends.some(
          spend => !isWireOutpoint(spend.outpoint) || spend.spender !== statePlan.identity.txid
        )
      )
        return false
      if (
        decision.evictions.some(
          eviction =>
            !isWireOutpoint(eviction) ||
            !state.outputs.has(outputKey(statePlan.identity.scope, decision.topic, eviction))
        )
      )
        return false
      if (
        decision.outputs.some(output => {
          if (output.txid !== statePlan.identity.txid || !isWireOutpoint(output)) return true
          if (
            ![output.satoshis, output.score, output.script.offset, output.script.byteLength].every(
              isUint64
            )
          )
            return true
          if (!isHash(output.script.payload.digest) || !isUint64(output.script.payload.byteLength))
            return true
          return (
            parseStorageUint64(output.script.offset) +
              parseStorageUint64(output.script.byteLength) >
            parseStorageUint64(output.script.payload.byteLength)
          )
        })
      )
        return false
      if (
        decision.edges.some(edge => !isWireOutpoint(edge.source) || !isWireOutpoint(edge.consumer))
      )
        return false
      const applied = decision.applied
      if (
        applied.txid !== statePlan.identity.txid ||
        !isHash(applied.txid) ||
        state.applied.has(appliedKey(statePlan.identity.scope, decision.topic, applied.txid))
      )
        return false
      if (
        (applied.firstSeenHeight !== undefined && !isUint64(applied.firstSeenHeight)) ||
        (applied.proof !== undefined &&
          (!isHash(applied.proof.digest) || !isUint64(applied.proof.byteLength))) ||
        (applied.block !== undefined &&
          (![applied.block.height, applied.block.index].every(isUint64) ||
            !isHash(applied.block.hash) ||
            !isHash(applied.block.merkleRoot)))
      )
        return false
      if (decision.historyUpdate !== undefined) {
        if (
          !isUint64(decision.historyUpdate.nextTopicHistoryGeneration) ||
          !isUint64(decision.historyUpdate.affectedFromHeight) ||
          parseStorageUint64(decision.historyUpdate.nextTopicHistoryGeneration) <=
            parseStorageUint64(decision.expectedHistory.topicHistoryGeneration)
        )
          return false
      }
    }
    return true
  }

  private isBoundSteak(plan: AdmissionCommit): boolean {
    let steak: unknown
    try {
      steak = JSON.parse(plan.steak)
    } catch {
      return false
    }
    if (typeof steak !== 'object' || steak === null || Array.isArray(steak)) return false
    const record = steak as Record<string, unknown>
    if (Object.keys(record).length !== plan.decisions.length) return false
    return plan.decisions.every(decision => {
      const entry = record[decision.topic]
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
      const result = entry as Record<string, unknown>
      if (!decision.outputs.every(isWireOutpoint)) return false
      const admitted = decision.outputs.map(output => parseStorageOutputIndex(output.outputIndex))
      return (
        Array.isArray(result.outputsToAdmit) &&
        Array.isArray(result.coinsToRetain) &&
        Array.isArray(result.coinsRemoved) &&
        JSON.stringify(result.outputsToAdmit) === JSON.stringify(admitted) &&
        result.coinsToRetain.length === 0 &&
        result.coinsRemoved.length === 0
      )
    })
  }

  private canHandoff(
    state: ReferenceState,
    scope: StorageScope,
    topic: string,
    expectedHistory: HistoryFence,
    handoff: HistoryRevisionHandoff
  ): boolean {
    const lease = handoff.expected
    const current = state.leases.get(leaseKey(lease))
    return (
      current !== undefined &&
      sameScope(lease.scope, scope) &&
      lease.topic === topic &&
      sameFence(current, expectedHistory) &&
      isRecoveryLeaseCurrent(lease, current, state.nowMs)
    )
  }

  private makeReceipt(plan: AdmissionCommit): AdmissionReceipt {
    const lookupTargets = [
      ...new Set(
        plan.outbox.filter(intent => intent.kind === 'lookup').map(intent => intent.target)
      )
    ]
    return {
      operationId: plan.key.operationId,
      semanticDigest: plan.key.semanticDigest,
      durability: 'atomic-local',
      steak: plan.steak,
      indexes: lookupTargets.map(target => ({ target, state: 'pending' as const })),
      propagation: plan.outbox.some(intent => intent.kind === 'propagation')
        ? 'pending'
        : 'not-requested'
    }
  }
}

export class ReferenceAdmissionHarness implements AdmissionStorageContractHarness {
  private readonly shared = { state: newState() }
  private readonly faultState = { loseReplyAfterCommit: false, abortBeforeCommit: false }
  private readonly options: ReferenceAdmissionStorageOptions
  readonly seed: AdmissionStorageSeeds
  readonly faults: AdmissionStorageFaults

  constructor(options: ReferenceAdmissionStorageOptions = {}) {
    this.options = options
    this.seed = {
      readyPayload: ref => {
        this.shared.state.payloads.set(ref.digest, clone(ref))
      },
      read: (scope, topic, key, version) => {
        this.shared.state.reads.set(readKey(scope, topic, key), version)
      },
      spendable: (scope, topic, outpoint, version) => {
        this.shared.state.outputs.set(outputKey(scope, topic, outpoint), { version })
      },
      history: (scope, topic, fence) => {
        this.shared.state.fences.set(topicKey(scope, topic), clone(fence))
      },
      lease: lease => {
        this.shared.state.leases.set(leaseKey(lease), clone(lease))
      },
      now: milliseconds => {
        this.shared.state.nowMs = milliseconds
      }
    }
    this.faults = {
      loseReplyAfterCommitOnce: () => {
        this.faultState.loseReplyAfterCommit = true
      },
      abortBeforeCommitOnce: () => {
        this.faultState.abortBeforeCommit = true
      }
    }
  }

  get storage(): { admission: AdmissionStorage } {
    return { admission: this.restart() }
  }

  restart(): AdmissionStorage {
    return new ReferenceAdmissionStorage(this.shared, this.faultState, this.options)
  }

  reset(): void {
    this.shared.state = newState()
    this.faultState.loseReplyAfterCommit = false
    this.faultState.abortBeforeCommit = false
  }

  snapshot(): AdmissionStorageTestSnapshot {
    const state = this.shared.state
    return {
      payloads: [...state.payloads.values()].map(ref => ({
        ref: clone(ref),
        pinned: state.pins.has(ref.digest)
      })),
      reads: [...state.reads].map(([key, version]) => ({ key, version })),
      fences: [...state.fences].map(([key, fence]) => ({
        topic: JSON.parse(key)[1] as string,
        fence: clone(fence)
      })),
      leases: [...state.leases.values()].map(lease => clone(lease)),
      outputs: [...state.outputs].map(([key, output]) => ({ key, ...clone(output) })),
      edges: [...state.edges].sort(),
      applied: [...state.applied].map(([key, record]) => ({ key, record: clone(record) })),
      outbox: [...state.outbox.keys()].map(key => {
        const [network, genesisHash, nodeId, eventId] = JSON.parse(key) as [
          string,
          string,
          string,
          string
        ]
        return { scope: { network, genesisHash, nodeId }, eventId }
      }),
      handoffs: [...state.handoffs].map(([key, checkpoint]) => ({
        topic: JSON.parse(key)[1] as string,
        checkpoint
      })),
      historyUpdates: [...state.historyUpdates].map(([key, update]) => ({
        topic: JSON.parse(key)[1] as string,
        ...clone(update)
      })),
      operations: [...state.operations].map(([key, operation]) => ({
        key,
        semanticDigest: operation.semanticDigest
      }))
    }
  }
}

/** The shared fixture scope used by the bounded reference harness. */
export const referenceScope: StorageScope = {
  network: 'testnet',
  genesisHash: '11'.repeat(32),
  nodeId: 'reference-node'
}

export const replaySafeProjection = (): ReplaySafeProjection => ({
  protocol: 'overlay-projection-v1',
  applyEvent: async (_scope, _intent) => ({ checkpoint: 'checkpoint' }),
  reconcile: async (_scope, _checkpoint) => ({ checkpoint: 'checkpoint' })
})
