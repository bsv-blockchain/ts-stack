import { randomUUID } from 'node:crypto'
import { Binary } from 'mongodb'
import {
  type AdmissionCommitResult,
  type AdmissionOperationKey,
  type AdmissionOutpoint,
  type AdmissionPayloadRef,
  type AdmissionReconcileResult,
  type AdmissionStorage,
  type StorageScope
} from '../../storage/AdmissionStorage.js'
import type { RecoveryLease } from '../../storage/RecoveryContract.js'
import type {
  AdmissionStorageContractHarness,
  AdmissionStorageFaults,
  AdmissionStorageSeeds,
  AdmissionStorageTestSnapshot
} from '../admission/ReferenceAdmissionStorage.js'
import { MongoAdmissionStorage } from '../../storage/mongo/MongoAdmissionStorage.js'
import { MongoReadGuards } from '../../storage/mongo/MongoReadGuards.js'
import {
  MongoCollectionNames,
  decodeMongoUint64,
  encodeMongoOutputIndex,
  encodeMongoUint64,
  mongoChainKey,
  mongoNodeKey,
  mongoRecordKey
} from '../../storage/mongo/MongoSchema.js'
import type { MongoReplicaFixture } from './MongoReplicaFixture.js'
import { referenceScope } from '../admission/ReferenceAdmissionStorage.js'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const scopeKey = (scope: StorageScope): string =>
  JSON.stringify([scope.network, scope.genesisHash, scope.nodeId])
const operationKey = (key: AdmissionOperationKey): string =>
  JSON.stringify([scopeKey(key.scope), key.operationId])
const outputKey = (scope: StorageScope, topic: string, outpoint: AdmissionOutpoint): string =>
  JSON.stringify([scopeKey(scope), topic, outpoint.txid, outpoint.outputIndex])
const appliedKey = (scope: StorageScope, topic: string, txid: string): string =>
  JSON.stringify([scope.network, scope.genesisHash, scope.nodeId, topic, txid])
const edgeKey = (
  scope: StorageScope,
  topic: string,
  source: AdmissionOutpoint,
  consumer: AdmissionOutpoint
): string =>
  JSON.stringify([scope.network, scope.genesisHash, scope.nodeId, topic, source, consumer])

class FaultAdmission implements AdmissionStorage {
  readonly protocol = 'overlay-admission-v1' as const
  inner: AdmissionStorage
  loseReply = false
  abortBefore = false
  unresolved = new Map<string, { attemptId: string; aborted: boolean }>()

  constructor(inner: AdmissionStorage) {
    this.inner = inner
  }

  async commitAdmission(
    plan: Parameters<AdmissionStorage['commitAdmission']>[0]
  ): Promise<AdmissionCommitResult> {
    const key = operationKey(plan.key)
    const active = this.unresolved.get(key)
    if (active !== undefined) return { state: 'pending', attemptId: active.attemptId }
    if (this.abortBefore) {
      this.abortBefore = false
      const attemptId = randomUUID()
      this.unresolved.set(key, { attemptId, aborted: true })
      return { state: 'pending', attemptId }
    }
    const result = await this.inner.commitAdmission(plan)
    if (this.loseReply && result.state === 'committed') {
      this.loseReply = false
      const attemptId = randomUUID()
      this.unresolved.set(key, { attemptId, aborted: false })
      return { state: 'pending', attemptId }
    }
    return result
  }

  async reconcileAdmission(
    key: AdmissionOperationKey,
    attemptId?: string
  ): Promise<AdmissionReconcileResult> {
    const record = this.unresolved.get(operationKey(key))
    if (record !== undefined) {
      if (attemptId !== undefined && attemptId !== record.attemptId) {
        return { state: 'pending', attemptId: record.attemptId }
      }
      this.unresolved.delete(operationKey(key))
      if (record.aborted) return { state: 'aborted' }
      return await this.inner.reconcileAdmission(key, attemptId)
    }
    return await this.inner.reconcileAdmission(key, attemptId)
  }
}

export class MongoAdmissionHarness implements AdmissionStorageContractHarness {
  private inner: MongoAdmissionStorage
  private readonly wrapper: FaultAdmission
  private readonly leases = new Map<string, RecoveryLease>()
  private readonly seededPayloads = new Set<string>()
  readonly seed: AdmissionStorageSeeds
  readonly faults: AdmissionStorageFaults

  constructor(private readonly fixture: MongoReplicaFixture) {
    this.inner = new MongoAdmissionStorage(fixture.db, referenceScope)
    this.wrapper = new FaultAdmission(this.inner)
    this.seed = {
      readyPayload: async ref => {
        this.seededPayloads.add(`${ref.kind}:${ref.digest}`)
        await this.insertReadyPayload(ref)
      },
      read: async (scope, _topic, key, version) => {
        const guards = new MongoReadGuards(this.fixture.db)
        await guards.initialize(scope, key)
        await this.fixture.db
          .collection(MongoCollectionNames.readGuards)
          .updateOne(
            { _id: mongoRecordKey(mongoNodeKey(scope), 'read-guard', key) },
            { $set: { version, updatedAt: new Date() } }
          )
      },
      spendable: async (scope, topic, outpoint, version) => {
        await this.insertSpendable(scope, topic, outpoint, version)
      },
      history: async (scope, topic, fence) => {
        await this.insertHistory(scope, topic, fence)
      },
      lease: async lease => {
        this.leases.set(`${lease.topic}:${lease.peerId}:${lease.jobId}`, clone(lease))
        await this.insertLease(lease)
      },
      now: () => undefined
    }
    this.faults = {
      loseReplyAfterCommitOnce: () => {
        this.wrapper.loseReply = true
      },
      abortBeforeCommitOnce: () => {
        this.wrapper.abortBefore = true
      }
    }
  }

  get storage(): { admission: AdmissionStorage } {
    return { admission: this.wrapper }
  }

  restart(): AdmissionStorage {
    this.inner = new MongoAdmissionStorage(this.fixture.db, referenceScope)
    this.wrapper.inner = this.inner
    return this.wrapper
  }

  async reset(): Promise<void> {
    this.wrapper.loseReply = false
    this.wrapper.abortBefore = false
    this.wrapper.unresolved.clear()
    this.leases.clear()
    this.seededPayloads.clear()
    await this.inner.close().catch(() => undefined)
    for (const name of Object.values(MongoCollectionNames)) {
      if (name === MongoCollectionNames.schema) continue
      await this.fixture.db.collection(name).deleteMany({})
    }
    await this.fixture.db.collection('enlisted_index').deleteMany({})
    this.inner = new MongoAdmissionStorage(this.fixture.db, referenceScope)
    this.wrapper.inner = this.inner
  }

  async snapshot(): Promise<AdmissionStorageTestSnapshot> {
    const payloads = await this.fixture.db
      .collection(MongoCollectionNames.payloads)
      .find()
      .toArray()
    const refs = await this.fixture.db
      .collection(MongoCollectionNames.payloadReferences)
      .find()
      .toArray()
    const pinned = new Set(refs.map(item => item.payloadId as string))
    const reads = await this.fixture.db.collection(MongoCollectionNames.readGuards).find().toArray()
    const fences = await this.fixture.db
      .collection(MongoCollectionNames.topicGenerations)
      .find()
      .toArray()
    const jobs = await this.fixture.db
      .collection(MongoCollectionNames.basmRecoveryJobs)
      .find()
      .toArray()
    const outputs = await this.fixture.db.collection(MongoCollectionNames.outputs).find().toArray()
    const edges = await this.fixture.db
      .collection(MongoCollectionNames.consumptionEdges)
      .find()
      .toArray()
    const applied = await this.fixture.db
      .collection(MongoCollectionNames.appliedTransactions)
      .find()
      .toArray()
    const lookup = await this.fixture.db
      .collection(MongoCollectionNames.lookupOutbox)
      .find()
      .toArray()
    const propagation = await this.fixture.db
      .collection(MongoCollectionNames.propagationOutbox)
      .find()
      .toArray()
    const historyRefs = refs.filter(item => item.slot === 'history-update')
    const historyUpdates = []
    for (const reference of historyRefs) {
      const payload = payloads.find(item => item._id === reference.payloadId)
      const bytes =
        payload?.inlineData instanceof Binary
          ? Buffer.from(payload.inlineData.buffer)
          : Buffer.alloc(0)
      const parsed = JSON.parse(bytes.toString('utf8')) as {
        affectedFromHeight: string
        checkpoint?: string
      }
      historyUpdates.push({ topic: reference.ownerId as string, ...parsed })
    }
    return {
      payloads: payloads
        .filter(
          item =>
            this.seededPayloads.has(`${item.kind}:${item.digest}`) || pinned.has(item._id as string)
        )
        .map(item => ({
          ref: {
            kind: item.kind,
            digest: item.digest,
            byteLength: decodeMongoUint64(item.byteLength as string)
          } as AdmissionPayloadRef,
          pinned: pinned.has(item._id as string)
        })),
      reads: reads
        .filter(item => item.version !== null)
        .map(item => ({
          key: JSON.stringify([scopeKey(this.scopeOf(item)), '', item.key]),
          version: item.version as string
        })),
      fences: fences.map(item => ({
        topic: item.topic as string,
        fence: {
          chainEpoch: decodeMongoUint64(item.chainEpoch as string),
          topicHistoryGeneration: decodeMongoUint64(item.topicHistoryGeneration as string)
        }
      })),
      leases: jobs.map(job => {
        const seeded = this.leases.get(`${job.topic}:${job.peerId}:${job.jobId}`)
        const base = seeded ?? {
          scope: this.scopeOf(job),
          topic: job.topic as string,
          peerId: job.peerId as string,
          jobId: job.jobId as string,
          leaseToken: decodeMongoUint64(job.leaseToken as string),
          expiresAtMs: String((job.leaseUntil as Date).getTime()),
          chainEpoch: decodeMongoUint64(job.chainEpoch as string),
          topicHistoryGeneration: decodeMongoUint64(job.topicHistoryGeneration as string)
        }
        return {
          ...base,
          topicHistoryGeneration: decodeMongoUint64(job.topicHistoryGeneration as string)
        }
      }),
      outputs: outputs.map(item => {
        const outpoint = { txid: item.txid as string, outputIndex: item.outputIndex as string }
        const topic = item.topic as string
        const scope = this.scopeOf(item)
        return {
          key: outputKey(scope, topic, outpoint),
          version: item.version as string,
          ...(item.spender === undefined ? {} : { spentBy: item.spender as string }),
          topic,
          ...(item.state === 'unspent'
            ? {
                output: {
                  txid: item.txid as string,
                  outputIndex: item.outputIndex as string,
                  satoshis: decodeMongoUint64(item.satoshis as string),
                  score: decodeMongoUint64(item.score as string),
                  script: {
                    payload: {
                      digest: '00'.repeat(32),
                      byteLength: '0',
                      kind: 'locking-script' as const
                    },
                    offset: decodeMongoUint64(item.scriptOffset as string),
                    byteLength: decodeMongoUint64(item.scriptByteLength as string)
                  }
                }
              }
            : {})
        }
      }),
      edges: edges
        .map(item =>
          edgeKey(
            this.scopeOf(item),
            item.topic as string,
            { txid: item.sourceTxid as string, outputIndex: item.sourceOutputIndex as string },
            { txid: item.consumerTxid as string, outputIndex: item.consumerOutputIndex as string }
          )
        )
        .sort(),
      applied: applied.map(item => ({
        key: appliedKey(this.scopeOf(item), item.topic as string, item.txid as string),
        record: { txid: item.txid as string }
      })),
      outbox: [
        ...lookup.map(item => ({ scope: this.scopeOf(item), eventId: item.eventId as string })),
        ...propagation.map(item => ({ scope: this.scopeOf(item), eventId: item.eventId as string }))
      ],
      handoffs: jobs
        .filter(item => typeof item.checkpoint === 'string' && item.checkpoint.length > 0)
        .map(item => ({ topic: item.topic as string, checkpoint: item.checkpoint as string })),
      historyUpdates,
      operations: []
    }
  }

  get adapter(): MongoAdmissionStorage {
    return this.inner
  }

  private scopeOf(document: {
    network?: unknown
    genesisHash?: unknown
    nodeId?: unknown
  }): StorageScope {
    return {
      network: document.network as string,
      genesisHash: document.genesisHash as string,
      nodeId: document.nodeId as string
    }
  }

  private async insertReadyPayload(ref: AdmissionPayloadRef): Promise<void> {
    const now = new Date()
    const id = mongoRecordKey(mongoChainKey(this.fixture.scope), ref.kind, ref.digest)
    try {
      await this.fixture.db.collection(MongoCollectionNames.payloads).insertOne({
        _id: id,
        schemaVersion: 1,
        network: this.fixture.scope.network,
        genesisHash: this.fixture.scope.genesisHash,
        kind: ref.kind,
        digest: ref.digest,
        byteLength: encodeMongoUint64(ref.byteLength),
        state: 'ready',
        guard: randomUUID(),
        ownerNodeId: this.fixture.scope.nodeId,
        ownerId: randomUUID(),
        fencingToken: encodeMongoUint64('1'),
        leaseUntil: now,
        createdAt: now,
        updatedAt: now
      })
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)
        return
      throw error
    }
  }

  private async insertSpendable(
    scope: StorageScope,
    topic: string,
    outpoint: AdmissionOutpoint,
    version: string
  ): Promise<void> {
    const now = new Date()
    const id = mongoRecordKey(
      mongoNodeKey(scope),
      'output',
      topic,
      outpoint.txid,
      encodeMongoOutputIndex(outpoint.outputIndex)
    )
    try {
      await this.fixture.db.collection(MongoCollectionNames.outputs).insertOne({
        _id: id,
        schemaVersion: 1,
        network: scope.network,
        genesisHash: scope.genesisHash,
        nodeId: scope.nodeId,
        topic,
        txid: outpoint.txid,
        outputIndex: encodeMongoOutputIndex(outpoint.outputIndex),
        satoshis: encodeMongoUint64('1'),
        score: encodeMongoUint64('1'),
        scriptPayloadId: mongoRecordKey(mongoChainKey(scope), 'locking-script', 'bb'.repeat(32)),
        scriptOffset: encodeMongoUint64('0'),
        scriptByteLength: encodeMongoUint64('1'),
        state: 'unspent',
        version,
        createdAt: now,
        updatedAt: now
      })
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        await this.fixture.db
          .collection(MongoCollectionNames.outputs)
          .updateOne({ _id: id }, { $set: { version, state: 'unspent', updatedAt: now } })
        return
      }
      throw error
    }
  }

  private async insertHistory(
    scope: StorageScope,
    topic: string,
    fence: { chainEpoch: string; topicHistoryGeneration: string }
  ): Promise<void> {
    const now = new Date()
    const id = mongoRecordKey(mongoNodeKey(scope), 'generation', topic)
    await this.fixture.db.collection(MongoCollectionNames.topicGenerations).updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          schemaVersion: 1,
          network: scope.network,
          genesisHash: scope.genesisHash,
          nodeId: scope.nodeId,
          topic,
          policyId: 'policy-1',
          createdAt: now
        },
        $set: {
          chainEpoch: encodeMongoUint64(fence.chainEpoch),
          topicHistoryGeneration: encodeMongoUint64(fence.topicHistoryGeneration),
          updatedAt: now
        }
      },
      { upsert: true }
    )
  }

  private async insertLease(lease: RecoveryLease): Promise<void> {
    const now = new Date()
    const id = mongoRecordKey(
      mongoNodeKey(lease.scope),
      'job',
      lease.topic,
      lease.peerId,
      lease.jobId
    )
    await this.fixture.db.collection(MongoCollectionNames.basmRecoveryJobs).updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          schemaVersion: 1,
          network: lease.scope.network,
          genesisHash: lease.scope.genesisHash,
          nodeId: lease.scope.nodeId,
          topic: lease.topic,
          peerId: lease.peerId,
          jobId: lease.jobId,
          createdAt: now
        },
        $set: {
          chainEpoch: encodeMongoUint64(lease.chainEpoch),
          topicHistoryGeneration: encodeMongoUint64(lease.topicHistoryGeneration),
          leaseToken: encodeMongoUint64(lease.leaseToken),
          leaseUntil: new Date(Date.now() + 60 * 60 * 1000),
          state: 'leased',
          checkpoint: lease.jobId,
          updatedAt: now
        }
      },
      { upsert: true }
    )
  }
}
