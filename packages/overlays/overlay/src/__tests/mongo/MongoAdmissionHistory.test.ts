import { Binary } from 'mongodb'
import {
  admissionSemanticDigest,
  getAdmissionHistory,
  type AdmissionCommit,
  type AdmissionHistoryQuery
} from '../../storage/AdmissionStorage.js'
import { MongoAdmissionStorage } from '../../storage/mongo/MongoAdmissionStorage.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { MongoTransactionRunner } from '../../storage/mongo/MongoTransactionRunner.js'
import { admissionReceiptFor } from '../../storage/mongo/MongoAdmissionPlan.js'
import {
  bootstrapMongoOverlay,
  MongoCollectionNames,
  mongoNodeKey,
  mongoRecordKey
} from '../../storage/mongo/MongoSchema.js'
import { admissionPlan } from '../admission/AdmissionStorageContract.js'
import { referenceScope } from '../admission/ReferenceAdmissionStorage.js'
import { MongoAdmissionHarness } from './MongoAdmissionHarness.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

// Jest provides the same test object to native ESM through import.meta.
const jest = import.meta.jest

const operationKey = (plan: AdmissionCommit) =>
  mongoRecordKey(
    'operation',
    referenceScope.network,
    referenceScope.genesisHash,
    referenceScope.nodeId,
    plan.key.operationId
  )
const appliedKey = (topic: string, txid: string) =>
  mongoRecordKey(mongoNodeKey(referenceScope), 'applied', topic, txid)
const queryFor = (plan: AdmissionCommit): AdmissionHistoryQuery => ({
  scope: structuredClone(plan.identity.scope),
  txid: plan.identity.txid,
  topic: plan.identity.topics[0].topic,
  policyId: plan.identity.topics[0].policyId,
  contextDigest: plan.identity.contextDigest
})

describe('retained admission history on a real three-member replica set', () => {
  let fixture: MongoReplicaFixture
  let harness: MongoAdmissionHarness
  let adapter: MongoAdmissionStorage
  const runners: MongoTransactionRunner[] = []

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, referenceScope)
    harness = new MongoAdmissionHarness(fixture)
  }, 120000)
  beforeEach(async () => {
    await harness.reset()
    adapter = new MongoAdmissionStorage(fixture.db, referenceScope, {
      retainAdmissionHistory: true
    })
  })
  afterEach(async () => {
    await adapter.close()
  })
  afterAll(async () => {
    await Promise.all(runners.map(async runner => await runner.close()))
    await harness.adapter.close()
    await fixture.close()
  }, 60000)

  async function seed(plan: AdmissionCommit): Promise<void> {
    for (const decision of plan.decisions) {
      await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
      for (const read of decision.reads) {
        if (read.expectedVersion !== null)
          await harness.seed.read(
            plan.identity.scope,
            decision.topic,
            read.key,
            read.expectedVersion
          )
      }
      for (const spend of decision.spends)
        await harness.seed.spendable(
          plan.identity.scope,
          decision.topic,
          spend.outpoint,
          spend.expectedVersion
        )
    }
    for (const payload of plan.payloads) await harness.seed.readyPayload(payload)
  }

  test('advertises only explicit retention and refuses invalid configuration', async () => {
    const legacy = new MongoOverlayStorage(fixture.db, referenceScope)
    const enabled = new MongoOverlayStorage(fixture.db, referenceScope, {
      retainAdmissionHistory: true
    })
    expect(getAdmissionHistory(legacy)).toBeUndefined()
    expect(getAdmissionHistory(enabled)?.protocol).toBe('overlay-admission-history-v1')
    expect(
      () =>
        new MongoAdmissionStorage(fixture.db, referenceScope, {
          retainAdmissionHistory: 'yes' as never
        })
    ).toThrow('retention option')
    await legacy.close()
    await enabled.close()
  })

  test('recovers the original multi-topic receipt after restart, eviction and changed history', async () => {
    const plan = structuredClone(admissionPlan('retained-multi'))
    plan.identity.mode = 'historical'
    plan.outbox = plan.outbox.filter(item => item.kind !== 'propagation')
    plan.identity.topics.push({ topic: 'tm_second', policyId: 'policy-2' })
    const second = structuredClone(plan.decisions[0])
    second.topic = 'tm_second'
    plan.decisions.push(second)
    plan.key.semanticDigest = admissionSemanticDigest(plan.identity)
    const steak = JSON.parse(plan.steak)
    steak.tm_second = steak.tm_contract
    // A duplicate topic in STEAK is deliberately not in this commit's identity.
    steak.tm_previous = { outputsToAdmit: [], coinsToRetain: [], coinsRemoved: [] }
    plan.steak = JSON.stringify(steak)
    await seed(plan)
    const result = await adapter.commitAdmission(plan)
    expect(result.state).toBe('committed')
    if (result.state !== 'committed') throw new Error('expected committed admission')
    expect(result.receipt).toEqual(admissionReceiptFor(plan, []))
    expect(result.receipt).not.toHaveProperty('admissionHistory')
    expect(result.receipt).not.toHaveProperty('acceptedAt')
    const committed = await fixture.db
      .collection(MongoCollectionNames.submissionOperations)
      .findOne({ _id: operationKey(plan) })
    const acceptedAt = String(Math.floor(committed!.updatedAt.getTime() / 1000))
    const before = await harness.snapshot()
    await adapter.close()
    adapter = new MongoAdmissionStorage(fixture.db, referenceScope, {
      retainAdmissionHistory: true
    })
    await fixture.db
      .collection(MongoCollectionNames.appliedTransactions)
      .updateMany({}, { $set: { state: 'evicted' } })
    await fixture.db
      .collection(MongoCollectionNames.outputs)
      .updateMany({}, { $set: { state: 'spent' } })
    await harness.seed.history(referenceScope, 'tm_contract', {
      chainEpoch: '8' as never,
      topicHistoryGeneration: '4' as never
    })
    const expected = {
      state: 'committed',
      admission: { identity: plan.identity, receipt: result.receipt, acceptedAt }
    }
    expect(await adapter.history!.read(queryFor(plan))).toEqual(expected)
    expect(await adapter.commitAdmission(plan)).toEqual(result)
    expect(
      (await fixture.db
        .collection(MongoCollectionNames.submissionOperations)
        .findOne({ _id: operationKey(plan) }))!.updatedAt
    ).toEqual(committed!.updatedAt)
    expect(
      await adapter.history!.read({ ...queryFor(plan), topic: 'tm_second', policyId: 'policy-2' })
    ).toEqual(expected)
    const read = await adapter.history!.read(queryFor(plan))
    if (read.state !== 'committed') throw new Error('expected retained history')
    read.admission.identity.topics[0].topic = 'mutated'
    expect(await adapter.history!.read(queryFor(plan))).toEqual(expected)
    expect((await harness.snapshot()).outbox).toEqual(before.outbox)
    // The collection validators and schema fingerprint still accept an ordinary bootstrap.
    await bootstrapMongoOverlay(fixture.db, referenceScope)
    for (const change of [
      { txid: '44'.repeat(32) },
      { topic: 'tm_absent' },
      { policyId: 'other' },
      { contextDigest: '55'.repeat(32) }
    ]) {
      expect(await adapter.history!.read({ ...queryFor(plan), ...change })).toEqual({
        state: 'unresolved'
      })
    }
    // Even a retained legacy applied pointer cannot turn a duplicate STEAK key
    // into a topic covered by this operation's semantic identity.
    const applied = await fixture.db
      .collection(MongoCollectionNames.appliedTransactions)
      .findOne({ _id: appliedKey('tm_contract', plan.identity.txid) })
    await fixture.db.collection(MongoCollectionNames.appliedTransactions).insertOne({
      ...applied!,
      _id: appliedKey('tm_previous', plan.identity.txid),
      topic: 'tm_previous'
    })
    expect(await adapter.history!.read({ ...queryFor(plan), topic: 'tm_previous' })).toEqual({
      state: 'unresolved'
    })
  })

  test('leaves legacy receipt bytes untouched even on retry after retention is enabled', async () => {
    const plan = admissionPlan('legacy')
    await seed(plan)
    const result = await harness.adapter.commitAdmission(plan)
    const operations = fixture.db.collection(MongoCollectionNames.submissionOperations)
    const before = await operations.findOne({ _id: operationKey(plan) })
    expect(before?.receipt).toBeInstanceOf(Binary)
    expect(await adapter.history!.read(queryFor(plan))).toEqual({ state: 'unresolved' })
    expect(await adapter.commitAdmission(plan)).toEqual(result)
    const after = await operations.findOne({ _id: operationKey(plan) })
    expect(after?.receipt).toEqual(before?.receipt)
    expect(await adapter.history!.read(queryFor(plan))).toEqual({ state: 'unresolved' })
  })

  test('does not interpret pending or missing operation history as a failed or successful admission', async () => {
    const plan = admissionPlan('pending')
    await seed(plan)
    await adapter.commitAdmission(plan)
    const operations = fixture.db.collection(MongoCollectionNames.submissionOperations)
    await operations.updateOne({ _id: operationKey(plan) }, { $set: { state: 'pending' } })
    expect(await adapter.history!.read(queryFor(plan))).toEqual({ state: 'unresolved' })
    expect((await operations.findOne({ _id: operationKey(plan) }))?.state).toBe('pending')
    await operations.deleteOne({ _id: operationKey(plan) })
    expect(await adapter.history!.read(queryFor(plan))).toEqual({ state: 'unresolved' })
  })

  test('detects corrupt operation and applied bindings without returning a receipt', async () => {
    const plan = admissionPlan('corrupt')
    await seed(plan)
    await adapter.commitAdmission(plan)
    const operations = fixture.db.collection(MongoCollectionNames.submissionOperations)
    const saved = await operations.findOne({ _id: operationKey(plan) })
    await operations.updateOne({ _id: operationKey(plan) }, { $set: { txid: '44'.repeat(32) } })
    await expect(adapter.history!.read(queryFor(plan))).rejects.toThrow('transaction')
    await operations.updateOne(
      { _id: operationKey(plan) },
      { $set: { txid: plan.identity.txid, receipt: new Binary(Buffer.from('{}')) } }
    )
    await expect(adapter.history!.read(queryFor(plan))).rejects.toThrow('receipt')
    await operations.updateOne({ _id: operationKey(plan) }, { $set: { receipt: saved!.receipt } })
    const applied = fixture.db.collection(MongoCollectionNames.appliedTransactions)
    await applied.updateOne(
      { _id: appliedKey('tm_contract', plan.identity.txid) },
      { $set: { txid: '44'.repeat(32) } }
    )
    await expect(adapter.history!.read(queryFor(plan))).rejects.toThrow(
      'applied admission identity'
    )
    await expect(
      adapter.history!.read({ ...queryFor(plan), scope: { ...referenceScope, nodeId: 'another' } })
    ).rejects.toThrow('different scope')
    await expect(adapter.history!.read({ ...queryFor(plan), txid: 'invalid' })).rejects.toThrow(
      'hash'
    )
  })

  test('rejects retained provenance belonging to a different node even when its digest is self-consistent', async () => {
    const plan = admissionPlan('wrong-retained-scope')
    await seed(plan)
    await adapter.commitAdmission(plan)
    const operations = fixture.db.collection(MongoCollectionNames.submissionOperations)
    const saved = await operations.findOne({ _id: operationKey(plan) })
    const retained = JSON.parse(Buffer.from(saved!.receipt.value()).toString('utf8'))
    retained.admissionHistory.identity.scope.nodeId = 'another-node'
    retained.semanticDigest = admissionSemanticDigest(retained.admissionHistory.identity)
    await operations.updateOne(
      { _id: operationKey(plan) },
      {
        $set: {
          semanticDigest: retained.semanticDigest,
          receipt: new Binary(Buffer.from(JSON.stringify(retained)))
        }
      }
    )
    await expect(adapter.history!.read(queryFor(plan))).rejects.toThrow('admission-history scope')
  })

  test('rejects oversized or malformed history selectors before any database query', async () => {
    const query = queryFor(admissionPlan('invalid-selector'))
    for (const change of [
      { policyId: 'p'.repeat(1025) },
      { topic: 't'.repeat(1025) },
      { contextDigest: 'c'.repeat(1025) },
      { txid: 't'.repeat(1025) },
      { policyId: 'invalid\u0000policy' },
      { topic: '' }
    ])
      await expect(adapter.history!.read({ ...query, ...change })).rejects.toThrow('key component')
  })

  test('owns the complete selector while the majority lookup is awaiting I/O', async () => {
    const plan = admissionPlan('owned-query')
    await seed(plan)
    await adapter.commitAdmission(plan)
    const query = queryFor(plan)
    const pending = adapter.history!.read(query)
    query.contextDigest = '44'.repeat(32)
    query.topic = 'other'
    query.scope.nodeId = 'other'
    expect((await pending).state).toBe('committed')
  })

  test('bounds retained bytes before the transaction body or operation claim', async () => {
    const runner = new MongoTransactionRunner(fixture.db, referenceScope)
    runners.push(runner)
    const plan = admissionPlan('capacity')
    plan.identity.topics = Array.from({ length: 64 }, (_, i) => ({
      topic: `topic-${i}`,
      policyId: 'p'.repeat(1024)
    }))
    plan.key.semanticDigest = admissionSemanticDigest(plan.identity)
    const receipt = {
      ...admissionReceiptFor(plan, []),
      semanticDigest: plan.key.semanticDigest,
      steak: JSON.stringify('x'.repeat(1000000))
    }
    const body = jest.fn(async () => {})
    await expect(
      runner.run({ key: plan.key, identity: plan.identity, receipt, retainIdentity: true }, body)
    ).rejects.toThrow('too large')
    expect(body).not.toHaveBeenCalled()
    expect(
      await fixture.db
        .collection(MongoCollectionNames.submissionOperations)
        .findOne({ _id: operationKey(plan) })
    ).toBeNull()
    expect(
      (await runner.run({ key: plan.key, identity: plan.identity, receipt }, body)).state
    ).toBe('committed')
    expect(body).toHaveBeenCalledTimes(1)
    expect(await runner.readRetainedAdmission(plan.key.operationId)).toBeUndefined()
    await runner.close()
    await expect(runner.readRetainedAdmission(plan.key.operationId)).rejects.toThrow('closed')
  })

  test('retention follows explicitly scoped writes without granting another node history access', async () => {
    const plan = admissionPlan('scope')
    const other = { ...referenceScope, nodeId: 'other-node' }
    plan.key.scope = other
    plan.identity.scope = other
    plan.key.semanticDigest = admissionSemanticDigest(plan.identity)
    await seed(plan)
    expect((await adapter.commitAdmission(plan)).state).toBe('committed')
    await expect(adapter.history!.read(queryFor(plan))).rejects.toThrow('different scope')
    const owner = new MongoAdmissionStorage(fixture.db, other, { retainAdmissionHistory: true })
    expect((await owner.history!.read(queryFor(plan))).state).toBe('committed')
    await owner.close()
  })
})
