import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Collection, Db, Document } from 'mongodb'
import {
  admissionSemanticDigest,
  asStorageUint64,
  isReplaySafeProjection,
  type AdmissionCommit,
  type AdmissionCommitResult,
  type AdmissionOperationKey,
  type AdmissionOutboxIntent,
  type AdmissionOutpoint,
  type AdmissionPayloadRef,
  type AdmissionReconcileResult,
  type AdmissionStorage,
  type AdmissionTopicDecision,
  type StorageScope
} from '../AdmissionStorage.js'
import type { RecoveryLease } from '../RecoveryContract.js'
import {
  AdmissionRejectedError,
  admissionPlanPayloads,
  admissionReceiptFor,
  lookupOutboxIntents,
  propagationOutboxIntents,
  rejectAdmission,
  sameScope,
  validateAdmissionPlan
} from './MongoAdmissionPlan.js'
import { MongoPayloadStore, type MongoPayloadKind } from './MongoPayloadStore.js'
import { MongoReadGuardConflictError, MongoReadGuards } from './MongoReadGuards.js'
import {
  MongoCollectionNames,
  encodeMongoOutputIndex,
  encodeMongoUint64,
  decodeMongoUint64,
  mongoChainKey,
  mongoNodeKey,
  mongoRecordKey
} from './MongoSchema.js'
import {
  MongoTransactionRunner,
  type MongoTransactionContext,
  type MongoTransactionOptions
} from './MongoTransactionRunner.js'

export interface MongoEnlistedLookupIndex {
  readonly protocol: 'overlay-mongo-index-v1'
  readonly target: string
  apply: (context: MongoTransactionContext, plan: AdmissionCommit) => Promise<void>
}

export interface MongoAdmissionStorageOptions {
  runner?: MongoTransactionRunner
  payloads?: MongoPayloadStore
  readGuards?: MongoReadGuards
  enlistedIndexes?: MongoEnlistedLookupIndex[]
  projector?: unknown
}

export interface MongoOutboxLease {
  eventId: string
  kind: 'lookup' | 'propagation'
  target: string
  payloads: AdmissionPayloadRef[]
}

interface OutputDocument extends Document {
  _id: string
  topic: string
  txid: string
  outputIndex: string
  satoshis: string
  score: string
  scriptPayloadId: string
  scriptOffset: string
  scriptByteLength: string
  state: 'unspent' | 'spent' | 'evicted'
  spender?: string
  version: string
}

interface AppliedDocument extends Document {
  _id: string
  topic: string
  txid: string
  state: 'active' | 'unproven' | 'evicted'
  admissionId: string
  firstSeenHeight?: string
  proofPayloadId?: string
}

interface GenerationDocument extends Document {
  _id: string
  topic: string
  chainEpoch: string
  topicHistoryGeneration: string
  policyId: string
}

interface JobDocument extends Document {
  _id: string
  topic: string
  peerId: string
  jobId: string
  chainEpoch: string
  topicHistoryGeneration: string
  leaseToken: string
  leaseUntil: Date
  state: string
  checkpoint: string
}

interface OutboxDocument extends Document {
  _id: string
  eventId: string
  target: string
  state: string
  nextAttemptAt?: Date
  leaseUntil?: Date
}

interface IdDocument extends Document {
  _id: string
  [key: string]: unknown
}

const majority = { w: 'majority' as const, j: true }
const schemaVersion = 1

const duplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

const isPayloadKind = (value: string): value is MongoPayloadKind =>
  value === 'raw-transaction' ||
  value === 'merkle-path' ||
  value === 'beef-manifest' ||
  value === 'locking-script' ||
  value === 'outbox-data'

/**
 * Opt-in Mongo AdmissionStorage. Engine submit uses this only when
 * getAdmissionStorage(storage) observes overlay-admission-v1.
 */
export class MongoAdmissionStorage implements AdmissionStorage {
  readonly protocol = 'overlay-admission-v1' as const
  readonly scope: StorageScope
  private readonly runner: MongoTransactionRunner
  private readonly payloads: MongoPayloadStore
  private readonly guards: MongoReadGuards
  private readonly enlisted: MongoEnlistedLookupIndex[]
  private readonly projector: unknown
  private readonly peers = new Map<string, MongoAdmissionStorage>()

  constructor(
    private readonly db: Db,
    scope: StorageScope,
    options: MongoAdmissionStorageOptions = {}
  ) {
    this.scope = { ...scope }
    this.runner = options.runner ?? new MongoTransactionRunner(db, this.scope)
    this.payloads = options.payloads ?? new MongoPayloadStore(db, this.scope)
    this.guards = options.readGuards ?? new MongoReadGuards(db)
    this.enlisted = [...(options.enlistedIndexes ?? [])]
    this.projector = options.projector
    if (
      this.enlisted.some(
        index => index.protocol !== 'overlay-mongo-index-v1' || index.target.length === 0
      )
    ) {
      throw new Error('Invalid enlisted Mongo lookup index')
    }
    if (new Set(this.enlisted.map(index => index.target)).size !== this.enlisted.length) {
      throw new Error('Duplicate enlisted Mongo lookup index target')
    }
  }

  enlistedTargets(): string[] {
    return this.enlisted.map(index => index.target)
  }

  async commitAdmission(plan: AdmissionCommit): Promise<AdmissionCommitResult> {
    if (!sameScope(plan.key.scope, this.scope) || !sameScope(plan.identity.scope, this.scope)) {
      return await this.peerFor(plan.key.scope).commitAdmission(plan)
    }
    let semanticDigest: string
    try {
      semanticDigest = admissionSemanticDigest(plan.identity)
    } catch {
      return { state: 'rejected', code: 'digest-mismatch' }
    }
    if (
      plan.key.semanticDigest !== semanticDigest ||
      !sameScope(plan.key.scope, plan.identity.scope)
    ) {
      return { state: 'rejected', code: 'digest-mismatch' }
    }
    if (this.projector !== undefined && !isReplaySafeProjection(this.projector)) {
      return { state: 'rejected', code: 'unsupported-projection' }
    }
    const existing = await this.runner.reconcile(plan.key)
    if (existing.state === 'committed' || existing.state === 'rejected') return existing
    if (existing.state === 'pending' && existing.attemptId !== 'unlocated') {
      const waited = await this.waitForPending(plan.key, existing.attemptId)
      if (waited.state === 'committed' || waited.state === 'rejected') return waited
    }
    const rejected = validateAdmissionPlan(plan)
    if (rejected !== undefined) return { state: 'rejected', code: rejected }
    let receipt
    try {
      receipt = admissionReceiptFor(plan, this.enlistedTargets())
    } catch (error) {
      return this.asResult(error)
    }
    await this.prepareReadGuards(plan)
    await this.publishHistoryUpdatePayloads(plan)
    try {
      const result = await this.runner.run(
        { key: plan.key, identity: plan.identity, receipt },
        async context => {
          await this.applyPlan(context, plan)
        }
      )
      if (result.state !== 'pending') return result
      return await this.waitForPending(plan.key, result.attemptId)
    } catch (error) {
      return this.asResult(error)
    }
  }

  private async waitForPending(
    key: AdmissionOperationKey,
    attemptId: string
  ): Promise<AdmissionCommitResult> {
    let current: AdmissionCommitResult = { state: 'pending', attemptId }
    for (let index = 0; index < 50 && current.state === 'pending'; index += 1) {
      await delay(20)
      const reconciled = await this.runner.reconcile(
        key,
        current.state === 'pending' ? current.attemptId : attemptId
      )
      if (reconciled.state === 'committed' || reconciled.state === 'rejected') return reconciled
      if (reconciled.state === 'aborted') {
        return { state: 'pending', attemptId }
      }
      current = reconciled
    }
    return current
  }

  async reconcileAdmission(
    key: AdmissionOperationKey,
    attemptId?: string,
    options: MongoTransactionOptions = {}
  ): Promise<AdmissionReconcileResult> {
    if (!sameScope(key.scope, this.scope))
      return await this.peerFor(key.scope).reconcileAdmission(key, attemptId, options)
    return await this.runner.reconcile(key, attemptId, options)
  }

  async close(): Promise<void> {
    await Promise.all([
      this.runner.close(),
      ...[...this.peers.values()].map(async peer => await peer.close())
    ])
  }

  private peerFor(scope: StorageScope): MongoAdmissionStorage {
    const id = mongoNodeKey(scope)
    const existing = this.peers.get(id)
    if (existing !== undefined) return existing
    const peer = new MongoAdmissionStorage(this.db, scope, {
      enlistedIndexes: this.enlisted,
      projector: this.projector
    })
    this.peers.set(id, peer)
    return peer
  }

  async claimOutbox(
    kind: 'lookup' | 'propagation',
    leaseMS = 15_000
  ): Promise<MongoOutboxLease | null> {
    if (!Number.isSafeInteger(leaseMS) || leaseMS < 1 || leaseMS > 60_000) {
      throw new Error('Invalid Mongo outbox lease')
    }
    const claimed = await this.outbox(kind).findOneAndUpdate(
      {
        network: this.scope.network,
        genesisHash: this.scope.genesisHash,
        nodeId: this.scope.nodeId,
        $or: [{ state: 'pending' }, { state: 'leased', $expr: { $lte: ['$leaseUntil', '$$NOW'] } }]
      },
      [
        {
          $set: {
            state: 'leased',
            leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: leaseMS } },
            nextAttemptAt: {
              $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: leaseMS }
            },
            updatedAt: '$$NOW'
          }
        }
      ],
      { returnDocument: 'after', writeConcern: majority }
    )
    if (claimed === null) return null
    return {
      eventId: claimed.eventId,
      kind,
      target: claimed.target,
      payloads: await this.outboxPayloads(kind, claimed.eventId)
    }
  }

  async acknowledgeOutbox(kind: 'lookup' | 'propagation', eventId: string): Promise<void> {
    const result = await this.outbox(kind).updateOne(
      {
        _id: this.outboxId(kind, eventId),
        eventId,
        state: { $in: ['leased', 'delivered'] }
      },
      { $set: { state: 'delivered', updatedAt: new Date() } },
      { writeConcern: majority }
    )
    if (result.matchedCount !== 1) throw new Error('Mongo outbox event is not leased')
  }

  private asResult(error: unknown): AdmissionCommitResult {
    if (error instanceof AdmissionRejectedError) return { state: 'rejected', code: error.code }
    if (error instanceof MongoReadGuardConflictError)
      return { state: 'rejected', code: 'read-conflict' }
    if (error instanceof Error && error.message === 'Mongo payload is not ready for reference') {
      return { state: 'rejected', code: 'payload-not-ready' }
    }
    throw error
  }

  private async prepareReadGuards(plan: AdmissionCommit): Promise<void> {
    for (const decision of plan.decisions) {
      for (const read of decision.reads) await this.guards.initialize(this.scope, read.key)
    }
  }

  private async publishHistoryUpdatePayloads(plan: AdmissionCommit): Promise<void> {
    for (const decision of plan.decisions) {
      if (decision.historyUpdate === undefined) continue
      const bytes = Buffer.from(JSON.stringify(this.historyUpdateRecord(decision)), 'utf8')
      const digest = createHash('sha256').update(bytes).digest('hex')
      await this.payloads.publish({
        kind: 'outbox-data',
        digest,
        byteLength: String(bytes.byteLength),
        bytes: (async function* () {
          yield bytes
        })()
      })
    }
  }

  private historyUpdateRecord(decision: AdmissionTopicDecision): {
    affectedFromHeight: string
    checkpoint?: string
  } {
    if (decision.historyUpdate === undefined) return { affectedFromHeight: '0' }
    return {
      affectedFromHeight: decision.historyUpdate.affectedFromHeight,
      ...(decision.historyUpdate.handoff === undefined
        ? {}
        : { checkpoint: decision.historyUpdate.handoff.checkpoint })
    }
  }

  private async applyPlan(context: MongoTransactionContext, plan: AdmissionCommit): Promise<void> {
    await this.assertReadyPayloads(context, plan)
    for (const decision of plan.decisions) {
      await this.checkReads(context, decision)
      await this.checkHistory(context, decision)
      await this.assertAppliedAvailable(context, plan, decision)
    }
    for (const intent of plan.outbox) await this.assertOutboxAvailable(context, intent)
    for (const decision of plan.decisions) {
      for (const spend of decision.spends) await this.applySpend(context, decision.topic, spend)
      for (const eviction of decision.evictions)
        await this.applyEviction(context, decision.topic, eviction)
      for (const output of decision.outputs) await this.insertOutput(context, decision, output)
      for (const edge of decision.edges) await this.insertEdge(context, decision.topic, edge)
      await this.insertApplied(context, plan, decision)
      await this.applyHistoryUpdate(
        context,
        decision,
        plan.identity.topics.find(item => item.topic === decision.topic)?.policyId ?? 'default'
      )
    }
    await this.upsertTransaction(context, plan)
    for (const ref of admissionPlanPayloads(plan)) {
      await this.pin(context, ref, 'transaction', plan.identity.txid, `${ref.kind}:${ref.digest}`)
    }
    for (const intent of lookupOutboxIntents(plan))
      await this.insertOutbox(context, 'lookup', intent)
    for (const intent of propagationOutboxIntents(plan)) {
      await this.insertOutbox(context, 'propagation', intent)
    }
    for (const index of this.enlisted) await index.apply(context, plan)
  }

  private async assertReadyPayloads(
    context: MongoTransactionContext,
    plan: AdmissionCommit
  ): Promise<void> {
    const seen = new Set<string>()
    for (const ref of admissionPlanPayloads(plan)) {
      const id = this.payloadId(ref)
      if (seen.has(id)) continue
      seen.add(id)
      const found = await this.db
        .collection<IdDocument>(MongoCollectionNames.payloads)
        .findOne({ _id: id, state: 'ready', digest: ref.digest, kind: ref.kind }, context.options())
      if (found === null || decodeMongoUint64(String(found.byteLength)) !== ref.byteLength) {
        rejectAdmission('payload-not-ready')
      }
    }
  }

  private async checkReads(
    context: MongoTransactionContext,
    decision: AdmissionTopicDecision
  ): Promise<void> {
    for (const read of decision.reads) {
      const options = context.options()
      await this.guards.check(
        options.session,
        { scope: this.scope, key: read.key, expectedVersion: read.expectedVersion },
        { timeoutMS: options.timeoutMS, signal: context.signal }
      )
    }
  }

  private async checkHistory(
    context: MongoTransactionContext,
    decision: AdmissionTopicDecision
  ): Promise<void> {
    const document = await this.generations().findOne(
      { _id: this.generationId(decision.topic) },
      context.options()
    )
    const epoch = document === null ? '0' : decodeMongoUint64(document.chainEpoch)
    const generation = document === null ? '0' : decodeMongoUint64(document.topicHistoryGeneration)
    if (
      epoch !== decision.expectedHistory.chainEpoch ||
      generation !== decision.expectedHistory.topicHistoryGeneration
    ) {
      rejectAdmission('read-conflict')
    }
  }

  private async assertAppliedAvailable(
    context: MongoTransactionContext,
    plan: AdmissionCommit,
    decision: AdmissionTopicDecision
  ): Promise<void> {
    const existing = await this.applied().findOne(
      { _id: this.appliedId(decision.topic, decision.applied.txid) },
      context.options()
    )
    if (existing !== null && existing.admissionId !== plan.key.operationId) {
      rejectAdmission('invalid-plan')
    }
  }

  private async assertOutboxAvailable(
    context: MongoTransactionContext,
    intent: AdmissionOutboxIntent
  ): Promise<void> {
    const existing = await this.outbox(intent.kind).findOne(
      { _id: this.outboxId(intent.kind, intent.eventId) },
      context.options()
    )
    if (existing !== null) rejectAdmission('invalid-plan')
  }

  private async applySpend(
    context: MongoTransactionContext,
    topic: string,
    spend: { outpoint: AdmissionOutpoint; expectedVersion: string; spender: string }
  ): Promise<void> {
    const id = this.outputId(topic, spend.outpoint)
    const result = await this.outputs().findOneAndUpdate(
      {
        _id: id,
        version: spend.expectedVersion,
        state: 'unspent'
      },
      {
        $set: {
          state: 'spent',
          spender: spend.spender,
          updatedAt: new Date()
        }
      },
      { ...context.options(), returnDocument: 'after' }
    )
    if (result === null) {
      const current = await this.outputs().findOne({ _id: id }, context.options())
      if (current?.spender === spend.spender && current.state === 'spent') return
      rejectAdmission('spend-conflict')
    }
  }

  private async applyEviction(
    context: MongoTransactionContext,
    topic: string,
    eviction: AdmissionOutpoint
  ): Promise<void> {
    const id = this.outputId(topic, eviction)
    const result = await this.outputs().updateOne(
      { _id: id },
      { $set: { state: 'evicted', updatedAt: new Date() } },
      context.options()
    )
    if (result.matchedCount !== 1) rejectAdmission('invalid-plan')
  }

  private async insertOutput(
    context: MongoTransactionContext,
    decision: AdmissionTopicDecision,
    output: AdmissionTopicDecision['outputs'][number]
  ): Promise<void> {
    const now = new Date()
    const payloadId = this.payloadId(output.script.payload)
    try {
      await this.outputs().insertOne(
        {
          _id: this.outputId(decision.topic, output),
          schemaVersion,
          network: this.scope.network,
          genesisHash: this.scope.genesisHash,
          nodeId: this.scope.nodeId,
          topic: decision.topic,
          txid: output.txid,
          outputIndex: encodeMongoOutputIndex(output.outputIndex),
          satoshis: encodeMongoUint64(output.satoshis),
          score: encodeMongoUint64(output.score),
          scriptPayloadId: payloadId,
          scriptOffset: encodeMongoUint64(output.script.offset),
          scriptByteLength: encodeMongoUint64(output.script.byteLength),
          state: 'unspent',
          version: '1',
          createdAt: now,
          updatedAt: now
        },
        context.options()
      )
    } catch (error) {
      if (duplicateKey(error)) rejectAdmission('invalid-plan')
      throw error
    }
    await this.pin(
      context,
      output.script.payload,
      'output',
      this.outputId(decision.topic, output),
      'script'
    )
  }

  private async insertEdge(
    context: MongoTransactionContext,
    topic: string,
    edge: { source: AdmissionOutpoint; consumer: AdmissionOutpoint }
  ): Promise<void> {
    const now = new Date()
    const id = mongoRecordKey(
      mongoNodeKey(this.scope),
      'edge',
      topic,
      edge.source.txid,
      encodeMongoOutputIndex(edge.source.outputIndex),
      edge.consumer.txid,
      encodeMongoOutputIndex(edge.consumer.outputIndex)
    )
    await this.db.collection<IdDocument>(MongoCollectionNames.consumptionEdges).updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          schemaVersion,
          network: this.scope.network,
          genesisHash: this.scope.genesisHash,
          nodeId: this.scope.nodeId,
          topic,
          sourceTxid: edge.source.txid,
          sourceOutputIndex: encodeMongoOutputIndex(edge.source.outputIndex),
          consumerTxid: edge.consumer.txid,
          consumerOutputIndex: encodeMongoOutputIndex(edge.consumer.outputIndex),
          createdAt: now
        },
        $set: { updatedAt: now }
      },
      { upsert: true, ...context.options() }
    )
  }

  private async insertApplied(
    context: MongoTransactionContext,
    plan: AdmissionCommit,
    decision: AdmissionTopicDecision
  ): Promise<void> {
    const now = new Date()
    const proven = decision.applied.block !== undefined
    try {
      await this.applied().insertOne(
        {
          _id: this.appliedId(decision.topic, decision.applied.txid),
          schemaVersion,
          network: this.scope.network,
          genesisHash: this.scope.genesisHash,
          nodeId: this.scope.nodeId,
          topic: decision.topic,
          txid: decision.applied.txid,
          state: proven ? 'active' : 'unproven',
          admissionId: plan.key.operationId,
          ...(decision.applied.firstSeenHeight === undefined
            ? {}
            : { firstSeenHeight: encodeMongoUint64(decision.applied.firstSeenHeight) }),
          ...(decision.applied.proof === undefined
            ? {}
            : { proofPayloadId: this.payloadId(decision.applied.proof) }),
          createdAt: now,
          updatedAt: now
        },
        context.options()
      )
    } catch (error) {
      if (duplicateKey(error)) rejectAdmission('invalid-plan')
      throw error
    }
    if (decision.applied.proof !== undefined) {
      await this.pin(
        context,
        decision.applied.proof,
        'applied-history',
        this.appliedId(decision.topic, decision.applied.txid),
        'proof'
      )
    }
  }

  private async applyHistoryUpdate(
    context: MongoTransactionContext,
    decision: AdmissionTopicDecision,
    policyId: string
  ): Promise<void> {
    if (decision.historyUpdate === undefined) return
    const now = new Date()
    const next = decision.historyUpdate.nextTopicHistoryGeneration
    const updated = await this.generations().findOneAndUpdate(
      {
        _id: this.generationId(decision.topic),
        chainEpoch: encodeMongoUint64(decision.expectedHistory.chainEpoch),
        topicHistoryGeneration: encodeMongoUint64(decision.expectedHistory.topicHistoryGeneration)
      },
      {
        $set: {
          topicHistoryGeneration: encodeMongoUint64(next),
          policyId,
          updatedAt: now
        }
      },
      { ...context.options(), returnDocument: 'after' }
    )
    if (updated === null) {
      if (
        decision.expectedHistory.chainEpoch !== '0' ||
        decision.expectedHistory.topicHistoryGeneration !== '0'
      ) {
        rejectAdmission('read-conflict')
      }
      try {
        await this.generations().insertOne(
          {
            _id: this.generationId(decision.topic),
            schemaVersion,
            network: this.scope.network,
            genesisHash: this.scope.genesisHash,
            nodeId: this.scope.nodeId,
            topic: decision.topic,
            chainEpoch: encodeMongoUint64(decision.expectedHistory.chainEpoch),
            topicHistoryGeneration: encodeMongoUint64(next),
            policyId,
            createdAt: now,
            updatedAt: now
          },
          context.options()
        )
      } catch (error) {
        if (duplicateKey(error)) rejectAdmission('read-conflict')
        throw error
      }
    }
    if (decision.historyUpdate.handoff !== undefined) {
      await this.applyHandoff(context, decision, decision.historyUpdate.handoff.expected, next)
    }
    const bytes = Buffer.from(JSON.stringify(this.historyUpdateRecord(decision)), 'utf8')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const ref: AdmissionPayloadRef = {
      kind: 'outbox-data',
      digest,
      byteLength: asStorageUint64(String(bytes.byteLength))
    }
    const payload = await this.db
      .collection<IdDocument>(MongoCollectionNames.payloads)
      .findOne({ _id: this.payloadId(ref), state: 'ready' }, context.options())
    if (payload === null) rejectAdmission('payload-not-ready')
    await this.replaceHistoryPin(
      context,
      decision.topic,
      decision.expectedHistory.topicHistoryGeneration,
      next,
      ref
    )
  }

  private historyUpdateSlot(generation: string): string {
    return `history-update:${generation}`
  }

  private async replaceHistoryPin(
    context: MongoTransactionContext,
    topic: string,
    previousGeneration: string,
    nextGeneration: string,
    ref: AdmissionPayloadRef
  ): Promise<void> {
    const previousSlot = this.historyUpdateSlot(previousGeneration)
    const previous = await this.db
      .collection<IdDocument>(MongoCollectionNames.payloadReferences)
      .findOne(
        {
          network: this.scope.network,
          genesisHash: this.scope.genesisHash,
          nodeId: this.scope.nodeId,
          ownerKind: 'basm-job',
          ownerId: topic,
          slot: previousSlot
        },
        context.options()
      )
    if (previous !== null) {
      const previousPayload = await this.db
        .collection<IdDocument>(MongoCollectionNames.payloads)
        .findOne({ _id: String(previous.payloadId) }, context.options())
      if (
        previousPayload !== null &&
        isPayloadKind(String(previousPayload.kind)) &&
        typeof previousPayload.digest === 'string'
      ) {
        const options = context.options()
        await this.payloads.releaseReference(
          options.session,
          {
            scope: this.scope,
            payload: {
              kind: previousPayload.kind as MongoPayloadKind,
              digest: previousPayload.digest
            },
            ownerKind: 'basm-job',
            ownerId: topic,
            slot: previousSlot
          },
          { timeoutMS: options.timeoutMS, signal: context.signal }
        )
      }
    }
    await this.pin(context, ref, 'basm-job', topic, this.historyUpdateSlot(nextGeneration))
  }

  private async applyHandoff(
    context: MongoTransactionContext,
    decision: AdmissionTopicDecision,
    expected: RecoveryLease,
    nextGeneration: string
  ): Promise<void> {
    if (
      !sameScope(expected.scope, this.scope) ||
      expected.topic !== decision.topic ||
      expected.chainEpoch !== decision.expectedHistory.chainEpoch ||
      expected.topicHistoryGeneration !== decision.expectedHistory.topicHistoryGeneration
    ) {
      rejectAdmission('read-conflict')
    }
    const now = new Date()
    const result = await this.jobs().findOneAndUpdate(
      {
        _id: this.jobId(expected),
        topic: expected.topic,
        peerId: expected.peerId,
        jobId: expected.jobId,
        chainEpoch: encodeMongoUint64(expected.chainEpoch),
        topicHistoryGeneration: encodeMongoUint64(expected.topicHistoryGeneration),
        leaseToken: encodeMongoUint64(expected.leaseToken),
        $expr: { $gt: ['$leaseUntil', '$$NOW'] }
      },
      {
        $set: {
          topicHistoryGeneration: encodeMongoUint64(nextGeneration),
          checkpoint: decision.historyUpdate?.handoff?.checkpoint ?? expected.jobId,
          updatedAt: now
        }
      },
      { ...context.options(), returnDocument: 'after' }
    )
    if (result === null) rejectAdmission('read-conflict')
  }

  private async upsertTransaction(
    context: MongoTransactionContext,
    plan: AdmissionCommit
  ): Promise<void> {
    const raw = plan.payloads.find(ref => ref.kind === 'raw-transaction')
    const manifest = plan.payloads.find(ref => ref.kind === 'beef-manifest')
    const now = new Date()
    const id = mongoRecordKey(mongoChainKey(this.scope), 'transaction', plan.identity.txid)
    await this.db.collection<IdDocument>(MongoCollectionNames.transactions).updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          schemaVersion,
          network: this.scope.network,
          genesisHash: this.scope.genesisHash,
          txid: plan.identity.txid,
          ...(raw === undefined ? {} : { rawPayloadId: this.payloadId(raw) }),
          ...(manifest === undefined ? {} : { manifestPayloadId: this.payloadId(manifest) }),
          createdAt: now
        },
        $set: { updatedAt: now }
      },
      { upsert: true, ...context.options() }
    )
  }

  private async insertOutbox(
    context: MongoTransactionContext,
    kind: 'lookup' | 'propagation',
    intent: AdmissionOutboxIntent
  ): Promise<void> {
    const now = new Date()
    try {
      await this.outbox(kind).insertOne(
        {
          _id: this.outboxId(kind, intent.eventId),
          schemaVersion,
          network: this.scope.network,
          genesisHash: this.scope.genesisHash,
          nodeId: this.scope.nodeId,
          eventId: intent.eventId,
          target: intent.target,
          state: 'pending',
          nextAttemptAt: now,
          leaseUntil: new Date(0),
          createdAt: now,
          updatedAt: now
        },
        context.options()
      )
    } catch (error) {
      if (duplicateKey(error)) rejectAdmission('invalid-plan')
      throw error
    }
    for (const [index, payload] of intent.payloads.entries()) {
      await this.pin(context, payload, `${kind}-outbox`, intent.eventId, String(index))
    }
  }

  private async pin(
    context: MongoTransactionContext,
    ref: AdmissionPayloadRef,
    ownerKind:
      | 'transaction'
      | 'applied-history'
      | 'output'
      | 'gasp-graph'
      | 'gasp-node'
      | 'basm-job'
      | 'lookup-outbox'
      | 'propagation-outbox'
      | 'manifest'
      | 'pin',
    ownerId: string,
    slot: string
  ): Promise<void> {
    if (!isPayloadKind(ref.kind)) rejectAdmission('invalid-plan')
    const options = context.options()
    try {
      await this.payloads.addReference(
        options.session,
        {
          scope: this.scope,
          payload: { kind: ref.kind, digest: ref.digest },
          ownerKind,
          ownerId,
          slot
        },
        { timeoutMS: options.timeoutMS, signal: context.signal }
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'Mongo payload is not ready for reference') {
        rejectAdmission('payload-not-ready')
      }
      throw error
    }
  }

  private async outboxPayloads(
    kind: 'lookup' | 'propagation',
    eventId: string
  ): Promise<AdmissionPayloadRef[]> {
    const refs = await this.db
      .collection<IdDocument>(MongoCollectionNames.payloadReferences)
      .find({
        network: this.scope.network,
        genesisHash: this.scope.genesisHash,
        nodeId: this.scope.nodeId,
        ownerKind: `${kind}-outbox`,
        ownerId: eventId
      })
      .sort({ slot: 1 })
      .toArray()
    const result: AdmissionPayloadRef[] = []
    for (const reference of refs) {
      const payload = await this.db
        .collection<IdDocument>(MongoCollectionNames.payloads)
        .findOne({ _id: String(reference.payloadId) })
      if (payload === null || !isPayloadKind(payload.kind as string)) continue
      result.push({
        kind: payload.kind as MongoPayloadKind,
        digest: payload.digest as string,
        byteLength: decodeMongoUint64(payload.byteLength as string)
      })
    }
    return result
  }

  payloadId(ref: Pick<AdmissionPayloadRef, 'kind' | 'digest'>): string {
    return mongoRecordKey(mongoChainKey(this.scope), ref.kind, ref.digest)
  }

  outputId(topic: string, outpoint: AdmissionOutpoint): string {
    return mongoRecordKey(
      mongoNodeKey(this.scope),
      'output',
      topic,
      outpoint.txid,
      encodeMongoOutputIndex(outpoint.outputIndex)
    )
  }

  private appliedId(topic: string, txid: string): string {
    return mongoRecordKey(mongoNodeKey(this.scope), 'applied', topic, txid)
  }

  generationId(topic: string): string {
    return mongoRecordKey(mongoNodeKey(this.scope), 'generation', topic)
  }

  jobId(lease: Pick<RecoveryLease, 'topic' | 'peerId' | 'jobId'>): string {
    return mongoRecordKey(mongoNodeKey(this.scope), 'job', lease.topic, lease.peerId, lease.jobId)
  }

  outboxId(kind: 'lookup' | 'propagation', eventId: string): string {
    return mongoRecordKey(mongoNodeKey(this.scope), `${kind}-outbox`, eventId)
  }

  private outputs(): Collection<OutputDocument> {
    return this.db.collection<OutputDocument>(MongoCollectionNames.outputs)
  }

  private applied(): Collection<AppliedDocument> {
    return this.db.collection<AppliedDocument>(MongoCollectionNames.appliedTransactions)
  }

  generations(): Collection<GenerationDocument> {
    return this.db.collection<GenerationDocument>(MongoCollectionNames.topicGenerations)
  }

  jobs(): Collection<JobDocument> {
    return this.db.collection<JobDocument>(MongoCollectionNames.basmRecoveryJobs)
  }

  outbox(kind: 'lookup' | 'propagation'): Collection<OutboxDocument> {
    return this.db.collection<OutboxDocument>(
      kind === 'lookup' ? MongoCollectionNames.lookupOutbox : MongoCollectionNames.propagationOutbox
    )
  }
}
