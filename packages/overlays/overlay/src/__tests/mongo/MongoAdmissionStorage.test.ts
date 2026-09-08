import { admissionPlan, admissionStorageContract } from '../admission/AdmissionStorageContract.js'
import { getAdmissionStorage } from '../../storage/AdmissionStorage.js'
import { MongoAdmissionStorage } from '../../storage/mongo/MongoAdmissionStorage.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { bootstrapMongoOverlay, MongoCollectionNames } from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'
import { MongoAdmissionHarness } from './MongoAdmissionHarness.js'
import type { MongoEnlistedLookupIndex } from '../../storage/mongo/MongoAdmissionStorage.js'
import type { AdmissionCommit } from '../../storage/AdmissionStorage.js'

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
})
