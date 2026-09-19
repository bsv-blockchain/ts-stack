import { Transaction } from '@bsv/sdk'
import { admissionPlan, admissionStorageContract } from '../admission/AdmissionStorageContract.js'
import { getAdmissionStorage } from '../../storage/AdmissionStorage.js'
import { MongoAdmissionStorage } from '../../storage/mongo/MongoAdmissionStorage.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import {
  MongoPayloadStore,
  type MongoPayloadReference
} from '../../storage/mongo/MongoPayloadStore.js'
import type { ClientSession } from 'mongodb'
import {
  bootstrapMongoOverlay,
  encodeMongoOutputIndex,
  encodeMongoUint64,
  MongoCollectionNames,
  mongoChainKey,
  mongoNodeKey,
  mongoRecordKey
} from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'
import { MongoAdmissionHarness } from './MongoAdmissionHarness.js'
import type { MongoEnlistedLookupIndex } from '../../storage/mongo/MongoAdmissionStorage.js'
import type { AdmissionCommit, StorageScope } from '../../storage/AdmissionStorage.js'
import { referenceScope } from '../admission/ReferenceAdmissionStorage.js'

const clone = <T>(value: T): T => structuredClone(value)

describe('Mongo admission storage', () => {
  let fixture: MongoReplicaFixture
  let harness: MongoAdmissionHarness

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, fixture.scope)
    harness = new MongoAdmissionHarness(fixture)
  }, 120000)

  afterAll(async () => {
    await fixture.close()
  }, 60000)

  /** Seeds everything a plan's decisions and payloads need to be admissible, mirroring the shared contract helper. */
  async function seedPlan(
    plan: AdmissionCommit,
    options: { skipHistory?: boolean } = {}
  ): Promise<void> {
    for (const decision of plan.decisions) {
      if (!options.skipHistory) {
        await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
      }
      for (const read of decision.reads) {
        if (read.expectedVersion !== null) {
          await harness.seed.read(
            plan.identity.scope,
            decision.topic,
            read.key,
            read.expectedVersion
          )
        }
      }
      for (const spend of decision.spends) {
        await harness.seed.spendable(
          plan.identity.scope,
          decision.topic,
          spend.outpoint,
          spend.expectedVersion
        )
      }
    }
    for (const payload of plan.payloads) await harness.seed.readyPayload(payload)
  }

  admissionStorageContract(() => harness)

  test('advertises overlay-admission-v1 only on the complete adapter', () => {
    const storage = new MongoOverlayStorage(fixture.db, fixture.scope)
    expect(getAdmissionStorage(storage)?.protocol).toBe('overlay-admission-v1')
    expect(getAdmissionStorage(storage.admission)).toBeUndefined()
  })

  test('lost ACK after majority commit returns the saved STEAK without a new body', async () => {
    const plan = admissionPlan('lost-ack')
    await harness.reset()
    for (const decision of plan.decisions) {
      await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
      for (const read of decision.reads) {
        if (read.expectedVersion !== null) {
          await harness.seed.read(
            plan.identity.scope,
            decision.topic,
            read.key,
            read.expectedVersion
          )
        }
      }
      for (const spend of decision.spends) {
        await harness.seed.spendable(
          plan.identity.scope,
          decision.topic,
          spend.outpoint,
          spend.expectedVersion
        )
      }
    }
    for (const payload of plan.payloads) await harness.seed.readyPayload(payload)
    const first = await harness.adapter.commitAdmission(plan)
    expect(first.state).toBe('committed')
    const replacement = new MongoAdmissionStorage(fixture.db, fixture.scope)
    let bodies = 0
    const original = replacement.commitAdmission.bind(replacement)
    replacement.commitAdmission = async (next: AdmissionCommit) => {
      bodies += 1
      return await original(next)
    }
    const retried = await replacement.commitAdmission(plan)
    expect(retried).toEqual(first)
    expect(bodies).toBe(1)
    await replacement.close()
  })

  test('enlisted indexes are visible at commit and external indexes stay pending', async () => {
    await harness.reset()
    const visible: string[] = []
    const enlisted: MongoEnlistedLookupIndex = {
      protocol: 'overlay-mongo-index-v1',
      target: 'ls_enlisted',
      apply: async (context, plan) => {
        visible.push(plan.identity.txid)
        await fixture.db
          .collection('enlisted_index')
          .insertOne({ txid: plan.identity.txid, target: 'ls_enlisted' }, context.options())
      }
    }
    const adapter = new MongoAdmissionStorage(fixture.db, fixture.scope, {
      enlistedIndexes: [enlisted]
    })
    const plan = admissionPlan('enlisted-visible', 'e1'.repeat(32))
    plan.outbox = plan.outbox.filter(intent => intent.kind !== 'lookup')
    for (const decision of plan.decisions) {
      await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
      for (const read of decision.reads) {
        if (read.expectedVersion !== null) {
          await harness.seed.read(
            plan.identity.scope,
            decision.topic,
            read.key,
            read.expectedVersion
          )
        }
      }
      for (const spend of decision.spends) {
        await harness.seed.spendable(
          plan.identity.scope,
          decision.topic,
          spend.outpoint,
          spend.expectedVersion
        )
      }
    }
    for (const payload of plan.payloads) await harness.seed.readyPayload(payload)
    const result = await adapter.commitAdmission(plan)
    expect(result.state).toBe('committed')
    if (result.state !== 'committed') throw new Error('expected commit')
    expect(result.receipt.indexes).toEqual([{ target: 'ls_enlisted', state: 'visible' }])
    expect(
      await fixture.db.collection('enlisted_index').findOne({ txid: plan.identity.txid })
    ).toEqual(expect.objectContaining({ target: 'ls_enlisted' }))
    expect(visible).toEqual([plan.identity.txid])
    await adapter.close()
  })

  test('external lookup index is not visible at commit and duplicate delivery is idempotent', async () => {
    const plan = admissionPlan('outbox-delivery')
    await harness.reset()
    for (const decision of plan.decisions) {
      await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
      for (const read of decision.reads) {
        if (read.expectedVersion !== null) {
          await harness.seed.read(
            plan.identity.scope,
            decision.topic,
            read.key,
            read.expectedVersion
          )
        }
      }
      for (const spend of decision.spends) {
        await harness.seed.spendable(
          plan.identity.scope,
          decision.topic,
          spend.outpoint,
          spend.expectedVersion
        )
      }
    }
    for (const payload of plan.payloads) await harness.seed.readyPayload(payload)
    const result = await harness.adapter.commitAdmission(plan)
    expect(result.state).toBe('committed')
    if (result.state !== 'committed') throw new Error('expected commit')
    expect(result.receipt.indexes).toEqual([{ target: 'ls_contract', state: 'pending' }])
    expect(
      await fixture.db.collection('enlisted_index').findOne({ txid: plan.identity.txid })
    ).toBeNull()
    const first = await harness.adapter.claimOutbox('lookup')
    expect(first?.eventId).toBe(`${plan.key.operationId}:lookup`)
    await harness.adapter.acknowledgeOutbox('lookup', first!.eventId)
    await harness.adapter.acknowledgeOutbox('lookup', first!.eventId)
    expect(await harness.adapter.claimOutbox('lookup')).toBeNull()
    const stored = await fixture.db.collection(MongoCollectionNames.lookupOutbox).findOne({
      eventId: first!.eventId
    })
    expect(stored?.state).toBe('delivered')
  })

  test('competing spend of a different spender is rejected', async () => {
    await harness.reset()
    const first = admissionPlan('race-a', '6'.repeat(64))
    const second = admissionPlan('race-b', '7'.repeat(64))
    for (const plan of [first, second]) {
      for (const decision of plan.decisions) {
        await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
        for (const read of decision.reads) {
          if (read.expectedVersion !== null) {
            await harness.seed.read(
              plan.identity.scope,
              decision.topic,
              read.key,
              read.expectedVersion
            )
          }
        }
        for (const spend of decision.spends) {
          await harness.seed.spendable(
            plan.identity.scope,
            decision.topic,
            spend.outpoint,
            spend.expectedVersion
          )
        }
      }
      for (const payload of plan.payloads) await harness.seed.readyPayload(payload)
    }
    const results = await Promise.all([
      harness.adapter.commitAdmission(first),
      harness.adapter.commitAdmission(second)
    ])
    expect(results.filter(result => result.state === 'committed')).toHaveLength(1)
    expect(
      results.filter(result => result.state === 'rejected' && result.code === 'spend-conflict')
    ).toHaveLength(1)
  })

  test('sequential history updates replace the generation-scoped pin', async () => {
    await harness.reset()
    const first = admissionPlan('history-first')
    first.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '4',
      affectedFromHeight: '99'
    }
    const second = admissionPlan('history-second', '6'.repeat(64))
    second.decisions[0].spends = []
    second.decisions[0].expectedHistory = { chainEpoch: '7', topicHistoryGeneration: '4' }
    second.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '5',
      affectedFromHeight: '100'
    }
    await harness.seed.history(
      first.identity.scope,
      first.decisions[0].topic,
      first.decisions[0].expectedHistory
    )
    for (const read of first.decisions[0].reads) {
      if (read.expectedVersion !== null) {
        await harness.seed.read(
          first.identity.scope,
          first.decisions[0].topic,
          read.key,
          read.expectedVersion
        )
      }
    }
    for (const spend of first.decisions[0].spends) {
      await harness.seed.spendable(
        first.identity.scope,
        first.decisions[0].topic,
        spend.outpoint,
        spend.expectedVersion
      )
    }
    for (const payload of first.payloads) await harness.seed.readyPayload(payload)
    expect((await harness.adapter.commitAdmission(first)).state).toBe('committed')
    await harness.seed.history(
      second.identity.scope,
      second.decisions[0].topic,
      second.decisions[0].expectedHistory
    )
    for (const read of second.decisions[0].reads) {
      if (read.expectedVersion !== null) {
        await harness.seed.read(
          second.identity.scope,
          second.decisions[0].topic,
          read.key,
          read.expectedVersion
        )
      }
    }
    for (const payload of second.payloads) await harness.seed.readyPayload(payload)
    expect((await harness.adapter.commitAdmission(second)).state).toBe('committed')
    const snapshot = await harness.snapshot()
    expect(snapshot.fences.find(item => item.topic === 'tm_contract')?.fence).toEqual({
      chainEpoch: '7',
      topicHistoryGeneration: '5'
    })
    expect(snapshot.historyUpdates).toEqual([{ topic: 'tm_contract', affectedFromHeight: '100' }])
  })

  test('hydrates output scripts and BEEF from payload bytes', async () => {
    await harness.reset()
    const storage = new MongoOverlayStorage(fixture.db, fixture.scope)
    const script = [0x76, 0xa9, 0x14, 0x00, 0x88, 0xac]
    const beef = hydrationBeef()
    const txid = Transaction.fromBEEF(beef).id('hex')
    await storage.insertOutput({
      txid,
      outputIndex: 0,
      outputScript: script,
      satoshis: 1234,
      topic: 'tm_contract',
      spent: false,
      outputsConsumed: [],
      consumedBy: [],
      score: 10,
      beef
    })
    const found = await storage.findOutput(txid, 0, 'tm_contract', false, true)
    expect(found?.outputScript).toEqual(script)
    expect(found?.satoshis).toBe(1234)
    expect(found?.score).toBe(10)
    expect(found?.beef?.length).toBeGreaterThan(0)
    await storage.close()
  })

  test('majority admission effects survive killing the acknowledged primary', async () => {
    const plan = admissionPlan('kill-primary')
    await harness.reset()
    for (const decision of plan.decisions) {
      await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
      for (const read of decision.reads) {
        if (read.expectedVersion !== null) {
          await harness.seed.read(
            plan.identity.scope,
            decision.topic,
            read.key,
            read.expectedVersion
          )
        }
      }
      for (const spend of decision.spends) {
        await harness.seed.spendable(
          plan.identity.scope,
          decision.topic,
          spend.outpoint,
          spend.expectedVersion
        )
      }
    }
    for (const payload of plan.payloads) await harness.seed.readyPayload(payload)
    const committed = await harness.adapter.commitAdmission(plan)
    expect(committed.state).toBe('committed')
    await fixture.killPrimary()
    const client = await fixture.connect()
    fixture.db = client.db(fixture.db.databaseName)
    const replacement = new MongoAdmissionStorage(fixture.db, fixture.scope)
    expect(await replacement.commitAdmission(plan)).toEqual(committed)
    await replacement.close()
  }, 60000)

  test('covers overlay storage fences, CRUD filters, and unimplemented BEEF updates', async () => {
    await harness.reset()
    const storage = new MongoOverlayStorage(fixture.db, fixture.scope)
    expect(await storage.getHistoryFence('tm_missing')).toEqual({
      chainEpoch: '0',
      topicHistoryGeneration: '0'
    })
    const now = new Date()
    await storage.admission.generations().insertOne({
      _id: storage.admission.generationId('tm_contract'),
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      nodeId: fixture.scope.nodeId,
      topic: 'tm_contract',
      chainEpoch: encodeMongoUint64('3'),
      topicHistoryGeneration: encodeMongoUint64('4'),
      policyId: 'policy-1',
      createdAt: now,
      updatedAt: now
    })
    expect(await storage.getHistoryFence('tm_contract')).toEqual({
      chainEpoch: '3',
      topicHistoryGeneration: '4'
    })

    const published = await storage.publishAdmissionPayload({
      kind: 'locking-script',
      bytes: new Uint8Array([0x76, 0xa9])
    })
    expect(published.byteLength).toBe('2')
    expect(published.digest).toHaveLength(64)

    const beef = hydrationBeef()
    const txid = Transaction.fromBEEF(beef).id('hex')
    const script = [0x76, 0xa9, 0x14, 0x00, 0x88, 0xac]
    await storage.insertOutput({
      txid,
      outputIndex: 0,
      outputScript: script,
      satoshis: 50,
      topic: 'tm_contract',
      spent: false,
      outputsConsumed: [],
      consumedBy: [],
      score: 8,
      beef
    })
    expect(await storage.findOutput(txid, 0, undefined, false)).toEqual(
      expect.objectContaining({ txid, spent: false, satoshis: 50 })
    )
    expect(await storage.findOutput(txid, 0, 'tm_contract', true)).toBeNull()
    expect(await storage.findOutputsForTransaction(txid)).toHaveLength(1)
    expect(await storage.findUTXOsForTopic('tm_contract', 0, 0)).toHaveLength(1)
    expect(await storage.findUTXOsForTopic('tm_contract', 8, 1, true)).toHaveLength(1)
    expect(await storage.findUTXOsForTopic('tm_contract', 9, 1)).toHaveLength(0)

    await storage.updateConsumedBy(txid, 0, 'tm_contract', [
      { txid: 'ab'.repeat(32), outputIndex: 1 }
    ])
    await storage.insertAppliedTransaction({ txid, topic: 'tm_contract', proven: false })
    await storage.insertAppliedTransaction({
      txid: 'dd'.repeat(32),
      topic: 'tm_contract',
      proven: true
    })
    expect(await storage.doesAppliedTransactionExist({ txid, topic: 'tm_contract' })).toBe(true)
    expect(
      await storage.doesAppliedTransactionExist({ txid: 'cd'.repeat(32), topic: 'tm_contract' })
    ).toBe(false)
    await storage.updateLastInteraction('peer.example', 'tm_contract', 42)
    expect(await storage.getLastInteraction('peer.example', 'tm_contract')).toBe(42)
    expect(await storage.getLastInteraction('missing', 'tm_contract')).toBe(0)

    await storage.markUTXOAsSpent(txid, 0, 'tm_contract')
    expect(await storage.findOutput(txid, 0, 'tm_contract', true)).toEqual(
      expect.objectContaining({ spent: true })
    )
    await storage.deleteOutput(txid, 0, 'tm_contract')
    expect(await storage.findOutput(txid, 0, 'tm_contract', false)).toBeNull()
    await expect(storage.updateTransactionBEEF(txid, [])).rejects.toThrow(
      `Mongo overlay storage does not implement updateTransactionBEEF for ${txid}`
    )

    const outputDoc = {
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      nodeId: fixture.scope.nodeId,
      scriptPayloadId: storage.admission.payloadId(published),
      scriptOffset: encodeMongoUint64('0'),
      scriptByteLength: encodeMongoUint64(published.byteLength),
      state: 'unspent' as const,
      version: '1',
      createdAt: now,
      updatedAt: now
    }
    await fixture.db.collection(MongoCollectionNames.outputs).insertOne({
      ...outputDoc,
      _id: mongoRecordKey(
        mongoNodeKey(fixture.scope),
        'output',
        'tm_unsafe',
        'ee'.repeat(32),
        encodeMongoOutputIndex('0')
      ),
      topic: 'tm_unsafe',
      txid: 'ee'.repeat(32),
      outputIndex: encodeMongoOutputIndex('0'),
      satoshis: encodeMongoUint64('9007199254740993'),
      score: encodeMongoUint64('1')
    })
    await expect(storage.findOutput('ee'.repeat(32), 0, 'tm_unsafe')).rejects.toThrow(
      'Mongo satoshis exceeds a safe JavaScript integer'
    )

    await fixture.db.collection(MongoCollectionNames.outputs).insertOne({
      ...outputDoc,
      _id: mongoRecordKey(
        mongoNodeKey(fixture.scope),
        'output',
        'tm_score',
        'cc'.repeat(32),
        encodeMongoOutputIndex('0')
      ),
      topic: 'tm_score',
      txid: 'cc'.repeat(32),
      outputIndex: encodeMongoOutputIndex('0'),
      satoshis: encodeMongoUint64('1'),
      score: encodeMongoUint64('9007199254740993')
    })
    await expect(storage.findOutput('cc'.repeat(32), 0, 'tm_score')).rejects.toThrow(
      'Mongo score exceeds a safe JavaScript integer'
    )

    await fixture.db.collection(MongoCollectionNames.outputs).insertOne({
      ...outputDoc,
      _id: mongoRecordKey(
        mongoNodeKey(fixture.scope),
        'output',
        'tm_script',
        'ff'.repeat(32),
        encodeMongoOutputIndex('0')
      ),
      topic: 'tm_script',
      txid: 'ff'.repeat(32),
      outputIndex: encodeMongoOutputIndex('0'),
      satoshis: encodeMongoUint64('1'),
      score: encodeMongoUint64('1'),
      scriptPayloadId: 'missing-payload'
    })
    await expect(storage.findOutput('ff'.repeat(32), 0, 'tm_script')).rejects.toThrow(
      'Mongo output script payload is not ready'
    )
    await expect(harness.adapter.acknowledgeOutbox('lookup', 'missing-event')).rejects.toThrow(
      'Mongo outbox event is not leased'
    )
    await storage.close()
  })

  test('rejects a missing eviction and a history update from an empty fence', async () => {
    await harness.reset()
    const missingEviction = admissionPlan('missing-eviction')
    missingEviction.decisions[0].evictions = [{ txid: 'aa'.repeat(32), outputIndex: '0' }]
    for (const decision of missingEviction.decisions) {
      await harness.seed.history(
        missingEviction.identity.scope,
        decision.topic,
        decision.expectedHistory
      )
      for (const read of decision.reads) {
        if (read.expectedVersion !== null) {
          await harness.seed.read(
            missingEviction.identity.scope,
            decision.topic,
            read.key,
            read.expectedVersion
          )
        }
      }
      for (const spend of decision.spends) {
        await harness.seed.spendable(
          missingEviction.identity.scope,
          decision.topic,
          spend.outpoint,
          spend.expectedVersion
        )
      }
    }
    for (const payload of missingEviction.payloads) await harness.seed.readyPayload(payload)
    expect(await harness.adapter.commitAdmission(missingEviction)).toEqual({
      state: 'rejected',
      code: 'invalid-plan'
    })

    await harness.reset()
    const fromZero = admissionPlan('history-zero')
    fromZero.decisions[0].expectedHistory = { chainEpoch: '0', topicHistoryGeneration: '0' }
    fromZero.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '1',
      affectedFromHeight: '0'
    }
    fromZero.decisions[0].spends = []
    for (const read of fromZero.decisions[0].reads) {
      if (read.expectedVersion !== null) {
        await harness.seed.read(
          fromZero.identity.scope,
          fromZero.decisions[0].topic,
          read.key,
          read.expectedVersion
        )
      }
    }
    for (const payload of fromZero.payloads) await harness.seed.readyPayload(payload)
    expect((await harness.adapter.commitAdmission(fromZero)).state).toBe('committed')
  })

  test('a decision whose expected history fence no longer matches the topic is rejected as a read conflict', async () => {
    await harness.reset()
    const plan = admissionPlan('fence-conflict')
    // Leave the topic's generation row unseeded so checkHistory sees the
    // default zero fence against the plan's own nonzero expectation.
    await seedPlan(plan, { skipHistory: true })
    expect(await harness.adapter.commitAdmission(plan)).toEqual({
      state: 'rejected',
      code: 'read-conflict'
    })
  })

  test('re-admitting the same tx and topic under a different operation id is fenced off as invalid', async () => {
    await harness.reset()
    const txid = 'fe'.repeat(32)
    const first = admissionPlan('reapply-a', txid)
    await seedPlan(first)
    expect((await harness.adapter.commitAdmission(first)).state).toBe('committed')

    const second = admissionPlan('reapply-b', txid)
    const result = await harness.adapter.commitAdmission(second)
    expect(result).toEqual({ state: 'rejected', code: 'invalid-plan' })
  })

  test('applyEviction transitions a real, currently-unspent output to evicted', async () => {
    await harness.reset()
    const plan = admissionPlan('real-eviction')
    plan.decisions[0].spends = []
    const eviction = { txid: 'ab'.repeat(32), outputIndex: '0' }
    plan.decisions[0].evictions = [eviction]
    await seedPlan(plan)
    await harness.seed.spendable(plan.identity.scope, plan.decisions[0].topic, eviction, '1')
    const result = await harness.adapter.commitAdmission(plan)
    expect(result.state).toBe('committed')
    const raw = await fixture.db
      .collection(MongoCollectionNames.outputs)
      .findOne({ _id: harness.adapter.outputId(plan.decisions[0].topic, eviction) })
    expect(raw?.state).toBe('evicted')
  })

  test('an output insert that collides with an existing row is rejected as invalid-plan', async () => {
    await harness.reset()
    const plan = admissionPlan('duplicate-output')
    await seedPlan(plan)
    const output = plan.decisions[0].outputs[0]
    const now = new Date()
    // Pre-existing row at the exact _id the plan's own output insert will
    // target. Nothing else in applyPlan checks for output existence ahead
    // of the insert itself, so this exercises Mongo's own uniqueness guard.
    await fixture.db.collection(MongoCollectionNames.outputs).insertOne({
      _id: harness.adapter.outputId(plan.decisions[0].topic, output),
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      nodeId: fixture.scope.nodeId,
      topic: plan.decisions[0].topic,
      txid: output.txid,
      outputIndex: encodeMongoOutputIndex(output.outputIndex),
      satoshis: encodeMongoUint64(output.satoshis),
      score: encodeMongoUint64(output.score),
      scriptPayloadId: 'unrelated-payload',
      scriptOffset: encodeMongoUint64('0'),
      scriptByteLength: encodeMongoUint64('1'),
      state: 'unspent',
      version: 'pre-existing',
      createdAt: now,
      updatedAt: now
    })
    const result = await harness.adapter.commitAdmission(plan)
    expect(result).toEqual({ state: 'rejected', code: 'invalid-plan' })
  })

  test('a non-duplicate-key failure inserting an output is rethrown unchanged rather than swallowed', async () => {
    await harness.reset()
    const plan = admissionPlan('output-insert-failure')
    await seedPlan(plan)
    // Scope the injected failure to the outputs namespace specifically, so
    // it lands on insertOutput's own insertOne rather than the transaction
    // runner's unrelated claim-row insert: duplicateKey(error) must be
    // false here, so the original error propagates as-is unclassified.
    await fixture.failCommands({
      failCommands: ['insert'],
      errorCode: 1,
      namespace: `${fixture.db.databaseName}.${MongoCollectionNames.outputs}`
    })
    await expect(harness.adapter.commitAdmission(plan)).rejects.toMatchObject({ code: 1 })
    await fixture.disableFailPoint()
  })

  test('an applied-history insert that collides under the same admission id is rejected as invalid-plan', async () => {
    await harness.reset()
    const plan = admissionPlan('duplicate-applied')
    await seedPlan(plan)
    const appliedId = mongoRecordKey(
      mongoNodeKey(plan.identity.scope),
      'applied',
      plan.decisions[0].topic,
      plan.decisions[0].applied.txid
    )
    const now = new Date()
    // The admissionId matches this plan's own operationId, so
    // assertAppliedAvailable's mismatch guard does not reject it ahead of
    // time; only Mongo's own uniqueness guard on the insert itself can.
    await fixture.db.collection(MongoCollectionNames.appliedTransactions).insertOne({
      _id: appliedId,
      schemaVersion: 1,
      network: plan.identity.scope.network,
      genesisHash: plan.identity.scope.genesisHash,
      nodeId: plan.identity.scope.nodeId,
      topic: plan.decisions[0].topic,
      txid: plan.decisions[0].applied.txid,
      state: 'unproven',
      admissionId: plan.key.operationId,
      createdAt: now,
      updatedAt: now
    })
    const result = await harness.adapter.commitAdmission(plan)
    expect(result).toEqual({ state: 'rejected', code: 'invalid-plan' })
  })

  test('a non-duplicate-key failure inserting an applied-history row is rethrown unchanged rather than swallowed', async () => {
    await harness.reset()
    const plan = admissionPlan('applied-insert-failure')
    await seedPlan(plan)
    // Scope the injected failure to the appliedTransactions namespace so it
    // lands on insertApplied's own insertOne (which runs after the output
    // has already been inserted successfully), not an earlier, unrelated
    // insert -- and duplicateKey(error) must be false here, so the original
    // error propagates as-is instead of being reclassified.
    await fixture.failCommands({
      failCommands: ['insert'],
      errorCode: 1,
      namespace: `${fixture.db.databaseName}.${MongoCollectionNames.appliedTransactions}`
    })
    await expect(harness.adapter.commitAdmission(plan)).rejects.toMatchObject({ code: 1 })
    await fixture.disableFailPoint()
  })

  test('omits firstSeenHeight from the applied-history row when the plan does not supply one', async () => {
    await harness.reset()
    const plan = clone(admissionPlan('no-first-seen'))
    delete (plan.decisions[0].applied as { firstSeenHeight?: string }).firstSeenHeight
    await seedPlan(plan)
    expect((await harness.adapter.commitAdmission(plan)).state).toBe('committed')
    const appliedId = mongoRecordKey(
      mongoNodeKey(plan.identity.scope),
      'applied',
      plan.decisions[0].topic,
      plan.decisions[0].applied.txid
    )
    const raw = await fixture.db
      .collection(MongoCollectionNames.appliedTransactions)
      .findOne({ _id: appliedId })
    expect(raw?.firstSeenHeight).toBeUndefined()
  })

  test('upsertTransaction omits rawPayloadId and records manifestPayloadId when the plan carries no raw payload', async () => {
    await harness.reset()
    const plan = clone(admissionPlan('no-raw-with-manifest'))
    plan.outbox = []
    plan.payloads = plan.payloads.filter(ref => ref.kind !== 'raw-transaction')
    plan.payloads.push({ kind: 'beef-manifest', digest: 'ef'.repeat(32), byteLength: '12' })
    await seedPlan(plan)
    expect((await harness.adapter.commitAdmission(plan)).state).toBe('committed')
    const id = mongoRecordKey(mongoChainKey(plan.identity.scope), 'transaction', plan.identity.txid)
    const raw = await fixture.db.collection(MongoCollectionNames.transactions).findOne({ _id: id })
    expect(raw?.rawPayloadId).toBeUndefined()
    expect(raw?.manifestPayloadId).toBe(
      harness.adapter.payloadId({ kind: 'beef-manifest', digest: 'ef'.repeat(32) })
    )
  })

  test('an output payload ref with an unrecognized kind is rejected even though it is otherwise well-formed', async () => {
    await harness.reset()
    const plan = clone(admissionPlan('weird-payload-kind'))
    const weirdRef = { kind: 'weird-kind', digest: 'cd'.repeat(32), byteLength: '2' }
    ;(
      plan.decisions[0].outputs[0].script as unknown as {
        payload: { kind: string; digest: string; byteLength: string }
      }
    ).payload = weirdRef
    await seedPlan(plan)
    await harness.seed.readyPayload(
      weirdRef as unknown as Parameters<typeof harness.seed.readyPayload>[0]
    )
    const result = await harness.adapter.commitAdmission(plan)
    expect(result).toEqual({ state: 'rejected', code: 'invalid-plan' })
  })

  test('a payload store failure while pinning an output script surfaces as payload-not-ready', async () => {
    await harness.reset()
    // admissionPlan() binds its identity/key to referenceScope, not the
    // fixture's own randomly-named scope, so the adapter under test must be
    // constructed with the same scope -- otherwise commitAdmission's own
    // cross-scope guard would silently delegate to an unwrapped peer.
    const realPayloads = new MongoPayloadStore(fixture.db, referenceScope)
    const payloads = {
      publish: realPayloads.publish.bind(realPayloads),
      addReference: async (
        session: ClientSession,
        reference: MongoPayloadReference,
        operation?: { timeoutMS?: number; signal?: AbortSignal }
      ) => {
        if (reference.ownerKind === 'output' && reference.slot === 'script') {
          throw new Error('Mongo payload is not ready for reference')
        }
        await realPayloads.addReference(session, reference, operation)
      },
      releaseReference: realPayloads.releaseReference.bind(realPayloads)
    } as unknown as MongoPayloadStore
    const adapter = new MongoAdmissionStorage(fixture.db, referenceScope, { payloads })
    const plan = admissionPlan('pin-store-failure')
    await seedPlan(plan)
    const result = await adapter.commitAdmission(plan)
    expect(result).toEqual({ state: 'rejected', code: 'payload-not-ready' })
    await adapter.close()
  })

  test('an unrelated payload store failure while pinning propagates unchanged rather than being reclassified', async () => {
    await harness.reset()
    const realPayloads = new MongoPayloadStore(fixture.db, referenceScope)
    const payloads = {
      publish: realPayloads.publish.bind(realPayloads),
      addReference: async (
        session: ClientSession,
        reference: MongoPayloadReference,
        operation?: { timeoutMS?: number; signal?: AbortSignal }
      ) => {
        if (reference.ownerKind === 'output' && reference.slot === 'script') {
          throw new Error('Mongo payload store is temporarily unavailable')
        }
        await realPayloads.addReference(session, reference, operation)
      },
      releaseReference: realPayloads.releaseReference.bind(realPayloads)
    } as unknown as MongoPayloadStore
    const adapter = new MongoAdmissionStorage(fixture.db, referenceScope, { payloads })
    const plan = admissionPlan('pin-unrelated-failure')
    await seedPlan(plan)
    await expect(adapter.commitAdmission(plan)).rejects.toThrow(
      'Mongo payload store is temporarily unavailable'
    )
    await adapter.close()
  })

  test('claimOutbox omits a pinned payload whose underlying document has since been removed', async () => {
    await harness.reset()
    const plan = admissionPlan('outbox-missing-payload')
    await seedPlan(plan)
    expect((await harness.adapter.commitAdmission(plan)).state).toBe('committed')
    const outboxDataRef = plan.payloads.find(ref => ref.kind === 'outbox-data')
    if (outboxDataRef === undefined) throw new Error('expected an outbox-data payload in the plan')
    await fixture.db
      .collection(MongoCollectionNames.payloads)
      .deleteOne({ _id: harness.adapter.payloadId(outboxDataRef) })
    const claimed = await harness.adapter.claimOutbox('lookup')
    expect(claimed?.eventId).toBe(`${plan.key.operationId}:lookup`)
    expect(claimed?.payloads).toEqual([])
  })

  test('reconcileAdmission for a different scope delegates to, and reuses, a scoped peer instance', async () => {
    await harness.reset()
    const otherScope: StorageScope = { ...fixture.scope, nodeId: `${fixture.scope.nodeId}-peer` }
    const key = {
      scope: otherScope,
      operationId: 'never-committed-on-peer-scope',
      semanticDigest: 'ab'.repeat(32)
    }
    // A never-committed operation reconciles to a fresh "pending/unlocated"
    // result from the peer's own MongoTransactionRunner; a second call for
    // the same foreign scope must reuse the cached peer rather than
    // constructing (and reconnecting) a fresh one every time.
    const first = await harness.adapter.reconcileAdmission(key)
    const second = await harness.adapter.reconcileAdmission(key)
    expect(first).toEqual({ state: 'pending', attemptId: 'unlocated' })
    expect(second).toEqual(first)
  })

  test('applyHandoff advances a matching, unexpired lease and records its checkpoint', async () => {
    await harness.reset()
    const plan = admissionPlan('handoff-happy')
    plan.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '4',
      affectedFromHeight: '99',
      handoff: {
        expected: {
          scope: plan.identity.scope,
          topic: plan.decisions[0].topic,
          peerId: 'peer-a',
          jobId: 'job-a',
          leaseToken: '9',
          expiresAtMs: '1',
          chainEpoch: '7',
          topicHistoryGeneration: '3'
        },
        checkpoint: 'checkpoint-a'
      }
    }
    await seedPlan(plan)
    await harness.seed.lease(plan.decisions[0].historyUpdate.handoff.expected)
    expect((await harness.adapter.commitAdmission(plan)).state).toBe('committed')
    const jobId = mongoRecordKey(
      mongoNodeKey(plan.identity.scope),
      'job',
      plan.decisions[0].topic,
      'peer-a',
      'job-a'
    )
    const raw = await fixture.db
      .collection(MongoCollectionNames.basmRecoveryJobs)
      .findOne({ _id: jobId })
    expect(raw?.checkpoint).toBe('checkpoint-a')
    expect(raw?.topicHistoryGeneration).toBe(encodeMongoUint64('4'))
  })

  test('applyHandoff rejects a handoff whose expected fence does not match the decision', async () => {
    await harness.reset()
    const plan = admissionPlan('handoff-mismatch')
    plan.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '4',
      affectedFromHeight: '99',
      handoff: {
        expected: {
          scope: plan.identity.scope,
          topic: plan.decisions[0].topic,
          peerId: 'peer-b',
          jobId: 'job-b',
          leaseToken: '9',
          expiresAtMs: '1',
          chainEpoch: '1',
          topicHistoryGeneration: '3'
        },
        checkpoint: 'checkpoint-b'
      }
    }
    await seedPlan(plan)
    await harness.seed.lease(plan.decisions[0].historyUpdate.handoff.expected)
    expect(await harness.adapter.commitAdmission(plan)).toEqual({
      state: 'rejected',
      code: 'read-conflict'
    })
  })

  test('applyHandoff rejects when no matching, unexpired lease exists for the topic revision handoff', async () => {
    await harness.reset()
    const plan = admissionPlan('handoff-missing-job')
    plan.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '4',
      affectedFromHeight: '99',
      handoff: {
        expected: {
          scope: plan.identity.scope,
          topic: plan.decisions[0].topic,
          peerId: 'peer-c',
          jobId: 'job-c',
          leaseToken: '9',
          expiresAtMs: '1',
          chainEpoch: '7',
          topicHistoryGeneration: '3'
        },
        checkpoint: 'checkpoint-c'
      }
    }
    await seedPlan(plan)
    // No lease is seeded for job-c: applyHandoff's own findOneAndUpdate must
    // fail closed rather than silently skipping the checkpoint update.
    expect(await harness.adapter.commitAdmission(plan)).toEqual({
      state: 'rejected',
      code: 'read-conflict'
    })
  })

  test('two admissions racing to bootstrap the same topic generation resolve to exactly one winner', async () => {
    await harness.reset()
    const bootstrapPlan = (operationId: string, txid: string): AdmissionCommit => {
      const value = admissionPlan(operationId, txid)
      value.decisions[0].expectedHistory = { chainEpoch: '0', topicHistoryGeneration: '0' }
      value.decisions[0].historyUpdate = {
        nextTopicHistoryGeneration: '1',
        affectedFromHeight: '0'
      }
      value.decisions[0].spends = []
      return value
    }
    const a = bootstrapPlan('bootstrap-race-a', 'aa'.repeat(32))
    const b = bootstrapPlan('bootstrap-race-b', 'bb'.repeat(32))
    for (const value of [a, b]) await seedPlan(value)
    const results = await Promise.all([
      harness.adapter.commitAdmission(a),
      harness.adapter.commitAdmission(b)
    ])
    expect(results.filter(result => result.state === 'committed')).toHaveLength(1)
    expect(
      results.filter(result => result.state === 'rejected' && result.code === 'read-conflict')
    ).toHaveLength(1)
  })

  test('two admissions racing on the same outbox event id resolve to exactly one winner', async () => {
    await harness.reset()
    const sharedEventId = 'shared-outbox-event'
    const racePlan = (operationId: string, txid: string): AdmissionCommit => {
      const value = admissionPlan(operationId, txid)
      value.decisions[0].spends = []
      value.outbox = [{ ...value.outbox[0], eventId: sharedEventId }]
      return value
    }
    const a = racePlan('outbox-race-a', 'cc'.repeat(32))
    const b = racePlan('outbox-race-b', 'dd'.repeat(32))
    for (const value of [a, b]) await seedPlan(value)
    const results = await Promise.all([
      harness.adapter.commitAdmission(a),
      harness.adapter.commitAdmission(b)
    ])
    expect(results.filter(result => result.state === 'committed')).toHaveLength(1)
    expect(results.filter(result => result.state === 'rejected')).toHaveLength(1)
  })
})

function hydrationBeef(): number[] {
  return Transaction.fromHexBEEF(
    '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000'
  ).toBEEF()
}
