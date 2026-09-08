import { Transaction } from '@bsv/sdk'
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
})

function hydrationBeef(): number[] {
  return Transaction.fromHexBEEF(
    '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000'
  ).toBEEF()
}
